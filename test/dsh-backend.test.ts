import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentEvent, AgentRun } from '../src/agent/types';
import { DSH_VERSION } from '../src/agent/dsh/constants';
import { DshBackend, type DshBackendDeps } from '../src/agent/dsh/backend';

const fixture = fileURLToPath(new URL('./fixtures/fake-dsh-agent.mjs', import.meta.url));
const roots: string[] = [];

interface Observation {
  pid: number;
  method: string;
  params?: Record<string, unknown>;
  runtime: Record<string, string | undefined>;
}

function harness(env: NodeJS.ProcessEnv = {}): {
  backend: DshBackend;
  root: string;
  observe: string;
  profile: string;
  sessions: string;
} {
  const root = mkdtempSync(join(tmpdir(), 'fcb-dsh-backend-'));
  roots.push(root);
  const observe = join(root, 'requests.jsonl');
  const profile = join(root, 'cordis.yml');
  const sessions = join(root, 'sessions');
  const deps: DshBackendDeps = {
    locateBin: () => process.execPath,
    installedVersion: () => DSH_VERSION,
    ensureProfile: async () => profile,
    sessionsDir: () => sessions,
    runtimeArgs: (profileFile) => [fixture, profileFile],
    runtimeEnv: {
      FAKE_DSH_FULL_TURN: '1',
      FAKE_DSH_OBSERVE: observe,
      ...env,
    },
  };
  return { backend: new DshBackend(deps), root, observe, profile, sessions };
}

function observations(file: string): Observation[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Observation);
}

