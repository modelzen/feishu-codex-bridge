import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  ensureLogFiles,
  resolveCliBinPath,
  serviceStderrPath,
  serviceStdoutPath,
  type ServiceStatus,
} from './common';

/**
 * Linux background service via a **systemd user unit**. Mirrors launchd: a
 * single user-level service whose body runs `feishu-codex-bridge run`, with
 * `Restart=always` (≈ launchd KeepAlive) and `WantedBy=default.target` for
 * login autostart. Modeled on the systemd adapter in feishu-claude-code-bridge.
 *
 * This is also the path WSL hits (WSL reports as `process.platform === 'linux'`).
 * WSL only has a user systemd manager when `[boot] systemd=true` is set in
 * `/etc/wsl.conf`; otherwise `systemctl --user` can't connect — we detect that
 * and raise a friendly error pointing at foreground `run`.
 */
export const SYSTEMD_UNIT_NAME = 'feishu-codex-bridge.service';

/** User unit path: `$XDG_CONFIG_HOME/systemd/user/` (defaults to ~/.config). */
function systemdUnitPath(): string {
  const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config');
  return join(base, 'systemd', 'user', SYSTEMD_UNIT_NAME);
}

/**
 * Build the unit. `Type=simple` (started the moment ExecStart fires, like
 * launchd/the WS handshake happens later); `Restart=always`+`RestartSec=5` for
 * crash-restart; `StandardOutput/Error=append:` into our shared log files so
 * `logs` works uniformly; PATH baked in so child tools (codex, lark-cli) resolve
 * under the minimal systemd environment.
 */
export function buildUnit(): string {
  const esc = (s: string): string => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const nodePath = process.execPath;
  const cliBinPath = resolveCliBinPath();
  const pathEnv = process.env.PATH ?? '';
  const codexBinEnv = process.env.CODEX_BIN ? `Environment="CODEX_BIN=${esc(process.env.CODEX_BIN)}"\n` : '';
  return `[Unit]
Description=feishu-codex-bridge bot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart="${esc(nodePath)}" "${esc(cliBinPath)}" run
Restart=always
RestartSec=5
StandardOutput=append:${serviceStdoutPath()}
StandardError=append:${serviceStderrPath()}
Environment="PATH=${esc(pathEnv)}"
${codexBinEnv}

[Install]
WantedBy=default.target
`;
}

interface SystemctlResult {
  ok: boolean;
  status: number | null;
  stdout: string;
  stderr: string;
}

function runSystemctl(args: string[]): SystemctlResult {
  const r = spawnSync('systemctl', ['--user', ...args], { encoding: 'utf8' });
  return {
    ok: r.status === 0,
    status: r.status,
    stdout: r.stdout ?? '',
    stderr: (r.error ? `${r.error.message}\n` : '') + (r.stderr ?? ''),
  };
}

function systemctlError(command: string, r: SystemctlResult): Error {
  const out = [r.stderr.trim(), r.stdout.trim()].filter(Boolean).join('\n');
  return new Error(`${command} 失败（exit ${r.status ?? 'unknown'}）${out ? `：${out}` : ''}`);
}

/**
 * Whether a user-level systemd manager is reachable. False when systemd isn't
 * PID 1 (WSL without `systemd=true`, containers, or non-systemd distros) or
 * `systemctl` isn't installed — in those cases the user-bus connection fails.
 */
export function systemdAvailable(): boolean {
  const r = spawnSync('systemctl', ['--user', 'is-system-running'], { encoding: 'utf8' });
  if (r.error) return false; // systemctl not installed
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  // "running"/"degraded"/"starting"/"offline" all mean systemd is present; only
  // these messages mean there's no user manager to talk to.
  return !/not been booted with systemd|Failed to connect to (the )?bus|Failed to (connect|get) D-?Bus/i.test(out);
}

function ensureSystemdOrThrow(): void {
  if (systemdAvailable()) return;
  throw new Error(
    '未检测到可用的用户级 systemd。' +
      'WSL 需在 /etc/wsl.conf 写入 `[boot]\\nsystemd=true` 后执行 `wsl --shutdown` 重启；' +
      '或直接用 `feishu-codex-bridge run` 前台运行（无需后台服务）。',
  );
}

export async function installSystemd(): Promise<ServiceStatus> {
  ensureSystemdOrThrow();
  const unitPath = systemdUnitPath();
  await mkdir(dirname(unitPath), { recursive: true });
  await ensureLogFiles();
  await writeFile(unitPath, buildUnit(), 'utf8');

  const reload = runSystemctl(['daemon-reload']);
  if (!reload.ok) throw systemctlError('systemctl --user daemon-reload', reload);

  // enable --now = autostart on login + start immediately (≈ launchd bootstrap).
  const enable = runSystemctl(['enable', '--now', SYSTEMD_UNIT_NAME]);
  if (!enable.ok) throw systemctlError('systemctl --user enable --now', enable);

  return statusSystemd();
}

export async function uninstallSystemd(): Promise<void> {
  if (systemdAvailable() && unitExists()) {
    // disable --now = stop + remove autostart (≈ launchd bootout).
    runSystemctl(['disable', '--now', SYSTEMD_UNIT_NAME]); // best-effort
  }
  await rm(systemdUnitPath(), { force: true });
  if (systemdAvailable()) runSystemctl(['daemon-reload']);
}

export async function restartSystemd(): Promise<ServiceStatus> {
  ensureSystemdOrThrow();
  if (!unitExists()) {
    throw new Error(`systemd unit 未安装：${systemdUnitPath()}（先运行 \`feishu-codex-bridge start\`）`);
  }
  const restart = runSystemctl(['restart', SYSTEMD_UNIT_NAME]);
  if (!restart.ok) throw systemctlError('systemctl --user restart', restart);
  return statusSystemd();
}

export function statusSystemd(): ServiceStatus {
  const installed = unitExists();
  const raw = installed && systemdAvailable() ? describeService() : '';
  return {
    platformName: 'systemd (Linux user)',
    installed,
    running: systemdActive(),
    servicePath: systemdUnitPath(),
    stdoutPath: serviceStdoutPath(),
    stderrPath: serviceStderrPath(),
    pid: raw.match(/Main PID:\s*(\d+)/)?.[1],
    // On an inactive unit the "Process: <pid> ExecStart=... status=<n>" line
    // carries the last exit code.
    lastExit: raw.match(/Process:\s+\d+\s+ExecStart=.*status=(\d+)/)?.[1],
    raw,
  };
}

export function unitExists(): boolean {
  return existsSync(systemdUnitPath());
}

/** Sync run-state check (used by the `daemonRunning` fast path). */
export function systemdActive(): boolean {
  const r = spawnSync('systemctl', ['--user', 'is-active', SYSTEMD_UNIT_NAME], {
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  return r.status === 0;
}

function describeService(): string {
  const r = runSystemctl(['status', SYSTEMD_UNIT_NAME, '--no-pager']);
  return r.stdout || r.stderr || '';
}
