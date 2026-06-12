import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { CliBridgeAgent, CliHookStatus } from './types';

export interface InstallCliBridgeHooksOptions {
  homeDir?: string;
  command: string;
  agents: { claude: boolean; codex: boolean };
}

export interface InspectCliBridgeHooksOptions {
  homeDir?: string;
}

type HookCommand = { type?: string; command?: string; timeout?: number };
type HookGroup = { matcher?: string; hooks?: HookCommand[] };
type HookRoot = { hooks?: Record<string, HookGroup[]>; [key: string]: unknown };

const AGENT2LARK_MARKER = 'agent2lark-hook';
const CODEX_EVENTS = ['PermissionRequest', 'Stop'] as const;
const CLAUDE_EVENTS = ['PermissionRequest', 'Stop'] as const;

/** The shell command Claude/Codex runs for each hook. Uses the absolute node
 *  binary + this CLI's own entry script rather than a bare `feishu-codex-bridge`,
 *  so the hook resolves even when the bin isn't on PATH (npx / local installs).
 *  installAgentGroups appends ` --agent <agent>`. */
export function resolveBridgeHookCommand(botAppId?: string): string {
  const script = process.argv[1];
  if (process.platform === 'win32') {
    // Windows: Claude/Codex run the hook via `cmd.exe /c` (confirmed in their
    // binaries), so quote for cmd + the Node CRT. Best-effort, pending end-to-end
    // verification on a real Windows host. The macOS/Linux branch below is left
    // exactly as-is so existing behavior is untouched.
    const winBase = script
      ? `${win32Quote(process.execPath)} ${win32Quote(resolve(script))} hook`
      : 'feishu-codex-bridge hook';
    return botAppId ? `${winBase} --bot ${win32Quote(botAppId)}` : winBase;
  }
  const base = script
    ? `"${process.execPath}" "${resolve(script)}" hook`
    : 'feishu-codex-bridge hook'; // REPL / unusual launch — best effort
  return botAppId ? `${base} --bot ${shellQuote(botAppId)}` : base;
}

export async function inspectCliBridgeHooks(opts: InspectCliBridgeHooksOptions = {}): Promise<{
  claude: CliHookStatus;
  codex: CliHookStatus;
}> {
  const home = resolveHome(opts.homeDir);
  const claude = await readJson(join(home, '.claude', 'settings.json'));
  const codex = await readJson(join(home, '.codex', 'hooks.json'));
  let codexStatus = inspectAgent('codex', codex, [...CODEX_EVENTS]);
  // hooks.json alone is not enough for Codex: without `[features] hooks = true`
  // in config.toml the agent silently ignores every hook. Don't show a green
  // 'installed' while the feature gate is off — downgrade so the card prompts a
  // repair (which re-writes the flag).
  if (codexStatus.status === 'installed') {
    const toml = await readFile(join(home, '.codex', 'config.toml'), 'utf8').catch(() => '');
    if (!hasCodexHooksFeature(toml)) {
      codexStatus = {
        agent: 'codex',
        status: 'needs_repair',
        details: [...codexStatus.details, 'config.toml [features] hooks=true missing'],
      };
    }
  }
  return {
    claude: inspectAgent('claude', claude, [...CLAUDE_EVENTS]),
    codex: codexStatus,
  };
}

export async function installCliBridgeHooks(opts: InstallCliBridgeHooksOptions): Promise<void> {
  const home = resolveHome(opts.homeDir);
  if (opts.agents.claude) {
    const file = join(home, '.claude', 'settings.json');
    const json = await readJson(file);
    json.hooks = installAgentGroups(json.hooks, 'claude', [...CLAUDE_EVENTS], opts.command);
    await writeJson(file, json);
  }
  if (opts.agents.codex) {
    const file = join(home, '.codex', 'hooks.json');
    const json = await readJson(file);
    json.hooks = installAgentGroups(json.hooks, 'codex', [...CODEX_EVENTS], opts.command);
    await writeJson(file, json);

    const tomlPath = join(home, '.codex', 'config.toml');
    const existing = await readFile(tomlPath, 'utf8').catch(() => '');
    await mkdir(join(home, '.codex'), { recursive: true });
    await writeFile(tomlPath, withCodexHooksFeature(existing), 'utf8');
  }
}

