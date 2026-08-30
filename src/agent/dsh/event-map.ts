import type { AgentEvent, ToolKind } from '../types';
import type { DshSessionEventEnvelope } from './protocol';

const TOOL_TITLE_MAX = 400;
const TOOL_DETAIL_MAX = 2_000;
const TOOL_OUTPUT_MAX = 16_000;
const ERROR_MAX = 2_000;

export class DshEventMapper {
  private readonly surfacedBlocks = new Set<string>();
  private readonly surfacedUsage = new Set<string>();
  private currentTurn: string | undefined;

  constructor(private readonly sessionId: string) {}

  map(event: DshSessionEventEnvelope): AgentEvent[] {
    if (!event || typeof event.type !== 'string' || !isRecord(event.data)) return [];
    const data = event.data;
    switch (event.type) {
      case 'turn/start':
        return this.mapTurnStart(data);
      case 'assistant/chunk':
        return this.mapAssistantChunk(data);
      case 'assistant/message':
        return this.mapAssistantMessage(data);
      case 'tool/call':
        return this.mapToolCall(data);
      case 'tool/result':
        return this.mapToolResult(data);
      case 'turn/end':
        return this.mapTurnEnd(data);
      default:
        return [];
    }
  }

  private mapTurnStart(data: Record<string, unknown>): AgentEvent[] {
    const turn = scalarId(data.turn);
    if (!turn) return [];
    this.currentTurn = turn;
    return [{ type: 'turn_started', turnId: this.turnId(turn) }];
  }

  private mapAssistantChunk(data: Record<string, unknown>): AgentEvent[] {
    const turn = scalarId(data.turn) ?? this.currentTurn;
    const step = scalarId(data.step);
    const chunk = isRecord(data.chunk) ? data.chunk : undefined;
    if (!turn || !step || !chunk || typeof chunk.type !== 'string') return [];
    const index = scalarId(chunk.index) ?? '0';

    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
      const itemId = blockId(turn, step, index, 'text');
      this.surfacedBlocks.add(itemId);
      return chunk.text ? [{ type: 'text_delta', itemId, delta: chunk.text }] : [];
    }
    if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string') {
      const itemId = blockId(turn, step, index, 'reasoning');
      this.surfacedBlocks.add(itemId);
      return chunk.text ? [{ type: 'thinking_delta', itemId, delta: chunk.text }] : [];
    }
    if (chunk.type === 'block-end' && isRecord(chunk.block)) {
      const block = chunk.block;
      if (block.type !== 'text' && block.type !== 'reasoning') return [];
      const itemId = blockId(turn, step, index, block.type);
      if (this.surfacedBlocks.has(`${itemId}:final`)) return [];
      this.surfacedBlocks.add(itemId);
      this.surfacedBlocks.add(`${itemId}:final`);
      if (typeof block.text !== 'string' || !block.text) return [];
      return block.type === 'text'
        ? [{ type: 'text', itemId, text: block.text }]
        : [{ type: 'thinking', itemId, text: block.text }];
    }
    if (chunk.type === 'usage' && isRecord(chunk.usage)) {
      return this.mapUsage(turn, step, chunk.usage);
    }
    return [];
  }

  private mapAssistantMessage(data: Record<string, unknown>): AgentEvent[] {
    const turn = scalarId(data.turn) ?? this.currentTurn;
    const step = scalarId(data.step);
    if (!turn || !step) return [];
    const out: AgentEvent[] = [];
    const message = isRecord(data.message) ? data.message : undefined;
    const content = message && Array.isArray(message.content) ? message.content : [];
    for (let index = 0; index < content.length; index++) {
      const block = content[index];
      if (!isRecord(block) || (block.type !== 'text' && block.type !== 'reasoning')) continue;
      const itemId = blockId(turn, step, String(index), block.type);
      if (this.surfacedBlocks.has(itemId)) continue;
      this.surfacedBlocks.add(itemId);
      if (typeof block.text !== 'string' || !block.text) continue;
      out.push(
        block.type === 'text'
          ? { type: 'text', itemId, text: block.text }
          : { type: 'thinking', itemId, text: block.text },
      );
    }
    if (isRecord(data.usage)) out.push(...this.mapUsage(turn, step, data.usage));
    return out;
  }

  private mapUsage(
    turn: string,
    step: string,
    usage: Record<string, unknown>,
  ): AgentEvent[] {
    const key = `${turn}:${step}`;
    if (this.surfacedUsage.has(key)) return [];
    const inputTokens = finiteNumber(usage.inputTokens);
    const outputTokens = finiteNumber(usage.outputTokens);
    if (inputTokens === undefined && outputTokens === undefined) return [];
    this.surfacedUsage.add(key);
    return [{ type: 'usage', inputTokens, outputTokens }];
  }

  private mapToolCall(data: Record<string, unknown>): AgentEvent[] {
    const name = typeof data.name === 'string' && data.name ? data.name : '工具调用';
    const itemId =
      scalarId(data.callId) ??
      `dsh:${scalarId(data.turn) ?? this.currentTurn ?? 'unknown'}:${scalarId(data.step) ?? '0'}:tool:${name}`;
    const args = parseArguments(data.arguments);
    return [
      {
        type: 'tool_use',
        itemId,
        title: truncate(redactSensitive(toolTitle(name, args)), TOOL_TITLE_MAX),
        detail: optionalText(truncate(redactSensitive(toolDetail(name, args)), TOOL_DETAIL_MAX)),
        kind: toolKind(name),
      },
    ];
  }

  private mapToolResult(data: Record<string, unknown>): AgentEvent[] {
    const message = isRecord(data.message) ? data.message : undefined;
    const content = message && Array.isArray(message.content) ? message.content : [];
    const out: AgentEvent[] = [];
    for (const value of content) {
      if (!isRecord(value) || value.type !== 'tool-result') continue;
      const itemId = scalarId(value.toolCallId) ?? toolCallIdFromSource(message?.source);
      if (!itemId) continue;
      const output = optionalText(
        truncate(redactSensitive(flattenContent(value.content)), TOOL_OUTPUT_MAX),
      );
      out.push({
        type: 'tool_result',
        itemId,
        output,
        exitCode: value.isError === true ? 1 : 0,
      });
    }
    return out;
  }

  private mapTurnEnd(data: Record<string, unknown>): AgentEvent[] {
    const turn = scalarId(data.turn) ?? this.currentTurn;
    if (!turn) return [];
    const reason = isRecord(data.reason) ? data.reason : undefined;
    const out: AgentEvent[] = [];
    if (reason?.kind === 'error') {
      const error = isRecord(reason.error) ? reason.error : undefined;
      const message =
        typeof error?.message === 'string' && error.message.trim()
          ? error.message.trim()
          : `DSH 运行失败${typeof error?.code === 'string' ? `（${error.code}）` : ''}`;
      out.push({
        type: 'error',
        message: truncate(redactSensitive(message), ERROR_MAX),
        willRetry: false,
      });
    }
    out.push({ type: 'done', turnId: this.turnId(turn) });
    return out;
  }

  private turnId(turn: string): string {
    return `dsh:${this.sessionId}:${turn}`;
  }
}

