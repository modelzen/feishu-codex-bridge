import { mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnProcess } from '../platform/spawn';
import { paths } from '../config/paths';
import { log } from '../core/logger';
import { isBackendDepInstalled, isBackendBinInstalled, installedBackendVersion } from './backend-loader';
import { fixNativeHelperPerms } from './native-helpers';

/**
 * 按需后端依赖的安装执行器（npm-ondemand 包；Claude / DSH 共用）。
 *
 * 装到用户私装目录 {@link paths.backendsDir}（永远用户可写，零 sudo/brew——见
 * design/backend-catalog-ondemand.md §2.2 方案A）。流程：
 *   ① 确保 backendsDir 有 package.json（npm `--prefix` 目录必须有 package.json
 *      才不向上回溯查找——实验 D；首次写一个最小 private 包等价 `npm init`）。
 *   ② spawn `npm install <pkg> --prefix backendsDir --include=optional`（cross-spawn，
 *      Windows `.cmd` shim 安全；--include=optional 拉平台二进制——实验 F）。
 *      stdout/stderr 逐块流给 onProgress（Web SSE / DM 卡轮询的进度源）。
 *   ③ 装完用 {@link isBackendDepInstalled} 校验真能解析到（半装/损坏 = 失败）。
 *
 * 可取消：传 AbortSignal，abort 时 kill npm 子进程并清半装子目录回滚。
 * 限纯 JS / 自带 prebuild 二进制的包（catalog 的 npm-ondemand 标注保证）——不触发
 * 本机原生编译，所以无需 build 工具链。
 */

const NPM = 'npm';

/** 查 npm registry 上某包的最新版本（`npm view <pkg> version`）。用于后端「检查更新」。
 *  绝不抛错：网络/registry 失败或超时 → null。8s 超时（registry 慢也不卡 UI）。 */
export async function latestNpmVersion(pkg: string, timeoutMs = 8000): Promise<string | null> {
  const bare = stripVersion(pkg);
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawnProcess>;
    try {
      child = spawnProcess(NPM, ['view', bare, 'version', '--no-fund', '--no-audit'], {
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      resolve(null);
      return;
    }
    let out = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
      resolve(null);
    }, timeoutMs);
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (d: string) => { out += d; });
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const v = out.trim().split('\n').pop()?.trim() ?? '';
      resolve(code === 0 && /^\d+\.\d+\.\d+/.test(v) ? v : null);
    });
  });
}

/** 安装结果：ok + npm 退出码 + 合并输出尾部（失败时给用户看的诊断）。 */
export interface InstallResult {
  ok: boolean;
  /** npm 进程退出码（被取消时为 null） */
  code: number | null;
  /** 是否被 AbortSignal 取消 */
  aborted: boolean;
  /** 合并 stdout/stderr 的尾部（最多 ~2KB，失败诊断用） */
  tail: string;
}

/** 进度回调：npm 每输出一块就回调一次（已按行无关，原样字符串块）。 */
export type InstallProgress = (chunk: string) => void;

/** backendsDir 里要写的最小 package.json（让 npm `--prefix` 不向上回溯——实验 D）。 */
const BACKENDS_PACKAGE_JSON = JSON.stringify(
  { name: 'feishu-codex-bridge-backends', private: true, version: '0.0.0' },
  null,
  2,
);

/** 确保 backendsDir 存在且有最小 package.json（幂等；已存在不覆写，保留 npm 写的锁等）。 */
export async function ensureBackendsDir(): Promise<void> {
  await mkdir(paths.backendsDir, { recursive: true });
  const pkgFile = join(paths.backendsDir, 'package.json');
  if (!existsSync(pkgFile)) {
    await writeFile(pkgFile, `${BACKENDS_PACKAGE_JSON}\n`, 'utf8');
  }
}

/**
 * 构建 `npm install` 命令（纯函数，exported for tests——单测只验命令构建，不真跑 npm）。
 * 装进 backendsDir、拉平台二进制、用桥的 npm 缓存目录、关进度条（避免流里乱码）。
 *
 * **用默认 --save（不加 --no-save）**：backendsDir 是多后端共享的一个 node_modules + 一个
 * package.json。npm install 会按 package.json reconcile，把「不在 package.json 里」的包当
 * extraneous 删掉。所以若用 --no-save + 最小 package.json，装第二个后端会把第一个 prune
 * 掉（实测：装第二个后端后第一个的 .bin 消失）——后端变互斥。默认 --save 把每个装过的包
 * 记进 package.json，多后端因此**共存**：从空目录装一个后端只有它自己，之后再装另一个
 * 两者并存（按需下载、各自体积如实呈现）。代价是「重装/修复一个」会按 package.json
 * 重装全部（缓存热则已装的近乎 no-op）。卸载见 {@link uninstallBackendDep}（连带 --save 移除
 * package.json 条目，避免下次装别的又把它带回）。
 */
