import type { TenantBrand } from '../config/schema';

/**
 * 事件订阅自动诊断（research/01 的「最大增量点」）。
 *
 * 飞书对「添加事件 / 回调 / 发布版本」没有任何**写入类** OpenAPI，但提供了只读的
 * 「获取应用版本列表」（`GET /application/v6/applications/:app_id/app_versions`），
 * 响应里每个版本的 `event_infos[].event_type` 是事件 ID，`events` 是本地化名称，
 * `status` 为 1 表示审核通过/已上架。
 * 凭它可把「@机器人没反应」从"等用户发现"变成启动/doctor/诊断卡上的精确三态：
 *
 *   - `unpublished` —— 从未发布过版本（事件订阅尚未生效）；
 *   - `missing`     —— 已发布但缺 {@link REQUIRED_EVENTS}（im.message.receive_v1）；
 *   - `ok`          —— 必需事件齐全（可选事件单列，不影响状态）。
 *
 * 第四态 `unchecked` 是优雅降级：缺 `application:application.app_version:readonly`
 * scope、网络不通、接口报错都归这里——只告知、绝不阻塞启动（项目既有策略）。
 *
 * 注意：事件列表只含「事件配置」标签页的事件；「回调配置」（card.action.trigger
 * 卡片回传交互）不在其中，**无法检测**——相关提示仍须保留人工指引。
 */

const ENDPOINTS: Record<TenantBrand, string> = {
  feishu: 'https://open.feishu.cn',
  lark: 'https://open.larksuite.com',
};

/** 核心链路必需的事件：缺了 = @bot / 私聊都收不到消息。 */
export const REQUIRED_EVENTS = ['im.message.receive_v1'] as const;

/**
 * 可选功能各自依赖的事件：缺了只是对应功能静默关闭（机器人菜单 / 文档评论回复 /
 * 加入存量群绑定与自动解绑 / 表情回复驱动），不影响诊断状态，仅在结果里单列提醒。
 */
export const OPTIONAL_EVENTS = [
  'application.bot.menu_v6',
  'drive.notice.comment_add_v1',
  'im.chat.member.bot.added_v1',
  'im.chat.member.bot.deleted_v1',
  'im.message.reaction.created_v1',
] as const;

export type EventDiagnosisState = 'unchecked' | 'unpublished' | 'missing' | 'ok';

export interface EventDiagnosis {
  state: EventDiagnosisState;
  /** unchecked：没查成的原因（缺 scope / 网络 / 非 0 错误码）。 */
  reason?: string;
  /** 最新已上架（status=1）版本的版本号，如 "1.0.0"。 */
  version?: string;
  /** 该版本已订阅的全部事件。 */
  events?: string[];
  /** {@link REQUIRED_EVENTS} 中缺失的（`state === 'missing'` 时非空）。 */
  missingRequired?: string[];
  /** {@link OPTIONAL_EVENTS} 中缺失的（不影响 state）。 */
  missingOptional?: string[];
}

interface TokenResp {
  code?: number;
  msg?: string;
  tenant_access_token?: string;
}

interface VersionListResp {
  code?: number;
  msg?: string;
  data?: { items?: {
    version?: string;
    status?: number;
    events?: string[];
    event_infos?: { event_type?: string }[];
  }[] };
}

/**
 * 拉取应用版本列表并诊断事件订阅状态。任何失败（含缺 scope 的非 0 错误码）都
 * 落到 `unchecked` 并带原因——绝不 throw，调用方可无脑织进日志/卡片。
 * `fetchFn` 仅供测试注入。
 */
