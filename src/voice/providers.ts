import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../config/schema';
import { resolveAppSecret } from '../config/secret-resolver';
import { ASR_SCOPE, DEFAULT_RETRY_DELAY_MS, MAX_PCM_BYTES } from './constants';
import { VoiceFailure } from './types';

export { ASR_SCOPE } from './constants';

const REQUEST_TIMEOUT_MS = 20_000;
const MAX_RETRY_DELAY_MS = 3_600_000;
const TOKEN_EXPIRY_CODES = new Set([99991661, 99991663, 99991668]);

/** Only the response fields this client consumes; checked at their usage sites. */
interface FeishuResponse {
  code?: number | string;
  msg?: unknown;
  tenant_access_token?: string;
  expire?: number | string;
  data?: {
    scopes?: Array<{ scope_name?: string; grant_status?: number }>;
    recognition_text?: unknown;
  };
}

/** Provider error text is untrusted and can echo submitted credentials. */
export function safeReason(value: unknown, secrets: string[] = []): string {
  let s = typeof value === 'string' ? value : '';
  for (const secret of secrets) if (secret) s = s.split(secret).join('[已隐藏]');
  return s.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 240);
}

async function request(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch {
    throw new VoiceFailure('连接飞书超时或网络异常，尚不能确认租户是否可用', 'temporary_error', { issue: 'network' });
  }
}

async function readResponse(res: Response): Promise<FeishuResponse> {
  try {
    return await res.json() as FeishuResponse;
  } catch {
    throw new VoiceFailure(`服务返回无效响应（HTTP ${res.status}）`, 'temporary_error');
  }
}

function missingPermission(diagnostics: { code?: string; detail?: string } = {}): VoiceFailure {
  return new VoiceFailure(
    '尚未获得语音识别权限，套餐资格无法自动确认；免费版请勿为此开通权限',
    'missing_permission',
    { ...diagnostics, issue: 'permission' },
  );
}

export interface FeishuVoiceClient {
  checkPermission(): Promise<void>;
  recognize(pcm: Buffer): Promise<string>;
}

export function createFeishuVoiceClient(cfg: AppConfig): FeishuVoiceClient {
  let cached: { token: string; expiresAt: number } | undefined;
  const base = cfg.accounts.app.tenant === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn';

  async function token(): Promise<string> {
    if (cached && cached.expiresAt > Date.now()) return cached.token;
    let secret: string;
    try {
      secret = await resolveAppSecret(cfg);
    } catch {
      throw new VoiceFailure('无法读取飞书应用凭据，请检查机器人配置', 'unavailable', { issue: 'authentication' });
    }
    const res = await request(base + '/open-apis/auth/v3/tenant_access_token/internal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: cfg.accounts.app.id, app_secret: secret }),
    });
    const body = await readResponse(res);
    if (!res.ok || body.code !== 0 || typeof body.tenant_access_token !== 'string') {
      throw new VoiceFailure(
        '飞书应用认证失败，请检查该机器人的 App ID 和 App Secret；这不是套餐判定',
        res.status >= 500 ? 'temporary_error' : 'unavailable',
        { issue: 'authentication', code: String(body.code ?? res.status), detail: safeReason(body.msg, [secret]) },
      );
    }
    cached = {
      token: body.tenant_access_token,
      expiresAt: Date.now() + Math.max(0, Number(body.expire ?? 7200) - 120) * 1000,
    };
    return cached.token;
  }

  function check(res: Response, body: FeishuResponse, accessToken: string): void {
    if (res.ok && body.code === 0) return;
    const code = Number(body.code);
    const msg = safeReason(body.msg, [accessToken]);
    const tokenExpired = TOKEN_EXPIRY_CODES.has(code) || res.status === 401;
    if (tokenExpired) cached = undefined;
    const diagnostics = { code: String(body.code ?? res.status), detail: msg };
    if (code === 99991672) throw missingPermission(diagnostics);
    if (res.status === 429 || code === 99991400) {
      const retry = res.headers.get('Retry-After');
      const seconds = Number(retry);
      const wait = retry ? (Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retry) - Date.now()) : DEFAULT_RETRY_DELAY_MS;
      throw new VoiceFailure('飞书限制了当前请求频率，暂时无法识别；不能据此判断套餐不支持', 'temporary_error', {
        ...diagnostics,
        issue: 'rate_limit',
        retryAfterMs: Number.isFinite(wait)
          ? Math.max(DEFAULT_RETRY_DELAY_MS, Math.min(wait, MAX_RETRY_DELAY_MS))
          : DEFAULT_RETRY_DELAY_MS,
      });
    }
    if (code === 99991403) {
      throw new VoiceFailure('飞书返回本月 API 调用额度已用尽；这不等于 ASR 套餐不支持', 'unavailable', { ...diagnostics, issue: 'quota' });
    }
    if (res.status >= 500 || code === 1040102) {
      throw new VoiceFailure('飞书服务暂时异常，请稍后重试；尚不能确认当前可用性', 'temporary_error', diagnostics);
    }
    if (code === 1040101) throw new VoiceFailure('飞书无法处理此音频，已保留原语音附件', 'audio', diagnostics);
    if (tokenExpired) {
      throw new VoiceFailure('飞书应用凭据或访问令牌失效，请重新检测；这不是套餐判定', 'unavailable', { ...diagnostics, issue: 'authentication' });
    }
    // Generic 403, permission and rate-limit errors are NOT evidence of a free plan.
    const explicitPlan = /(?:免费版|免费版本|套餐|租户版本).*(?:不支持|不包含)|(?:not supported|not available).*(?:free|plan)|(?:free (?:edition|plan|version)).*(?:not support|not available)/i.test(msg);
    throw new VoiceFailure(
      explicitPlan ? '飞书明确返回：当前机器人租户的套餐不支持 ASR' : '飞书拒绝了此次调用，尚不能确定是否由套餐导致',
      'unavailable',
      { ...diagnostics, issue: explicitPlan ? 'unsupported_plan' : 'rejected' },
    );
  }

  return {
    async checkPermission() {
      const t = await token();
      const res = await request(base + '/open-apis/application/v6/scopes', { headers: { Authorization: `Bearer ${t}` } });
      const body = await readResponse(res);
      check(res, body, t);
      if (!Array.isArray(body.data?.scopes)) throw new VoiceFailure('无法获取飞书权限列表，请重新检测', 'temporary_error');
      if (!body.data.scopes.some((scope) => scope.scope_name === ASR_SCOPE && scope.grant_status === 1)) {
        throw missingPermission();
      }
    },
    async recognize(pcm) {
      if (pcm.length > MAX_PCM_BYTES || !pcm.length) throw new VoiceFailure('音频不在飞书支持的 0–60 秒范围内', 'audio');
      const t = await token();
      const res = await request(base + '/open-apis/speech_to_text/v1/speech/file_recognize', {
        method: 'POST',
        headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          speech: { speech: pcm.toString('base64') },
          config: { file_id: randomUUID().replaceAll('-', '').slice(0, 16), format: 'pcm', engine_type: '16k_auto' },
        }),
      });
      const body = await readResponse(res);
      check(res, body, t);
      if (typeof body.data?.recognition_text !== 'string') throw new VoiceFailure('飞书响应缺少转写结果', 'temporary_error');
      return body.data.recognition_text.trim();
    },
  };
}
