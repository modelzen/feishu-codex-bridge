import { RUNTIME_TERMINAL_ICON } from './runtime-card-icons';
import type { ToolEntry } from './run-state';

type ToolInput = Pick<ToolEntry, 'title' | 'kind' | 'detail' | 'status'>;
interface ToolAction {
  readonly icon: string;
  readonly action: string;
  readonly subject?: string;
  readonly preview?: string;
  readonly command?: string;
}

/** Describe an observed operation; never infer the purpose of arbitrary code. */
export function toolPresentation(tool: ToolInput): ToolAction & { readonly header: string; } {
  const action = describeTool(tool);
  const subject = action.subject ? ` ${action.subject}` : '';
  const label = tool.status === 'running' ? `正在${action.action}${subject}`
    : tool.status === 'error' ? `${action.action}${subject}${subject ? ' ' : ''}失败` : `已${action.action}${subject}`;
  const preview = action.preview ? ` · ${escapeInline(short(action.preview, 80))}` : '';
  return { ...action, header: `${tool.status === 'error' ? '❌ ' : ''}${escapeInline(label)}${preview}` };
}

export function toolArguments(detail: string | undefined): Record<string, unknown> | undefined {
  if (!detail) return undefined;
  try {
    const value: unknown = JSON.parse(detail);
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch { return undefined; }
}

function describeTool(tool: ToolInput): ToolAction {
  const args = toolArguments(tool.detail);
  const name = tool.title.trim();
  const normalized = name.toLowerCase().replace(/^functions\./u, '');
  const argument = (...keys: string[]): string | undefined => {
    for (const key of keys) if (typeof args?.[key] === 'string' && args[key].trim()) return args[key].trim();
    return undefined;
  };
  if (/^(?:skill|read_skill|load_skill)$/u.test(normalized)) {
    const skill = argument('name', 'skill', 'skill_name');
    return { icon: 'setting-inter_outlined', action: '读取', subject: skill ? `${short(skill, 64)} 技能` : '技能' };
  }
  if (tool.kind === 'command' || /^(?:bash|shell|exec_command|run_command|terminal)$/u.test(normalized)) {
    const command = tool.kind === 'command' ? tool.title
      : typeof args?.command === 'string' ? args.command : typeof args?.cmd === 'string' ? args.cmd : undefined;
    if (!command) return { icon: RUNTIME_TERMINAL_ICON, action: '运行命令' };
    const unwrapped = unwrapShell(command);
    const words = shellWords(unwrapped);
    if (!words) return { icon: RUNTIME_TERMINAL_ICON, action: '运行命令', command };
    const readPath = simpleReadPath(words);
    if (readPath) return { ...readAction(readPath), command };
    if (words.length === 1 && words[0] === 'pwd') return { icon: 'folder_outlined', action: '查看当前目录', command };
    if (words[0] === 'ls') return { icon: 'folder_outlined', action: '查看目录', command };
    if (words.length > 1 && /^(?:rg|grep|find)$/u.test(words[0]!) && !isMutatingSearch(words)) {
      return { icon: 'search_outlined', action: '搜索文件', command };
    }
    const mcporter = mcporterAction(words);
    if (mcporter) return { ...mcporter, command };
    return { icon: RUNTIME_TERMINAL_ICON, action: '运行命令', command };
  }
  if (/^(?:read|read_file|readfile)$/u.test(normalized)) return readAction(argument('file_path', 'filePath', 'path') ?? '文件');
  if (/^(?:edit|edit_file|apply_patch|write|write_file)$/u.test(normalized)) {
    return { icon: 'edit_outlined', action: /^(?:write|write_file)$/u.test(normalized) ? '写入' : '编辑', subject: shortPath(argument('file_path', 'filePath', 'path') ?? '文件') };
  }
  if (tool.kind === 'file') {
    const match = /^(读取|编辑|新建|删除|写入)\s*(.*)$/u.exec(name);
    return { icon: match?.[1] === '读取' ? 'wiki-book_outlined' : 'edit_outlined', action: match?.[1] ?? '编辑', subject: short(match?.[2] || name || '文件', 90) };
  }
  if (tool.kind === 'search' || /^(?:grep|glob|search|web_search|websearch|search_query)$/u.test(normalized)) {
    const query = argument('query', 'pattern', 'q') ?? (tool.kind === 'search' ? name.replace(/^(?:联网搜索|搜索|查找)(?:结果|内容)?[：:\s]*/u, '') : undefined);
    return { icon: 'search_outlined', action: /web|联网/u.test(normalized) ? '搜索网页' : '搜索', subject: query ? short(query, 80) : '内容' };
  }
  if (/^(?:view_image|image_view|open_image)$/u.test(normalized)) return { icon: 'image_outlined', action: '查看图像', ...(argument('path', 'file_path') ? { preview: argument('path', 'file_path')! } : {}) };
  const integration = /^mcp__(.+?)__(.+)$/u.exec(name);
  if (integration) return { icon: 'plugin_outlined', action: '使用', subject: `${short(integration[1]!.replaceAll('_', ' '), 64)} 集成` };
  if (/^(?:exec|execute_code|run_code)$/u.test(normalized)) return { icon: 'code_outlined', action: '运行代码' };
  return { icon: 'setting-inter_outlined', action: '调用', subject: /^(?:工具调用|tool)$/u.test(name) ? '工具' : `${short(name.replaceAll('_', ' '), 80)} 工具` };
}

function readAction(path: string): ToolAction {
  const segments = path.replaceAll('\\', '/').split('/');
  return segments.at(-1) === 'SKILL.md' && segments.length > 1
    ? { icon: 'setting-inter_outlined', action: '读取', subject: `${short(segments.at(-2)!, 64)} 技能` }
    : { icon: 'wiki-book_outlined', action: '读取', subject: shortPath(path) };
}

function unwrapShell(command: string): string {
  const wrapper = /^(?:\S*\/)?(?:bash|zsh|sh)\s+-(?:lc|c)\s+([\s\S]+)$/u.exec(command);
  if (!wrapper) return command;
  const wrapped = shellWords(wrapper[1]!);
  return wrapped?.length === 1 ? wrapped[0]! : command;
}

function simpleReadPath(words: readonly string[]): string | undefined {
  const [program, ...args] = words;
  if (program === 'cat') {
    const paths = args[0] === '--' ? args.slice(1) : args;
    return paths.length === 1 && !paths[0]!.startsWith('-') ? paths[0] : undefined;
  }
  if (program === 'head' || program === 'tail') {
    let index = 0;
    if (args[index] === '-n' || args[index] === '--lines') index += 2;
    if (args[index] === '--') index += 1;
    return index === args.length - 1 && !args[index]!.startsWith('-') ? args[index] : undefined;
  }
  if (program === 'sed' && args.length === 3 && args[0] === '-n' && /^\d+(?:,\d+)?p$/u.test(args[1]!)) {
    return !args[2]!.startsWith('-') ? args[2] : undefined;
  }
  return undefined;
}

function mcporterAction(words: readonly string[]): ToolAction | undefined {
  if (words.length < 3 || !/(?:^|\/)mcporter$/u.test(words[0]!) || words[1] !== 'call') return undefined;
  const target = words[2]!;
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_.-]+$/u.test(target)) return undefined;
  if (target === 'exa.web_search_exa') {
    const query = words.slice(3).find(word => word.startsWith('query='))?.slice('query='.length).trim();
    return { icon: 'search_outlined', action: '搜索网页', subject: query ? short(query, 80) : '内容' };
  }
  return { icon: 'plugin_outlined', action: '使用', subject: `${short(target.split('.')[0]!, 64)} 集成` };
}

