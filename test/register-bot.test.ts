import { rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// 把整个 ~/.feishu-codex-bridge 指到临时目录——keystore(secrets.enc/.salt) +
// bots.json + 每 bot config.json 全落临时区，绝不碰真实用户数据。secretsGetterScript
// 也指到临时区（buildEncryptedAccountConfig 会写它）。
vi.mock('../src/config/paths', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const appDir = mkdtempSync(join(tmpdir(), 'register-bot-test-'));
  const botDir = (appId: string): string => join(appDir, 'bots', appId);
  const botPaths = (appId: string) => {
    const dir = botDir(appId);
    return {
      dir,
      configFile: join(dir, 'config.json'),
      sessionsFile: join(dir, 'sessions.json'),
      projectsFile: join(dir, 'projects.json'),
      processesFile: join(dir, 'processes.json'),
    };
  };
  let currentBotDir = appDir;
  return {
    botDir,
    botPaths,
    useBotDir: (appId: string): void => {
      currentBotDir = botDir(appId);
    },
    paths: {
      appDir,
      cacheDir: appDir,
      botsFile: join(appDir, 'bots.json'),
      secretsFile: join(appDir, 'secrets.enc'),
      keystoreSaltFile: join(appDir, '.keystore.salt'),
      secretsGetterScript: join(appDir, 'secrets-getter'),
      get configFile(): string {
        return join(currentBotDir, 'config.json');
      },
    },
  };
});

import { refreshBotCredentials } from '../src/bot/refresh-bot';
import { registerBotFromCredentials } from '../src/bot/register-bot';
import { getSecret } from '../src/config/keystore';
import { loadBots, saveBots } from '../src/config/bots';
import { botPaths, paths } from '../src/config/paths';
import { secretKeyForApp } from '../src/config/schema';

const okValidate = vi.fn(async () => ({
  ok: true as const,
  botName: '阿尔法机器人',
  missingScopes: ['im:resource'],
}));

afterAll(() => {
  rmSync(paths.appDir, { recursive: true, force: true });
});

beforeEach(() => {
  okValidate.mockClear();
});

describe('registerBotFromCredentials · 校验', () => {
  it('空 appId / 空 secret → invalid_input（绝不打真 API）', async () => {
    const r1 = await registerBotFromCredentials(
      { appId: '', appSecret: 's', tenant: 'feishu', ownerOpenId: 'ou_scanner' },
      okValidate,
    );
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.code).toBe('invalid_input');
    const r2 = await registerBotFromCredentials(
      { appId: 'cli_abc123', appSecret: '', tenant: 'feishu', ownerOpenId: 'ou_scanner' },
      okValidate,
    );
    expect(r2.ok).toBe(false);
    expect(okValidate).not.toHaveBeenCalled();
  });

  it('appId 格式不对 → invalid_input（不以 cli_ 开头）', async () => {
    const r = await registerBotFromCredentials(
      { appId: 'not_an_app', appSecret: 'sec', tenant: 'feishu', ownerOpenId: 'ou_scanner' },
      okValidate,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('invalid_input');
    expect(okValidate).not.toHaveBeenCalled();
  });

  it('探活失败 → credential_rejected，且坏密钥绝不落 keystore', async () => {
    const badValidate = vi.fn(async () => ({ ok: false as const, reason: 'code=10003 msg=invalid' }));
    const r = await registerBotFromCredentials(
      { appId: 'cli_badbad99', appSecret: 'wrong', tenant: 'feishu', ownerOpenId: 'ou_scanner' },
      badValidate,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('credential_rejected');
      expect(r.reason).toContain('10003');
    }
    expect(await getSecret(secretKeyForApp('cli_badbad99'))).toBeUndefined();
    const reg = await loadBots();
    expect(reg.bots.find((b) => b.appId === 'cli_badbad99')).toBeUndefined();
  });
});

