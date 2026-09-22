import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixNativeHelperPerms } from '../src/agent/native-helpers';

// node-pty 的 macOS spawn-helper 经 npm 装后偶发丢 +x（变 0644）→ posix_spawnp failed
// → 任何依赖 node-pty 的按需后端必挂。fixNativeHelperPerms 把顶层
// node_modules/node-pty/prebuilds/<平台>/spawn-helper 补回 0755。
// 这里用临时目录真实建文件 + chmod 验证（不 mock fs）。

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'fcb-native-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true }).catch(() => undefined);
});

async function makeHelper(rel: string, mode: number): Promise<string> {
  const full = join(root, rel);
  await mkdir(join(full, '..'), { recursive: true });
  await writeFile(full, '#!/bin/sh\n', { mode });
  await chmod(full, mode); // writeFile 受 umask 影响，显式定死
  return full;
}

const isExec = async (p: string): Promise<boolean> => ((await stat(p)).mode & 0o111) !== 0;

describe('fixNativeHelperPerms', () => {
  // Windows chmod only controls the read-only attribute, not POSIX execute bits.
  it.skipIf(process.platform === 'win32')('把丢了 +x 的 spawn-helper（0644）补成可执行', async () => {
    const helper = await makeHelper('node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper', 0o644);
    expect(await isExec(helper)).toBe(false);
    await fixNativeHelperPerms(root);
    expect(await isExec(helper)).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('多平台目录都修（darwin-arm64 + darwin-x64）', async () => {
    const a = await makeHelper('node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper', 0o644);
    const b = await makeHelper('node_modules/node-pty/prebuilds/darwin-x64/spawn-helper', 0o600);
    await fixNativeHelperPerms(root);
    expect(await isExec(a)).toBe(true);
    expect(await isExec(b)).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('只扫顶层 node_modules/node-pty：嵌在其他包 node_modules 下的不动', async () => {
    // npm 默认 hoist，node-pty 在顶层 node_modules；src 只扫顶层那一处。
    const nested = await makeHelper(
      'node_modules/some-backend/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper',
      0o644,
    );
    await fixNativeHelperPerms(root);
    expect(await isExec(nested)).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('已是可执行 → 幂等不报错', async () => {
    const helper = await makeHelper('node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper', 0o755);
    await fixNativeHelperPerms(root);
    expect(await isExec(helper)).toBe(true);
  });

  it('没装 node-pty → 静默不抛', async () => {
    await expect(fixNativeHelperPerms(root)).resolves.toBeUndefined();
  });
});
