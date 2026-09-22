// Adapted from vonvon-dsh's ordered Feishu process presentation.
import { md as markdown, type CardElement } from './cards';
import { processPanel } from './process-panel';
import { renderRichText } from './markdown-render';
import { toolPresentation, toolArguments } from './tool-presentation';
import type { Block, ToolEntry, RunState, Terminal } from './run-state';

const PROCESS_BODY_BUDGET = 22_000;
const PROCESS_COMPONENT_BUDGET = 120;
const REASONING_MAX = 1_500;

export function buildProcessBody(
  blocks: readonly Block[],
  images?: ReadonlyMap<string, string>,
  componentBudget = PROCESS_COMPONENT_BUDGET,
): CardElement[] {
  const rich = processElements(blocks, false, images);
  if (fitsProcessBudget(rich, 0, componentBudget)) return rich;
  const compact = processElements(blocks, true, images);
  if (fitsProcessBudget(compact, 0, componentBudget)) return compact;
  // Retain a chronological prefix rather than regrouping content to make it fit.
  const kept: CardElement[] = [];
  for (const element of compact) {
    if (!fitsProcessBudget([...kept, element], 512, componentBudget)) break;
    kept.push(element);
  }
  return [...kept, markdown(`_…后续 ${String(compact.length - kept.length)} 项过程已省略（内容过长）_`)];
}

function fitsProcessBudget(elements: readonly CardElement[], reserve = 0, componentBudget = PROCESS_COMPONENT_BUDGET): boolean {
  return Buffer.byteLength(JSON.stringify(elements), 'utf8') + reserve <= PROCESS_BODY_BUDGET
    && estimateComponents(elements) + (reserve > 0 ? 1 : 0) <= componentBudget;
}

function processElements(
  blocks: readonly Block[],
  compactTools: boolean,
  images?: ReadonlyMap<string, string>,
): CardElement[] {
  const elements: CardElement[] = [];
  let tools: ToolEntry[] = [];
  const flushTools = (): void => {
    if (compactTools && tools.length) elements.push(compactToolGroup(tools));
    else if (tools.length === 1) elements.push(toolPanel(tools[0]!, compactTools));
    else if (tools.length > 1) elements.push(processPanel(
      toolGroupTitle(tools), tools.map(tool => toolPanel(tool, compactTools)), false,
      { icon: toolPresentation(tools[0]!).icon, spacing: 8 },
    ));
    tools = [];
  };
  for (const block of blocks) {
    if (block.kind === 'tool') tools.push(block.tool);
    else if (block.content.trim() !== '') {
      flushTools();
      elements.push(...renderRichText(truncate(block.content, block.kind === 'reasoning' ? REASONING_MAX : 6000), images));
    }
  }
  flushTools();

  return elements;
}

function compactToolGroup(tools: readonly ToolEntry[]): CardElement {
  const lines: string[] = [];
  let bytes = 0;
  for (const tool of tools) {
    const item = toolPresentation(tool);
    const line = `${item.header}\n${codeBlock(item.command ?? tool.title, 400)}`;
    bytes += Buffer.byteLength(line, 'utf8');
    if (bytes > 6000) break;
    lines.push(line);
  }
  if (lines.length < tools.length) lines.push(`_…还有 ${tools.length - lines.length} 项操作未显示_`);
  return processPanel(toolGroupTitle(tools), [markdown(lines.join('\n\n'))], false,
    { icon: toolPresentation(tools[0]!).icon, spacing: 8 });
}

function toolPanel(tool: ToolEntry, compact: boolean): CardElement {
  return processPanel(
    toolPresentation(tool).header,
    [markdown(toolBodyMarkdown(tool, compact) || '_无输出_')],
    false,
    { icon: toolPresentation(tool).icon, bodyIndent: 20, spacing: 8 },
  );
}

