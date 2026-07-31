import { appendFileSync, createReadStream, statSync } from 'node:fs';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { paths } from '../config/paths';
import { compatibilityCliBinPath } from '../core/runtime-context';

/**
 * Platform-agnostic snapshot of the background service, produced by whichever
 * OS service manager backs this platform (launchd on macOS, Task Scheduler on
 * Windows, systemd on Linux). Callers render these fields without knowing the
 * platform.
 */
export interface ServiceStatus {
  /** Human label of the service manager, e.g. `"launchd (macOS)"`. */
  platformName: string;
  /** The service definition (plist / task / unit) is registered with the OS. */
  installed: boolean;
  /** The service process is currently alive. */
  running: boolean;
  /** Path or name of the service definition (plist path / task name / unit path). */
  servicePath: string;
  stdoutPath: string;
  stderrPath: string;
  pid?: string;
  lastExit?: string;
  /** Raw status output from the underlying tool, for diagnostics. */
  raw: string;
}

/** Service log files live under the app dir, identical across platforms. */
export function serviceStdoutPath(): string {
  return join(paths.appDir, 'service.log');
}

export function serviceStderrPath(): string {
  return join(paths.appDir, 'service.err.log');
}

/** Touch both log files so the service (and `logs` tail) always have a target. */
export async function ensureLogFiles(): Promise<void> {
  await mkdir(paths.appDir, { recursive: true });
  await appendFile(serviceStdoutPath(), '');
  await appendFile(serviceStderrPath(), '');
}

/**
 * Append a timestamped diagnostic line to service.err.log (sync, best-effort,
 * never throws). The update/restart flow and the Windows tree-free relauncher
 * both write here so the built-in `logs` command surfaces "what happened" — the
 * relauncher runs detached with no console, and these events otherwise only land
 * in the daily JSON log, which users don't think to check. Sync because callers
 * include a short-lived relauncher that may exit before an async write flushes.
 */
export function appendServiceErr(tag: string, line: string, filePath: string = serviceStderrPath()): void {
  try {
    appendFileSync(filePath, `[${new Date().toISOString()}] [${tag}] ${line}\n`);
  } catch {
    /* best-effort — diagnostics must never crash the caller */
  }
}

/**
 * Absolute path to the installed bin entry. After bundling, this module lives at
 * `<pkg>/dist/...`, so the bin is `<pkg>/bin/feishu-codex-bridge.mjs` — the same
 * layout in a global npm install and a local checkout. Used by the Windows/Linux
 * service definitions, which need an absolute ExecStart.
 */
export function resolveCliBinPath(): string {
  return compatibilityCliBinPath();
}

/**
 * Tail the service logs in pure Node (no `tail` binary — Windows lacks it, and
 * systemd's append files are plain files). Prints the last ~100 lines of each
 * file, then (when `follow`) polls for appended bytes until interrupted (Ctrl+C).
 * launchd keeps its own `tail`-based path; this serves Windows + Linux.
 */
export async function tailServiceLogs(follow: boolean): Promise<void> {
  await ensureLogFiles();
  const files = [serviceStdoutPath(), serviceStderrPath()];

  for (const f of files) {
    const tail = await lastLines(f, 100);
    if (tail) process.stdout.write(`\n===== ${f} =====\n${tail}\n`);
  }
  if (!follow) return;

  const offsets = new Map<string, number>(files.map((f) => [f, fileSize(f)]));
  await new Promise<void>((resolvePromise) => {
    const onSigint = (): void => {
      clearInterval(timer);
      process.off('SIGINT', onSigint);
      resolvePromise();
    };
    process.on('SIGINT', onSigint);
    const timer = setInterval(() => {
      for (const f of files) {
        const size = fileSize(f);
        const from = offsets.get(f) ?? 0;
        if (size > from) {
          offsets.set(f, size);
          createReadStream(f, { start: from, end: size - 1, encoding: 'utf8' }).pipe(process.stdout, {
            end: false,
          });
        } else if (size < from) {
          offsets.set(f, size); // truncated/rotated — reset
        }
      }
    }, 700);
  });
}

function fileSize(file: string): number {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}

async function lastLines(file: string, n: number): Promise<string> {
  try {
    const text = await readFile(file, 'utf8');
    return text
      .split('\n')
      .slice(-n - 1)
      .join('\n')
      .trimEnd();
  } catch {
    return '';
  }
}
