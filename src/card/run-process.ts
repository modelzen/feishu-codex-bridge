// Adapted from vonvon-dsh's ordered Feishu process presentation.
import { md as markdown, type CardElement } from './cards';
import { processPanel } from './process-panel';
import { renderRichText } from './markdown-render';
import { toolPresentation, toolArguments } from './tool-presentation';
import type { Block, ToolEntry, RunState, Terminal } from './run-state';

const PROCESS_BODY_BUDGET = 22_000;
const PROCESS_COMPONENT_BUDGET = 120;

export interface ProcessPreview {
  elements: CardElement[];
  hasMore: boolean;
}

/** Each page is complete; callers must expose navigation when there is overflow. */
export function buildProcessPages(
  blocks: readonly Block[],
  images?: ReadonlyMap<string, string>,
  componentBudget = PROCESS_COMPONENT_BUDGET,
): CardElement[][] {
  return Array.from(processPages(blocks, images, componentBudget), page => page.elements);
}

export function buildProcessPreview(
  blocks: readonly Block[],
  images?: ReadonlyMap<string, string>,
  componentBudget = PROCESS_COMPONENT_BUDGET,
): ProcessPreview {
  return processPages(blocks, images, componentBudget).next().value ?? { elements: [], hasMore: false };
}

function* processPages(
  blocks: readonly Block[],
  images: ReadonlyMap<string, string> | undefined,
  componentBudget: number,
): Generator<ProcessPreview, undefined> {
  let page: CardElement[] = [];
  let tools: ToolEntry[] = [];
  let panels: CardElement[] = [];
  const limit = Math.max(4, componentBudget);
  const grouped = (): CardElement[] => panels.length > 1
    ? [processPanel(toolGroupTitle(tools), panels, false, { icon: toolPresentation(tools[0]!).icon, spacing: 8 })]
    : panels;
  const flush = (): void => {
    page.push(...grouped());
    tools = [];
    panels = [];
  };
  let ordinal = 0;
  for (const block of blocks) {
    if (block.kind === 'tool') {
      ordinal += 1;
      for (const panel of toolPanels(block.tool, ordinal, limit)) {
        const candidate = panels.length ? processPanel(toolGroupTitle([...tools, block.tool]), [...panels, panel], false,
          { icon: toolPresentation(tools[0]!).icon, spacing: 8 }) : panel;
        if (!fitsProcessBudget([...page, candidate], limit)) {
          flush();
          if (page.length) yield { elements: page, hasMore: true };
          page = [];
        }
        panels.push(panel);
        tools.push(block.tool);
      }
    } else if (block.content !== '') {
      flush();
      for (const chunk of payloadChunks(block.content)) {
        for (const richElement of renderRichText(chunk, images)) {
          for (const element of splitRichElement(richElement, limit)) {
            if (!fitsProcessBudget([...page, element], limit)) {
              if (page.length) yield { elements: page, hasMore: true };
              page = [];
            }
            page.push(element);
          }
        }
      }
    }
  }
  flush();
  if (page.length) yield { elements: page, hasMore: false };
}

function fitsProcessBudget(elements: CardElement[], componentBudget: number): boolean {
  return Buffer.byteLength(JSON.stringify(elements), 'utf8') <= PROCESS_BODY_BUDGET
    && estimateComponents(elements) <= componentBudget;
}

function* splitRichElement(element: CardElement, componentBudget: number): Generator<CardElement> {
  if (fitsProcessBudget([element], componentBudget)) {
    yield element;
  } else if (Array.isArray(element.columns)) {
    for (const column of element.columns) {
      if (Array.isArray(column.elements)) {
        for (const child of column.elements) yield* splitRichElement(child, componentBudget);
      }
    }
  } else if (Array.isArray(element.elements)) {
    for (const child of element.elements) yield* splitRichElement(child, componentBudget);
  } else if (element.tag === 'markdown' && typeof element.content === 'string') {
    for (const chunk of payloadChunks(element.content)) yield { ...element, content: chunk };
  } else {
    throw new Error('A process element exceeds the card budget');
  }
}

export function buildProcessBody(blocks: readonly Block[], images?: ReadonlyMap<string, string>, componentBudget = PROCESS_COMPONENT_BUDGET): CardElement[] {
  return buildProcessPreview(blocks, images, componentBudget).elements;
}

function* payloadChunks(value: string): Generator<string> {
  let chunk = '';
  let bytes = 0;
  for (const character of value) {
    const size = Buffer.byteLength(JSON.stringify(character), 'utf8') - 2;
    if (bytes + size > 2000 && chunk) {
      yield chunk;
      chunk = '';
      bytes = 0;
    }
    chunk += character;
    bytes += size;
  }
  if (chunk || value.length === 0) yield chunk;
}

