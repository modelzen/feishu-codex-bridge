import { loadConfig, saveConfig, buildEncryptedAccountConfig } from '../config/store';
import { setSecret } from '../config/keystore';
import { isComplete, secretKeyForApp, type AppConfig } from '../config/schema';
import { resolveAppSecret } from '../config/secret-resolver';
import { runRegistrationWizard } from './wizard';
import { validateAppCredentials } from '../utils/feishu-auth';
import {
  diagnoseEventSubscription,
  pollEventSubscription,
  summarizeEventDiagnosis,
  REQUIRED_EVENTS,
  type EventDiagnosis,
} from '../utils/event-diagnosis';
import { buildScopeGrantUrl, buildEventConfigUrl, labelScope } from '../config/scopes';
import { detectAgents } from '../agent';
import { log } from '../core/logger';
import { useBotDir } from '../config/paths';
import { ensureRegistry, addBot, currentBot, findBot, loadBots, uniqueName, type BotEntry } from '../config/bots';

export interface OnboardResult {
  cfg: AppConfig;
  secret: string;
  /** required scopes still ungranted at validation time (undefined = couldn't check). */
  missingScopes?: string[];
  /** 事件订阅诊断（版本信息 API，三态 + unchecked 降级；undefined = 没跑诊断）。 */
  events?: EventDiagnosis;
}

/**
 * Verify the agent backend (codex) is runnable。探 codex agent（detectAgents），
 * 可用即放行；不可用时**仍只告警不阻塞**（与缺权限策略一致——零交互纯告知，因为
 * 要同时支持人 + codex 安装/升级），让用户装好 codex 后再用。
 *
 * 返回 true 始终放行（不再拒启）。布尔仍保留给调用方签名（早期返回点用得到）。
 */
export async function ensureAnyAgent(): Promise<boolean> {
  const agents = await detectAgents().catch(() => []);
  const anyAvailable = agents.some((a) => a.backends.some((b) => b.available));
  if (anyAvailable) return true;
  // 都无：告警但不阻塞。
  const rule = '-'.repeat(64);
  console.error(`\n${rule}`);
  console.error('⚠️  未检测到可用的 codex 后端——仍会启动，但群里发消息会报后端不可用。');
  console.error('   装上 codex：npm i -g @openai/codex，然后 codex login');
  console.error('   装好后用 `feishu-codex-bridge doctor` 自检。');
  console.error(`${rule}\n`);
  return true;
}

/** @deprecated 旧名，保留兼容 `bot init` 调用点；语义已是 ensureAnyAgent（任一 agent 可用即放行，都无也不阻塞）。 */
export const ensureCodex = ensureAnyAgent;

/**
 * Bring a bot to a runnable state and return its config + secret.
 *
 * - With `opts.bot` (a name or appId), resolves THAT specific bot — used by
 *   `run --bot <name>` and the multi-bot supervisor's children. A missing
 *   selector is an error (never the create-wizard, even with `allowCreate`).
 * - Without a selector, resolves the registry's `current` bot (migrating a
 *   legacy flat install on first run). With `allowCreate`, a missing current
 *   bot triggers the scan-QR wizard (named `default`) — this is what makes the
 *   implicit `run`/`start` "init if not initialized". Without it (or off a TTY)
 *   a missing bot is an error.
 * - Validates credentials; on missing scopes it prints a non-blocking notice
 *   (which features are gated, where to grant, that 诊断 can grant later) and
 *   prints the grant link without opening a browser or reading stdin.
 *
 * Returns null (after printing why) on any failure.
 */
