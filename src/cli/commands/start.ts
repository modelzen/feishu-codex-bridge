import { loadConfig, saveConfig, buildEncryptedAccountConfig } from '../../config/store';
import { setSecret } from '../../config/keystore';
import { isComplete, secretKeyForApp, type AppConfig } from '../../config/schema';
import { resolveAppSecret } from '../../config/secret-resolver';
import { runRegistrationWizard } from '../../bot/wizard';
import { validateAppCredentials } from '../../utils/feishu-auth';
import { buildScopeGrantUrl } from '../../config/scopes';
import { resolveCodexBin } from '../../agent/codex-appserver/locate';
import { startBridge } from '../../bot/bridge';
import { acquireSingleInstanceLock, BridgeAlreadyRunningError } from '../../core/single-instance';
import { log } from '../../core/logger';

/**
 * `feishu-codex-bridge start` — onboarding + bring up the bridge.
 *
 * M1 status: onboarding (scan-QR → keystore → encrypted config → validate)
 * is wired. The long-connection bot bridge is the next slice.
 */
export async function runStart(): Promise<void> {
  if (!resolveCodexBin()) {
    console.error('✗ 未找到 codex CLI。设置 CODEX_BIN 或安装 @openai/codex，再重试。');
    process.exitCode = 1;
    return;
  }

  const cfg = await ensureConfigured();
  if (!cfg) {
    process.exitCode = 1;
    return;
  }

  const secret = await resolveAppSecret(cfg);
  const v = await validateAppCredentials(cfg.accounts.app.id, secret, cfg.accounts.app.tenant);
  if (!v.ok) {
    console.error(`✗ 应用凭据校验失败：${v.reason}`);
    console.error('  重新运行 `feishu-codex-bridge start` 走扫码，或检查应用是否被禁用。');
    process.exitCode = 1;
    return;
  }

  console.log(`✓ 凭据校验通过  bot: ${v.botName ?? '-'}  appId: ${cfg.accounts.app.id}`);
  log.info('start', 'credentials-ok', { appId: cfg.accounts.app.id, bot: v.botName ?? null });

  // Feishu has no API to declare app scopes (even the official CLI can't), so
  // we point the user at one console URL that pre-selects every missing scope.
  // Best-effort: v.missingScopes is undefined when the check couldn't run.
  if (v.missingScopes && v.missingScopes.length > 0) {
    const url = buildScopeGrantUrl(cfg.accounts.app.id, cfg.accounts.app.tenant);
    console.log(`\n⚠️ 还差 ${v.missingScopes.length} 项权限未开通：${v.missingScopes.join('  ')}`);
    console.log('   飞书没有「扫码即授权」的接口，需点下面这个链接一次性开通全部权限（开通后无需重启，即时生效）：');
    console.log(`\n   ${url}\n`);
  } else if (v.missingScopes === undefined) {
    log.info('start', 'scope-check-skipped', { reason: 'scope list unavailable' });
  }

  // Refuse to run alongside another bridge for the same app — two long
  // connections split card callbacks and make buttons flaky (see module doc).
  let releaseLock: () => void;
  try {
    releaseLock = acquireSingleInstanceLock(cfg.accounts.app.id);
  } catch (err) {
    if (err instanceof BridgeAlreadyRunningError) {
      console.error(`✗ ${err.message}`);
      log.info('start', 'already-running', { pid: err.pid });
      process.exitCode = 1;
      return;
    }
    throw err;
  }
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.once(sig, () => {
      releaseLock();
      process.exit(0);
    });
  }

  // Projects bind their own cwd (registry). Unregistered groups fall back here.
  const fallbackCwd = process.env.FEISHU_CODEX_CWD || process.cwd();
  console.log('\n正在启动长连接 bot…');
  console.log('私聊我 `/new <名>` 建项目；在项目群里 @我 干活。Ctrl+C 退出。\n');
  await startBridge({ cfg, appSecret: secret, fallbackCwd });
  // keep the process alive; the WS connection drives everything.
  await new Promise<never>(() => {});
}

/**
 * Load config; if incomplete, run the scan-QR wizard, move the secret into
 * the keystore, and persist an encrypted-account config. Returns the
 * complete config or null on failure.
 */
async function ensureConfigured(): Promise<AppConfig | null> {
  const existing = await loadConfig();
  if (isComplete(existing)) return existing;

  const wizardCfg = await runRegistrationWizard();
  const app = wizardCfg.accounts.app;
  if (typeof app.secret !== 'string') {
    console.error('✗ 向导未返回明文密钥，无法继续。');
    return null;
  }
  // Move plaintext secret into the encrypted keystore; config points at it.
  await setSecret(secretKeyForApp(app.id), app.secret);
  const encrypted = await buildEncryptedAccountConfig(app.id, app.tenant, wizardCfg.preferences);
  await saveConfig(encrypted);
  console.log(`✓ 配置已保存，密钥进加密库  (${app.id})`);
  return encrypted;
}