function* section(label: string, value: string, language = ''): Generator<CardElement> {
  let index = 0;
  for (const chunk of payloadChunks(value)) {
    index += 1;
    yield markdown(`**${label}${chunk.length < value.length ? ` ${index}` : ''}**\n${codeBlock(chunk, language)}`);
  }
}

function* toolElements(tool: ToolEntry, command: string | undefined): Generator<CardElement> {
  if (command !== undefined) {
    yield* section('命令', command, 'bash');
    const args = toolArguments(tool.detail);
    if (args) {
      const extra = Object.fromEntries(Object.entries(args).filter(([key, value]) => !((key === 'command' || key === 'cmd') && value === command)));
      if (Object.keys(extra).length) yield* section('调用参数', JSON.stringify(extra, null, 2), 'json');
    } else if (tool.detail !== undefined && tool.detail !== command) yield* section('详情', tool.detail);
  } else if (tool.detail !== undefined) {
    yield* section('调用参数', tool.detail);
  } else {
    yield* section('操作', tool.title);
  }
  if (tool.output !== undefined && tool.output !== '') yield* section(tool.status === 'error' ? '错误' : '输出', tool.output);
  else if (tool.status === 'running') yield markdown('_运行中…_');
  if (tool.exitCode !== undefined && tool.exitCode !== null) yield markdown(`退出码：${String(tool.exitCode)}`);
}

function* toolPanels(tool: ToolEntry, ordinal: number, componentBudget: number): Generator<CardElement> {
  const presentation = toolPresentation(tool);
  const command = tool.kind === 'command' ? tool.title : presentation.command;
  let group: CardElement[] = [];
  let index = 0;
  const panel = (continued: boolean): CardElement => processPanel(
    `${presentation.header}${continued || index > 0 ? ` · 操作 ${ordinal}（第 ${index + 1} 部分）` : ''}`,
    group, false, { icon: presentation.icon, bodyIndent: 20, spacing: 8 },
  );
  for (const element of toolElements(tool, command)) {
    if (group.length && (Buffer.byteLength(JSON.stringify([...group, element]), 'utf8') > 12000
      || group.length + 1 > Math.max(1, componentBudget - 6))) {
      yield panel(true);
      index += 1;
      group = [];
    }
    group.push(element);
  }
  if (group.length) yield panel(false);
}

function toolGroupTitle(tools: readonly ToolEntry[]): string {
  const unique = [...new Map(tools.map(tool => [tool.id, tool])).values()];
  const failed = unique.filter(tool => tool.status === 'error').length;
  const running = unique.some(tool => tool.status === 'running');
  return `${running ? '正在执行' : '已执行'} ${unique.length} 项操作${failed ? ` · ${failed} 项失败` : ''}`;
}

function codeBlock(value: string, language = ''): string {
  const fence = '`'.repeat(Math.max(3, ...Array.from(value.matchAll(/`+/gu), match => match[0].length + 1)));
  return `${fence}${language}\n${value}\n${fence}`;
}

export function runElapsedMs(state: RunState, now = Date.now()): number | undefined {
  if (state.startedAt === undefined) return undefined;
  return Math.max(0, (state.completedAt ?? now) - state.startedAt);
}

export function processTitle(
  status: Terminal,
  elapsedMs?: number,
): string {
  const label = elapsedMs === undefined || !Number.isFinite(elapsedMs) ? '执行过程' : `${status === 'running' ? '已处理' : '用时'} ${formatElapsed(elapsedMs)}`;
  const suffix = status === 'interrupted' ? ' · 已停止' : status === 'idle_timeout' ? ' · 已超时' : status === 'error' ? ' · 失败' : '';
  return `${status === 'error' ? '❌ ' : ''}${label}${suffix}`;
}

function formatElapsed(milliseconds: number): string {
  const total = Math.max(0, Math.floor(milliseconds / 1_000));
  if (total === 0) return '不足 1 秒';
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3_600);
  return [hours > 0 ? `${String(hours)}小时` : '', minutes > 0 ? `${String(minutes)}分钟` : '', seconds > 0 ? `${String(seconds)}秒` : ''].filter(Boolean).join(' ');
}

export function currentAnswerIndex(blocks: readonly Block[]): number {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    if (block?.kind === 'tool') return -1;
    if (block !== undefined && block.content.trim() !== '') return block.kind === 'text' ? index : -1;
  }
  return -1;
}

function estimateComponents(elements: readonly CardElement[]): number {
  return elements.reduce((total, element) => total + (element.tag === 'collapsible_panel' ? 3 : 1) + (Array.isArray(element.elements) ? estimateComponents(element.elements) : 0) + (Array.isArray(element.columns) ? estimateComponents(element.columns) : 0), 0);
}
