import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type ManagedTool = 'codex' | 'claude' | 'lark-cli';
export type ManagedToolSelection =
  | { kind: 'absent' | 'disabled' | 'invalid' }
  | { kind: 'active'; executable: string; version: string };

const executableNames: Record<ManagedTool, string> = { codex: 'codex', claude: 'claude', 'lark-cli': 'lark-cli' };
const generationPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function managedToolExecutable(prefix: string, tool: ManagedTool, platform = process.platform): string {
  const name = executableNames[tool];
  return platform === 'win32' ? join(prefix, `${name}.cmd`) : join(prefix, 'bin', name);
}

export function managedToolSelection(dataRoot: string, tool: ManagedTool, platform = process.platform): ManagedToolSelection {
  const directory = join(dataRoot, 'managed-tools', tool);
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(join(directory, 'current.json'), 'utf8'));
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'ENOENT' ? { kind: 'absent' } : { kind: 'invalid' };
  }
  if (typeof value !== 'object' || value === null || !('schemaVersion' in value) || value.schemaVersion !== 1 || !('tool' in value) || value.tool !== tool || !('state' in value)) return { kind: 'invalid' };
  if (value.state === 'disabled') return { kind: 'disabled' };
  if (value.state !== 'active' || !('generation' in value) || typeof value.generation !== 'string' || !generationPattern.test(value.generation) || !('version' in value) || typeof value.version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(value.version)) return { kind: 'invalid' };
  const executable = managedToolExecutable(join(directory, 'releases', value.generation), tool, platform);
  return existsSync(executable) ? { kind: 'active', executable, version: value.version } : { kind: 'invalid' };
}
