import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { spawnProcess } from '../../platform/spawn';
import { WindowsCodexJob } from './windows-job';

export class CodexProcessCleanupError extends Error {}

type Exit = { kind: 'exit'; code: number | null; signal: NodeJS.Signals | null } | { kind: 'error'; error: Error };
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
const missing = (error: unknown): boolean => error instanceof Error && 'code' in error && error.code === 'ESRCH';

export class OwnedCodexProcess {
  readonly child: ChildProcess;
  private readonly windowsJob = process.platform === 'win32' ? new WindowsCodexJob() : undefined;
  readonly exited: Promise<Exit>;
  private readonly closed: Promise<void>;
  private closing: Promise<void> | undefined;

  constructor(command: string, args: string[], options: SpawnOptions) {
    this.child = this.windowsJob
      ? spawnProcess(this.windowsJob.executable, this.windowsJob.launch(command, args), options)
      : spawnProcess(command, args, { ...options, detached: true });
    this.closed = new Promise(resolve => this.child.once('close', () => resolve()));
    this.exited = new Promise(resolve => {
      this.child.once('exit', (code, signal) => resolve({ kind: 'exit', code, signal }));
      this.child.once('error', error => resolve({ kind: 'error', error }));
    });
  }

  close(graceMs = 4000): Promise<void> {
    this.closing ??= this.stop(graceMs).catch(error => {
      throw new CodexProcessCleanupError('无法确认 Codex 子进程树已退出', { cause: error });
    });
    return this.closing;
  }

  private async stop(graceMs: number): Promise<void> {
    const child = this.child;
    const pid = child.pid;
    if (pid === undefined) { this.windowsJob?.dispose(); return; }
    if (this.windowsJob) {
      const job = this.windowsJob;
      job.requestStop();
      await this.waitForDirectExit(6500);
      if (!job.verifiedEmpty) throw new Error('Windows job termination could not be verified');
      job.dispose();
    } else {
      const signalGroup = (signal: NodeJS.Signals | 0): boolean => {
        try { process.kill(-pid, signal); return true; }
        catch (error) {
          if (missing(error)) return false;
          if (signal === 0 && error instanceof Error && 'code' in error && error.code === 'EPERM') return true;
          throw error;
        }
      };
      const waitForGroup = async (ms: number): Promise<boolean> => {
        const deadline = Date.now() + ms;
        while (signalGroup(0)) {
          if (Date.now() >= deadline) return false;
          await sleep(25);
        }
        return true;
      };
      if (signalGroup('SIGTERM') && !await waitForGroup(Math.min(Math.max(0, graceMs), 4000))) {
        signalGroup('SIGKILL');
        if (!await waitForGroup(2000)) throw new Error(`Codex process group ${pid} still exists`);
      }
      await this.waitForDirectExit(100);
    }
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([this.closed, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Codex child pipes did not close')), 500);
      })]);
    } finally { clearTimeout(timer); }
  }

  private async waitForDirectExit(ms: number): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([this.exited, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Codex child exit could not be confirmed')), ms);
      })]);
    } finally { clearTimeout(timer); }
  }
}
