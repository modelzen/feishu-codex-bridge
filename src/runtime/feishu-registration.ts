import { registerApp } from '@larksuiteoapi/node-sdk';
import type { TenantBrand } from '../config/schema';

export interface RuntimeRegistrationCredentials {
  appId: string;
  appSecret: string;
  tenant: TenantBrand;
  operatorOpenId?: string;
}

export interface RuntimeRegistrationClientOptions {
  appPreset: { name: string; desc: string };
  source: string;
  scopes: readonly string[];
  events: readonly string[];
  callbacks: readonly string[];
  qrReadyTimeoutMs?: number | false;
  /** Optional host SDK adapter; avoids coupling consumers to Runtime's pinned SDK copy. */
  register?: (options: Record<string, unknown>) => Promise<{
    client_id: string;
    client_secret: string;
    user_info?: { open_id?: string; tenant_brand?: TenantBrand };
  }>;
}

export interface RuntimeRegistrationStartOptions {
  purpose?: 'add' | 'refresh';
  appId?: string;
  signal: AbortSignal;
  onQr: (input: { url: string; expireIn: number }) => void;
  onStatus?: (input: { status: 'polling' | 'slow_down' | 'domain_switched'; interval?: number }) => void;
}

/** Shared registerApp adapter; hosts vary only branding and requested capabilities. */
export class RuntimeFeishuRegistrationClient {
  constructor(private readonly options: RuntimeRegistrationClientOptions) {}

  async start(input: RuntimeRegistrationStartOptions): Promise<RuntimeRegistrationCredentials> {
    const refresh = input.purpose === 'refresh';
    if (refresh && !input.appId) throw new Error('刷新飞书应用需要已有应用标识。');
    const timeout = this.options.qrReadyTimeoutMs === false ? undefined : new AbortController();
    const signal = timeout === undefined ? input.signal : AbortSignal.any([input.signal, timeout.signal]);
    let qrReady = false;
    const timer = timeout === undefined ? undefined : setTimeout(() => {
      if (!qrReady) timeout.abort(new Error('生成飞书二维码超时，请检查网络后重试。'));
    }, this.options.qrReadyTimeoutMs || 30_000);
    let result: Awaited<ReturnType<typeof registerApp>>;
    try {
      const registerOptions = {
        appPreset: { ...this.options.appPreset },
        source: this.options.source,
        ...(refresh ? { appId: input.appId, createOnly: false } : {}),
        addons: {
          scopes: { tenant: [...this.options.scopes] },
          events: { items: { tenant: [...this.options.events] } },
          callbacks: { items: [...this.options.callbacks] },
        },
        signal,
        onQRCodeReady: (info) => {
          if (signal.aborted) return;
          qrReady = true;
          if (timer !== undefined) clearTimeout(timer);
          input.onQr({ url: info.url, expireIn: info.expireIn });
        },
        onStatusChange: (info) => {
          if (signal.aborted) return;
          input.onStatus?.({
            status: info.status,
            ...(info.interval === undefined ? {} : { interval: info.interval }),
          });
        },
      } as Parameters<typeof registerApp>[0];
      const operation = this.options.register === undefined
        ? registerApp(registerOptions)
        : this.options.register(registerOptions as unknown as Record<string, unknown>);
      result = await settleOnAbort(operation as Promise<Awaited<ReturnType<typeof registerApp>>>, signal, () => input.signal.aborted
        ? { code: 'abort' }
        : timeout?.signal.reason instanceof Error
          ? timeout.signal.reason
          : new Error('飞书授权已中止。'));
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    return {
      appId: result.client_id,
      appSecret: result.client_secret,
      tenant: result.user_info?.tenant_brand ?? 'feishu',
      ...(result.user_info?.open_id === undefined ? {} : { operatorOpenId: result.user_info.open_id }),
    };
  }
}

export interface RuntimeCredentialValidationResult {
  ok: boolean;
  reason?: string;
  botName?: string;
  botAvatarUrl?: string;
  missingScopes?: readonly string[];
}

export interface RuntimeFeishuCredentialValidatorOptions {
  requiredScopes: readonly string[];
  timeoutMs?: number;
}

/** Shared token/profile/scope validator used by desktop and DSH registration. */
export class RuntimeFeishuCredentialValidator {
  readonly #timeoutMs: number;

