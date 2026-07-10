import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ensureLogFiles,
  serviceStderrPath,
  serviceStdoutPath,
  type ServiceStatus,
} from './common';

export const LAUNCHD_LABEL = 'ai.feishu-codex-bridge.bot';

interface LaunchctlResult {
  ok: boolean;
  status: number | null;
  stdout: string;
  stderr: string;
}

export function launchAgentPlistPath(): string {
  return join(homedir(), 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
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
    <string>run</string>
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
${process.env.CODEX_BIN ? `    <key>CODEX_BIN</key>
    <string>${escapeXml(process.env.CODEX_BIN)}</string>
` : ''}  </dict>
</dict>
</plist>
`;
}

export async function installLaunchd(): Promise<ServiceStatus> {
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
  // Remove the plist FIRST, bootout LAST. When this runs from the detached `stop`
  // helper, the helper is itself a member of the launchd job (detached/setsid does
  // NOT escape launchd job membership), so the `bootout` below tears down the whole
  // job tree and frequently kills this helper — and even the `launchctl` child —
  // before it returns. If the plist were removed only AFTER bootout (the old order),
  // that rm got skipped on every such race → the plist lingered in
  // ~/Library/LaunchAgents and launchd auto-bootstrapped the daemon again at the
  // next login ("停止" not sticking). bootout's teardown is committed server-side by
  // launchd the moment it receives the request, so it still kills the daemon even if
  // the helper dies mid-call; only the post-bootout steps are at risk — so nothing
  // load-bearing may follow it. Same self-kill hazard restartLaunchd dodges via
  // `kickstart -k`. (Run from a terminal the helper isn't in the job, so order is
  // immaterial there — this only ever helps the in-job case.)
  await rm(launchAgentPlistPath(), { force: true });
  if (isLoaded()) {
    const bootout = runLaunchctl(['bootout', serviceTarget()]);
    if (!bootout.ok) throw launchctlError('launchctl bootout', bootout);
    await waitUntilUnloaded();
  }
}

export async function restartLaunchd(): Promise<ServiceStatus> {
  if (!existsSync(launchAgentPlistPath())) {
    throw new Error(`launchd service 未安装：${launchAgentPlistPath()}`);
  }

  if (isLoaded()) {
    // kickstart -k 让 launchd 自己「杀掉旧实例 → 起新实例」。指令一旦投递给
    // launchd 就与本进程脱钩，所以即便本进程**就是**被重启的 daemon（一键更新的
    // 卡片回调正是跑在 daemon 里），被 SIGTERM 杀掉后 launchd 仍会拉起新实例。
    // 绝不能用 bootout+bootstrap：bootout 先把本进程杀了，后面的 bootstrap 永远
    // 执行不到 → 服务被移出 domain（KeepAlive 也随之失效）→ 永久卸载、无进程、
    // 更新卡片永远停在「正在重启」。
    const kick = runLaunchctl(['kickstart', '-k', serviceTarget()]);
    if (!kick.ok) throw launchctlError('launchctl kickstart', kick);
    return statusLaunchd();
  }

  // 服务已安装但未加载（plist 在、domain 里却没有，例如上一版自杀式重启留下的
  // 烂摊子）：bootstrap 直接拉起。
  const bootstrap = runLaunchctl(['bootstrap', userTarget(), launchAgentPlistPath()]);
  if (!bootstrap.ok) throw launchctlError('launchctl bootstrap', bootstrap);
  return statusLaunchd();
}

export function statusLaunchd(): ServiceStatus {
  const result = runLaunchctl(['print', serviceTarget()]);
  const raw = result.stdout || result.stderr;
  const parsed = parseLaunchdStatus(raw);

  return {
    platformName: 'launchd (macOS)',
    installed: existsSync(launchAgentPlistPath()),
    running: result.ok,
    servicePath: launchAgentPlistPath(),
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

export function isLoaded(): boolean {
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
