// Adapted from vonvon-dsh's ordered Feishu process presentation.
import { md as markdown, type CardElement } from './cards';
import { processPanel } from './process-panel';
import { renderRichText } from './markdown-render';
import { toolPresentation, toolArguments } from './tool-presentation';
import type { Block, ToolEntry, RunState, Terminal } from './run-state';

const PROCESS_BODY_BUDGET = 22_000;
const PROCESS_COMPONENT_BUDGET = 120;
const REASONING_MAX = 1_500;
const TEXT_MAX = 6_000;
const DETAIL_MAX = 4_000;
const OUTPUT_MAX = 1_200;
const COMPACT_GROUP_BUDGET = 18_000;

interface ProcessUnit {
  readonly element: CardElement;
  readonly itemCount: number;
}

export function buildProcessBody(
  blocks: readonly Block[],
  images?: ReadonlyMap<string, string>,
  componentBudget = PROCESS_COMPONENT_BUDGET,
): CardElement[] {
  const rich = processUnits(blocks, false, images);
  const richElements = rich.map(unit => unit.element);
  if (fitsProcessBudget(richElements, 0, componentBudget)) return richElements;

  const compact = processUnits(blocks, true, images);
  const compactElements = compact.map(unit => unit.element);
  if (fitsProcessBudget(compactElements, 0, componentBudget)) return compactElements;

  const kept: CardElement[] = [];
  let keptUnits = 0;
  for (const unit of compact) {
    if (!fitsProcessBudget([...kept, unit.element], 512, componentBudget)) break;
    kept.push(unit.element);
    keptUnits += 1;
  }
  const omitted = compact.slice(keptUnits).reduce((total, unit) => total + unit.itemCount, 0);
  if (omitted > 0) kept.push(markdown(`_…后续 ${String(omitted)} 项过程已省略（卡片容量限制）_`));
  return kept;
}

function fitsProcessBudget(
  elements: readonly CardElement[],
  reserve = 0,
  componentBudget = PROCESS_COMPONENT_BUDGET,
): boolean {
  return Buffer.byteLength(JSON.stringify(elements), 'utf8') + reserve <= PROCESS_BODY_BUDGET
    && estimateComponents(elements) + (reserve > 0 ? 1 : 0) <= componentBudget;
}

function processUnits(
  blocks: readonly Block[],
  compactTools: boolean,
  images?: ReadonlyMap<string, string>,
): ProcessUnit[] {
  const units: ProcessUnit[] = [];
  let tools: ToolEntry[] = [];
  const flushTools = (): void => {
    if (compactTools) units.push(...compactToolUnits(tools));
    else if (tools.length === 1) units.push({ element: toolPanel(tools[0]!), itemCount: 1 });
    else if (tools.length > 1) units.push({
      element: processPanel(
        toolGroupTitle(tools),
        tools.map(tool => toolPanel(tool)),
        false,
        { icon: toolPresentation(tools[0]!).icon, spacing: 8 },
      ),
      itemCount: tools.length,
    });
    tools = [];
  };

  for (const block of blocks) {
    if (block.kind === 'tool') {
      tools.push(block.tool);
      continue;
    }
    if (block.content.trim() === '') continue;
    flushTools();
    const content = truncate(block.content, block.kind === 'reasoning' ? REASONING_MAX : TEXT_MAX);
    const elements = renderRichText(content, images);
    elements.forEach(element => units.push({ element, itemCount: 1 }));
  }
  flushTools();
  return units;
}

function compactToolUnits(tools: readonly ToolEntry[]): ProcessUnit[] {
  const units: ProcessUnit[] = [];
  let batch: ToolEntry[] = [];
  let entries: string[] = [];
  const flush = (): void => {
    if (!batch.length) return;
    units.push({
      element: processPanel(
        toolGroupTitle(batch),
        [markdown(entries.join('\n\n'))],
        false,
        { icon: toolPresentation(batch[0]!).icon, spacing: 8 },
      ),
      itemCount: batch.length,
    });
    batch = [];
    entries = [];
  };

  for (const tool of tools) {
    const entry = compactToolEntry(tool);
    const candidate = processPanel(
      toolGroupTitle([...batch, tool]),
      [markdown([...entries, entry].join('\n\n'))],
      false,
      { icon: toolPresentation(batch[0] ?? tool).icon, spacing: 8 },
    );
    if (batch.length && Buffer.byteLength(JSON.stringify(candidate), 'utf8') > COMPACT_GROUP_BUDGET) flush();
    batch.push(tool);
    entries.push(entry);
  }
  flush();
  return units;
}

