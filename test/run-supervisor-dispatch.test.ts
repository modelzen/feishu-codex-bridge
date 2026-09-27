import { afterEach, expect, it, vi } from 'vitest';
import { ensureRegistry, type BotsRegistry } from '../src/config/bots';
import { ensureOnboarded } from '../src/bot/onboarding';
import { runSupervisor } from '../src/bot/supervisor';
import { runRun } from '../src/cli/commands/run';

vi.mock('../src/config/bots', async (original) => ({ ...await original<typeof import('../src/config/bots')>(), ensureRegistry: vi.fn() }));
vi.mock('../src/bot/supervisor', () => ({ runSupervisor: vi.fn(async () => {}) }));
vi.mock('../src/bot/onboarding', () => ({ ensureOnboarded: vi.fn(async () => null), announceEventsWhenLive() {} }));
const control = { requested: false, waitForRequest: async () => {}, dispose() {} };
const originalTty = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
afterEach(() => {
  if (originalTty) Object.defineProperty(process.stdout, 'isTTY', originalTty);
  else Reflect.deleteProperty(process.stdout, 'isTTY'); vi.restoreAllMocks(); vi.clearAllMocks(); });

it.each([0, 1, 2])('starts the dynamic supervisor for %i active bots', async (count) => {
  const registry: BotsRegistry = { version: 1, bots: Array.from({ length: count }, (_, i) => ({
    name: String(i), appId: String(i), tenant: 'feishu', createdAt: 0, active: true,
  })) };
  Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
  vi.mocked(ensureRegistry).mockResolvedValue(registry);
  await runRun(undefined, { control });
  expect(runSupervisor).toHaveBeenCalledWith(registry.bots, { control, managed: false });
  expect(ensureOnboarded).not.toHaveBeenCalled();
});

it('does not resurrect an explicitly disabled current bot on an interactive run', async () => {
  Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
  vi.mocked(ensureRegistry).mockResolvedValue({ version: 1, current: 'a', bots: [{ name: 'a', appId: 'a', tenant: 'feishu', createdAt: 0, active: false }] });
  await runRun(undefined, { control });
  expect(runSupervisor).toHaveBeenCalledWith([], { control, managed: false });
  expect(ensureOnboarded).not.toHaveBeenCalled();
});

it('uses the legacy current bot returned by registry migration', async () => {
  const bot = { name: 'default', appId: 'legacy', tenant: 'feishu' as const, createdAt: 0 };
  vi.mocked(ensureRegistry).mockResolvedValue({ version: 1, current: 'legacy', bots: [bot] });
  await runRun(undefined, { control });
  expect(runSupervisor).toHaveBeenCalledWith([bot], { control, managed: false });
});