  constructor(private readonly options: RuntimeFeishuCredentialValidatorOptions) {
    this.#timeoutMs = options.timeoutMs ?? 15_000;
  }

  async validate(
    appId: string,
    appSecret: string,
    tenant: TenantBrand,
    signal?: AbortSignal,
  ): Promise<RuntimeCredentialValidationResult> {
    const requestSignal = signal === undefined
      ? AbortSignal.timeout(this.#timeoutMs)
      : AbortSignal.any([signal, AbortSignal.timeout(this.#timeoutMs)]);
    const base = tenant === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn';
    let response: Response;
    try {
      response = await fetch(`${base}/open-apis/auth/v3/tenant_access_token/internal`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
        redirect: 'error',
        signal: requestSignal,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      return { ok: false, reason: '无法连接飞书开放平台，请检查网络后重试。' };
    }
    if (!response.ok) return { ok: false, reason: `飞书开放平台返回 HTTP ${response.status}。` };
    const token = await response.json().catch(() => undefined) as {
      code?: number;
      msg?: string;
      tenant_access_token?: string;
    } | undefined;
    if (token?.code !== 0 || !token.tenant_access_token) {
      return { ok: false, reason: token?.msg ?? '飞书拒绝了应用凭据。' };
    }
    const [bot, grantedScopes] = await Promise.all([
      optionalDiagnostic(fetchBotProfile(base, token.tenant_access_token, requestSignal), signal),
      optionalDiagnostic(fetchGrantedScopes(base, token.tenant_access_token, requestSignal), signal),
    ]);
    return {
      ok: true,
      ...(bot?.name === undefined ? {} : { botName: bot.name }),
      ...(bot?.avatarUrl === undefined ? {} : { botAvatarUrl: bot.avatarUrl }),
      ...(grantedScopes === undefined
        ? {}
        : { missingScopes: this.options.requiredScopes.filter((scope) => !grantedScopes.has(scope)) }),
    };
  }
}

function settleOnAbort<T>(operation: Promise<T>, signal: AbortSignal, abortError: () => unknown): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(abortError());
    signal.addEventListener('abort', abort, { once: true });
    void operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

async function optionalDiagnostic<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T | undefined> {
  try {
    return await operation;
  } catch (error) {
    if (signal?.aborted) throw error;
    return undefined;
  }
}

async function fetchBotProfile(base: string, token: string, signal: AbortSignal): Promise<{
  name?: string;
  avatarUrl?: string;
} | undefined> {
  const response = await fetch(`${base}/open-apis/bot/v3/info`, {
    headers: { authorization: `Bearer ${token}` },
    redirect: 'error',
    signal,
  });
  if (!response.ok) return undefined;
  const body = await response.json() as { bot?: { app_name?: string; avatar_url?: string } };
  if (!body.bot) return undefined;
  return {
    ...(body.bot.app_name === undefined ? {} : { name: body.bot.app_name }),
    ...(body.bot.avatar_url === undefined ? {} : { avatarUrl: body.bot.avatar_url }),
  };
}

async function fetchGrantedScopes(base: string, token: string, signal: AbortSignal): Promise<Set<string> | undefined> {
  const response = await fetch(`${base}/open-apis/application/v6/scopes`, {
    headers: { authorization: `Bearer ${token}` },
    redirect: 'error',
    signal,
  });
  if (!response.ok) return undefined;
  const body = await response.json() as {
    data?: { scopes?: Array<{ scope_name: string; grant_status: number }> };
  };
  if (!body.data?.scopes) return undefined;
  return new Set(body.data.scopes
    .filter((scope) => scope.grant_status === 1)
    .map((scope) => scope.scope_name));
}