describe('registerBotFromCredentials · 注册落盘', () => {
  it('成功：secret 进 keystore（明文绝不进 config.json）+ bots.json 注册 + 返回基本信息', async () => {
    const r = await registerBotFromCredentials(
      { appId: 'cli_alpha12345', appSecret: 'super-secret-value', tenant: 'feishu', ownerOpenId: 'ou_scanner' },
      okValidate,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.appId).toBe('cli_alpha12345');
    expect(r.botName).toBe('阿尔法机器人');
    expect(r.missingScopes).toEqual(['im:resource']);
    expect(okValidate).toHaveBeenCalledWith('cli_alpha12345', 'super-secret-value', 'feishu');

    // 密钥进 keystore，可解密回原值
    expect(await getSecret(secretKeyForApp('cli_alpha12345'))).toBe('super-secret-value');

    // config.json 里绝不出现明文密钥（只存指向 keystore 的 exec SecretRef）
    const cfgRaw = readFileSync(botPaths('cli_alpha12345').configFile, 'utf8');
    expect(cfgRaw).not.toContain('super-secret-value');
    expect(cfgRaw).toContain('exec');

    // 注册表 + 唯一短名
    const reg = await loadBots();
    const entry = reg.bots.find((b) => b.appId === 'cli_alpha12345');
    expect(entry).toBeTruthy();
    expect(entry!.tenant).toBe('feishu');
    expect(entry!.botName).toBe('阿尔法机器人');
    expect(reg.current).toBe('cli_alpha12345'); // 首个注册成为 current
  });

  it('重复添加拒绝覆盖密钥与已有 Agent', async () => {
    await registerBotFromCredentials(
      { appId: 'cli_dup1234567', appSecret: 'secret-1', tenant: 'feishu', ownerOpenId: 'ou_dup' },
      okValidate,
    );
    const before = await loadBots();
    const original = before.bots.find(b => b.appId === 'cli_dup1234567')!;
    original.active = true;
    await saveBots(before);
    const duplicate = await registerBotFromCredentials(
      { appId: 'cli_dup1234567', appSecret: 'secret-2', tenant: 'feishu', ownerOpenId: 'ou_dup' },
      okValidate,
    );
    expect(duplicate).toMatchObject({ ok: false, code: 'already_registered' });
    expect(await getSecret(secretKeyForApp('cli_dup1234567'))).toBe('secret-1');
    const reg = await loadBots();
    expect(reg.bots.filter((b) => b.appId === 'cli_dup1234567')).toEqual([original]);
  });

  it('lark 租户透传给探活与注册', async () => {
    const r = await registerBotFromCredentials(
      { appId: 'cli_lark1234567', appSecret: 'sec', tenant: 'lark', ownerOpenId: 'ou_lark' },
      okValidate,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.tenant).toBe('lark');
    expect(okValidate).toHaveBeenCalledWith('cli_lark1234567', 'sec', 'lark');
  });

  it('secretsGetterScript / config 都落在临时目录里（没污染真实 appDir）', () => {
    expect(existsSync(paths.appDir)).toBe(true);
    expect(paths.appDir).toContain('register-bot-test-');
  });
});

describe('registerBotFromCredentials · ownerOpenId（扫码人 = owner+admin）', () => {
  it('传 ownerOpenId → config.preferences.access 落 ownerOpenId + admins 含它', async () => {
    const r = await registerBotFromCredentials(
      { appId: 'cli_owner123456', appSecret: 'sec', tenant: 'feishu', ownerOpenId: 'ou_scanner' },
      okValidate,
    );
    expect(r.ok).toBe(true);
    const cfg = JSON.parse(readFileSync(botPaths('cli_owner123456').configFile, 'utf8'));
    expect(cfg.preferences.access.ownerOpenId).toBe('ou_scanner');
    expect(cfg.preferences.access.admins).toContain('ou_scanner');
  });

  it('ownerOpenId 为空 → 拒绝保存无人可管理的配置', async () => {
    const r = await registerBotFromCredentials(
      { appId: 'cli_noowner1234', appSecret: 'sec', tenant: 'feishu', ownerOpenId: '   ' },
      okValidate,
    );
    expect(r).toMatchObject({ ok: false, code: 'invalid_input' });
    if (!r.ok) expect(r.reason).toContain('未获取到扫码人的飞书身份');
    expect(okValidate).not.toHaveBeenCalled();
    expect(await getSecret(secretKeyForApp('cli_noowner1234'))).toBeUndefined();
    expect(() => readFileSync(botPaths('cli_noowner1234').configFile, 'utf8')).toThrow();
    expect((await loadBots()).bots.find((b) => b.appId === 'cli_noowner1234')).toBeUndefined();
  });

  it('幂等：同 appId 重扫 owner，admins 去重不重复堆叠', async () => {
    await registerBotFromCredentials(
      { appId: 'cli_dupowner99', appSecret: 's1', tenant: 'feishu', ownerOpenId: 'ou_o' },
      okValidate,
    );
    await registerBotFromCredentials(
      { appId: 'cli_dupowner99', appSecret: 's2', tenant: 'feishu', ownerOpenId: 'ou_o' },
      okValidate,
    );
    const cfg = JSON.parse(readFileSync(botPaths('cli_dupowner99').configFile, 'utf8'));
    expect(cfg.preferences.access.admins.filter((a: string) => a === 'ou_o')).toHaveLength(1);
  });
});


