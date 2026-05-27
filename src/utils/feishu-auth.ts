import type { TenantBrand } from '../config/schema';
import { REQUIRED_SCOPES } from '../config/scopes';

const ENDPOINTS: Record<TenantBrand, string> = {
  feishu: 'https://open.feishu.cn',
  lark: 'https://open.larksuite.com',
};

export interface ValidationResult {
  ok: boolean;
  reason?: string;
  botName?: string;
  botOpenId?: string;
  /**
   * Required scopes the app hasn't been granted yet (best-effort; undefined if
   * the scope list couldn't be fetched). Empty array = all granted.
   */
  missingScopes?: string[];
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
  const token = data.tenant_access_token;
  const info = await fetchBotInfo(base, token).catch(() => undefined);
  const missingScopes = await fetchMissingScopes(base, token).catch(() => undefined);
  return { ok: true, botName: info?.bot?.app_name, botOpenId: info?.bot?.open_id, missingScopes };
}

async function fetchBotInfo(base: string, token: string): Promise<BotInfoResp | undefined> {
  const resp = await fetch(`${base}/open-apis/bot/v3/info`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) return undefined;
  return (await resp.json()) as BotInfoResp;
}

interface ScopeListResp {
  data?: { scopes?: { scope_name: string; grant_status: number }[] };
}

/**
 * Which {@link REQUIRED_SCOPES} the app still lacks. `grant_status === 1` means
 * granted; scopes missing from the list count as not granted. Returns undefined
 * (not []) on any failure so callers can tell "all granted" from "couldn't check".
 */
async function fetchMissingScopes(base: string, token: string): Promise<string[] | undefined> {
  const resp = await fetch(`${base}/open-apis/application/v6/scopes`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) return undefined;
  const body = (await resp.json()) as ScopeListResp;
  if (!body.data?.scopes) return undefined;
  const granted = new Set(body.data.scopes.filter((s) => s.grant_status === 1).map((s) => s.scope_name));
  return REQUIRED_SCOPES.filter((s) => !granted.has(s));
}
