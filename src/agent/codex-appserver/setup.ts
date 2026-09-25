import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { AppServerClient } from './app-server-client';
import { resolveCodexBin } from './locate';
import { installManagedCodex, runSetupChild } from './managed-install';
import { CodexProcessCleanupError } from './owned-process';

export interface CodexSetup {
  installation: 'missing' | 'installed' | 'unknown';
  authentication: 'signedOut' | 'signedIn' | 'notRequired' | 'unknown';
  version: string | null;
  executable: string | null;
  message?: string;
}
export type CodexJobType = 'install' | 'login';
export type CodexJob = { id: string; type: CodexJobType } & (
  | { state: 'running' | 'succeeded' | 'failed' | 'cancelled'; message?: string }
  | { state: 'authorizing'; userCode: string; verificationUrl: string; message?: string }
);
interface JobEntry { snapshot: CodexJob; abort: AbortController; done: Promise<void> }
export class CodexSetupConflict extends Error {}
class SetupDisplayError extends Error {}

function accountState(raw: unknown): 'signedOut' | 'signedIn' | 'notRequired' {
  if (!raw || typeof raw !== 'object' || !('requiresOpenaiAuth' in raw) || typeof raw.requiresOpenaiAuth !== 'boolean' || !('account' in raw)) throw new SetupDisplayError('Codex 账户状态响应无效');
  if (!raw.requiresOpenaiAuth) return 'notRequired';
  if (raw.account === null) return 'signedOut';
  if (typeof raw.account === 'object' && raw.account && 'type' in raw.account && (raw.account.type === 'chatgpt' || raw.account.type === 'apiKey')) return 'signedIn';
  throw new SetupDisplayError('Codex 账户状态响应无效');
}
function deviceLogin(raw: unknown): { loginId: string; userCode: string; verificationUrl: string } {
  if (!raw || typeof raw !== 'object' || !('type' in raw) || raw.type !== 'chatgptDeviceCode' || !('loginId' in raw) || typeof raw.loginId !== 'string' || !raw.loginId || !('userCode' in raw) || typeof raw.userCode !== 'string' || !raw.userCode || raw.userCode.length > 100 || !('verificationUrl' in raw) || typeof raw.verificationUrl !== 'string') throw new SetupDisplayError('当前 Codex 不支持设备码登录，请检查所选可执行文件');
  const url = new URL(raw.verificationUrl);
  if (url.protocol !== 'https:' || url.hostname !== 'auth.openai.com' || url.username || url.password || url.port) throw new SetupDisplayError('Codex 返回的登录地址不受信任');
  return { loginId: raw.loginId, userCode: raw.userCode, verificationUrl: url.href };
}

export class CodexSetupService {
  private readonly jobs = new Map<string, JobEntry>();
  private active: JobEntry | undefined;
  private readonly cleanupFailures = new Map<string, CodexProcessCleanupError>();
  private closed = false;
  private probe: { abort: AbortController; done: Promise<CodexSetup> } | undefined;
  private closing: Promise<void> | undefined;

  constructor(private readonly options: { install?: (signal: AbortSignal) => Promise<void>; retain?: number } = {}) {}

  setup(): Promise<CodexSetup> {
    if (this.closed) throw new CodexSetupConflict('Host 正在退出');
    if (this.cleanupFailures.size) throw new CodexSetupConflict('此前 Codex 子进程清理未确认，请先退出并检查');
    if (this.probe) return this.probe.done;
    const abort = new AbortController();
    const done = this.readSetup(abort.signal).catch(error => {
      if (error instanceof CodexProcessCleanupError) this.cleanupFailures.set('probe', error);
      throw error;
    }).finally(() => { this.probe = undefined; });
    this.probe = { abort, done };
    return done;
  }

  private client(bin: string): AppServerClient {
    return new AppServerClient({ bin, cwd: homedir(), clientName: 'vonvon-codex-setup', quietOutput: true, initializeTimeoutMs: 10_000 });
  }

  private async readSetup(signal: AbortSignal): Promise<CodexSetup> {
    const bin = resolveCodexBin({ force: true });
    if (!bin) return { installation: process.env.CODEX_BIN ? 'unknown' : 'missing', authentication: 'unknown', version: null, executable: null, message: process.env.CODEX_BIN ? `CODEX_BIN 指向不可用的文件：${process.env.CODEX_BIN}` : '尚未安装 Codex' };
    let version: string | null = null;
    const client = this.client(bin);
    const stop = (): void => { void client.close().catch(() => undefined); };
    signal.addEventListener('abort', stop, { once: true });
    try {
      version = await runSetupChild(bin, ['--version'], { cwd: homedir(), signal, timeoutMs: 20_000 });
      if (!/^codex-cli \S+$/.test(version)) throw new SetupDisplayError('所选文件不是可识别的 Codex CLI');
      signal.throwIfAborted();
      await client.connect();
      const authentication = accountState(await client.request('account/read', { refreshToken: false }, 10_000));
      return { installation: 'installed', authentication, version, executable: bin, message: `当前 Codex：${bin}` };
    } catch (error) {
      if (error instanceof CodexProcessCleanupError) throw error;
      return { installation: version && /^codex-cli \S+$/.test(version) ? 'installed' : 'unknown', authentication: 'unknown', version, executable: bin, message: `无法确认当前 Codex 的账户状态：${bin}` };
    } finally {
      signal.removeEventListener('abort', stop);
      await client.close();
    }
  }

