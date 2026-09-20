import { chmod, readdir } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { join } from 'node:path';
import { paths } from '../config/paths';
import { log } from '../core/logger';

/**
 * 平台 prebuild 原生 helper 的可执行位修复（通用基础设施，供任何用 node-pty 的
 * 按需后端复用；DSH 的依赖闭包包含 node-pty）。
 *
 * 【为什么需要】node-pty 1.1.0 的 macOS `spawn-helper`（prebuildify 产物，node-pty
 * 在 macOS 上经它 posix_spawnp 起 PTY 子进程）经 `npm install` 装进用户私装目录后
 * **偶发丢失可执行位变成 0644**（node-pty 历史上的打包/解包回归）。结果：node-pty
 * 一 spawn 就 `posix_spawnp failed.`。
 *
 * 【修法】对用户私装目录下所有 `node-pty/prebuilds/<平台>/spawn-helper` 无条件补
 * 0755。幂等、绝不抛错（无该 helper 的平台 / 没装 node-pty / 不可写都静默跳过）。
 * 安装后（installer）跑一次治本。
 */
export async function fixNativeHelperPerms(rootDir: string = paths.backendsDir): Promise<void> {
  // npm 默认 hoist → node-pty 在顶层 node_modules。
  const nodePtyDirs = [join(rootDir, 'node_modules', 'node-pty')];
  let fixed = 0;
  for (const npDir of nodePtyDirs) {
    const prebuilds = join(npDir, 'prebuilds');
    let plats: Dirent[];
    try {
      plats = await readdir(prebuilds, { withFileTypes: true });
    } catch {
      continue; // 该位置没装 node-pty
    }
    for (const p of plats) {
      if (!p.isDirectory()) continue;
      const helper = join(prebuilds, p.name, 'spawn-helper');
      try {
        await chmod(helper, 0o755);
        fixed++;
      } catch {
        /* 该平台无 spawn-helper（仅 darwin 有）/ 不可写 → 跳过 */
      }
    }
  }
  if (fixed > 0) log.info('agent', 'native-helper-perms-fixed', { count: fixed });
}