function toolGroupTitle(tools: readonly ToolEntry[]): string {
  const descriptions = new Map<string, { verb: string; noun: string; count: number; }>();
  for (const tool of tools) {
    const item = toolPresentation(tool);
    const [verb, noun] = item.action === '运行命令' ? ['运行', '条命令']
      : item.action === '运行代码' ? ['运行', '段代码']
        : item.icon === 'wiki-book_outlined' ? ['读取', '个文件']
          : item.icon === 'edit_outlined' ? ['编辑', '个文件']
            : item.icon === 'search_outlined' ? ['执行', '次搜索']
              : item.icon === 'image_outlined' ? ['查看', '张图像'] : ['调用', '个工具'];
    const key = `${verb}:${noun}`;
    const current = descriptions.get(key);
    descriptions.set(key, { verb: verb!, noun: noun!, count: (current?.count ?? 0) + 1 });
  }
  const failed = tools.filter(tool => tool.status === 'error').length;
  const running = tools.some(tool => tool.status === 'running');
  const summary = [...descriptions.values()].map(item => `${item.verb} ${String(item.count)} ${item.noun}`).join('，');
  return `${failed ? '❌ ' : running ? '正在' : '已'}${summary}${failed ? ` · ${String(failed)} 项失败` : ''}`;
}

function toolBodyMarkdown(tool: ToolEntry, compact: boolean): string {
  const detailLimit = compact ? 400 : 1_000;
  const presentation = toolPresentation(tool);
  const args = toolArguments(tool.detail);
  const argumentText = args ? JSON.stringify(args, null, 2) : tool.detail;
  const extraArgs = args ? Object.fromEntries(Object.entries(args).filter(([key]) => key !== 'command' && key !== 'cmd')) : undefined;
  if (presentation.command) {
    const clip = (value: string, limit: number): string => value.length > limit
      ? `${truncate(value, limit)}\n（内容过长，已截断；完整内容 ${String(value.length)} 字符）` : value;
    const lines = [
      `$ ${clip(presentation.command, detailLimit)}`,
      tool.output ? clip(tool.output, compact ? 400 : 1_200) : tool.status === 'running' ? '运行中…' : undefined,
      tool.exitCode === undefined || tool.exitCode === null ? undefined : `退出码：${String(tool.exitCode)}`,
      tool.kind === 'command' && tool.detail ? `详情：${clip(tool.detail, detailLimit)}` : undefined,
      extraArgs && Object.keys(extraArgs).length > 0 ? `调用参数：\n${clip(JSON.stringify(extraArgs, null, 2), detailLimit)}` : undefined,
    ].filter((line): line is string => line !== undefined).join('\n\n');
    return `<font color='grey'>Shell</font>\n${codeBlock(lines, lines.length, 'bash')}`;
  }
  const invocation = argumentText?.trim() ? `**调用参数**\n${codeBlock(argumentText, detailLimit, args ? 'json' : '')}` : '';
  const output = tool.output === undefined || tool.output === ''
    ? tool.status === 'running'
      ? '_运行中…_'
      : tool.kind === 'search'
        ? '_（搜索结果已用于作答，不单独回传）_'
        : ''
    : `**${tool.status === 'error' ? '错误' : '输出'}**\n${codeBlock(tool.output, compact ? 400 : 1_200)}`;
  const exit = tool.exitCode === undefined || tool.exitCode === null ? '' : `**退出码** \`${String(tool.exitCode)}\``;
  return [invocation, output, exit].filter(Boolean).join('\n\n');
}

function codeBlock(value: string, max: number, language = ''): string {
  // Keep the fence closed even when the tool's output contains code fences.
  const clipped = truncate(value, max);
  const fence = '`'.repeat(Math.max(3, ...Array.from(clipped.matchAll(/`+/gu), match => match[0].length + 1)));
  const note = value.length > max ? `\n_（内容过长，已截断；完整内容 ${String(value.length)} 字符）_` : '';
  return `${fence}${language}\n${clipped}\n${fence}${note}`;
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
  return elements.reduce((total, element) => total + (element.tag === 'collapsible_panel' ? 3 : 1) + (Array.isArray(element.elements) ? estimateComponents(element.elements as CardElement[]) : 0), 0);
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}
