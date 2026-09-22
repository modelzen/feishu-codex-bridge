import { describe, expect, it, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { createAppPreferencesWriter } from '../src/admin/ops';
import type { AppConfig } from '../src/config/schema';
import { createVoiceService, validateVoiceAction } from '../src/voice/service';
import { voiceView } from '../src/voice/view';
import { VoiceFailure, type VoiceConfig } from '../src/voice/types';
import { createFeishuVoiceClient } from '../src/voice/providers';
import { opusToPcm } from '../src/voice/audio';
import { probePcm } from '../src/voice/probe';
import { createIntakeQueue } from '../src/voice/inbound';

function setup(voice: VoiceConfig = { enabled: true }) {
  const cfg: AppConfig = { accounts: { app: { id: 'cli_test', secret: 'secret', tenant: 'feishu' } }, preferences: { voice } };
  const feishu = { checkPermission: vi.fn(async () => {}), recognize: vi.fn(async () => '飞书文字') };
  const decode = vi.fn(async () => Buffer.alloc(32));
  const persist = vi.fn(async () => {});
  const service = createVoiceService(cfg, createAppPreferencesWriter({ cfg, persistConfig: persist }), { feishu, decode });
  return { cfg, feishu, decode, service, persist };
}
const ready = { state: 'ready' as const, message: '通过' };
afterEach(() => vi.unstubAllGlobals());

describe('voice routing and setup', () => {
  it('checks permission only after enabling and prevents tests while disabled', async () => {
    const t = setup({ enabled: false });
    await expect(t.service.action({ action: 'test' })).rejects.toThrow('请先开启');
    expect(t.feishu.checkPermission).not.toHaveBeenCalled();
    await t.service.action({ action: 'enable' }); await t.service.settled();
    expect(t.feishu.checkPermission).toHaveBeenCalledOnce();
    expect(t.feishu.recognize).not.toHaveBeenCalled();
    expect(voiceView(t.cfg)).toMatchObject({ enabled: true, feishu: { state: 'permission_ready' } });
    await t.service.action({ action: 'test' }); await t.service.settled();
    expect(t.feishu.recognize).toHaveBeenCalledOnce();
    expect(voiceView(t.cfg)).toMatchObject({ enabled: true, feishu: { state: 'ready' } });
    await t.service.action({ action: 'disable' });
    await expect(t.service.action({ action: 'test' })).rejects.toThrow('请先开启');
  });

  it('refreshes a cached missing permission without uploading audio or changing the switch', async () => {
    const t = setup({ enabled: true, feishu: { state: 'missing_permission', message: '缺权限' } });
    await t.service.action({ action: 'refreshPermission' }); await t.service.settled();
    expect(t.feishu.checkPermission).toHaveBeenCalledOnce();
    expect(t.feishu.recognize).not.toHaveBeenCalled();
    expect(voiceView(t.cfg)).toMatchObject({ enabled: true, feishu: { state: 'permission_ready' } });
    await t.service.action({ action: 'disable' });
    await expect(t.service.action({ action: 'refreshPermission' })).rejects.toThrow('请先开启');
    expect(t.feishu.checkPermission).toHaveBeenCalledOnce();
  });
  it('keeps the authorization prompt when a fresh permission query still fails', async () => {
    const t = setup({ enabled: true, feishu: { state: 'missing_permission', message: '缺权限' } });
    t.feishu.checkPermission.mockRejectedValue(new VoiceFailure('缺权限', 'missing_permission'));
    await t.service.action({ action: 'refreshPermission' }); await t.service.settled();
    expect(voiceView(t.cfg).feishu.state).toBe('missing_permission');
    expect(t.feishu.recognize).not.toHaveBeenCalled();
  });
  it('uses Feishu ASR after checking permission', async () => {
    const t = setup({ enabled: true });
    expect(await t.service.transcribe(Buffer.from('voice'))).toEqual({ text: '飞书文字', provider: 'feishu' });
    expect(t.feishu.checkPermission).toHaveBeenCalledOnce();
  });
  it('caches missing permission and skips it until explicit recheck', async () => {
    const t = setup({ enabled: true });
    t.feishu.checkPermission.mockRejectedValueOnce(new VoiceFailure('缺权限', 'missing_permission'));
    expect(await t.service.transcribe(Buffer.from('voice'))).toHaveProperty('reason');
    await t.service.transcribe(Buffer.from('voice'));
    expect(t.feishu.checkPermission).toHaveBeenCalledOnce();
    expect(t.decode).not.toHaveBeenCalled();
    await t.service.action({ action: 'test' }); await t.service.settled();
    expect(voiceView(t.cfg).feishu.state).toBe('ready');
    await t.service.transcribe(Buffer.from('voice'));
    expect(t.feishu.recognize).toHaveBeenCalledTimes(2); // probe + actual message
  });
  it('does not infer a free plan from missing permission or make recognition calls during that probe', async () => {
    const t = setup(); t.feishu.checkPermission.mockRejectedValue(new VoiceFailure('缺权限', 'missing_permission'));
    await t.service.action({ action: 'enable' }); await t.service.settled();
    expect(voiceView(t.cfg).feishu.state).toBe('missing_permission');
    expect(t.feishu.recognize).not.toHaveBeenCalled();
  });
  it('blocks explicit entitlement failure without repeated attempts', async () => {
    const t = setup(); t.feishu.recognize.mockRejectedValue(new VoiceFailure('当前租户不支持', 'unavailable'));
    expect(await t.service.transcribe(Buffer.from('voice'))).toHaveProperty('reason');
    await t.service.transcribe(Buffer.from('voice'));
    expect(t.feishu.recognize).toHaveBeenCalledOnce();
  });
  it('recovers temporary failures after cooldown and does not poll during it', async () => {
    const t = setup({ enabled: true });
    t.feishu.recognize.mockRejectedValueOnce(new VoiceFailure('限流', 'temporary_error'));
    await t.service.transcribe(Buffer.from('voice')); await t.service.transcribe(Buffer.from('voice'));
    expect(t.feishu.recognize).toHaveBeenCalledOnce();
    t.cfg.preferences!.voice!.feishu!.retryAt = Date.now() - 1;
    expect(await t.service.transcribe(Buffer.from('voice'))).toHaveProperty('provider', 'feishu');
  });
  it('preserves successful silence', async () => {
    const t = setup({ enabled: true }); t.feishu.recognize.mockResolvedValue('');
    expect(await t.service.transcribe(Buffer.from('voice'))).toEqual({ text: '', provider: 'feishu' });
  });
  it('preserves long audio without disabling Feishu', async () => {
    const t = setup({ enabled: true, feishu: ready });
    expect(await t.service.transcribe(Buffer.from('voice'), 65000)).toHaveProperty('reason');
    expect(t.decode).not.toHaveBeenCalled(); expect(voiceView(t.cfg).feishu.state).toBe('ready');
  });
  it('falls back on decode failure but leaves Feishu available for other clips', async () => {
    const t = setup({ enabled: true, feishu: ready });
    t.decode.mockRejectedValue(new VoiceFailure('损坏', 'audio'));
    expect(await t.service.transcribe(Buffer.from('voice'))).toHaveProperty('reason');
    expect(voiceView(t.cfg).feishu.state).toBe('ready');
  });
  it('does not call ASR when disabled or oversized', async () => {
    const t = setup({ enabled: false });
    expect(await t.service.transcribe(Buffer.from('voice'))).toHaveProperty('reason');
    t.cfg.preferences!.voice!.enabled = true;
    expect(await t.service.transcribe(Buffer.alloc(20 * 1024 * 1024 + 1))).toHaveProperty('reason');
    expect(t.feishu.checkPermission).not.toHaveBeenCalled();
  });
  it('ignores historical alternate-provider config and drops its references on update', async () => {
    const legacy = { enabled: true, doubaoSecretId: 'old-secret', doubao: ready };
    const t = setup(legacy);
    t.feishu.recognize.mockRejectedValueOnce(new VoiceFailure('套餐不支持', 'unavailable', { issue: 'unsupported_plan' }));
    expect(await t.service.transcribe(Buffer.from('voice'))).toHaveProperty('reason');
    expect(t.cfg.preferences!.voice).not.toHaveProperty('doubaoSecretId');
    expect(voiceView(t.cfg).result).toContain('当前租户不支持');
    expect(voiceView(t.cfg)).not.toHaveProperty('doubao');
  });
  it('enforces retry cooldown for manual tests even across disabling', async () => {
    const t = setup();
    t.feishu.recognize.mockRejectedValueOnce(new VoiceFailure('限流', 'temporary_error', { issue: 'rate_limit', retryAfterMs: 120_000 }));
    await t.service.transcribe(Buffer.from('voice'));
    await expect(t.service.action({ action: 'test' })).rejects.toThrow('冷却');
    await t.service.action({ action: 'disable' });
    await t.service.action({ action: 'enable' }); await t.service.settled();
    await expect(t.service.action({ action: 'test' })).rejects.toThrow('冷却');
    expect(t.feishu.recognize).toHaveBeenCalledOnce();
  });
  it('explains legacy rate-limit errors without claiming a free plan', () => {
    const t = setup({ enabled: true, feishu: { state: 'temporary_error', message: '飞书暂时不可用（99991400）：request trigger frequency limit' } });
    expect(voiceView(t.cfg).result).toBe('请求受限，请稍后测试。');
    expect(voiceView(t.cfg).feishu.issue).toBe('rate_limit');
  });
  it('does not retry legacy monthly quota errors on each message', async () => {
    const t = setup({ enabled: true, feishu: { state: 'temporary_error', message: '99991403', retryAt: 0 } });
    expect(await t.service.transcribe(Buffer.from('voice'))).toHaveProperty('reason');
    expect(t.feishu.recognize).not.toHaveBeenCalled();
    expect(voiceView(t.cfg).result).toContain('调用额度已用尽');
  });
  it('coalesces concurrent tests, and disabling invalidates their late results', async () => {
    const t = setup(); let finish!: () => void;
    t.feishu.checkPermission.mockImplementation(() => new Promise<void>(r => { finish = r; }));
    await Promise.all([t.service.action({ action: 'test' }), t.service.action({ action: 'test' })]);
    await vi.waitFor(() => expect(t.feishu.checkPermission).toHaveBeenCalledOnce());
    await t.service.action({ action: 'disable' }); finish(); await t.service.settled();
    expect(voiceView(t.cfg).enabled).toBe(false); expect(voiceView(t.cfg).feishu.state).toBe('unchecked');
  });
  it('rejects removed provider actions and arbitrary plan selection', () => {
    expect(() => validateVoiceAction({ action: 'configureDoubao', credentials: { apiKey: 'secret' } })).toThrow('无效');
    expect(() => validateVoiceAction({ action: 'removeDoubao' })).toThrow('无效');
    expect(() => validateVoiceAction({ action: 'switchPlan', plan: 'free' })).toThrow('无效');
  });
});

function response(body: unknown, status = 200, headers?: Record<string, string>) { return new Response(JSON.stringify(body), { status, headers }); }
describe('provider contracts', () => {
  it('sends real PCM speech in the Feishu request contract', async () => {
    const t = setup(); const fetch = vi.fn().mockResolvedValueOnce(response({ code: 0, tenant_access_token: 'token' }))
      .mockResolvedValueOnce(response({ code: 0, data: { scopes: [{ scope_name: 'speech_to_text:speech', grant_status: 1 }] } }))
      .mockResolvedValueOnce(response({ code: 0, data: { recognition_text: '你好' } }));
    vi.stubGlobal('fetch', fetch);
    const client = createFeishuVoiceClient(t.cfg); await client.checkPermission();
    expect(await client.recognize(await probePcm())).toBe('你好');
    const body = JSON.parse(fetch.mock.calls[2]![1].body);
    expect(body.config).toEqual({ file_id: expect.stringMatching(/^[a-f0-9]{16}$/), format: 'pcm', engine_type: '16k_auto' });
    expect(body.speech.speech).toBe((await probePcm()).toString('base64'));
  });
  it.each([
    [99991672, 'access denied', 'missing_permission', 'permission'],
    [99991400, 'request trigger frequency limit', 'temporary_error', 'rate_limit'],
    [99991403, 'monthly quota exceeded', 'unavailable', 'quota'],
    [1040102, 'network error', 'temporary_error', undefined],
    [1040101, 'invalid audio', 'audio', undefined],
    [99991663, 'expired token', 'unavailable', 'authentication'],
    [1234, '免费版不支持调用', 'unavailable', 'unsupported_plan'],
    [1234, 'forbidden', 'unavailable', 'rejected'],
  ])('maps code %s to an actionable diagnosis without guessing eligibility', async (code, msg, kind, issue) => {
    const fetch = vi.fn().mockResolvedValueOnce(response({ code: 0, tenant_access_token: 'private-token' }))
      .mockResolvedValueOnce(response({ code, msg })); vi.stubGlobal('fetch', fetch);
    await expect(createFeishuVoiceClient(setup().cfg).recognize(Buffer.alloc(32))).rejects.toMatchObject({ kind, diagnostics: { code: String(code), ...(issue ? { issue } : {}) } });
  });
  it('respects Retry-After and redacts secrets in diagnostic details', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response({ code: 0, tenant_access_token: 'private-token' }))
      .mockResolvedValueOnce(response({ code: 99991400, msg: 'limit private-token' }, 429, { 'Retry-After': '120' })); vi.stubGlobal('fetch', fetch);
    await expect(createFeishuVoiceClient(setup().cfg).recognize(Buffer.alloc(32))).rejects.toMatchObject({
      diagnostics: { retryAfterMs: 120_000, detail: 'limit [已隐藏]', issue: 'rate_limit' },
    });
  });
  it('detects missing permission without making an ASR call or inventing eligibility', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response({ code: 0, tenant_access_token: 'token' }))
      .mockResolvedValueOnce(response({ code: 0, data: { scopes: [] } })); vi.stubGlobal('fetch', fetch);
    await expect(createFeishuVoiceClient(setup().cfg).checkPermission()).rejects.toMatchObject({ kind: 'missing_permission', message: expect.stringContaining('免费版请勿') });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

});

