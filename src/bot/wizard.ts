import { registerApp } from '@larksuiteoapi/node-sdk';
import qrcode from 'qrcode-terminal';
import type { AppConfig, TenantBrand } from '../config/schema';

/**
 * Scan-QR onboarding 的**共享启动器**：把 SDK 的 `registerApp` 异步轮询封成一个
 * 「发起 → onQr 吐二维码 → onStatus 推状态 → resolve 凭据 / reject 失败」的 Promise，
 * 命令行向导（{@link runRegistrationWizard}）与 Web 扫码 SSE（admin/service.ts
 * registerBotByQr）**共用同一条链路**，避免两处各自拼 registerApp 参数漂移。
 *
 * 关键事实（来自 SDK 源码，落地必须照做）：
 *   - `registerApp` 写死 archetype=PersonalAgent / auth=client_secret /
 *     request_user_info=open_id → 我们无需传任何参数即可拿到扫码人 open_id
 *     （当 owner+admin 的来源）。
 *   - 取消靠 AbortSignal：`signal.abort()` → SDK reject `{code:'abort'}`。
 *   - 超时由 SDK 自带 expire 定时器负责（reject `{code:'expired_token'}`），
 *     我们**不叠自己的超时**。
 *   - **SDK reject 的是普通对象 `{code, description}`，不是 Error 实例** →
 *     catch 里读 `err.code`（见 {@link registrationErrorCode}），绝不用 instanceof。
 */

/** 一次扫码会话的二维码信息（透传 SDK onQRCodeReady）。 */
export interface RegistrationQr {
  /** 飞书创建跳转链接（文本，非图；前端/CLI 自己编码成二维码）。 */
  url: string;
  /** 二维码有效期（秒，默认 600）。 */
  expireIn: number;
}

/** 一次扫码会话的状态变化（透传 SDK onStatusChange）。 */
export interface RegistrationStatus {
  status: 'polling' | 'slow_down' | 'domain_switched';
  /** slow_down 时的降速间隔（秒）。 */
  interval?: number;
}

/** 扫码成功拿到的凭据 + 扫码人信息（client_secret 是明文，调用方立刻进 keystore）。 */
export interface RegistrationCredentials {
  clientId: string;
  /** 明文 client_secret——只活在内存，调用方立刻 setSecret 进 keystore，绝不回显/落盘。 */
  clientSecret: string;
  tenant: TenantBrand;
  /** 扫码人 open_id（当 owner+admin 的来源）；理论上 request_user_info 总返回，仍兜底。 */
  operatorOpenId?: string;
}

/** {@link startRegistration} 的回调/取消信号。 */
export interface StartRegistrationOptions {
  onQr: (info: RegistrationQr) => void;
  onStatus?: (info: RegistrationStatus) => void;
  /** 取消信号；abort → SDK reject `{code:'abort'}` → 本函数原样抛出（code='abort'）。 */
  signal?: AbortSignal;
}

/** 扫码后的创建页预填（用户仍可改；`{user}` 由飞书替换为扫码人姓名）。
 * QR 预填仅支持 avatar/name/desc——scope 与事件没有任何预填通道（见 config/scopes.ts），
 * avatar 需公网图床 URL，这里不带。命令行与 Web 共用同一预填，文案不漂移。 */
const APP_PRESET = {
  name: 'Codex Bridge',
  desc: '{user} 的 Codex 助手：群里 @我，就在绑定的项目目录里干活（feishu-codex-bridge）',
} as const;

/**
 * 发起一次扫码注册会话。resolve 拿到明文凭据；失败 reject 的对象其 `.code` 可用
 * {@link registrationErrorCode} 读出（'abort'|'expired_token'|'access_denied'|...）。
 * 不打印任何东西、不写盘——纯封装 registerApp，让 CLI / Web 各自决定怎么呈现。
 */
export async function startRegistration(opts: StartRegistrationOptions): Promise<RegistrationCredentials> {
  const result = await registerApp({
    appPreset: { ...APP_PRESET },
    signal: opts.signal,
    onQRCodeReady: (info) => opts.onQr({ url: info.url, expireIn: info.expireIn }),
    onStatusChange: (info) => opts.onStatus?.({ status: info.status, interval: info.interval }),
  });
  return {
    clientId: result.client_id,
    clientSecret: result.client_secret,
    tenant: result.user_info?.tenant_brand ?? 'feishu',
    operatorOpenId: result.user_info?.open_id,
  };
}

/**
 * 读出 SDK registerApp reject 对象的失败码。SDK reject 的是普通对象 `{code, description}`
 * 而非 Error 实例（createError 在 lib/index.js），所以**绝不能用 instanceof** 判断。
 * 已知码：'abort'（用户/连接取消）/ 'expired_token'（二维码过期）/ 'access_denied'
 * （飞书里拒绝创建）/ 其它。读不出 → 'unknown'。
 */
export function registrationErrorCode(err: unknown): string {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' ? code : 'unknown';
}

/** 读出 SDK reject 对象的人读描述（描述/消息，兜底空串）。 */
export function registrationErrorMessage(err: unknown): string {
  const e = err as { description?: unknown; message?: unknown } | null | undefined;
  if (typeof e?.description === 'string') return e.description;
  if (typeof e?.message === 'string') return e.message;
  return '';
}

/**
 * 命令行扫码向导：在 TTY 前用 ASCII 二维码引导扫码创建 PersonalAgent 应用，返回含
 * 明文 client_secret 的 AppConfig（调用方移进 keystore）。扫码人 open_id 必须落成
 * owner+admin；缺失时拒绝返回配置，避免产生无人可管理的机器人。
 */
export async function runRegistrationWizard(): Promise<AppConfig> {
  console.log('\n未检测到飞书应用配置，进入扫码创建向导。\n');

  const creds = await startRegistration({
    onQr: (info) => {
      console.log('请用飞书 App 扫描以下二维码完成应用创建：\n');
      qrcode.generate(info.url, { small: true });
      const mins = Math.max(1, Math.round(info.expireIn / 60));
      console.log(`\n二维码有效期：约 ${mins} 分钟`);
      console.log(`也可以直接在浏览器打开：${info.url}\n`);
    },
    onStatus: (info) => {
      if (info.status === 'domain_switched') {
        console.log('识别到国际版租户，已切换到 larksuite.com 域名。');
      } else if (info.status === 'slow_down') {
        console.log('轮询速度过快，已自动降速。');
      }
    },
  });

  console.log('\n✓ 应用创建成功');
  console.log(`  App ID:  ${creds.clientId}`);
  console.log(`  Tenant:  ${creds.tenant}`);

  const ownerOpenId = creds.operatorOpenId?.trim();
  if (!ownerOpenId) {
    throw new Error('扫码成功，但未获取到你的飞书身份；未保存机器人。请重新扫码并确认授权。');
  }
  const cfg: AppConfig = {
    accounts: { app: { id: creds.clientId, secret: creds.clientSecret, tenant: creds.tenant } },
    preferences: { access: { ownerOpenId, admins: [ownerOpenId] } },
  };
  console.log(`  Admin:   ${ownerOpenId} (你自己，已自动加入管理员名单)`);
  console.log('');
  return cfg;
}
