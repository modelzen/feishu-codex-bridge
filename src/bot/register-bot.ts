import { setSecret } from '../config/keystore';
import { buildEncryptedAccountConfig, loadConfig, saveConfig } from '../config/store';
import { botPaths } from '../config/paths';
import { isComplete, secretKeyForApp, type AppPreferences, type TenantBrand } from '../config/schema';
import { validateAppCredentials } from '../utils/feishu-auth';
import { addBot, loadBots, uniqueName } from '../config/bots';
import { log } from '../core/logger';

/**
 * 扫码注册拿到凭据后的共享落盘函数。Web 扫码在 daemon 进程内调用，不能复用
 * `registerNewBot` 的 `useBotDir()` 全局切目录写法（会把在跑 bot 的 paths 指歪），
 * 因而全程走 {@link botPaths} 的显式路径写该 bot 自己的 config.json。
 *
 * 安全：appSecret 只在本函数内一次性流过——真探活验证有效后立刻进 AES keystore
 * （config/keystore.ts），config.json 里存的是指向 keystore 的 exec SecretRef（明文
 * 绝不落 config / bots.json / 日志）。日志只记 appId + botName，绝不记 secret。
 *
 * 幂等：appId 已注册过 → addBot 按 appId 覆盖（替换 entry），keystore setSecret 覆盖
 * 旧密钥（用于同一应用重复扫码后刷新凭据）。
 */

export interface RegisterBotInput {
  appId: string;
  appSecret: string;
  tenant: TenantBrand;
  /** 期望的短句柄（默认用探活拿到的 botName / appId 派生，registry 内唯一化）。 */
  desiredName?: string;
  /** 扫码注册者的 open_id；必填并落成 owner+admin，禁止保存无管理员配置。 */
  ownerOpenId: string;
}

export interface RegisterBotResult {
  ok: true;
  name: string;
  appId: string;
  tenant: TenantBrand;
  botName?: string;
  /** 必需 scope 中尚未授权的（undefined = 没查成；空 = 已齐全）。 */
  missingScopes?: string[];
}

export interface RegisterBotFailure {
  ok: false;
  /** 机器可分支的失败原因：格式错 / 探活拒绝（密钥无效）/ 写盘失败。 */
  code: 'invalid_input' | 'credential_rejected' | 'persist_failed';
  /** 面向人的中文原因（扫码页面展示，绝不含 secret）。 */
  reason: string;
}

/** appId 形如 `cli_xxx`（飞书自建应用）；做一道轻校验，别让明显的脏输入打真 API。 */
const APP_ID_RE = /^cli_[A-Za-z0-9]{6,}$/;

/**
 * 校验 + 真探活 + 落盘注册一个 bot。绝不 throw——所有失败都落到
 * {@link RegisterBotFailure}，扫码编排层按 code 分支映射文案。
 * `validate` 仅供测试注入（默认打真飞书 tenant_access_token 接口）。
 */
export async function registerBotFromCredentials(
  input: RegisterBotInput,
  validate: typeof validateAppCredentials = validateAppCredentials,
): Promise<RegisterBotResult | RegisterBotFailure> {
  const appId = input.appId?.trim() ?? '';
  const appSecret = input.appSecret?.trim() ?? '';
  const ownerOpenId = input.ownerOpenId?.trim() ?? '';
  const tenant: TenantBrand = input.tenant === 'lark' ? 'lark' : 'feishu';

  if (!appId || !appSecret) {
    return { ok: false, code: 'invalid_input', reason: 'App ID 与 App Secret 都不能为空。' };
  }
  if (!ownerOpenId) {
    return {
      ok: false,
      code: 'invalid_input',
      reason: '未获取到扫码人的飞书身份，已拒绝保存无管理员的机器人配置。请重新扫码。',
    };
  }
  if (!APP_ID_RE.test(appId)) {
    return {
      ok: false,
      code: 'invalid_input',
      reason: 'App ID 格式不对：应为开发者后台「凭证与基础信息」里的 App ID（形如 cli_ 开头）。',
    };
  }

  // 真探活：换 tenant_access_token，密钥无效直接拒绝——不让坏密钥落进 keystore。
  const v = await validate(appId, appSecret, tenant);
  if (!v.ok) {
    return {
      ok: false,
      code: 'credential_rejected',
      reason: `凭据校验失败：${v.reason ?? '未知原因'}。请核对 App ID / App Secret（应用可能被禁用或 Secret 已重置）。`,
    };
  }

  try {
    // secret 先进 keystore（AES-256-GCM），再写指向它的 exec SecretRef config——
    // 顺序保证 config 落盘时密钥已可解析；明文绝不进 config.json / bots.json。
    await setSecret(secretKeyForApp(appId), appSecret);

    const files = botPaths(appId);
    // 显式路径读旧 config（同 appId 重复扫码时保留既有 preferences，如管理员名单），
    // 不存在 / 不完整就建全新的——绝不 useBotDir 切全局目录。
    const existing = await loadConfig(files.configFile);
    const basePrefs = isComplete(existing) ? existing.preferences : undefined;
    // 扫码人 open_id → 落成 owner+admin（与 CLI wizard 对齐）。
    const preferences = withOwnerAdmin(basePrefs, ownerOpenId);
    const cfg = await buildEncryptedAccountConfig(appId, tenant, preferences);
    await saveConfig(cfg, files.configFile);

    const reg = await loadBots();
    const name = uniqueName(reg, input.desiredName ?? v.botName ?? appId);
    await addBot({ name, appId, tenant, botName: v.botName, createdAt: Date.now() });

    log.info('register-bot', 'bot-registered', { name, appId, bot: v.botName ?? null });
    return { ok: true, name, appId, tenant, botName: v.botName, missingScopes: v.missingScopes };
  } catch (err) {
    log.fail('register-bot', err, { phase: 'persist', appId });
    return {
      ok: false,
      code: 'persist_failed',
      reason: `保存失败：${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * 把扫码人 open_id 落成 owner+admin，merge 进既有 preferences（保留 base 的其它字段
 * 与 access 字段，幂等：admins 去重）。owner 恒入 admins（与 schema 注释
 * 「ownerOpenId 恒为 admin」一致）。
 */
function withOwnerAdmin(base: AppPreferences | undefined, ownerOpenId: string): AppPreferences {
  const access = base?.access;
  const admins = new Set(access?.admins ?? []);
  admins.add(ownerOpenId);
  return {
    ...base,
    access: { ...access, ownerOpenId, admins: [...admins] },
  };
}
