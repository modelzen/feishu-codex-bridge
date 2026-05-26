import type { TenantBrand } from '../config/schema';

const ENDPOINTS: Record<TenantBrand, string> = {
  feishu: 'https://open.feishu.cn',
  lark: 'https://open.larksuite.com',
};

export interface ValidationResult {
  ok: boolean;
  reason?: string;
  botName?: string;
  botOpenId?: string;
}

interface TokenResp {
  code?: number;
  msg?: string;
  tenant_access_token?: string;
}

interface BotInfoResp {
  code?: number;
  bot?: { activate_status?: number; app_name?: string; open_id?: string };
}

/** Validate app credentials by exchanging for a tenant_access_token. */
export async function validateAppCredentials(
  appId: string,
  appSecret: string,
  tenant: TenantBrand,
): Promise<ValidationResult> {
  const base = ENDPOINTS[tenant];
  let resp: Response;
  try {
    resp = await fetch(`${base}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    });
  } catch (err) {
    return { ok: false, reason: `网络错误：${err instanceof Error ? err.message : String(err)}` };
  }
  if (!resp.ok) return { ok: false, reason: `HTTP ${resp.status}` };
  let data: TokenResp;
  try {
    data = (await resp.json()) as TokenResp;
  } catch {
    return { ok: false, reason: '响应不是合法 JSON' };
  }
  if (data.code !== 0 || !data.tenant_access_token) {
    return { ok: false, reason: `code=${data.code ?? '?'} msg=${data.msg ?? '<no msg>'}` };
  }
  const info = await fetchBotInfo(base, data.tenant_access_token).catch(() => undefined);
  return { ok: true, botName: info?.bot?.app_name, botOpenId: info?.bot?.open_id };
}

async function fetchBotInfo(base: string, token: string): Promise<BotInfoResp | undefined> {
  const resp = await fetch(`${base}/open-apis/bot/v3/info`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) return undefined;
  return (await resp.json()) as BotInfoResp;
}