export function buildInstallCommand(
  pkg: string | readonly string[],
  opts: { prefix?: string; cacheDir?: string } = {},
): { command: string; args: string[] } {
  const prefix = opts.prefix ?? paths.backendsDir;
  const cacheDir = opts.cacheDir ?? paths.npmCacheDir;
  const specs = normalizeSpecs(pkg);
  return {
    command: NPM,
    args: [
      'install',
      ...specs,
      '--prefix',
      prefix,
      '--include=optional',
      '--no-audit',
      '--no-fund',
      '--no-progress',
      '--cache',
      cacheDir,
    ],
  };
}

/**
 * 按需安装一个后端依赖到用户私装目录。绝不抛错——失败落 {@link InstallResult}.ok=false
 * （HTTP/卡片层据 tail 给诊断）。装完用 isBackendDepInstalled 校验；校验不过即视为失败
 * 并回滚半装子目录。可取消（signal.abort → kill npm + 回滚）。
 *
 * @param pkg     npm 包名（catalog 的 installSpec.pkg；可带 @version）
 * @param onProgress npm 输出流回调（每块）
 * @param signal  取消信号（abort → kill 子进程 + rm 半装子目录）
 * @param opts.binName  bin 类后端的 bin 名。给了 ⇒ 安装后校验走
 *   node_modules/.bin 存在性而非 require.resolve（bin-only 包无 main 入口，resolve 必失败）。
 */
export async function installBackendDep(
  pkg: string | readonly string[],
  onProgress?: InstallProgress,
  signal?: AbortSignal,
  opts?: { binName?: string },
): Promise<InstallResult> {
  const specs = normalizeSpecs(pkg);
  const bareNames = specs.map(stripVersion);
  if (specs.length === 0) {
    return { ok: false, code: null, aborted: false, tail: '没有可安装的后端包' };
  }
  try {
    await ensureBackendsDir();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.fail('agent', err, { phase: 'backend-install-mkdir', pkg: specs });
    return { ok: false, code: null, aborted: false, tail: `创建后端目录失败：${msg}` };
  }

  if (signal?.aborted) {
    return { ok: false, code: null, aborted: true, tail: '安装已取消' };
  }

  const { command, args } = buildInstallCommand(specs);
  log.info('agent', 'backend-install-start', { pkg: specs });

  const result = await new Promise<InstallResult>((resolve) => {
    let child;
    try {
      child = spawnProcess(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      resolve({ ok: false, code: null, aborted: false, tail: `spawn npm 失败：${msg}` });
      return;
    }

    let out = '';
    const capture = (d: Buffer): void => {
      const s = d.toString('utf8');
      out += s;
      // 只保留尾部，避免长安装把内存撑大（SSE/卡片只需要最近的进度）。
      if (out.length > 8192) out = out.slice(-8192);
      onProgress?.(s);
    };
    child.stdout?.on('data', capture);
    child.stderr?.on('data', capture);

    let aborted = false;
    const onAbort = (): void => {
      aborted = true;
      child.kill('SIGTERM');
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    child.on('error', (e) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve({ ok: false, code: null, aborted, tail: (out + e.message).slice(-2000) });
    });
    child.on('close', (code) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve({ ok: code === 0 && !aborted, code, aborted, tail: out.slice(-2000) });
    });
  });

  // 取消 / 退出码非零 → 回滚半装子目录（避免 resolve 假阳性放行一个加载会炸的包）。
  if (!result.ok) {
    await rollbackMany(bareNames);
    log.warn('agent', 'backend-install-failed', { pkg: specs, code: result.code, aborted: result.aborted });
    return result;
  }

  // npm exit 0 仍要校验（半装、exports 缺失、平台二进制没拉到都可能 exit 0）。bin 类
  // 查 .bin 存在性，库类查 require.resolve（dispatch 见 backend-loader）。包集合还要逐个
  // 查 package.json 版本，避免其中一个直接依赖缺失却被主入口掩盖。
  const packagesOk =
    specs.length === 1
      ? opts?.binName
        ? true
        : isBackendDepInstalled(bareNames[0]!)
      : bareNames.every((name) => installedBackendVersion(name) !== null);
  const binOk = opts?.binName ? isBackendBinInstalled(opts.binName) : true;
  const verifyOk = packagesOk && binOk;
  if (!verifyOk) {
    await rollbackMany(bareNames);
    log.warn('agent', 'backend-install-unverified', { pkg: specs });
    return {
      ok: false,
      code: result.code,
      aborted: false,
      tail: `${result.tail}\n\n安装后校验失败：「${bareNames.join('、')}」的包集合或入口不完整（可能半装/平台二进制缺失），已回滚。`,
    };
  }

  // 治本：修 node-pty spawn-helper 的可执行位（npm 安装偶发丢 +x → posix_spawnp
  // failed）。在 verify 通过后跑——绝不抛错，不影响安装结果。
  await fixNativeHelperPerms().catch(() => undefined);

  log.info('agent', 'backend-install-done', { pkg: specs });
  return result;
}