function blockId(turn: string, step: string, index: string, kind: 'text' | 'reasoning'): string {
  return `dsh:${turn}:${step}:${index}:${kind}`;
}

function parseArguments(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : { input: value };
  } catch {
    return { input: value };
  }
}

function toolTitle(name: string, args: Record<string, unknown>): string {
  const lower = name.toLowerCase();
  if (lower === 'bash' || lower.includes('shell')) return stringField(args, 'command') || name;
  const path =
    stringField(args, 'path') ||
    stringField(args, 'file_path') ||
    stringField(args, 'filePath');
  if (path) return `${name} ${path}`;
  const query = stringField(args, 'query') || stringField(args, 'pattern');
  if (query) return `${name} ${query}`;
  return name;
}

function toolDetail(name: string, args: Record<string, unknown>): string {
  const description = stringField(args, 'description');
  if (description) return description;
  if (name.toLowerCase() === 'bash') return '';
  return Object.keys(args).length ? JSON.stringify(args) : '';
}

function toolKind(name: string): ToolKind {
  const lower = name.toLowerCase();
  if (lower === 'bash' || lower.includes('shell')) return 'command';
  if (/read|write|edit|file|filesystem/.test(lower)) return 'file';
  if (/search|glob|grep|web/.test(lower)) return 'search';
  return 'tool';
}

function flattenContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value
    .map((block) => {
      if (!isRecord(block)) return '';
      if (block.type === 'text' && typeof block.text === 'string') return block.text;
      if (block.type === 'image') return '[图片]';
      return '';
    })
    .join('');
}

function toolCallIdFromSource(source: unknown): string | undefined {
  return isRecord(source) ? scalarId(source.callId) : undefined;
}

function scalarId(value: unknown): string | undefined {
  if (typeof value === 'string' && value) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stringField(value: Record<string, unknown>, key: string): string {
  return typeof value[key] === 'string' ? value[key] : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalText(value: string): string | undefined {
  return value || undefined;
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

export function redactSensitive(value: string): string {
  return value
    .replace(/(authorization\s*[:=]\s*)(?:bearer\s+)?([^\s'"]+)/gi, '$1[REDACTED]')
    .replace(/((?:api[_-]?key|token|secret)\s*[:=]\s*)([^\s,'"}]+)/gi, '$1[REDACTED]');
}