export async function uninstallCliBridgeHooks(opts: InspectCliBridgeHooksOptions = {}): Promise<void> {
  const home = resolveHome(opts.homeDir);
  await removeBridgeGroups(join(home, '.claude', 'settings.json'));
  await removeBridgeGroups(join(home, '.codex', 'hooks.json'));
  // installCliBridgeHooks flips `[features] hooks = true` in config.toml; clear it on
  // uninstall so the gate isn't left enabled with no bridge hooks behind it. Only
  // touch the file if it exists and actually changes.
  const tomlPath = join(home, '.codex', 'config.toml');
  const existing = await readFile(tomlPath, 'utf8').catch(() => undefined);
  if (existing !== undefined) {
    const next = withoutCodexHooksFeature(existing);
    if (next !== existing) await writeFile(tomlPath, next, 'utf8');
  }
}

function resolveHome(homeDir?: string): string {
  // os.homedir() resolves USERPROFILE on Windows / getpwuid on Unix — the repo's
  // convention (see config/paths.ts). The old process.env.HOME fallback is unset
  // on Windows, which silently wrote ~/.claude and ~/.codex under cwd.
  return homeDir ?? homedir();
}

async function readJson(path: string): Promise<HookRoot> {
  const text = await readFile(path, 'utf8').catch(() => '{}');
  const parsed = JSON.parse(text || '{}') as HookRoot;
  return typeof parsed === 'object' && parsed ? parsed : {};
}

async function writeJson(path: string, value: HookRoot): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function inspectAgent(agent: CliBridgeAgent, root: HookRoot, events: string[]): CliHookStatus {
  const hooks = root.hooks ?? {};
  const commands = Object.values(hooks).flatMap((groups) =>
    groups.flatMap((group) => group.hooks ?? []).map((hook) => hook.command ?? ''),
  );
  if (commands.some((command) => command.includes(AGENT2LARK_MARKER))) {
    return { agent, status: 'conflict_agent2lark', details: ['agent2lark hook command found'] };
  }
  const installedEvents = events.filter((event) =>
    (hooks[event] ?? []).some((group) =>
      (group.hooks ?? []).some((hook) => isBridgeAgentCommand(hook.command, agent)),
    ),
  );
  if (installedEvents.length === events.length) {
    return { agent, status: 'installed', details: installedEvents };
  }
  if (installedEvents.length > 0 || commands.some((command) => isBridgeCommand(command))) {
    return { agent, status: 'needs_repair', details: installedEvents };
  }
  return { agent, status: 'not_installed', details: [] };
}

function installAgentGroups(
  hooks: Record<string, HookGroup[]> | undefined,
  agent: CliBridgeAgent,
  events: string[],
  command: string,
): Record<string, HookGroup[]> {
  const next = removeHookGroups(hooks ?? {}, (hook) => isBridgeCommand(hook.command) || isAgent2larkCommand(hook.command));
  for (const event of events) {
    const groups = next[event] ?? [];
    next[event] = [
      ...groups,
      {
        matcher: '*',
        // timeout 必须 ≥ IPC 等待上限（24h）——否则 CLI 会在人到飞书点批准前先杀掉 hook。
        // agent2lark 在每个 Claude/Codex hook 上都写了 86400(见 installer.ts)。
        hooks: [{ type: 'command', command: `${command} --agent ${agent}`, timeout: 86400 }],
      },
    ];
  }
  return next;
}

function removeHookGroups(
  hooks: Record<string, HookGroup[]>,
  shouldRemove: (hook: HookCommand) => boolean,
): Record<string, HookGroup[]> {
  const next: Record<string, HookGroup[]> = {};
  for (const [event, groups] of Object.entries(hooks)) {
    const kept = groups.flatMap((group) => {
      if (!group.hooks) return [group];
      const keptHooks = group.hooks.filter((hook) => !shouldRemove(hook));
      return keptHooks.length > 0 ? [{ ...group, hooks: keptHooks }] : [];
    });
    if (kept.length > 0) next[event] = kept;
  }
  return next;
}

