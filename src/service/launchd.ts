import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { paths } from '../config/paths';

export const LAUNCHD_LABEL = 'ai.feishu-codex-bridge.bot';

export interface LaunchdStatus {
  installed: boolean;
  loaded: boolean;
  plistPath: string;
  stdoutPath: string;
  stderrPath: string;
  pid?: string;
  lastExit?: string;
  raw: string;
}

interface LaunchctlResult {
  ok: boolean;
  status: number | null;
  stdout: string;
  stderr: string;
}

export function launchAgentPlistPath(): string {
  return join(homedir(), 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
}

export function serviceStdoutPath(): string {
  return join(paths.appDir, 'service.log');
}

export function serviceStderrPath(): string {
  return join(paths.appDir, 'service.err.log');
}

function resolveCliBinPath(): string {
  const distDir = dirname(fileURLToPath(import.meta.url));
  return resolve(distDir, '..', 'bin', 'feishu-codex-bridge.mjs');
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function buildPlist(): string {
  const nodePath = process.execPath;
  const cliBinPath = resolveCliBinPath();
  const pathEnv = process.env.PATH ?? '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin';

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(nodePath)}</string>
    <string>${escapeXml(cliBinPath)}</string>
    <string>start</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapeXml(serviceStdoutPath())}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(serviceStderrPath())}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${escapeXml(pathEnv)}</string>
  </dict>
</dict>
</plist>
`;
}

export async function installLaunchd(): Promise<LaunchdStatus> {
  const plistPath = launchAgentPlistPath();
  await mkdir(dirname(plistPath), { recursive: true });
  await ensureLogFiles();
  await writeFile(plistPath, buildPlist(), 'utf8');

  if (isLoaded()) {
    const bootout = runLaunchctl(['bootout', serviceTarget()]);
    if (!bootout.ok) throw launchctlError('launchctl bootout', bootout);
    await waitUntilUnloaded();
  }

  // Use bootstrap instead of deprecated load -w; RunAtLoad/KeepAlive in the
  // plist provide login autostart and crash restart behavior.
  const bootstrap = runLaunchctl(['bootstrap', userTarget(), plistPath]);
  if (!bootstrap.ok) throw launchctlError('launchctl bootstrap', bootstrap);

  return statusLaunchd();
}

export async function uninstallLaunchd(): Promise<void> {
  if (isLoaded()) {
    const bootout = runLaunchctl(['bootout', serviceTarget()]);
    if (!bootout.ok) throw launchctlError('launchctl bootout', bootout);
    await waitUntilUnloaded();
  }
  await rm(launchAgentPlistPath(), { force: true });
}

export async function restartLaunchd(): Promise<LaunchdStatus> {
  if (!existsSync(launchAgentPlistPath())) {
    throw new Error(`launchd service 未安装：${launchAgentPlistPath()}`);
  }

  if (isLoaded()) {
    const bootout = runLaunchctl(['bootout', serviceTarget()]);
    if (!bootout.ok) throw launchctlError('launchctl bootout', bootout);
    await waitUntilUnloaded();
  }

  const bootstrap = runLaunchctl(['bootstrap', userTarget(), launchAgentPlistPath()]);
  if (!bootstrap.ok) throw launchctlError('launchctl bootstrap', bootstrap);
  return statusLaunchd();
}

export function statusLaunchd(): LaunchdStatus {
  const result = runLaunchctl(['print', serviceTarget()]);
  const raw = result.stdout || result.stderr;
  const parsed = parseLaunchdStatus(raw);

  return {
    installed: existsSync(launchAgentPlistPath()),
    loaded: result.ok,
    plistPath: launchAgentPlistPath(),
    stdoutPath: serviceStdoutPath(),
    stderrPath: serviceStderrPath(),
    pid: parsed.pid,
    lastExit: parsed.lastExit,
    raw,
  };
}

export async function tailLaunchdLogs(follow: boolean): Promise<void> {
  await ensureLogFiles();
  const args = follow
    ? ['-f', serviceStdoutPath(), serviceStderrPath()]
    : ['-n', '100', serviceStdoutPath(), serviceStderrPath()];

  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn('tail', args, { stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0 || (follow && code === null)) {
        resolvePromise();
        return;
      }
      reject(new Error(`tail 退出码 ${code ?? 'unknown'}`));
    });
  });
}

function parseLaunchdStatus(text: string): { pid?: string; lastExit?: string } {
  return {
    pid: text.match(/\bpid\s*=\s*(\d+)/)?.[1],
    lastExit: text.match(/last exit code\s*=\s*(-?\d+)/i)?.[1],
  };
}

function isLoaded(): boolean {
  const result = spawnSync('launchctl', ['print', serviceTarget()], {
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  return result.status === 0;
}

async function waitUntilUnloaded(timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isLoaded()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
  }
  throw new Error(`launchd service 未在 ${timeoutMs}ms 内卸载完成`);
}

async function ensureLogFiles(): Promise<void> {
  await mkdir(paths.appDir, { recursive: true });
  await appendFile(serviceStdoutPath(), '');
  await appendFile(serviceStderrPath(), '');
}

function userTarget(): string {
  return `gui/${userInfo().uid}`;
}

function serviceTarget(): string {
  return `${userTarget()}/${LAUNCHD_LABEL}`;
}

function runLaunchctl(args: string[]): LaunchctlResult {
  const result = spawnSync('launchctl', args, { encoding: 'utf8' });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function launchctlError(command: string, result: LaunchctlResult): Error {
  const output = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join('\n');
  return new Error(`${command} 失败（exit ${result.status ?? 'unknown'}）${output ? `：${output}` : ''}`);
}
