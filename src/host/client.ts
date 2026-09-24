import { inspectInstallation } from '../service/control';
import { spawn, type ChildProcess } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { acquireMutex, closeMutex } from '../config/data-access';
import { endpointRequest, readHostEndpoint, refusal, type HostEndpoint, type HostInspection, type HostRefusal } from './discovery';
import { stopChild } from './lifecycle';
export type { HostInspection, HostRefusal } from './discovery';
export { migrateHostDataOffline, type HostMigration } from './migration';

export interface HostOptions { home: string; nodePath: string; cliPath: string }
export interface HostHandle {
  kind: 'connected';
  ownership: 'owned' | 'attached';
  readonly pid: number;
  request(path: string, init?: RequestInit): Promise<Response>;
  restart(): Promise<void>;
  close(): Promise<void>;
}
export class HostOwnershipError extends Error {}

export async function inspectHost(home: string): Promise<HostInspection> {
  try {
    const lock = await acquireMutex(home, 'admission');
    try {
      const endpoint = await readHostEndpoint(home);
      if (!endpoint) return { kind: 'absent' };
      if ('kind' in endpoint) return endpoint;
      return { kind: 'attached', pid: endpoint.pid };
    } finally { await closeMutex(lock); }
  } catch (error) { return refusal(error); }
}

async function launch(options: HostOptions): Promise<{ child: ChildProcess; endpoint: HostEndpoint }> {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: options.home, USERPROFILE: options.home, XDG_CONFIG_HOME: `${options.home}/.config` };
  delete env.FEISHU_CODEX_BRIDGE_SERVICE;
  const child = spawn(options.nodePath, [options.cliPath, 'host', '--parent-control'], {
    env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'ignore', 'pipe'],
  });
  let failure = '';
  child.stderr?.on('data', (data: Buffer) => { failure = (failure + data.toString()).slice(-4096); });
  let spawnError: Error | undefined;
  child.on('error', (error) => { spawnError = error; });
  child.stdin?.on('error', () => {});
  const deadline = Date.now() + 25000;
  try {
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Host exited before readiness. ${failure.trim()}`);
      const endpoint = await readHostEndpoint(options.home);
      if (endpoint && !('kind' in endpoint) && endpoint.pid === child.pid) return { child, endpoint };
      if (endpoint && 'kind' in endpoint) throw new Error(endpoint.message);
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
    throw new Error('Host readiness timed out.');
  } catch (error) {
    await stopChild(child, undefined, process.platform !== 'win32').catch((shutdownError) => { throw new AggregateError([error, shutdownError], 'Host startup and cleanup failed.'); });
    throw error;
  }
}

export async function connectHost(input: HostOptions): Promise<HostHandle | HostRefusal> {
  try {
    const options = { ...input, home: realpathSync(input.home) };
    let endpoint: HostEndpoint;
    let child: ChildProcess | undefined;
    const existing = await readHostEndpoint(options.home);
    if (existing && 'kind' in existing) return existing;
    if (existing) endpoint = existing;
    else {
      const installation = inspectInstallation(options.home);
      if (installation.kind === 'registered') return { kind: 'blocked', reason: 'service-registered', message: `An existing service is registered (${installation.detail}). Start it to attach, or explicitly stop it first.` };
      const started = await launch(options);
      endpoint = started.endpoint;
      child = started.child;
    }
    const ownership = child ? 'owned' : 'attached';
    let closed = false;
    let operation = Promise.resolve();
    const serialize = (run: () => Promise<void>): Promise<void> => {
      const next = operation.then(run);
      operation = next.catch(() => {});
      return next;
    };
    return {
      kind: 'connected', ownership,
      get pid() { return endpoint.pid; },
      request(path, init) {
        if (closed) return Promise.reject(new Error('Host handle is closed.'));
        return endpointRequest(endpoint, path, init);
      },
      restart: () => serialize(async () => {
        if (ownership === 'attached') throw new HostOwnershipError('An attached Host is owned by another process.');
        if (closed) throw new Error('Host handle is closed.');
        if (child) await stopChild(child, undefined, process.platform !== 'win32');
        const started = await launch(options);
        child = started.child;
        endpoint = started.endpoint;
      }),
      close: () => serialize(async () => {
        if (closed) return;
        if (child) await stopChild(child, undefined, process.platform !== 'win32');
        closed = true;
      }),
    };
  } catch (error) { return { ...refusal(error), reason: 'startup-failed' }; }
}