export async function diagnoseEventSubscription(
  appId: string,
  appSecret: string,
  tenant: TenantBrand,
  fetchFn: typeof fetch = fetch,
): Promise<EventDiagnosis> {
  const base = ENDPOINTS[tenant];
  let token: string;
  try {
    const resp = await fetchFn(`${base}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    });
    if (!resp.ok) return { state: 'unchecked', reason: `token HTTP ${resp.status}` };
    const data = (await resp.json()) as TokenResp;
    if (data.code !== 0 || !data.tenant_access_token) {
      return { state: 'unchecked', reason: `token code=${data.code ?? '?'} msg=${data.msg ?? '<no msg>'}` };
    }
    token = data.tenant_access_token;
  } catch (err) {
    return { state: 'unchecked', reason: `网络错误：${err instanceof Error ? err.message : String(err)}` };
  }

  // order=0 = 按时间倒序 → 第一个 status=1 的就是当前在线（最新已上架）版本。
  let body: VersionListResp;
  try {
    const resp = await fetchFn(
      `${base}/open-apis/application/v6/applications/${encodeURIComponent(appId)}/app_versions?lang=zh_cn&page_size=50&order=0`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    // 飞书即便 HTTP 4xx 也常带 {code,msg}（如缺 scope 返回 400 + 99991672）——先尝试读 body
    // 拿到可读原因，而不是甩一个裸状态码。读不到 body 才回退到 HTTP 状态。
    body = (await resp.json().catch(() => undefined)) as VersionListResp | undefined ?? { code: -1, msg: '' };
    if (!resp.ok && body.code === -1) {
      const hint = resp.status === 400 || resp.status === 403 ? '——可能缺 application:application.app_version:readonly 权限' : '';
      return { state: 'unchecked', reason: `HTTP ${resp.status}${hint}` };
    }
  } catch (err) {
    return { state: 'unchecked', reason: `网络错误：${err instanceof Error ? err.message : String(err)}` };
  }
  if (body.code !== 0) {
    // 典型：缺 application:application.app_version:readonly scope → 非 0 错误码。
    const scopeHint = body.code === 99991672 || /permission|scope|access/i.test(body.msg ?? '')
      ? '——请在「权限管理」授权 application:application.app_version:readonly 后重试'
      : '';
    return { state: 'unchecked', reason: `code=${body.code ?? '?'} msg=${body.msg ?? '<no msg>'}${scopeHint}` };
  }

  const live = (body.data?.items ?? []).find((v) => v.status === 1);
  if (!live) return { state: 'unpublished' };

  // The API localizes `events` (e.g. "接收消息" for lang=zh_cn).
  // Compare stable event IDs from event_infos, never display names. Retain
  // compatibility with responses that expose IDs directly in events.
  const events = live.event_infos !== undefined
    ? [...new Set(live.event_infos.map((event) => event.event_type).filter((type): type is string => typeof type === 'string' && type.length > 0))]
    : live.events ?? [];
  const has = new Set(events);
  const missingRequired = REQUIRED_EVENTS.filter((e) => !has.has(e));
  const missingOptional = OPTIONAL_EVENTS.filter((e) => !has.has(e));
  return {
    state: missingRequired.length > 0 ? 'missing' : 'ok',
    version: live.version,
    events,
    missingRequired,
    missingOptional,
  };
}

/** 一行中文摘要，供启动日志 / doctor CLI 直接打印（卡片自己渲染富文本）。 */
export function summarizeEventDiagnosis(d: EventDiagnosis): string {
  switch (d.state) {
    case 'ok':
      return `✅ 已生效（版本 v${d.version ?? '?'} 已订阅 ${REQUIRED_EVENTS.join(' / ')}）`;
    case 'missing':
      return `❌ 已发布版本 v${d.version ?? '?'} 缺事件：${(d.missingRequired ?? []).join('、')} —— @我 不会有反应`;
    case 'unpublished':
      return '❌ 从未发布过版本 —— 事件订阅尚未生效，@我 不会有反应';
    case 'unchecked':
      return `⚠️ 未能自动检测（${d.reason ?? '未知原因'}）`;
  }
}

/**
 * 轮询版本 API 直到事件订阅生效（state='ok'）或超时。run 用它在用户照深链配完
 * 「事件配置 + 发布版本」后主动播报「事件已生效」（research/01 建议 6 的闭环确认）。
 * 返回 ok 的诊断结果；超时返回 null。绝不 throw。
 */
export async function pollEventSubscription(
  appId: string,
  appSecret: string,
  tenant: TenantBrand,
  opts: { intervalMs?: number; timeoutMs?: number; fetchFn?: typeof fetch } = {},
): Promise<EventDiagnosis | null> {
  const intervalMs = opts.intervalMs ?? 15_000;
  const timeoutMs = opts.timeoutMs ?? 10 * 60_000;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const d = await diagnoseEventSubscription(appId, appSecret, tenant, opts.fetchFn ?? fetch);
    if (d.state === 'ok') return d;
    if (Date.now() + intervalMs > deadline) return null;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