describe('portable audio and ordered intake', () => {
  it('embeds non-silent test speech in valid PCM', async () => {
    const pcm = await probePcm(); expect(pcm.length).toBeGreaterThan(32000); expect(pcm.some(v => v !== 0)).toBe(true);
  });
  it('decodes packaged Ogg Opus on Node without ffmpeg', async () => {
    const audio = readFileSync(new URL('./fixtures/voice-probe.ogg', import.meta.url));
    const pcm = await opusToPcm(audio);
    expect(pcm.length / 32000).toBeGreaterThan(1); expect(pcm.length / 32000).toBeLessThan(2);
    expect(pcm.some(v => v !== 0)).toBe(true);
  });
  it('orders slow voice before text, isolates topics and recovers after rejection', async () => {
    const queue = createIntakeQueue(); const order: string[] = []; let finish!: () => void;
    const a = queue('topic', async () => { await new Promise<void>(r => { finish = r; }); order.push('voice'); });
    const b = queue('topic', async () => { order.push('text'); });
    await queue('other', async () => { order.push('other'); });
    expect(order).toEqual(['other']); finish(); await Promise.all([a, b]); expect(order).toEqual(['other', 'voice', 'text']);
    await expect(queue('topic', async () => { throw new Error('failed'); })).rejects.toThrow('failed');
    expect(await queue('topic', async () => 'recovered')).toBe('recovered');
  });
});