export async function ensureOnboarded(
  opts: { allowCreate?: boolean; bot?: string } = {},
): Promise<OnboardResult | null> {
  // 任一 agent 可用即放行；都无也只告警不阻塞（Web 引导下载）—— 永远 true。
  await ensureAnyAgent();

  const reg = await ensureRegistry();
  const entry = opts.bot ? findBot(reg, opts.bot) : currentBot(reg);
  if (!entry) {
    if (opts.bot) {
      console.error(
        `✗ 找不到机器人「${opts.bot}」。用 \`feishu-codex-bridge bot list\` 查看已注册的机器人。`,
      );
      return null;
    }
    if (!opts.allowCreate) {
      console.error('✗ 尚未配置任何飞书机器人。请先运行 `feishu-codex-bridge bot init`（或前台 `run`）扫码创建。');
      return null;
    }
    return registerNewBot('default');
  }

  useBotDir(entry.appId);
  const cfg = await loadConfig();
  if (!isComplete(cfg)) {
    console.error(`✗ 当前机器人「${entry.name}」(${entry.appId}) 配置缺失或损坏。可 \`bot rm ${entry.name}\` 后重新 \`bot init\`。`);
    return null;
  }
  const r = await validateAndReport(cfg);
  if (r === null) return null;
  return { cfg, secret: r.secret, missingScopes: r.missingScopes, events: r.events };
}

/**
 * Run the scan-QR wizard to create a brand-new feishu app, persist it (keystore
 * + per-bot config dir + registry), validate, and surface the scope link.
 * `desiredName` defaults to the bot's display name (slugified); pass `'default'`
 * for the implicit first-run from `run`/`start`. Returns null on failure.
 */
export async function registerNewBot(desiredName?: string): Promise<OnboardResult | null> {
  // The scan needs a human at a terminal. A headless context (the launchd
  // service, CI) must never enter the wizard — `registerApp` would print a QR
  // to a log nobody reads and poll forever. Fail fast with a pointer instead.
  if (!process.stdout.isTTY) {
    console.error(
      '✗ 当前不是交互式终端，无法扫码创建飞书应用。\n' +
        '  请在终端前台运行 `feishu-codex-bridge bot init`（或 `run` / `start`）扫码 onboarding。',
    );
    return null;
  }

  const wizardCfg = await runRegistrationWizard();
  const app = wizardCfg.accounts.app;
  if (typeof app.secret !== 'string') {
    console.error('✗ 向导未返回明文密钥，无法继续。');
    return null;
  }

  // Validate with the plaintext secret before persisting — bad creds shouldn't
  // leave a half-registered bot behind.
  const v = await validateAppCredentials(app.id, app.secret, app.tenant);
  if (!v.ok) {
    console.error(`✗ 应用凭据校验失败：${v.reason}`);
    return null;
  }

  await setSecret(secretKeyForApp(app.id), app.secret);
  useBotDir(app.id); // from here all per-bot files land under bots/<appId>/
  const cfg = await buildEncryptedAccountConfig(app.id, app.tenant, wizardCfg.preferences);
  await saveConfig(cfg);

  const reg = await loadBots();
  const name = uniqueName(reg, desiredName ?? v.botName ?? 'default');
  await addBot({ name, appId: app.id, tenant: app.tenant, botName: v.botName, createdAt: Date.now() });

  console.log(`✓ 已创建机器人「${name}」  bot: ${v.botName ?? '-'}  appId: ${app.id}`);
  log.info('onboard', 'bot-created', { name, appId: app.id, bot: v.botName ?? null });
  noticeMissingScopes(cfg, v.missingScopes);
  const events = await diagnoseEventSubscription(app.id, app.secret, app.tenant);
  noticeEventDiagnosis(cfg, events);

  const secret = await resolveAppSecret(cfg);
  return { cfg, secret, missingScopes: v.missingScopes, events };
}

/** Resolve secret, validate credentials, report result; on missing scopes,
 *  print the non-blocking notice (see {@link noticeMissingScopes}); then run the
 *  event-subscription diagnosis and report it too (same notice-only policy). */
