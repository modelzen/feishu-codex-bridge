import { EventEmitter } from 'node:events';
import type { SpawnOptions } from 'node:child_process';
import type {
  BotRuntimeEvent,
  BotSpec,
} from '../src/kernel/start-bot';
import { describe, expect, it, vi } from 'vitest';
import {
  BridgeRuntimeBotProcess,
  createBridgeRuntimeBotLauncher,
  resolveBridgeRuntimeWorkerInvocation,
  type BridgeRuntimeChildProcess,
  type BridgeRuntimeScheduler,
} from '../src/runtime/bot-process';
import type {
  BridgeRuntimeParentMessage,
} from '../src/runtime/worker-protocol';

const SPEC: BotSpec = {
  appId: 'cli_sensitive_app',
  appSecret: 'sensitive-secret-value',
  accountSecretRef: 'secret-ref',
  tenant: 'feishu',
  ownerOpenId: 'ou_owner',
  admins: ['ou_admin'],
  dataDir: '/tmp/vonvon/bots/cli_sensitive_app',
  legacyAssetsDir: '/Users/test/.feishu-codex-bridge',
  writableAssetsDir: '/Users/test/Library/Application Support/Vonvon Bridge/compat-assets',
  fallbackCwd: '/Users/test',
};

class FakeChild extends EventEmitter implements BridgeRuntimeChildProcess {
  connected = true;
  readonly pid = 4321;
  readonly sent: BridgeRuntimeParentMessage[] = [];
  readonly signals: NodeJS.Signals[] = [];

  send(
    message: BridgeRuntimeParentMessage,
    callback?: (error: Error | null) => void,
  ): boolean {
    this.sent.push(message);
    callback?.(null);
    return true;
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.signals.push(signal);
    return true;
  }
}

class ManualScheduler implements BridgeRuntimeScheduler {
  readonly jobs: Array<{
    callback: () => void;
    milliseconds: number;
    cancelled: boolean;
  }> = [];

  setTimeout(callback: () => void, milliseconds: number): unknown {
    const job = { callback, milliseconds, cancelled: false };
    this.jobs.push(job);
    return job;
  }

  clearTimeout(handle: unknown): void {
    (handle as ManualScheduler['jobs'][number]).cancelled = true;
  }

  run(index: number): void {
    const job = this.jobs[index]!;
    if (!job.cancelled) job.callback();
  }
}

