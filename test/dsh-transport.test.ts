import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { killProcessGroup } from '../src/platform/spawn';
import {
  DshJsonRpcTransport,
  DshProtocolError,
  DshRpcError,
} from '../src/agent/dsh/transport';

const fixture = fileURLToPath(new URL('./fixtures/fake-dsh-agent.mjs', import.meta.url));
const transports: DshJsonRpcTransport[] = [];
const tempDirs: string[] = [];

function spawnFixture(
  env: NodeJS.ProcessEnv = {},
  options: Partial<Parameters<typeof DshJsonRpcTransport.spawn>[0]> = {},
): DshJsonRpcTransport {
  const transport = DshJsonRpcTransport.spawn({
    command: process.execPath,
    args: [fixture],
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    requestTimeoutMs: 500,
    shutdownTimeoutMs: 100,
    ...options,
  });
  transports.push(transport);
  return transport;
}

async function initialize(transport: DshJsonRpcTransport): Promise<unknown> {
  return transport.request('initialize', {
    cwd: process.cwd(),
    provider: 'deepseek',
    model: 'deepseek-v4-flash',
  });
}

afterEach(async () => {
  await Promise.all(transports.splice(0).map((transport) => transport.terminate()));
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('DshJsonRpcTransport', () => {
  it('correlates responses and buffers notifications that arrive before the prompt receipt', async () => {
    const transport = spawnFixture();
    await expect(initialize(transport)).resolves.toMatchObject({
      serverInfo: { name: 'deepseek-harness-sdk-runtime' },
    });

    const notifications = transport.notifications()[Symbol.asyncIterator]();
    const prompt = transport.request<{ messageId: string }>('session/prompt', {
      sessionId: 'owned-session',
      contentBlocks: [{ type: 'text', text: 'hello' }],
    });
    await expect(notifications.next()).resolves.toMatchObject({
      value: {
        method: 'session.event',
        params: { sessionId: 'owned-session', event: { type: 'turn/start' } },
      },
    });
    await expect(prompt).resolves.toEqual({ messageId: 'message-2' });
    expect(transport.lastActivity()).toBeGreaterThan(0);
    await transport.close();
    expect(transport.isAlive()).toBe(false);
  });

  it('preserves all notifications so the thread layer can filter foreign sessions', async () => {
    const transport = spawnFixture({ FAKE_DSH_FOREIGN: '1' });
    await initialize(transport);
    const notifications = transport.notifications()[Symbol.asyncIterator]();
    const prompt = transport.request('session/prompt', {
      sessionId: 'owned-session',
      contentBlocks: [{ type: 'text', text: 'hello' }],
    });
    const first = await notifications.next();
    const second = await notifications.next();
    expect(first.value?.params).toMatchObject({ sessionId: 'foreign-session' });
    expect(second.value?.params).toMatchObject({ sessionId: 'owned-session' });
    await prompt;
  });

  it('surfaces JSON-RPC errors with their stable code', async () => {
    const transport = spawnFixture({ FAKE_DSH_RPC_ERROR: '1' });
    await initialize(transport);
    await expect(
      transport.request('session/prompt', {
        sessionId: 'owned-session',
        contentBlocks: [{ type: 'text', text: 'reject me' }],
      }),
    ).rejects.toMatchObject({ code: -32001, message: 'fixture rejected prompt' } satisfies Partial<DshRpcError>);
    expect(transport.isAlive()).toBe(true);
  });

  it('fails closed on malformed stdout and terminates the runtime', async () => {
    const transport = spawnFixture({ FAKE_DSH_MALFORMED: '1' });
    await expect(initialize(transport)).rejects.toBeInstanceOf(DshProtocolError);
    await expect(transport.notifications()[Symbol.asyncIterator]().next()).rejects.toBeInstanceOf(
      DshProtocolError,
    );
    expect(transport.isAlive()).toBe(false);
    await transport.terminate();
    expect(transport.isAlive()).toBe(false);
  });

  it('rejects pending requests when the process exits unexpectedly', async () => {
    const transport = spawnFixture({ FAKE_DSH_EXIT_ON_INIT: '1' });
    await expect(initialize(transport)).rejects.toThrow(/退出.*23|23.*退出/);
    expect(transport.isAlive()).toBe(false);
  });

  it('keeps only a bounded stderr tail', async () => {
    const transport = spawnFixture(
      { FAKE_DSH_STDERR_BYTES: '4096' },
      { maxStderrBytes: 96 },
    );
    await initialize(transport);
    expect(Buffer.byteLength(transport.stderrTail(), 'utf8')).toBeLessThanOrEqual(96);
    expect(transport.stderrTail()).toMatch(/^E+$/);
  });

  it('forces the detached process group down when graceful shutdown times out', async () => {
    const killed: number[] = [];
    const transport = spawnFixture(
      { FAKE_DSH_HANG_SHUTDOWN: '1' },
      {
        shutdownTimeoutMs: 25,
        killGroup: async (pid, hasExited) => {
          if (pid !== undefined) killed.push(pid);
          await killProcessGroup(pid, hasExited, { graceMs: 20, pollMs: 5 });
        },
      },
    );
    await initialize(transport);
    await transport.close();
    expect(killed).toHaveLength(1);
    expect(transport.isAlive()).toBe(false);
  });

  it('writes monotonically increasing request ids', async () => {
    const root = mkdtempSync(join(tmpdir(), 'fcb-dsh-observe-'));
    tempDirs.push(root);
    const observe = join(root, 'requests.jsonl');
    const transport = spawnFixture({ FAKE_DSH_OBSERVE: observe });
    await initialize(transport);
    await transport.request('session/prompt', {
      sessionId: 'owned-session',
      contentBlocks: [{ type: 'text', text: 'hello' }],
    });
    await transport.close();
    const lines = (await import('node:fs/promises'))
      .readFile(observe, 'utf8')
      .then((text) => text.trim().split('\n').map((line) => JSON.parse(line) as { id: number }));
    await expect(lines).resolves.toEqual([
      expect.objectContaining({ id: 1 }),
      expect.objectContaining({ id: 2 }),
      expect.objectContaining({ id: 3 }),
    ]);
  });
});
