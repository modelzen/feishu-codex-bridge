// Native fallback keeps cards independent of per-bot image uploads.
const RUNTIME_TERMINAL_ICON = 'computer_outlined';
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
    const command = tool.kind === 'command' ? name : argument('command', 'cmd');
    if (!command) return { icon: RUNTIME_TERMINAL_ICON, action: '运行命令' };
    const unwrapped = unwrapShell(command);
    // Only classify simple single operations. Pipelines and scripts stay commands.
    if (!/[|;&<>\n]/u.test(unwrapped)) {
      const read = /^(?:cat|head|tail)\s+(?:(?:-n|--lines)\s+\d+\s+)?(?:--\s+)?(?:"([^"]+)"|'([^']+)'|([^\s]+))$/u.exec(unwrapped);
      if (read && !(read[1] ?? read[2] ?? read[3]!).startsWith('-')) return { ...readAction(read[1] ?? read[2] ?? read[3]!), command };
      if (/^pwd\s*$/u.test(unwrapped)) return { icon: 'folder_outlined', action: '查看当前目录', command };
      if (/^ls(?:\s|$)/u.test(unwrapped)) return { icon: 'folder_outlined', action: '查看目录', command };
      if (/^(?:rg|grep|find)\s/u.test(unwrapped)) return { icon: 'search_outlined', action: '搜索文件', preview: unwrapped, command };
    }
    return { icon: RUNTIME_TERMINAL_ICON, action: '运行命令', preview: unwrapped, command };
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
  return /^(?:\S*\/)?(?:bash|zsh|sh)\s+-(?:lc|c)\s+(['"])([\s\S]*)\1$/u.exec(command)?.[2] ?? command;
}

function shortPath(path: string): string {
  return short(path.length <= 80 ? path : `…/${path.replaceAll('\\', '/').split('/').slice(-2).join('/')}`, 80);
}

function short(value: string, max: number): string {
  const text = value.replace(/\s+/gu, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function escapeInline(value: string): string {
  return value.replace(/[&<>*_`\[\]~]/gu, character => `&#${String(character.charCodeAt(0))};`);
}