async function removeBridgeGroups(path: string): Promise<void> {
  const json = await readJson(path);
  if (!json.hooks) return;
  json.hooks = removeHookGroups(json.hooks, (hook) => isBridgeCommand(hook.command));
  await writeJson(path, json);
}

function isBridgeAgentCommand(command: string | undefined, agent: CliBridgeAgent): boolean {
  return isBridgeCommand(command) && (command ?? '').includes(`--agent ${agent}`);
}

function isBridgeCommand(command: string | undefined): boolean {
  const raw = command ?? '';
  return raw.includes(' hook') && raw.includes('--agent') && !raw.includes(AGENT2LARK_MARKER);
}

function isAgent2larkCommand(command: string | undefined): boolean {
  return Boolean(command?.includes(AGENT2LARK_MARKER));
}

function shellQuote(value: string): string {
  return `"${value.replace(/(["\\$`])/g, '\\$1')}"`;
}

/** Quote an argument for a hook command run via cmd.exe on Windows: wrap in
 *  double quotes and escape embedded quotes. Bot appIds / node + script paths
 *  here carry no cmd metacharacters, so this is belt-and-suspenders. */
function win32Quote(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

/** Read-only check for `[features] hooks = true` in config.toml. Mirrors the
 *  section scan in withCodexHooksFeature (table-header form only). */
function hasCodexHooksFeature(text: string): boolean {
  let inFeatures = false;
  for (const raw of text.split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (/^\[features\]$/.test(trimmed)) { inFeatures = true; continue; }
    if (inFeatures && /^\[.+\]$/.test(trimmed)) { inFeatures = false; continue; }
    if (inFeatures && /^hooks\s*=\s*true\b/.test(trimmed)) return true;
  }
  return false;
}

function withCodexHooksFeature(text: string): string {
  const lines = text.split(/\r?\n/).filter((line, index, array) => index < array.length - 1 || line.length > 0);
  let featuresIndex = -1;
  let nextSectionIndex = lines.length;
  let codexHooksIndex = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = (lines[index] ?? '').trim();
    if (/^\[features\]$/.test(trimmed)) {
      featuresIndex = index;
      nextSectionIndex = lines.length;
      continue;
    }
    if (featuresIndex >= 0 && index > featuresIndex && /^\[.+\]$/.test(trimmed)) {
      nextSectionIndex = Math.min(nextSectionIndex, index);
    }
    if (featuresIndex >= 0 && index > featuresIndex && index < nextSectionIndex && /^hooks\s*=/.test(trimmed)) {
      codexHooksIndex = index;
    }
  }

  if (featuresIndex < 0) {
    const prefix = lines.length > 0 ? [...lines, ''] : [];
    return [...prefix, '[features]', 'hooks = true', ''].join('\n');
  }
  if (codexHooksIndex >= 0) {
    lines[codexHooksIndex] = 'hooks = true';
    return [...lines, ''].join('\n');
  }
  lines.splice(featuresIndex + 1, 0, 'hooks = true');
  return [...lines, ''].join('\n');
}

/** Inverse of {@link withCodexHooksFeature}: drop any `hooks = …` line inside
 *  [features], and the [features] header too if that empties the section. All
 *  other sections/keys are left untouched. */
function withoutCodexHooksFeature(text: string): string {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  let featuresHeader = -1; // index in `out` of the open [features] header, else -1
  let featuresHasKeys = false;
  const closeFeatures = (): void => {
    if (featuresHeader >= 0 && !featuresHasKeys) out.splice(featuresHeader, 1);
    featuresHeader = -1;
    featuresHasKeys = false;
  };
  for (const raw of lines) {
    const trimmed = raw.trim();
    if (/^\[features\]$/.test(trimmed)) {
      closeFeatures();
      featuresHeader = out.length;
      out.push(raw);
      continue;
    }
    if (featuresHeader >= 0 && /^\[.+\]$/.test(trimmed)) {
      closeFeatures();
      out.push(raw);
      continue;
    }
    if (featuresHeader >= 0 && /^hooks\s*=/.test(trimmed)) continue; // drop the flag
    if (featuresHeader >= 0 && trimmed && !trimmed.startsWith('#')) featuresHasKeys = true;
    out.push(raw);
  }
  closeFeatures();
  return out.join('\n');
}