describe('targeted credential refresh', () => {
  let serial = 0;
  async function fixture() {
    const appId = `cli_refresh${++serial}`;
    await registerBotFromCredentials({ appId, appSecret: 'original', tenant: 'feishu', ownerOpenId: 'ou_owner' }, okValidate);
    const files = botPaths(appId);
    const config = JSON.parse(readFileSync(files.configFile, 'utf8'));
    config.preferences.access.admins.push('ou_admin');
    config.preferences.tools = { display: false };
    writeFileSync(files.configFile, JSON.stringify(config));
    writeFileSync(files.projectsFile, '{"project":"unchanged"}');
    writeFileSync(files.sessionsFile, '{"session":"unchanged"}');
    const preserved = [files.configFile, files.projectsFile, files.sessionsFile, paths.botsFile];
    const before = preserved.map(file => readFileSync(file, 'utf8'));
    const abort = new AbortController();
    const creds = { clientId: appId, clientSecret: 'replacement', tenant: 'feishu' as const, operatorOpenId: 'ou_admin' };
    return { appId, files, preserved, before, abort, creds, options: { signal: abort.signal, onQr: vi.fn() } };
  }

  it('rotates only target encrypted secret, preserving owner and all data bytes', async () => {
    const f = await fixture();
    const register = vi.fn(async () => f.creds);
    const other = await fixture();
    const registryBefore = readFileSync(paths.botsFile, 'utf8');
    const result = await refreshBotCredentials(f.appId, f.options, register, okValidate);
    expect(result).toMatchObject({ ok: true, appId: f.appId, adminOpenId: 'ou_owner' });
    expect(register).toHaveBeenCalledWith({ ...f.options, appId: f.appId });
    expect(await getSecret(secretKeyForApp(f.appId))).toBe('replacement');
    expect(await getSecret(secretKeyForApp(other.appId))).toBe('original');
    expect(readFileSync(paths.botsFile, 'utf8')).toBe(registryBefore);
    expect(f.preserved.slice(0, 3).map(file => readFileSync(file, 'utf8'))).toEqual(f.before.slice(0, 3));
    expect(readFileSync(paths.secretsFile, 'utf8')).not.toContain('replacement');
    expect(JSON.stringify(result)).not.toContain('replacement');
  });

  it.each(['wrong-app', 'wrong-tenant', 'wrong-scanner', 'abort', 'stale', 'rejected'] as const)('refuses %s without writing any encrypted data', async failure => {
    const f = await fixture();
    const beforeSecret = readFileSync(paths.secretsFile, 'utf8');
    const register = vi.fn(async () => {
      if (failure === 'wrong-app') f.creds.clientId = 'cli_unrelated';
      if (failure === 'wrong-scanner') f.creds.operatorOpenId = 'ou_stranger';
      if (failure === 'abort') f.abort.abort();
      if (failure === 'stale') writeFileSync(f.files.configFile, `${f.before[0]} `);
      return failure === 'wrong-tenant' ? { ...f.creds, tenant: 'lark' as const } : f.creds;
    });
    const validate = failure === 'rejected' ? vi.fn(async () => ({ ok: false as const, reason: 'replacement' })) : okValidate;
    const result = await refreshBotCredentials(f.appId, f.options, register, validate);
    expect(result.ok).toBe(false);
    expect(readFileSync(paths.secretsFile, 'utf8')).toBe(beforeSecret);
    expect(JSON.stringify(result)).not.toContain('replacement');
    expect(await getSecret(secretKeyForApp(f.appId))).toBe('original');
  });

  it('honors cancellation during validation before encrypted commit', async () => {
    const f = await fixture();
    const before = readFileSync(paths.secretsFile, 'utf8');
    const result = await refreshBotCredentials(f.appId, f.options, async () => f.creds, async () => {
      f.abort.abort();
      return { ok: true };
    });
    expect(result).toMatchObject({ ok: false, code: 'abort' });
    expect(readFileSync(paths.secretsFile, 'utf8')).toBe(before);
  });
});