describe('BridgeRuntimeBotProcess', () => {
  it('uses the same secret-free self invocation in development and packaged builds', () => {
    expect(resolveBridgeRuntimeWorkerInvocation({
      execPath: '/usr/local/bin/node',
      argv: ['/usr/local/bin/node', '/app/sidecar.cjs'],
      packaged: false,
    })).toEqual({
      command: '/usr/local/bin/node',
      args: ['/app/sidecar.cjs', '--bridge-runtime-worker'],
    });
    expect(resolveBridgeRuntimeWorkerInvocation({
      execPath: '/app/vonvon-runtime',
      argv: ['/app/vonvon-runtime'],
      packaged: true,
    })).toEqual({
      command: '/app/vonvon-runtime',
      args: ['--bridge-runtime-worker'],
    });
  });

  it('keeps robot identity and secret out of argv/env and sends them only after spawn over IPC', async () => {
    const child = new FakeChild();
    const calls: Array<{
      command: string;
      args: readonly string[];
      options: SpawnOptions;
    }> = [];
    const launcher = createBridgeRuntimeBotLauncher({
      runtime: {
        execPath: '/app/vonvon-runtime',
        argv: ['/app/vonvon-runtime'],
        packaged: true,
      },
      spawnProcess(command, args, options) {
        calls.push({ command, args, options });
        return child;
      },
    });
    const worker = new BridgeRuntimeBotProcess({ spec: SPEC, launcher });

    const start = worker.start();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      command: '/app/vonvon-runtime',
      args: ['--bridge-runtime-worker'],
      options: {
        env: expect.objectContaining({ PKG_EXECPATH: '' }),
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      },
    });
    expect(JSON.stringify(calls)).not.toContain(SPEC.appId);
    expect(JSON.stringify(calls)).not.toContain(SPEC.appSecret);
    expect(child.sent).toEqual([]);

    child.emit('spawn');
    await start;
    expect(child.sent).toEqual([{ type: 'bootstrap', spec: SPEC }]);
    expect(worker.liveStatus()).toEqual({
      running: true,
      pid: 4321,
      startedAt: expect.any(Number),
      connection: 'connecting',
    });

    const stopping = worker.stop();
    child.emit('exit', 0, null);
    await stopping;
    expect(worker.liveStatus()).toEqual({ running: false });
  });

  it('restarts only the failed robot with bounded backoff and resets only after a healthy window', async () => {
    const scheduler = new ManualScheduler();
    const children = [new FakeChild(), new FakeChild(), new FakeChild()];
    let launched = 0;
    const worker = new BridgeRuntimeBotProcess({
      spec: SPEC,
      launcher: () => children[launched++]!,
      scheduler,
      restartBaseMs: 100,
      restartMaxMs: 150,
      restartHealthyMs: 1_000,
    });

    const start = worker.start();
    children[0]!.emit('spawn');
    await start;
    children[0]!.emit('exit', 1, null);
    expect(scheduler.jobs[0]?.milliseconds).toBe(100);

    scheduler.run(0);
    children[1]!.emit('spawn');
    children[1]!.emit('exit', 1, null);
    expect(scheduler.jobs[1]?.milliseconds).toBe(150);

    scheduler.run(1);
    children[2]!.emit('spawn');
    children[2]!.emit('message', { type: 'ready' });
    expect(scheduler.jobs[2]?.milliseconds).toBe(1_000);
    children[2]!.emit('exit', 1, null);
    expect(scheduler.jobs[2]?.cancelled).toBe(true);
    expect(scheduler.jobs[3]?.milliseconds).toBe(150);

    const stopping = worker.stop();
    scheduler.run(3);
    expect(launched).toBe(3);
    await stopping;
  });

  it('resolves a fresh protected credential before the initial child and every crash relaunch', async () => {
    const scheduler = new ManualScheduler();
    const children = [new FakeChild(), new FakeChild()];
    const values = ['FIRST-DYNAMIC-SECRET', 'ROTATED-DYNAMIC-SECRET'];
    let launched = 0;
    const resolveAppSecret = vi.fn(async () => values.shift());
    const worker = new BridgeRuntimeBotProcess({
      spec: { ...SPEC, appSecret: 'STALE-MATERIALIZED-SECRET' },
      launcher: () => children[launched++]!,
      scheduler,
      restartBaseMs: 100,
      resolveAppSecret,
    });

    const start = worker.start();
    await vi.waitFor(() => expect(launched).toBe(1));
    children[0]!.emit('spawn');
    await start;
    expect(children[0]!.sent).toEqual([{
      type: 'bootstrap',
      spec: { ...SPEC, appSecret: 'FIRST-DYNAMIC-SECRET' },
    }]);

    children[0]!.emit('exit', 1, null);
    scheduler.run(0);
    await vi.waitFor(() => expect(launched).toBe(2));
    children[1]!.emit('spawn');
    expect(children[1]!.sent).toEqual([{
      type: 'bootstrap',
      spec: { ...SPEC, appSecret: 'ROTATED-DYNAMIC-SECRET' },
    }]);
    expect(resolveAppSecret).toHaveBeenCalledTimes(2);

    const stopping = worker.stop();
    children[1]!.emit('exit', 0, null);
    await stopping;
  });

  it('cancels restarts and escalates graceful stop through TERM then KILL', async () => {
    const scheduler = new ManualScheduler();
    const child = new FakeChild();
    const worker = new BridgeRuntimeBotProcess({
      spec: SPEC,
      launcher: () => child,
      scheduler,
      gracefulStopMs: 10,
      termStopMs: 5,
    });
    const start = worker.start();
    child.emit('spawn');
    await start;

    const stopping = worker.stop();
    expect(child.sent.at(-1)).toEqual({ type: 'stop' });
    expect(scheduler.jobs[0]?.milliseconds).toBe(10);
    scheduler.run(0);
    expect(child.signals).toEqual(['SIGTERM']);
    expect(scheduler.jobs[1]?.milliseconds).toBe(5);
    scheduler.run(1);
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL']);
    child.emit('exit', null, 'SIGKILL');
    await stopping;
    expect(scheduler.jobs).toHaveLength(3);
    expect(scheduler.jobs[2]?.cancelled).toBe(true);
  });

  it('reports an initial local spawn failure while keeping that robot on an isolated retry loop', async () => {
    const scheduler = new ManualScheduler();
    const child = new FakeChild();
    const worker = new BridgeRuntimeBotProcess({
      spec: SPEC,
      launcher: () => child,
      scheduler,
    });
    const start = worker.start();
    child.emit('error', new Error('spawn ENOENT'));
    await expect(start).rejects.toThrow('spawn ENOENT');
    expect(scheduler.jobs[0]?.milliseconds).toBe(500);
    await worker.stop();
    expect(scheduler.jobs[0]?.cancelled).toBe(true);
  });

  it('treats a kernel startup failure after spawn as robot-local and schedules restart', async () => {
    const scheduler = new ManualScheduler();
    const child = new FakeChild();
    const worker = new BridgeRuntimeBotProcess({
      spec: SPEC,
      launcher: () => child,
      scheduler,
    });
    const start = worker.start();
    const ready = worker.waitUntilReady(1_000);
    child.emit('spawn');
    await expect(start).resolves.toBeUndefined();
    child.emit('message', { type: 'start-failed', error: 'remote auth failed' });
    await expect(ready).rejects.toThrow('remote auth failed');
    child.emit('exit', 1, null);
    expect(scheduler.jobs[0]?.cancelled).toBe(true);
    expect(scheduler.jobs[1]?.milliseconds).toBe(500);
    await worker.stop();
  });

  it('reports initial readiness only after the complete kernel connects', async () => {
    const scheduler = new ManualScheduler();
    const child = new FakeChild();
    const worker = new BridgeRuntimeBotProcess({
      spec: SPEC,
      launcher: () => child,
      scheduler,
    });
    const start = worker.start();
    const ready = worker.waitUntilReady(1_000);
    child.emit('spawn');
    await start;
    let settled = false;
    void ready.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    child.emit('message', { type: 'ready' });
    await expect(ready).resolves.toBeUndefined();
    const stopping = worker.stop();
    child.emit('exit', 0, null);
    await stopping;
  });

  it('keeps retrying when a replacement child fails before spawn', async () => {
    const scheduler = new ManualScheduler();
    const children = [new FakeChild(), new FakeChild()];
    let launched = 0;
    const worker = new BridgeRuntimeBotProcess({
      spec: SPEC,
      launcher: () => children[launched++]!,
      scheduler,
    });
    const start = worker.start();
    children[0]!.emit('spawn');
    await start;
    children[0]!.emit('exit', 1, null);

    scheduler.run(0);
    children[1]!.emit('error', new Error('transient spawn failure'));
    expect(scheduler.jobs[1]?.milliseconds).toBe(1_000);

    await worker.stop();
  });

  it('forwards an embedded restart request for group-level coordination', async () => {
    const scheduler = new ManualScheduler();
    const child = new FakeChild();
    const events: BotRuntimeEvent[] = [];
    const worker = new BridgeRuntimeBotProcess({
      spec: SPEC,
      launcher: () => child,
      scheduler,
      onRuntimeEvent: (event) => events.push(event),
    });
    const start = worker.start();
    child.emit('spawn');
    await start;

    const restartEvent: BotRuntimeEvent = {
      type: 'restart-requested',
      appId: SPEC.appId,
      at: 1,
    };
    child.emit('message', { type: 'runtime-event', event: restartEvent });
    expect(events).toEqual([restartEvent]);
    expect(child.sent.at(-1)).toEqual({ type: 'bootstrap', spec: SPEC });

    const recycling = worker.restart();
    expect(child.sent.at(-1)).toEqual({ type: 'stop' });
    child.emit('exit', 0, null);
    await recycling;
    expect(scheduler.jobs[0]?.cancelled).toBe(true);
    expect(scheduler.jobs[1]?.milliseconds).toBe(500);
    await worker.stop();
  });

  it('rejects shutdown if a child never reports exit even after SIGKILL', async () => {
    const scheduler = new ManualScheduler();
    const child = new FakeChild();
    const worker = new BridgeRuntimeBotProcess({
      spec: SPEC,
      launcher: () => child,
      scheduler,
      gracefulStopMs: 10,
      termStopMs: 5,
    });
    const start = worker.start();
    child.emit('spawn');
    await start;

    const stopping = worker.stop();
    scheduler.run(0);
    scheduler.run(1);
    scheduler.run(2);
    await expect(stopping).rejects.toThrow('SIGKILL');
  });
});
