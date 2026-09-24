import { spawnSync } from 'node:child_process';
import { lstatSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { isDead } from '../config/data-access';

export const launchdLabel = 'ai.feishu-codex-bridge.bot';
export const systemdUnit = 'feishu-codex-bridge.service';
export const runKeyPath = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
export const runKeyName = 'feishu-codex-bridge';
export const relaunchTaskName = 'feishu-codex-bridge-relaunch';
export type InstallationState = { kind: 'absent' } | { kind: 'registered'; detail: string };

function exists(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false; throw error; }
}

function execute(command: string, args: string[]): string {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true, timeout: 5000 });
  if (result.error || result.status !== 0) throw new Error(`Cannot inspect or control ${command} (${result.status ?? 'unknown'}).`, { cause: result.error });
  return result.stdout;
}

export function installationPaths(home: string): { launchd: string; systemd: string } {
  return {
    launchd: join(home, 'Library', 'LaunchAgents', `${launchdLabel}.plist`),
    systemd: join(process.env.XDG_CONFIG_HOME || join(home, '.config'), 'systemd', 'user', systemdUnit),
  };
}

export function inspectInstallation(home: string): InstallationState {
  const paths = installationPaths(home);
  if (process.platform === 'darwin') {
    if (exists(paths.launchd)) return { kind: 'registered', detail: paths.launchd };
    const jobs = execute('launchctl', ['list']);
    return jobs.split('\n').some((line) => line.trim().endsWith(`\t${launchdLabel}`))
      ? { kind: 'registered', detail: launchdLabel } : { kind: 'absent' };
  }
  if (process.platform === 'linux') {
    if (exists(paths.systemd)) return { kind: 'registered', detail: paths.systemd };
    const units = execute('systemctl', ['--user', 'list-units', '--all', '--plain', '--no-legend', systemdUnit]);
    return units.includes(systemdUnit) ? { kind: 'registered', detail: systemdUnit } : { kind: 'absent' };
  }
  if (process.platform === 'win32') {
    const script = `$ErrorActionPreference='Stop'; $k='Registry::HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'; if (Test-Path $k) { $p=Get-ItemProperty -LiteralPath $k; if ($p.PSObject.Properties.Name -contains '${runKeyName}') { 'registered' } }`;
    const registration = execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
    const tasks = execute('schtasks', ['/query', '/fo', 'CSV', '/nh']);
    return registration.includes('registered') || tasks.includes(relaunchTaskName)
      ? { kind: 'registered', detail: `${runKeyName} startup or relaunch task` } : { kind: 'absent' };
  }
  throw new Error(`Offline service inspection is not supported on ${process.platform}.`);
}

export function existingDataRoots(home: string): string[] {
  const roots = [join(home, '.feishu-codex-bridge'), join(home, '.vonvon-bridge')].filter(exists);
  const unique = new Map<string, string>();
  for (const path of roots) unique.set(realpathSync(path), path);
  return [...unique.values()];
}

export function assertKnownOwnersStopped(home: string): void {
  for (const root of existingDataRoots(home)) {
    for (const name of ['update.lock', 'relaunch-request.json', 'relaunch-request.claim', 'win-relaunch.json']) {
      if (exists(join(root, name))) throw new Error(`Pending runtime operation ${join(root, name)}.`);
    }
    for (const name of readdirSync(root)) {
      if (/relaunch|update.*lock/i.test(name)) throw new Error(`Pending runtime operation ${join(root, name)}.`);
    }
    const dirs = [root];
    const bots = join(root, 'bots');
    if (exists(bots)) for (const bot of readdirSync(bots)) {
      const dir = join(bots, bot);
      if (!lstatSync(dir).isDirectory()) throw new Error(`Cannot inspect bot directory ${dir}.`);
      dirs.push(dir);
    }
    for (const dir of dirs) for (const name of ['processes.json', 'service.pid', 'web-console.json']) {
      const file = join(dir, name);
      if (!exists(file)) continue;
      const value: unknown = name === 'service.pid' ? { pid: Number(readFileSync(file, 'utf8').trim()) } : JSON.parse(readFileSync(file, 'utf8'));
      if (typeof value !== 'object' || value === null || !('pid' in value) || typeof value.pid !== 'number'
        || !Number.isSafeInteger(value.pid) || value.pid < 1) throw new Error(`Unknown runtime owner in ${file}.`);
      if (!isDead(value.pid)) throw new Error(`Bridge data is in use by process ${value.pid}.`);
    }
  }
  const inventory = process.platform === 'win32'
    ? execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference='Stop'; Get-CimInstance Win32_Process | ForEach-Object { '{0} {1}' -f $_.ProcessId,$_.CommandLine }"])
    : execute('ps', ['-axo', 'pid=,command=']);
  for (const line of inventory.split('\n')) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!match || Number(match[1]) === process.pid) continue;
    if (/(?:^|[\/\\\s"'])(?:feishu-codex-bridge|vonvon-bridge)(?:\.mjs)?(?:["']?\s)+(?:run|host|start|restart|stop|status|update|secrets|hook|bot|doctor|logs|web|__daemon-control|__win-relaunch)(?=\s|$)/.test(match[2] ?? '')) {
      throw new Error(`An older Bridge process may be using the data (${match[1]}).`);
    }
  }
}

export async function stopInstallation(home: string): Promise<void> {
  const paths = installationPaths(home);
  if (process.platform === 'darwin') {
    rmSync(paths.launchd, { force: true });
    const jobs = execute('launchctl', ['list']);
    if (jobs.split('\n').some((line) => line.trim().endsWith(`\t${launchdLabel}`))) {
      execute('launchctl', ['bootout', `gui/${process.getuid?.()}/${launchdLabel}`]);
    }
    return;
  }
  if (process.platform === 'linux') {
    if (inspectInstallation(home).kind === 'registered') execute('systemctl', ['--user', 'disable', '--now', systemdUnit]);
    rmSync(paths.systemd, { force: true });
    execute('systemctl', ['--user', 'daemon-reload']);
    return;
  }
  if (process.platform !== 'win32') throw new Error(`Service stop is not supported on ${process.platform}.`);
  execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference='Stop'; $k='Registry::HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'; if (Test-Path $k) { $p=Get-ItemProperty -LiteralPath $k; if ($p.PSObject.Properties.Name -contains '${runKeyName}') { Remove-ItemProperty -LiteralPath $k -Name '${runKeyName}' } }`]);
  for (const root of existingDataRoots(home)) {
    const file = join(root, 'service.pid');
    if (!exists(file)) continue;
    const pid = Number(readFileSync(file, 'utf8').trim());
    if (!Number.isSafeInteger(pid) || pid < 1) throw new Error(`Invalid service PID in ${file}.`);
    if (!isDead(pid)) {
      const command = execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference='Stop'; (Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`]);
      if (!/(?:feishu-codex-bridge|vonvon-bridge)(?:\.mjs)?["']?\s+run\b/.test(command)) throw new Error(`Cannot confirm service process identity ${pid}.`);
      execute('taskkill', ['/pid', String(pid), '/T', '/F']);
      for (let attempt = 0; attempt < 50 && !isDead(pid); attempt++) await new Promise((resolve) => setTimeout(resolve, 100));
      if (!isDead(pid)) throw new Error(`Service process ${pid} is still alive; PID evidence was retained.`);
    }
    if (readFileSync(file, 'utf8').trim() === String(pid)) rmSync(file);
  }
}