/** 卸载一个按需后端依赖（省空间 / 重装前清理）。绝不抛错。 */
export async function uninstallBackendDep(pkg: string | readonly string[]): Promise<boolean> {
  const bareNames = normalizeSpecs(pkg).map(stripVersion);
  await rollbackMany(bareNames);
  return bareNames.every((name) => installedBackendVersion(name) === null);
}

async function rollbackMany(bareNames: readonly string[]): Promise<void> {
  for (const bareName of bareNames) await rollback(bareName);
}

/** rm -rf backendsDir/node_modules/<pkg> + 从 package.json 移除条目 + 删 package-lock.json
 * （半装回滚 / 卸载）。绝不抛错。 */
async function rollback(bareName: string): Promise<void> {
  // scoped 包名（@scope/name）是两级目录，rm 整个包目录即可（@scope 空壳无害留着）。
  const target = join(paths.backendsDir, 'node_modules', ...bareName.split('/'));
  await rm(target, { recursive: true, force: true }).catch(() => undefined);
  // 连带从 package.json 删依赖条目——否则下次装别的后端时 npm 按 package.json reconcile
  // 又把它拉回来（默认 --save 把装过的都记进 package.json，多后端靠它共存；卸载就得反向清）。
  await removeBackendsDep(bareName);
  // 关键：删掉 package-lock.json。否则 lock 仍记着「<pkg> 已装」，下次 `npm i <pkg>` 会以为
  // 已满足、只「added 1 package」而**不恢复刚被 rm 的主包目录** → 校验又失败 → 再回滚 →
  // 永远装不上（实测踩坑）。删 lock 让下次安装全量重解析（其余后端按 package.json 一并恢复，
  // 缓存热则近乎 no-op）。
  await rm(join(paths.backendsDir, 'package-lock.json'), { force: true }).catch(() => undefined);
}

/** 从 backendsDir/package.json 的 dependencies 里删一个包（直接编辑 JSON，不 spawn npm）。绝不抛错。 */
async function removeBackendsDep(bareName: string): Promise<void> {
  const pkgFile = join(paths.backendsDir, 'package.json');
  try {
    const raw = await readFile(pkgFile, 'utf8');
    const json = JSON.parse(raw) as { dependencies?: Record<string, string> };
    if (json.dependencies && bareName in json.dependencies) {
      delete json.dependencies[bareName];
      await writeFile(pkgFile, `${JSON.stringify(json, null, 2)}\n`, 'utf8');
    }
  } catch {
    /* 文件不存在 / 解析失败 → 无条目可删，忽略 */
  }
}

/** 去掉版本后缀：`@scope/name@1.2.3` → `@scope/name`，`name@1.2.3` → `name`。 */
export function stripVersion(pkg: string): string {
  const at = pkg.lastIndexOf('@');
  // scoped 包以 @ 开头（lastIndexOf>0 才是版本分隔符）；非 scoped 的 at>0 也是版本分隔符。
  return at > 0 ? pkg.slice(0, at) : pkg;
}

function normalizeSpecs(pkg: string | readonly string[]): string[] {
  return typeof pkg === 'string' ? [pkg] : [...pkg];
}
