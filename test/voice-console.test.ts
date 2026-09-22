import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CardDispatcher } from '../src/card/dispatcher';
import { buildSettingsCard, buildVoiceSettingsCard, DM } from '../src/card/dm-cards';
import { createAppPreferencesWriter } from '../src/admin/ops';
import { createVoiceService } from '../src/voice/service';
import { VoiceFailure } from '../src/voice/types';
import { registerVoiceConsole } from '../src/bot/voice-console';
import type { AppConfig } from '../src/config/schema';
const managed = vi.hoisted(() => ({ update: vi.fn(async (_channel: unknown, _messageId: string, _card: object) => true), send: vi.fn(async () => ({ messageId: 'fresh-card' })) }));
vi.mock('../src/card/managed', () => ({ updateManagedCard: managed.update, sendManagedCard: managed.send }));
vi.mock('../src/voice/probe', () => ({ probePcm: async () => Buffer.alloc(32) }));
vi.mock('../src/core/logger', () => ({ log: { info: vi.fn(), fail: vi.fn() }, withTrace: (_: unknown, run: () => unknown) => run() }));
function setup() {
  const cfg: AppConfig = { accounts: { app: { id: 'cli_test', secret: 'test', tenant: 'feishu' } }, preferences: { access: { ownerOpenId: 'owner' }, voice: { enabled: false } } };
  const persist = vi.fn(async () => undefined);
  const feishu = { checkPermission: vi.fn(async () => undefined), recognize: vi.fn(async () => '测试正文') };
  const voice = createVoiceService(cfg, createAppPreferencesWriter({ cfg, persistConfig: persist }), { feishu });
  const channel = {} as never;
  const dispatcher = new CardDispatcher(channel, cfg);
  const console = registerVoiceConsole(dispatcher, channel, cfg, voice);
  const click = (a: string, v?: string, user = 'owner', messageId = 'card') => dispatcher.handle({ messageId, chatId: 'private', operator: { openId: user }, action: { value: { a, v } } } as never);
  return { cfg, persist, feishu, voice, console, click };
}
const rendered = () => JSON.stringify(managed.update.mock.calls.at(-1)?.[2]);
beforeEach(() => { vi.useFakeTimers(); managed.update.mockReset().mockResolvedValue(true); managed.send.mockClear(); });
afterEach(() => vi.useRealTimers());