  start(type: CodexJobType): { id: string } {
    if (this.closed) throw new CodexSetupConflict('Host 正在退出');
    if (this.cleanupFailures.size) throw new CodexSetupConflict('此前 Codex 子进程清理未确认，请先退出并检查');
    if (this.active) throw new CodexSetupConflict('已有 Codex 设置操作正在进行');
    if (type === 'install' && process.env.CODEX_BIN) throw new CodexSetupConflict(`当前使用显式 CODEX_BIN：${process.env.CODEX_BIN}；请先移除此覆盖再安装`);
    const id = randomUUID();
    const abort = new AbortController();
    const entry: JobEntry = { snapshot: { id, type, state: 'running' }, abort, done: Promise.resolve() };
    this.active = entry;
    this.jobs.set(id, entry);
    const timeout = setTimeout(() => abort.abort(new Error('操作超时')), type === 'login' ? 15 * 60_000 : 6 * 60_000);
    entry.done = Promise.resolve().then(async () => {
      try {
        abort.signal.throwIfAborted();
        if (type === 'install') await (this.options.install ?? installManagedCodex)(abort.signal);
        else await this.login(entry);
        abort.signal.throwIfAborted();
        entry.snapshot = { id, type, state: 'succeeded', message: type === 'install' ? 'Codex 已安装并通过版本校验' : 'Codex 账户已确认登录' };
      } catch (error) {
        if (error instanceof CodexProcessCleanupError) this.cleanupFailures.set(id, error);
        const cancelled = abort.signal.aborted && !(error instanceof CodexProcessCleanupError);
        entry.snapshot = { id, type, state: cancelled ? 'cancelled' : 'failed', message: cancelled ? '操作已取消' : error instanceof Error ? error.message : 'Codex 设置失败' };
      } finally {
        clearTimeout(timeout);
        this.active = undefined;
        this.prune();
      }
    });
    return { id };
  }

  private async login(entry: JobEntry): Promise<void> {
    const signal = entry.abort.signal;
    const bin = resolveCodexBin({ force: true });
    if (!bin) throw new SetupDisplayError('当前 Codex 不可用，请先安装或检查 CODEX_BIN');
    const client = this.client(bin);
    let loginId: string | undefined;
    let loginResponse: Promise<ReturnType<typeof deviceLogin>> | undefined;
    let cancellation: Promise<void> | undefined;
    const cancel = (): void => {
      cancellation ??= (async () => {
        if (loginResponse && !loginId) {
          let timer: NodeJS.Timeout | undefined;
          await Promise.race([loginResponse.catch(() => undefined), new Promise<void>(resolve => { timer = setTimeout(resolve, 2000); })]).finally(() => clearTimeout(timer));
        }
        if (loginId) await client.request('account/login/cancel', { loginId }, 2000).catch(() => undefined);
        await client.close();
      })();
      void cancellation.catch(() => undefined);
    };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      signal.throwIfAborted();
      await client.connect();
      const before = accountState(await client.request('account/read', { refreshToken: false }, 10_000));
      if (before === 'notRequired') throw new SetupDisplayError('当前 Codex 提供商不需要 OpenAI 账户登录，现有配置保持不变');
      if (before === 'signedIn') return;
      signal.throwIfAborted();
      loginResponse = client.request('account/login/start', { type: 'chatgptDeviceCode' }, 20_000).then(deviceLogin).then(login => { loginId = login.loginId; return login; });
      const login = await loginResponse;
      signal.throwIfAborted();
      entry.snapshot = { id: entry.snapshot.id, type: 'login', state: 'authorizing', userCode: login.userCode, verificationUrl: login.verificationUrl, message: `请在浏览器完成登录。当前 Codex：${bin}` };
      for await (const event of client.stream()) {
        signal.throwIfAborted();
        if (event.method !== 'account/login/completed' || event.params.loginId !== loginId) continue;
        if (event.params.success !== true) throw new SetupDisplayError('Codex 登录未完成，请重新尝试');
        if (accountState(await client.request('account/read', { refreshToken: false }, 10_000)) !== 'signedIn') throw new SetupDisplayError('Codex 登录完成后仍无法确认账户');
        return;
      }
      throw new SetupDisplayError('Codex 登录进程已退出，账户状态未确认');
    } catch (error) {
      if (error instanceof SetupDisplayError) throw error;
      throw new SetupDisplayError('Codex 设备码登录不可用，请检查当前可执行文件或稍后重试');
    } finally {
      signal.removeEventListener('abort', cancel);
      if (signal.aborted) cancel();
      if (cancellation) await cancellation;
      await client.close();
    }
  }

  get(id: string): CodexJob | undefined { const job = this.jobs.get(id); return job ? { ...job.snapshot } : undefined; }

  async cancel(id: string): Promise<CodexJob | undefined> {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    if (job.snapshot.state === 'running' || job.snapshot.state === 'authorizing') job.abort.abort();
    await job.done;
    const cleanupFailure = this.cleanupFailures.get(id);
    if (cleanupFailure) throw cleanupFailure;
    return this.get(id);
  }

  close(): Promise<void> {
    this.closed = true;
    this.closing ??= (async () => {
      this.probe?.abort.abort();
      this.active?.abort.abort();
      await Promise.all([this.probe?.done, this.active?.done]);
      if (this.cleanupFailures.size) throw new AggregateError([...this.cleanupFailures.values()], 'Codex 子进程清理未确认');
    })();
    return this.closing;
  }

  private prune(): void {
    const retain = Math.max(1, Math.min(this.options.retain ?? 32, 64));
    for (const [id, entry] of this.jobs) {
      if (this.jobs.size <= retain) break;
      if (entry !== this.active) this.jobs.delete(id);
    }
  }
}