function compactToolEntry(tool: ToolEntry): string {
  const presentation = toolPresentation(tool);
  const command = tool.kind === 'command' ? tool.title : presentation.command;
  const parts = [`**${presentation.header}**`];
  if (command !== undefined) {
    parts.push(codeBlock(command, 'bash'));
    const args = extraToolArguments(tool, command);
    if (args) parts.push(`**调用参数**\n${codeBlock(truncateWithNotice(args, DETAIL_MAX), 'json')}`);
  } else if (tool.detail !== undefined) {
    parts.push(`**调用参数**\n${codeBlock(truncateWithNotice(tool.detail, DETAIL_MAX))}`);
  } else {
    parts.push(`**操作**\n${codeBlock(tool.title)}`);
  }
  if (tool.exitCode !== undefined && tool.exitCode !== null) parts.push(`**退出码** \`${String(tool.exitCode)}\``);
  return parts.join('\n\n');
}

function toolPanel(tool: ToolEntry): CardElement {
  const presentation = toolPresentation(tool);
  return processPanel(
    presentation.header,
    [markdown(toolBodyMarkdown(tool) || '_无输出_')],
    false,
    { icon: presentation.icon, bodyIndent: 20, spacing: 8 },
  );
}

function toolBodyMarkdown(tool: ToolEntry): string {
  const command = commandFor(tool);
  const parts: string[] = [];
  if (command !== undefined) {
    parts.push(`**命令**\n${codeBlock(command, 'bash')}`);
    const args = extraToolArguments(tool, command);
    if (args) parts.push(`**调用参数**\n${codeBlock(truncateWithNotice(args, DETAIL_MAX), 'json')}`);
  } else if (tool.detail !== undefined) {
    parts.push(`**调用参数**\n${codeBlock(truncateWithNotice(tool.detail, DETAIL_MAX))}`);
  } else {
    parts.push(`**操作**\n${codeBlock(tool.title)}`);
  }

  if (tool.output !== undefined && tool.output !== '') {
    parts.push(`**${tool.status === 'error' ? '错误' : '输出'}**\n${codeBlock(truncateWithNotice(tool.output, OUTPUT_MAX))}`);
  } else if (tool.status === 'running') {
    parts.push('_运行中…_');
  } else if (tool.kind === 'search') {
    parts.push('_（搜索结果已用于作答，不单独回传）_');
  }
  if (tool.exitCode !== undefined && tool.exitCode !== null) parts.push(`**退出码** \`${String(tool.exitCode)}\``);
  return parts.join('\n\n');
}

function commandFor(tool: ToolEntry): string | undefined {
  const presentation = toolPresentation(tool);
  return tool.kind === 'command' ? tool.title : presentation.command;
}

function extraToolArguments(tool: ToolEntry, command: string): string | undefined {
  const args = toolArguments(tool.detail);
  if (args) {
    const extra = Object.fromEntries(Object.entries(args).filter(([key, value]) => !((key === 'command' || key === 'cmd') && value === command)));
    return Object.keys(extra).length ? JSON.stringify(extra, null, 2) : undefined;
  }
  return tool.detail !== undefined && tool.detail !== command ? tool.detail : undefined;
}

function toolGroupTitle(tools: readonly ToolEntry[]): string {
  const unique = [...new Map(tools.map(tool => [tool.id, tool])).values()];
  const failed = unique.filter(tool => tool.status === 'error').length;
  const running = unique.some(tool => tool.status === 'running');
  return `${running ? '正在执行' : '已执行'} ${unique.length} 项操作${failed ? ` · ${String(failed)} 项失败` : ''}`;
}

function codeBlock(value: string, language = ''): string {
  let fenceLength = 3;
  for (const match of value.matchAll(/`+/gu)) fenceLength = Math.max(fenceLength, match[0].length + 1);
  const fence = '`'.repeat(fenceLength);
  return `${fence}${language}\n${value}\n${fence}`;
}

function truncateWithNotice(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…\n（内容过长，已截断；完整内容 ${String(value.length)} 字符）` : value;
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
  return elements.reduce((total, element) => total + (element.tag === 'collapsible_panel' ? 3 : 1)
    + (Array.isArray(element.elements) ? estimateComponents(element.elements) : 0)
    + (Array.isArray(element.columns) ? estimateComponents(element.columns) : 0), 0);
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}
