import { afterEach, describe, expect, it, vi } from 'vitest';

// 隔离 registerBotByQr 的**编排**：mock SDK registerApp（推 onQr/onStatus + resolve/
// reject）与共享写盘 registerBotFromCredentials（spy 验入参），不碰真网络/keystore。
// startRegistration 的 reject-code 解析（registrationErrorCode）走真实实现。

const registerAppMock = vi.fn();
vi.mock('@larksuiteoapi/node-sdk', () => ({
  registerApp: (opts: unknown) => registerAppMock(opts),
}));

const registerBotFromCredentialsMock = vi.fn();
vi.mock('../src/bot/register-bot', () => ({
  registerBotFromCredentials: (input: unknown) => registerBotFromCredentialsMock(input),
}));

import { createAdminService } from '../src/admin/service';
import { runRegistrationWizard } from '../src/bot/wizard';

afterEach(() => {
  registerAppMock.mockReset();
  registerBotFromCredentialsMock.mockReset();
});

interface RegisterAppOpts {
  signal?: AbortSignal;
  onQRCodeReady: (info: { url: string; expireIn: number }) => void;
  onStatusChange?: (info: { status: string; interval?: number }) => void;
}

describe('registerBotByQr · 扫码编排', () => {
  it('桌面宿主 override 优先，不启动 upstream 注册或写 keystore', async () => {
    const route = vi.fn(async () => ({
      ok: false as const,
      code: 'abort' as const,
      reason: '由桌面注册控制器取消',
    }));
    const svc = createAdminService({ registerBotByQr: route });
    const opts = {
      signal: new AbortController().signal,
      onQr: vi.fn(),
    };

    await expect(svc.registerBotByQr(opts)).resolves.toEqual({
      ok: false,
      code: 'abort',
      reason: '由桌面注册控制器取消',
    });
    expect(route).toHaveBeenCalledWith(opts);
  });

  it('成功：透传 onQr/onStatus，拿明文密钥后委托 registerBotFromCredentials（含 ownerOpenId），done 不含 secret', async () => {
    registerAppMock.mockImplementation((opts: RegisterAppOpts) => {
      opts.onQRCodeReady({ url: 'https://accounts.feishu.cn/scan?c=1', expireIn: 600 });
      opts.onStatusChange?.({ status: 'polling' });
      return Promise.resolve({
        client_id: 'cli_qr12345678',
        client_secret: 'TOP-SECRET-PLAINTEXT',
        user_info: { open_id: 'ou_scanner', tenant_brand: 'feishu' },
      });
    });
    registerBotFromCredentialsMock.mockResolvedValue({
      ok: true,
      name: 'qrbot',
      appId: 'cli_qr12345678',
      tenant: 'feishu',
      botName: '扫码机器人',
      missingScopes: ['im:resource'],
    });

    const svc = createAdminService();
    const qrFrames: unknown[] = [];
    const statusFrames: unknown[] = [];
    const r = await svc.registerBotByQr({
      signal: new AbortController().signal,
      onQr: (i) => qrFrames.push(i),
      onStatus: (i) => statusFrames.push(i),
    });

    // 回调透传
    expect(qrFrames).toEqual([{ url: 'https://accounts.feishu.cn/scan?c=1', expireIn: 600 }]);
    expect(statusFrames).toEqual([{ status: 'polling', interval: undefined }]);

    // 委托写盘：明文密钥 + 扫码人 open_id 当 ownerOpenId
    expect(registerBotFromCredentialsMock).toHaveBeenCalledWith({
      appId: 'cli_qr12345678',
      appSecret: 'TOP-SECRET-PLAINTEXT',
      tenant: 'feishu',
      ownerOpenId: 'ou_scanner',
    });

    // 结果白名单字段，绝不回 secret
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.appId).toBe('cli_qr12345678');
      expect(r.adminOpenId).toBe('ou_scanner');
      expect(r.botName).toBe('扫码机器人');
      expect(r.missingScopes).toEqual(['im:resource']);
      expect(JSON.stringify(r)).not.toContain('SECRET');
    }
  });

  it('SDK reject {code:"expired_token"} → {ok:false, code:"expired_token"}（不委托写盘）', async () => {
    registerAppMock.mockRejectedValue({ code: 'expired_token', description: 'Polling timed out' });
    const svc = createAdminService();
    const r = await svc.registerBotByQr({ signal: new AbortController().signal, onQr: () => {} });
    expect(r).toEqual({ ok: false, code: 'expired_token', reason: '二维码已过期，请重新生成。' });
    expect(registerBotFromCredentialsMock).not.toHaveBeenCalled();
  });

  it('网络/TLS 抖动（无结构化 code，只有 socket 断连 message）→ code:"network" + 可操作中文（不甩英文原文）', async () => {
    // 复刻真实现场：切 VPN / 网络抖动让到开放平台的 HTTPS 握手中断，SDK 抛裸 Error。
    registerAppMock.mockRejectedValue(
      new Error('Client network socket disconnected before secure TLS connection was established'),
    );
    const svc = createAdminService();
    const r = await svc.registerBotByQr({ signal: new AbortController().signal, onQr: () => {} });
    expect(r).toMatchObject({ ok: false, code: 'network' });
    if (!r.ok) {
      expect(r.reason).toContain('飞书开放平台');
      expect(r.reason).not.toContain('socket'); // 绝不把英文原文甩给用户
    }
    expect(registerBotFromCredentialsMock).not.toHaveBeenCalled();
  });

  it('SDK reject {code:"access_denied"} → 映射拒绝文案', async () => {
    registerAppMock.mockRejectedValue({ code: 'access_denied', description: 'denied' });
    const svc = createAdminService();
    const r = await svc.registerBotByQr({ signal: new AbortController().signal, onQr: () => {} });
    expect(r).toMatchObject({ ok: false, code: 'access_denied' });
  });

  it('abort：signal.abort → SDK reject {code:"abort"} → {ok:false, code:"abort"}', async () => {
    const ac = new AbortController();
    registerAppMock.mockImplementation(
      (opts: RegisterAppOpts) =>
        new Promise((_resolve, reject) => {
          opts.onQRCodeReady({ url: 'https://x', expireIn: 600 });
          opts.signal?.addEventListener('abort', () => reject({ code: 'abort', description: 'aborted' }), { once: true });
        }),
    );
    const svc = createAdminService();
    const p = svc.registerBotByQr({ signal: ac.signal, onQr: () => {} });
    ac.abort();
    const r = await p;
    expect(r).toMatchObject({ ok: false, code: 'abort' });
    expect(registerBotFromCredentialsMock).not.toHaveBeenCalled();
  });

  it('入库失败（registerBotFromCredentials persist_failed）→ {ok:false, code:"persist_failed"}', async () => {
    registerAppMock.mockResolvedValue({
      client_id: 'cli_qr99999999',
      client_secret: 'sec',
      user_info: { open_id: 'ou_x', tenant_brand: 'feishu' },
    });
    registerBotFromCredentialsMock.mockResolvedValue({ ok: false, code: 'persist_failed', reason: '保存失败：磁盘满' });
    const svc = createAdminService();
    const r = await svc.registerBotByQr({ signal: new AbortController().signal, onQr: () => {} });
    expect(r).toMatchObject({ ok: false, code: 'persist_failed' });
    if (!r.ok) expect(r.reason).toContain('磁盘满');
  });

  it('SDK 未返回 open_id：拒绝落盘，避免产生无人可管理的机器人', async () => {
    registerAppMock.mockResolvedValue({ client_id: 'cli_qrnoopen11', client_secret: 'sec', user_info: {} });
    const svc = createAdminService();
    const r = await svc.registerBotByQr({ signal: new AbortController().signal, onQr: () => {} });
    expect(r).toMatchObject({ ok: false, code: 'identity_missing' });
    if (!r.ok) expect(r.reason).toContain('未获取到扫码人的飞书身份');
    expect(registerBotFromCredentialsMock).not.toHaveBeenCalled();
  });
});

describe('runRegistrationWizard · owner 不变量', () => {
  it('CLI 扫码返回空白 open_id：拒绝返回无人可管理的配置', async () => {
    registerAppMock.mockResolvedValue({ client_id: 'cli_qrcli11111', client_secret: 'sec', user_info: { open_id: '   ' } });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await expect(runRegistrationWizard()).rejects.toThrow('未获取到你的飞书身份');
    } finally {
      log.mockRestore();
    }
  });
});