describe('private console voice configuration', () => {
  it('has a settings entry and the same concise text and documentation link', () => {
    const t = setup();
    const outer = JSON.stringify(buildSettingsCard(t.cfg));
    expect(outer).toContain(DM.voiceSettings);
    expect(outer).toContain('去开启');
    expect(JSON.stringify(buildVoiceSettingsCard(t.cfg))).not.toContain(DM.testVoice);
    expect(outer.indexOf('云文档评论')).toBeLessThan(outer.indexOf('🎙️ 语音转文字'));
    expect(outer).not.toContain('专项功能');
    expect(outer).toContain('若机器人所属租户为飞书免费版，则不支持调用');
    expect(outer).toContain('file_recognize?lang=zh-CN');
    expect(outer).not.toContain('使用权益');
    t.cfg.preferences!.voice!.enabled = true;
    expect(JSON.stringify(buildSettingsCard(t.cfg))).toContain('去关闭');
    const card = JSON.stringify(buildVoiceSettingsCard(t.cfg));
    expect(card).toContain('给 agent 发语音时，先转为文字再发送给 agent。');
    expect(card).not.toContain('免费版不支持调用');
    expect(card.indexOf(DM.testVoice)).toBeGreaterThan(card.indexOf(DM.settings));
    expect(card).toContain(DM.setVoice);
  });
  it('enables through the shared service, checks permission, and shows authorization when missing', async () => {
    const t = setup(); t.feishu.checkPermission.mockRejectedValue(new VoiceFailure('缺权限', 'missing_permission'));
    await t.click(DM.setVoice, 'on');
    await vi.advanceTimersByTimeAsync(500); await t.voice.settled();
    expect(t.cfg.preferences!.voice!.enabled).toBe(true);
    expect(t.persist).toHaveBeenCalled();
    expect(t.feishu.recognize).not.toHaveBeenCalled();
    expect(rendered()).toContain('去授权');
    expect(rendered()).toContain('speech_to_text');
  });
  it('rechecks permissions and updates the same card without making a speech recognition request', async () => {
    const t = setup(); t.cfg.preferences!.voice = { enabled: true, feishu: { state: 'missing_permission', message: '缺权限' } };
    expect(JSON.stringify(buildVoiceSettingsCard(t.cfg))).toContain(DM.refreshVoicePermission);
    await t.click(DM.refreshVoicePermission); await vi.advanceTimersByTimeAsync(500); await t.voice.settled();
    expect(t.feishu.checkPermission).toHaveBeenCalledOnce(); expect(t.feishu.recognize).not.toHaveBeenCalled();
    expect(rendered()).toContain('权限已就绪'); expect(rendered()).not.toContain('去授权');
    expect(managed.send).not.toHaveBeenCalled();
  });
  it('renders an asynchronous test result in place while preserving the enabled switch', async () => {
    const t = setup(); t.cfg.preferences!.voice!.enabled = true; let finish!: (text: string) => void;
    t.feishu.recognize.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    await t.click(DM.testVoice);
    await vi.advanceTimersByTimeAsync(500);
    expect(rendered()).toContain('正在测试转写');
    finish('你好'); await t.voice.settled(); await vi.advanceTimersByTimeAsync(0);
    expect(rendered()).toContain('转写成功');
    expect(t.cfg.preferences!.voice!.enabled).toBe(true);
    expect(managed.send).not.toHaveBeenCalled();
  });
  it('recovers an orphan card and sends the final result to its replacement', async () => {
    const t = setup(); t.cfg.preferences!.voice!.enabled = true; let finish!: (text: string) => void;
    managed.update.mockResolvedValueOnce(false);
    t.feishu.recognize.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    await t.click(DM.testVoice); await vi.advanceTimersByTimeAsync(500);
    expect(managed.send).toHaveBeenCalledOnce();
    finish('你好'); await t.voice.settled(); await vi.advanceTimersByTimeAsync(0);
    expect(managed.update.mock.calls.at(-1)?.[1]).toBe('fresh-card');
    expect(rendered()).toContain('转写成功');
  });
  it('does not overwrite the settings page after leaving a pending test card', async () => {
    const t = setup(); t.cfg.preferences!.voice!.enabled = true; let finish!: (text: string) => void;
    t.feishu.recognize.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    await t.click(DM.testVoice); await vi.advanceTimersByTimeAsync(500);
    const count = managed.update.mock.calls.length;
    t.console.leave('card'); finish('你好'); await t.voice.settled(); await vi.advanceTimersByTimeAsync(0);
    expect(managed.update).toHaveBeenCalledTimes(count);
  });
  it('hides stale authorization actions and does not check permissions while disabled', async () => {
    const t = setup();
    t.cfg.preferences!.voice!.feishu = { state: 'missing_permission', message: '缺权限' };
    expect(JSON.stringify(buildVoiceSettingsCard(t.cfg))).not.toContain('去授权');
    await t.click(DM.testVoice); await vi.advanceTimersByTimeAsync(500);
    expect(t.feishu.checkPermission).not.toHaveBeenCalled();
    expect(rendered()).toContain('请先开启');
  });
  it('rejects non-admin callbacks and invalid toggle values', async () => {
    const t = setup();
    await t.click(DM.setVoice, 'on', 'guest'); await t.click(DM.testVoice, undefined, 'guest');
    await t.click(DM.refreshVoicePermission, undefined, 'guest');
    await t.click(DM.setVoice, 'anything'); await vi.advanceTimersByTimeAsync(500);
    expect(t.persist).not.toHaveBeenCalled(); expect(t.feishu.checkPermission).not.toHaveBeenCalled();
    expect(managed.update).not.toHaveBeenCalled();
  });
});