async function validateAndReport(
  cfg: AppConfig,
): Promise<{ secret: string; missingScopes?: string[]; events: EventDiagnosis } | null> {
  const secret = await resolveAppSecret(cfg);
  const v = await validateAppCredentials(cfg.accounts.app.id, secret, cfg.accounts.app.tenant);
  if (!v.ok) {
    console.error(`✗ 应用凭据校验失败：${v.reason}`);
    console.error('  应用可能被禁用/未发布；可重跑 `feishu-codex-bridge bot init` 重新扫码。');
    return null;
  }
  console.log(`✓ 凭据校验通过  bot: ${v.botName ?? '-'}  appId: ${cfg.accounts.app.id}`);
  log.info('onboard', 'credentials-ok', { appId: cfg.accounts.app.id, bot: v.botName ?? null });
  noticeMissingScopes(cfg, v.missingScopes);
  const events = await diagnoseEventSubscription(cfg.accounts.app.id, secret, cfg.accounts.app.tenant);
  noticeEventDiagnosis(cfg, events);
  return { secret, missingScopes: v.missingScopes, events };
}

function noticeMissingScopes(cfg: AppConfig, missingScopes: string[] | undefined): void {
  if (missingScopes === undefined) {
    log.info('onboard', 'scope-check-skipped', { reason: 'scope list unavailable' });
    return;
  }
  if (missingScopes.length === 0) return;
  const url = buildScopeGrantUrl(cfg.accounts.app.id, cfg.accounts.app.tenant);
  // 纯 ASCII 边框：`-` 在 UTF-8 与 GBK 下编码相同，老式 cmd.exe（CP936）也不会乱码。
  const rule = '-'.repeat(64);
  console.log(`\n${rule}`);
  console.log(`⚠️  缺 ${missingScopes.length} 项权限（不影响启动，但这些功能开通前用不了）：`);
  for (const s of missingScopes) console.log(`   · ${labelScope(s)}`);
  console.log('   权限授权链接（勾选后即时生效，无需重启）：');
  console.log(`   👉 ${url}`);
  console.log('   不想现在弄也行：之后私聊机器人 →「🩺 诊断」可随时再申请。');
  console.log(`${rule}\n`);
}

function noticeEventDiagnosis(cfg: AppConfig, d: EventDiagnosis): void {
  log.info('onboard', 'event-diagnosis', { state: d.state, ...(d.reason ? { reason: d.reason } : {}), ...(d.missingRequired?.length ? { missingRequired: d.missingRequired } : {}) });
  console.log(`事件订阅检测：${summarizeEventDiagnosis(d)}`);
  console.log('  若消息未送达，检查事件订阅方式是否为长连接；若按钮无响应，检查「回调配置」中的 card.action.trigger。');
  if (d.missingOptional?.length) {
    console.log(`  可选事件未订阅：${d.missingOptional.join('、')}（不影响基本消息功能，需要时添加并发布版本）。`);
  }
  if (d.state === 'ok' && !d.missingOptional?.length) return;
  if (d.state === 'missing') {
    console.log('  添加上面缺少的事件后，发布新版本。');
  } else if (d.state === 'unpublished') {
    console.log(`  在事件配置中添加 ${REQUIRED_EVENTS.join('、')}，然后到「版本管理与发布」发布版本。`);
  }
  console.log(`  配置链接：${buildEventConfigUrl(cfg.accounts.app.id, cfg.accounts.app.tenant)}`);
}

export async function announceEventsWhenLive(result: OnboardResult): Promise<void> {
  const d = result.events;
  if (!d || d.state === 'ok' || d.state === 'unchecked') return;
  const { app } = result.cfg.accounts;
  try {
    console.log('· 正在后台检查事件订阅；添加缺少的事件并发布版本后会自动更新结果。');
    const ok = await pollEventSubscription(app.id, result.secret, app.tenant);
    if (ok) {
      console.log(`\n事件订阅检测已更新：${summarizeEventDiagnosis(ok)}`);
      log.info('onboard', 'events-live', { appId: app.id, version: ok.version ?? null });
    } else {
      log.info('onboard', 'events-poll-timeout', { appId: app.id });
    }
  } catch (err) {
    log.fail('onboard', err, { phase: 'announce-events' });
  }
}

export type { BotEntry };
