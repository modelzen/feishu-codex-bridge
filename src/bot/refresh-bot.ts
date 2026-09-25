import { readFile } from 'node:fs/promises';
import { loadBots } from '../config/bots';
import { botPaths } from '../config/paths';
import { loadConfig } from '../config/store';
import { isComplete, secretKeyForApp } from '../config/schema';
import { setSecret } from '../config/keystore';
import { validateAppCredentials } from '../utils/feishu-auth';
import { startRegistration, registrationErrorCode, type StartRegistrationOptions } from './wizard';
import type { QrRegisterFailure, QrRegisterResult } from '../admin/service';

export async function refreshBotCredentials(
  appId: string,
  options: Omit<StartRegistrationOptions, 'appId'> & { signal: AbortSignal },
  register = startRegistration,
  validate = validateAppCredentials,
): Promise<QrRegisterResult | QrRegisterFailure> {
  const fail = (code: QrRegisterFailure['code'], reason: string): QrRegisterFailure => ({ ok: false, code, reason });
  try {
    const entry = (await loadBots()).bots.find(bot => bot.appId === appId);
    const file = botPaths(appId).configFile;
    const original = await readFile(file, 'utf8');
    const config = await loadConfig(file);
    if (!entry || !isComplete(config) || config.accounts.app.id !== appId || config.accounts.app.tenant !== entry.tenant) {
      return fail('stale_target', 'Agent 已移除或配置已变更，请重新加载。');
    }
    const owner = config.preferences?.access?.ownerOpenId;
    const secret = config.accounts.app.secret;
    if (!owner || typeof secret !== 'object' || secret.source !== 'exec' || secret.provider !== 'bridge' || secret.id !== secretKeyForApp(appId)) {
      return fail('credential_rejected', '此 Agent 未使用 Bridge 密钥存储或缺少管理员，无法刷新凭据。');
    }
    const creds = await register({ ...options, appId });
    if (options.signal.aborted) return fail('abort', '已取消。');
    if (creds.clientId !== appId || creds.tenant !== entry.tenant) return fail('credential_rejected', '扫码返回的应用或租户不匹配，未保存凭据。');
    if (!creds.operatorOpenId || (creds.operatorOpenId !== owner && !config.preferences?.access?.admins?.includes(creds.operatorOpenId))) {
      return fail('access_denied', '请由此 Agent 已有的所有者或管理员扫码，未保存凭据。');
    }
    const validation = await validate(appId, creds.clientSecret, entry.tenant);
    if (!validation.ok) return fail('credential_rejected', '新凭据校验失败，未保存。');
    await setSecret(secretKeyForApp(appId), creds.clientSecret, async () => {
      if (options.signal.aborted) throw { code: 'abort' };
      const current = (await loadBots()).bots.find(bot => bot.appId === appId);
      if (JSON.stringify(current) !== JSON.stringify(entry) || await readFile(file, 'utf8') !== original) throw { code: 'stale_target' };
    });
    return { ok: true, appId, name: entry.name, tenant: entry.tenant, adminOpenId: owner, botName: entry.botName, missingScopes: validation.missingScopes };
  } catch (error) {
    const code = registrationErrorCode(error);
    if (code === 'abort') return fail('abort', '已取消。');
    if (code === 'stale_target') return fail('stale_target', '配置在扫码期间发生变化，未保存凭据，请重试。');
    if (code === 'expired_token' || code === 'access_denied') return fail(code, '授权已过期或被拒绝，请重试。');
    return fail('persist_failed', '刷新凭据失败，未完成保存。');
  }
}
