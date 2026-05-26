import { loadConfig, saveConfig, buildEncryptedAccountConfig } from '../../config/store';
import { setSecret } from '../../config/keystore';
import { isComplete, secretKeyForApp, type AppConfig } from '../../config/schema';
import { resolveAppSecret } from '../../config/secret-resolver';
import { runRegistrationWizard } from '../../bot/wizard';
import { validateAppCredentials } from '../../utils/feishu-auth';
import { resolveCodexBin } from '../../agent/codex-appserver/locate';
import { startBridge } from '../../bot/bridge';
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

  // M1: fixed cwd (project registry is M2). Override via FEISHU_CODEX_CWD.
  const cwd = process.env.FEISHU_CODEX_CWD || process.cwd();
  console.log(`\n正在启动长连接 bot…  cwd(M1 固定): ${cwd}`);
  console.log('在飞书群里 @bot 发一句话试试（会在话题里流式回复）。Ctrl+C 退出。\n');
  await startBridge({
    appId: cfg.accounts.app.id,
    appSecret: secret,
    tenant: cfg.accounts.app.tenant,
    cwd,
  });
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