function isMutatingSearch(words: readonly string[]): boolean {
  return words[0] === 'find' && words.some(word => /^(?:-delete|-exec|-execdir|-ok|-okdir)$/u.test(word));
}

function shellWords(input: string): string[] | undefined {
  const words: string[] = [];
  let word = '';
  let active = false;
  let quote: "'" | '"' | undefined;
  const finish = (): void => {
    if (active) words.push(word);
    word = '';
    active = false;
  };
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index]!;
    if (quote) {
      if (character === quote) {
        quote = undefined;
        active = true;
      } else if (character === '\\' && quote === '"') {
        index += 1;
        if (index >= input.length) return undefined;
        word += input[index]!;
        active = true;
      } else {
        if (quote === '"' && (character === '`' || (character === '$' && /[({]/u.test(input[index + 1] ?? '')))) return undefined;
        word += character;
        active = true;
      }
      continue;
    }
    if (character === '\n' || character === '\r') return undefined;
    if (/\s/u.test(character)) {
      finish();
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      active = true;
      continue;
    }
    if (character === '\\') {
      index += 1;
      if (index >= input.length) return undefined;
      word += input[index]!;
      active = true;
      continue;
    }
    if (/[|;&<>`]/u.test(character) || (character === '$' && /[({]/u.test(input[index + 1] ?? ''))) return undefined;
    word += character;
    active = true;
  }
  if (quote) return undefined;
  finish();
  return words;
}

function shortPath(path: string): string {
  return short(path.replaceAll('\\', '/').split('/').at(-1) || path, 80);
}

function short(value: string, max: number): string {
  const text = value.replace(/\s+/gu, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function escapeInline(value: string): string {
  return value.replace(/[&<>*_`\[\]~]/gu, character => `&#${String(character.charCodeAt(0))};`);
}
