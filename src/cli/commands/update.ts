import {
  currentVersion,
  daemonRunning,
  installLatest,
  isDevSource,
  isNewer,
  latestVersion,
  packageName,
  restartDaemon,
} from '../../service/update';
import { getDesktopRelease, desktopReleaseNoticeForHost } from '../../service/desktop-release';
import { runtimeDistribution } from '../../service/distribution';

async function printDesktopGuidance(): Promise<void> {
  const release = await getDesktopRelease();
  if (!release) return;
  const notice = desktopReleaseNoticeForHost(release);
  if (notice) console.log(`\n${notice}`);
}

/**
 * `feishu-codex-bridge update` — self-update to the latest npm release and, if a
 * background daemon is running, restart it so the new code takes effect. With
 * `--check`, only report whether a newer version exists (no install).
 */
export async function runUpdate(opts: { check?: boolean } = {}): Promise<void> {
  const distribution = await runtimeDistribution();
  if (distribution.kind === 'bundled') {
    console.log('此 CLI 随 Vonvon Bridge 桌面应用提供，请在桌面应用中更新。');
    return;
  }
  try {
    await runCliUpdate(opts);
  } finally {
    await printDesktopGuidance();
  }
}

async function runCliUpdate(opts: { check?: boolean }): Promise<void> {
  const pkg = packageName();
  const current = currentVersion();
  console.log(`当前版本：v${current}`);
  console.log('查询最新版本…');
  const latest = await latestVersion();

  if (!latest) {
    console.log('⚠️ 查不到最新版本（网络或 npm registry 问题）。');
    process.exitCode = 1;
    return;
  }
  if (!isNewer(latest, current)) {
    console.log(`✓ 已是最新版本（v${current}）。`);
    return;
  }

  console.log(`发现新版本：v${current} → v${latest}`);
  if (opts.check) {
    console.log('运行 `feishu-codex-bridge update` 安装更新。');
    return;
  }
  if (isDevSource()) {
    console.log('检测到源码开发模式（仓库内有 .git）。请用：git pull && npm i —— 跳过全局安装。');
    return;
  }

  console.log(`开始全局安装最新版（npm i -g ${pkg}@latest）…`);
  const res = await installLatest({ inherit: true });
  if (!res.ok) {
    console.log(`❌ 安装失败：${res.message}`);
    console.log(`可在终端手动执行：npm i -g ${pkg}@latest`);
    process.exitCode = 1;
    return;
  }
  console.log(`✓ 已更新到 v${latest}`);

  if (daemonRunning()) {
    console.log('重启后台服务以加载新版本…');
    try {
      await restartDaemon();
      console.log('✓ 后台服务已重启，新版本已生效。');
    } catch (err) {
      console.log(`⚠️ 自动重启失败：${err instanceof Error ? err.message : String(err)}`);
      console.log('请手动执行：feishu-codex-bridge restart');
    }
  } else {
    console.log('未检测到运行中的后台 daemon；下次 `start` / `run` 即用新版本。');
  }
}
