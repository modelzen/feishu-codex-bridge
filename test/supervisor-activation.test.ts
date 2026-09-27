import { spawn, type ChildProcess } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';
import type { AdminServiceDeps } from '../src/admin/service';
import { runSupervisor } from '../src/bot/supervisor';

const captured = vi.hoisted(() => ({ deps: undefined as AdminServiceDeps | undefined }));
vi.mock('../src/admin/service', () => ({ createAdminService: (deps: AdminServiceDeps) => { captured.deps = deps; return deps; } }));
vi.mock('../src/web/mount', () => ({ mountWebConsole: vi.fn(async () => ({ port: 1, close: async () => {} })) }));
vi.mock('../src/service/win-startup', () => ({ recordServicePid() {}, SERVICE_ENV_FLAG: 'BRIDGE_TEST_SERVICE' }));
vi.mock('../src/core/logger', () => ({ log: { info() {}, warn() {}, fail() {} } }));
vi.mock('../src/agent', () => ({ installBackendDep() {}, uninstallBackendDep() {} }));
vi.mock('../src/cli/commands/daemon-control', () => ({ spawnDaemonControl() {} }));
vi.mock('../src/config/bots', () => ({ loadBots: async () => ({ bots: [
  { appId: 'a', name: 'a', tenant: 'feishu', createdAt: 0 },
  { appId: 'b', name: 'b', tenant: 'feishu', createdAt: 0 },
] }) }));
vi.mock('../src/core/single-instance', () => ({ readSingleInstanceHolder: vi.fn(() => undefined) }));
import { readSingleInstanceHolder } from '../src/core/single-instance';

vi.mock('../src/platform/spawn', () => ({ spawnProcess: vi.fn() }));
import { spawnProcess } from '../src/platform/spawn';
import { mountWebConsole } from '../src/web/mount';

const processes: ChildProcess[] = [];
let requestShutdown = () => {};
let supervisor: Promise<void> | undefined;
const bot = (appId: string) => ({ appId, name: appId, tenant: 'feishu' as const, createdAt: 0 });
const fixture = `
  const keepAlive = setInterval(() => {}, 1000);
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    setTimeout(() => { clearInterval(keepAlive); process.disconnect(); }, 150);
  };
  process.on('SIGTERM', stop);
  process.on('message', message => {
    if (message.type === 'bridge:shutdown') stop();
    else if (message.fcb === 'fcb.admin.req') process.send({ fcb: 'fcb.admin.res', id: message.id, ok: true, result: { connection: 'connected' } });
  });
`;

async function start(ids: string[]) {
  captured.deps = undefined;
  vi.mocked(spawnProcess).mockImplementation((_bin, _args, options) => {
    const child = spawn(process.execPath, ['-e', fixture], options ?? {});
    processes.push(child);
    return child;
  });
  const pending = new Promise<void>((resolve) => { requestShutdown = resolve; });
  supervisor = runSupervisor(ids.map(bot), { control: { requested: false, waitForRequest: () => pending, dispose() {} } });
  await vi.waitFor(() => expect(captured.deps).toBeDefined());
  const deps = (() : AdminServiceDeps | undefined => captured.deps)();
  if (!deps?.applyBotActivation || !deps.liveStatus || !deps.executeGroups) throw new Error('Runtime activation unavailable');
  for (const id of ids) await deps.applyBotActivation(id, true);
  return { apply: deps.applyBotActivation, status: deps.liveStatus, groups: deps.executeGroups };
}

afterEach(async () => {
  requestShutdown();
  await supervisor;
  for (const child of processes.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  vi.clearAllMocks();
});

it('stops only the disabled bot before acknowledging and refuses writes during stopping', async () => {
  const runtime = await start(['a', 'b']);
  const before = await runtime.status('b');
  const a = processes[0];
  if (!a) throw new Error('Missing child');
  const disabling = runtime.apply('a', false);
  await expect(runtime.groups('a', { kind: 'joinedGroups' })).rejects.toThrow();
  await disabling;
  expect(a.exitCode).toBe(0);
  expect(await runtime.status('a')).toBeUndefined();
  expect(await runtime.status('b')).toMatchObject({ running: true, pid: before?.pid, connection: 'connected' });
});

it('keeps the empty supervisor available and can enable the first and last bot repeatedly', async () => {
  const runtime = await start([]);
  await runtime.apply('a', true);
  expect(await runtime.status('a')).toMatchObject({ running: true, connection: 'connected' });
  const original = processes[0];
  if (!original) throw new Error('Missing child');
  await runtime.apply('a', false);
  expect(original.exitCode).toBe(0);
  await runtime.apply('a', true);
  expect(processes).toHaveLength(2);
  expect((await runtime.status('a'))?.pid).not.toBe(original.pid);
  await runtime.apply('a', false);
  expect(await runtime.status('a')).toBeUndefined();
});

it('cancels a crashed disabled child scheduled for automatic restart', async () => {
  const runtime = await start(['a']);
  const child = processes[0];
  if (!child) throw new Error('Missing child');
  child.kill('SIGKILL');
  await vi.waitFor(async () => expect(await runtime.status('a')).toBeUndefined());
  await runtime.apply('a', false);
  await new Promise((resolve) => setTimeout(resolve, 1200));
  expect(processes).toHaveLength(1);
  expect(await runtime.status('a')).toBeUndefined();
});

it('does not claim to stop a bot running in an independent process', async () => {
  const runtime = await start([]);
  vi.mocked(readSingleInstanceHolder).mockReturnValue({ pid: 9876, startedAt: 1 });
  await expect(runtime.apply('a', false)).rejects.toThrow('其他进程');
  expect(processes).toHaveLength(0);
  expect(await runtime.status('a')).toBeUndefined();
  vi.mocked(readSingleInstanceHolder).mockReturnValue(undefined);
});

it('fails an empty host when its only usable interface cannot start', async () => {
  vi.mocked(mountWebConsole).mockResolvedValueOnce(undefined);
  supervisor = undefined;
  await expect(runSupervisor([], { control: { requested: false, waitForRequest: () => new Promise(() => {}), dispose() {} } })).rejects.toThrow('无法进入引导');
});