async function collect(run: AgentRun): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of run.events) out.push(event);
  return out;
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for DSH fixture');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('DshBackend', () => {
  it('reports an exact install and refuses stale or missing runtimes', async () => {
    let profileCalls = 0;
    const ready = new DshBackend({
      locateBin: () => '/private/dsh-jsonrpc-agent',
      installedVersion: () => DSH_VERSION,
      ensureProfile: async () => {
        profileCalls++;
        return '/private/cordis.yml';
      },
    });
    await expect(ready.doctor()).resolves.toMatchObject({
      ok: true,
      version: DSH_VERSION,
      location: '/private/dsh-jsonrpc-agent',
      depState: 'installed',
    });
    expect(profileCalls).toBe(1);

    const stale = new DshBackend({
      locateBin: () => '/private/dsh-jsonrpc-agent',
      installedVersion: () => '0.1.1-rc.1',
      ensureProfile: async () => {
        profileCalls++;
        return '/private/cordis.yml';
      },
    });
    await expect(stale.doctor()).resolves.toMatchObject({
      ok: false,
      version: '0.1.1-rc.1',
      installable: true,
      depState: 'not-installed',
    });
    expect(profileCalls).toBe(1);
  });

  it('streams a full turn and reuses one runtime for later turns', async () => {
    const { backend, root, observe, profile, sessions } = harness();
    const thread = await backend.startThread({ cwd: root, mode: 'full' });
    expect(thread.sessionId).toMatch(/^[0-9a-f-]{36}$/i);

    const first = await collect(thread.runStreamed({ text: 'hello' }));
    expect(first.map((event) => event.type)).toEqual([
      'turn_started',
      'thinking_delta',
      'text_delta',
      'thinking',
      'text',
      'usage',
      'tool_use',
      'tool_result',
      'done',
    ]);
    expect(first.filter((event) => event.type === 'text_delta')).toHaveLength(1);
    expect(first.filter((event) => event.type === 'usage')).toHaveLength(1);

    await collect(thread.runStreamed({ text: 'again' }));
    const lines = observations(observe);
    expect(lines.filter((line) => line.method === 'initialize')).toHaveLength(1);
    const prompts = lines.filter((line) => line.method === 'session/prompt');
    expect(prompts).toHaveLength(2);
    expect(prompts.map((line) => line.params?.sessionId)).toEqual([
      thread.sessionId,
      thread.sessionId,
    ]);
    expect(prompts[0]?.params?.contentBlocks).toEqual([{ type: 'text', text: 'hello' }]);
    expect(lines[0]?.runtime).toMatchObject({
      profile,
      cwd: root,
      sessionRoot: sessions,
      permission: 'danger-full-access',
      tools: 'native',
      telemetryDisabled: '1',
      effort: 'high',
    });
    await thread.close();
  });

  it('resumes the same persistent session in a fresh runtime', async () => {
    const { backend, root, observe } = harness();
    const sessionId = '6f11a724-a64d-4efb-a72e-f35ce90cc42d';
    const thread = await backend.resumeThread({ cwd: root, mode: 'full', sessionId });
    await collect(thread.runStreamed({ text: 'continue' }));
    expect(thread.sessionId).toBe(sessionId);
    expect(
      observations(observe).find((line) => line.method === 'session/prompt')?.params?.sessionId,
    ).toBe(sessionId);
    await thread.close();
  });

  it('restarts on model or effort changes without changing the session id', async () => {
    const { backend, root, observe } = harness();
    const thread = await backend.startThread({
      cwd: root,
      mode: 'full',
      model: 'moonshotai-cn/kimi-k3',
      effort: 'high',
    });
    await collect(thread.runStreamed({ text: 'one' }));
    await collect(
      thread.runStreamed(
        { text: 'two' },
        { model: 'minimax/MiniMax-M3', effort: 'none' },
      ),
    );

    const lines = observations(observe);
    const init = lines.filter((line) => line.method === 'initialize');
    expect(init).toHaveLength(2);
    expect(init.map((line) => line.params)).toEqual([
      { cwd: root, provider: 'moonshotai-cn', model: 'kimi-k3' },
      { cwd: root, provider: 'minimax', model: 'MiniMax-M3' },
    ]);
    expect(new Set(init.map((line) => line.pid)).size).toBe(2);
    expect(init.map((line) => line.runtime.effort)).toEqual(['high', 'off']);
    expect(
      lines
        .filter((line) => line.method === 'session/prompt')
        .map((line) => line.params?.sessionId),
    ).toEqual([thread.sessionId, thread.sessionId]);
    await thread.close();
  });

  it('rejects unsafe modes and images before spawning or prompting', async () => {
    const { backend, root, observe } = harness();
    await expect(backend.startThread({ cwd: root, mode: 'qa' })).rejects.toThrow(/仅支持.*full/);
    await expect(backend.startThread({ cwd: root, mode: 'write' })).rejects.toThrow(/仅支持.*full/);
    expect(observations(observe)).toEqual([]);

    const thread = await backend.startThread({ cwd: root, mode: 'full' });
    expect(() => thread.runStreamed({ text: 'look', images: ['/tmp/a.png'] })).toThrow(/图片/);
    expect(observations(observe)).toEqual([]);
    await thread.close();
  });

  it('filters notifications from every foreign DSH session', async () => {
    const { backend, root } = harness({ FAKE_DSH_FOREIGN: '1' });
    const thread = await backend.startThread({ cwd: root, mode: 'full' });
    const events = await collect(thread.runStreamed({ text: 'owned' }));
    const starts = events.filter((event) => event.type === 'turn_started');
    expect(starts).toHaveLength(1);
    expect(starts[0]).toMatchObject({
      type: 'turn_started',
      turnId: expect.stringContaining(thread.sessionId),
    });
    expect(JSON.stringify(events)).not.toContain('foreign-session');
    await thread.close();
  });

  it('turns an RPC rejection into one fatal event and a dead runtime', async () => {
    const { backend, root } = harness({ FAKE_DSH_RPC_ERROR: '1' });
    const thread = await backend.startThread({ cwd: root, mode: 'full' });
    const events = await collect(thread.runStreamed({ text: 'reject me' }));
    expect(events).toEqual([
      {
        type: 'error',
        message: 'fixture rejected prompt',
        willRetry: false,
      },
    ]);
    expect(thread.isAlive()).toBe(false);
    await thread.close();
  });

  it('allows only one active prompt per thread', async () => {
    const { backend, root } = harness();
    const thread = await backend.startThread({ cwd: root, mode: 'full' });
    const first = thread.runStreamed({ text: 'one' });
    expect(() => thread.runStreamed({ text: 'two' })).toThrow(/已有.*运行/);
    await collect(first);
    await expect(collect(thread.runStreamed({ text: 'three' }))).resolves.toBeTruthy();
    await thread.close();
  });

  it('aborts by killing the runtime while preserving the resumable session id', async () => {
    const hanging = harness({ FAKE_DSH_HANG_PROMPT: '1' });
    const thread = await hanging.backend.startThread({ cwd: hanging.root, mode: 'full' });
    const run = thread.runStreamed({ text: 'hang' });
    await waitFor(() => observations(hanging.observe).some((line) => line.method === 'session/prompt'));
    await thread.abort('manual-stop');
    const events = await collect(run);
    expect(events.some((event) => event.type === 'error')).toBe(false);
    expect(events.some((event) => event.type === 'done')).toBe(true);
    expect(thread.isAlive()).toBe(false);

    const resumedHarness = harness();
    const resumed = await resumedHarness.backend.resumeThread({
      cwd: resumedHarness.root,
      mode: 'full',
      sessionId: thread.sessionId,
    });
    await collect(resumed.runStreamed({ text: 'after stop' }));
    expect(
      observations(resumedHarness.observe).find((line) => line.method === 'session/prompt')
        ?.params?.sessionId,
    ).toBe(thread.sessionId);
    await resumed.close();
  });

  it('fails unsupported optional operations explicitly and closes idempotently', async () => {
    const { backend, root } = harness();
    const thread = await backend.startThread({ cwd: root, mode: 'full' });
    expect(() => thread.runGoal('ship it')).toThrow(/不支持.*goal/i);
    await expect(thread.clearGoal()).rejects.toThrow(/不支持.*goal/i);
    await expect(thread.steer({ text: 'change' }, 'turn')).rejects.toThrow(/不支持.*steer/i);
    await expect(thread.compact()).rejects.toThrow(/不支持.*compact/i);
    await thread.close();
    await expect(thread.close()).resolves.toBeUndefined();
  });
});
