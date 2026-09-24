import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventDiagnosis } from '../src/utils/event-diagnosis';
import { ensureOnboarded, announceEventsWhenLive } from '../src/bot/onboarding';
import { runStart } from '../src/cli/commands/daemon';

const mocks = vi.hoisted(() => ({
  diagnosis: vi.fn<() => Promise<EventDiagnosis>>(),
  poll: vi.fn<() => Promise<EventDiagnosis | null>>(),
  validate: vi.fn(),
  install: vi.fn(),
  open: vi.fn(() => { throw new Error('unexpected browser'); }),
  prompt: vi.fn(() => { throw new Error('unexpected stdin prompt'); }),
}));
vi.mock('node:readline/promises', () => ({ createInterface: mocks.prompt }));
vi.mock('../src/utils/open-url', () => ({ openUrl: mocks.open }));
vi.mock('../src/utils/event-diagnosis', async (original) => ({
  ...await original<typeof import('../src/utils/event-diagnosis')>(),
  diagnoseEventSubscription: mocks.diagnosis,
  pollEventSubscription: mocks.poll,
}));
vi.mock('../src/utils/feishu-auth', () => ({ validateAppCredentials: mocks.validate }));
vi.mock('../src/agent', () => ({ detectAgents: async () => [{ backends: [{ available: true }] }] }));
vi.mock('../src/config/store', () => ({ loadConfig: async () => ({ accounts: { app: { id: 'cli_test', secret: 'test', tenant: 'feishu' } } }) }));
vi.mock('../src/config/secret-resolver', () => ({ resolveAppSecret: async () => 'test' }));
vi.mock('../src/config/keystore', () => ({ setSecret: vi.fn() }));
vi.mock('../src/config/paths', () => ({ useBotDir: vi.fn() }));
vi.mock('../src/bot/wizard', () => ({ runRegistrationWizard: vi.fn() }));
vi.mock('../src/config/bots', () => {
  const bot = { name: 'test', appId: 'cli_test', tenant: 'feishu', active: true };
  return {
    ensureRegistry: async () => ({ bots: [bot] }), loadBots: async () => ({ bots: [bot] }),
    currentBot: () => bot, findBot: () => bot, activeBots: () => [bot],
  };
});
vi.mock('../src/core/logger', () => ({ log: { info: vi.fn(), fail: vi.fn() } }));
vi.mock('../src/service/adapter', () => ({ getServiceAdapter: () => ({ install: mocks.install }) }));
vi.mock('../src/web/discovery', () => ({ readWebConsole: () => undefined }));

const tty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
afterAll(() => {
  if (tty) Object.defineProperty(process.stdin, 'isTTY', tty);
  else Reflect.deleteProperty(process.stdin, 'isTTY');
});
beforeEach(() => {
  vi.clearAllMocks();
  mocks.validate.mockResolvedValue({ ok: true, botName: 'test', missingScopes: [] });
  mocks.install.mockResolvedValue({ platformName: 'test', installed: true, running: true });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); process.exitCode = 0; });
const output = () => vi.mocked(console.log).mock.calls.map((args) => args.join(' ')).join('\n');
const healthy: EventDiagnosis = { state: 'ok', version: '1.0', missingRequired: [], missingOptional: [] };

describe('automatic event checks during startup', () => {
  it.each<EventDiagnosis>([
    healthy,
    { state: 'missing', version: '1.0', missingRequired: ['im.message.receive_v1'] },
    { state: 'unpublished' },
    { state: 'unchecked', reason: 'no permission' },
  ])('start continues without confirmation or browser for $state', async (d) => {
    mocks.diagnosis.mockResolvedValue(d);
    await runStart();
    expect(mocks.install).toHaveBeenCalledOnce();
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.prompt).not.toHaveBeenCalled();
    expect(output()).not.toContain('按 Enter');
    if (d.state === 'ok') {
      expect(output()).toContain('已订阅 im.message.receive_v1');
      expect(output()).not.toContain('/event');
    } else {
      expect(output()).toContain('https://open.feishu.cn/app/cli_test/event');
      if (d.state === 'missing') expect(output()).toContain('缺事件：im.message.receive_v1');
      if (d.state === 'unchecked') expect(output()).toContain('no permission');
    }
  });

  it('optional omissions and missing permissions get links without opening a browser', async () => {
    mocks.diagnosis.mockResolvedValue({ ...healthy, missingOptional: ['application.bot.menu_v6'] });
    mocks.validate.mockResolvedValue({ ok: true, missingScopes: ['im:message:send_as_bot'] });
    const result = await ensureOnboarded({ bot: 'test' });
    expect(result?.events?.state).toBe('ok');
    expect(output()).toContain('可选事件未订阅：application.bot.menu_v6');
    expect(output()).toContain('/event');
    expect(output()).toContain('/auth?');
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.prompt).not.toHaveBeenCalled();
  });

  it('invalid credentials still prevent service installation', async () => {
    mocks.validate.mockResolvedValue({ ok: false, reason: 'invalid secret' });
    await runStart();
    expect(mocks.install).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('run reports newly published subscriptions without opening the configuration page', async () => {
    mocks.diagnosis.mockResolvedValue({ state: 'missing', missingRequired: ['im.message.receive_v1'] });
    mocks.poll.mockResolvedValue(healthy);
    const result = await ensureOnboarded({ bot: 'test' });
    expect(result).not.toBeNull();
    if (!result) throw new Error('expected onboarded bot');
    await announceEventsWhenLive(result);
    expect(mocks.poll).toHaveBeenCalledOnce();
    expect(output()).toContain('事件订阅检测已更新');
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.prompt).not.toHaveBeenCalled();
  });
});
