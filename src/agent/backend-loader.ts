import { createRequire } from 'node:module';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { paths } from '../config/paths';
import { runtimeRequireAnchor } from '../core/runtime-context';
import type { BackendCatalogEntry } from './catalog';
import { legacyBackendTombstonePath } from './backend-tombstone';

/**
 * 按需后端依赖的加载器（npm-ondemand 包，库类 / bin 类；通用基础设施，当前内置后端未用）。
 *
 * 真机验证过的解析方案（design/backend-catalog-ondemand.md §2.1，实验 C/D/F）：
 *   ① 先试 bridge 自身的 node_modules —— 直接 `await import(pkg)`（bare specifier）。
 *      这条兜 dev / worktree 模式：源码 checkout 里 `npm i` 把包装进仓库
 *      node_modules，命中此条，**绝不破坏当前 worktree 的测试/运行**。
 *      （ESM bare import 只认 importer 自身的 node_modules 链——实验 A/B。）
 *   ② catch ERR_MODULE_NOT_FOUND → 用户私装目录解析：
 *      `createRequire(backendsDir 下的锚点).resolve(pkg)`（honors exports map，实验 D）
 *      → `await import(pathToFileURL(resolved).href)`。生产 `npm i -g` 不带这些重包，
 *      用户在 Web 点「下载」后装进 backendsDir，从这条加载（SDK 内部对平台二进制的
 *      require.resolve 也落在这棵树里——实验 F）。
 *
 * 两处都解析不到 → 抛 {@link BackendNotInstalledError}（doctor 据此渲染「未安装·可下载」）。
 */

/** 一个按需后端包未安装（bridge 自身与用户私装目录均解析不到）。doctor 把它映射
 * 成三态里的「未安装」（installable）而非「真坏」。携带包名供卡片渲染下载提示。 */
export class BackendNotInstalledError extends Error {
  constructor(readonly pkg: string) {
    super(`后端依赖「${pkg}」未安装（bridge 自身与用户私装目录均未找到）`);
    this.name = 'BackendNotInstalledError';
  }
}

/** 用户私装目录下一个虚构锚点文件路径。createRequire 只用它定位 node_modules 链，
 * 文件本身不需真实存在（实验 C）。挂在 backendsDir 根 → 解析 backendsDir/node_modules。 */
function userAnchor(): string {
  return join(paths.backendsDir, '__backend_anchor__.cjs');
}

function legacyAnchor(): string | undefined {
  return paths.legacyBackendsDir === paths.backendsDir
    ? undefined
    : join(paths.legacyBackendsDir, '__legacy_backend_anchor__.cjs');
}

function managedAnchor(): string | undefined {
  return paths.managedBackendsDir
    ? join(paths.managedBackendsDir, '__managed_backend_anchor__.cjs')
    : undefined;
}

function privateAnchors(pkg: string): string[] {
  const managed = managedAnchor();
  const legacy = legacyAnchor();
  return [
    ...(managed ? [managed] : []),
    ...paths.systemNodeModulesDirs.map((root) => (
      join(dirname(root), '__system_backend_anchor__.cjs')
    )),
    userAnchor(),
    ...(legacy && !isLegacyBackendDisabled(pkg) ? [legacy] : []),
  ];
}

/**
 * Desktop-only package tombstone. Standalone upstream mode has no managed
 * root, so the original fallback order remains byte-for-byte effective.
 */
export function isLegacyBackendDisabled(pkg: string): boolean {
  if (
    paths.managedBackendsDir === undefined
    || paths.legacyBackendsDir === paths.backendsDir
  ) {
    return false;
  }
  try {
    lstatSync(legacyBackendTombstonePath(paths.managedBackendsDir, pkg));
    return true;
  } catch (error) {
    // Missing is the only affirmative "enabled" state. If the managed marker
    // cannot be inspected, fail closed instead of unexpectedly exposing the
    // read-only legacy package again.
    return (error as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}

/** Node 的 ESM「找不到模块」错误码族（不同 Node 版本/路径写法可能给不同码）。 */
const NOT_FOUND_CODES = new Set(['ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND', 'ERR_PACKAGE_PATH_NOT_EXPORTED']);

function isNotFound(err: unknown): boolean {
  const code = (err as { code?: string } | undefined)?.code;
  if (code !== undefined && NOT_FOUND_CODES.has(code)) return true;
  // 测试运行器（vite/vitest）拦截 bare `import()` 时给的不是 ERR_MODULE_NOT_FOUND，
  // 而是「Failed to load url <bare>」——按未找到处理，让第②路（用户目录）接管。
  // 真实 Node 永不产生此文案，所以生产无副作用。
  const msg = (err as { message?: string } | undefined)?.message ?? '';
  return /Failed to (load|resolve) (url|import)/i.test(msg);
}

/**
 * 按包名加载一个「可能装在 bridge 自身、也可能装在用户私装目录」的后端依赖。
 * 解析顺序见模块注释。两处都没有 → 抛 {@link BackendNotInstalledError}。
 * 拿到的 module 对象与裸 `import(pkg)` 完全一致（导出齐全——实验 F）。
 */
export async function loadBackendDep<T = unknown>(pkg: string): Promise<T> {
  // ① bridge 自身（dev/worktree 模式，或显式还留着依赖时）。
  try {
    return (await import(pkg)) as T;
  } catch (err) {
    // 仅「找不到模块」才回退用户目录；其它错误（包损坏、语法错误）原样抛出
    // ——那是真坏，不该被误判为「未安装·可下载」。
    if (!isNotFound(err)) throw err;
  }
  // ② Vonvon 托管目录，再回退原版用户私装目录。
  for (const anchor of privateAnchors(pkg)) {
    try {
      const resolved = resolveExisting(anchor, pkg);
      if (!resolved) continue;
      return (await import(pathToFileURL(resolved).href)) as T;
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
  }
  throw new BackendNotInstalledError(pkg);
}

/**
 * 一个按需后端依赖是否已安装（解析成功即装了——doctor / catalog 的快速判定）。
 * 与 {@link loadBackendDep} 同解析顺序，但只 resolve、不真 import（更轻、不触发
 * 包的副作用）。半装/损坏包让 resolve 抛 → 判未安装（与设计 R7 一致：宁可判未装，
 * 也不假阳性放行一个加载会炸的包）。绝不抛错。
 */
export function isBackendDepInstalled(pkg: string): boolean {
  // ① bridge 自身。
  try {
    createRequire(runtimeRequireAnchor()).resolve(pkg);
    return true;
  } catch {
    /* fall through to user dir */
  }
  // ② Vonvon 托管目录与原版用户私装目录。
  for (const anchor of privateAnchors(pkg)) {
    try {
      if (resolveExisting(anchor, pkg)) return true;
    } catch {
      // Continue through fixed private roots.
    }
  }
  return false;
}

/**
 * 有效私装目录里某个 npm bin 的绝对路径（npm 装包时生成 node_modules/.bin/<name>[.cmd]）。
 * bin 类后端被 **spawn** 而非 import —— 已装判定/命令解析走这里，
 * 不走 {@link isBackendDepInstalled}（bin-only 包通常无 main 入口，require.resolve 必失败）。
 * 命中需 existsSync 复验（卸载/移动自动失效）。找不到 → null。
 */
export function backendsBinPath(binName: string, pkg?: string): string | null {
  const roots = [
    ...(paths.managedBackendsDir ? [paths.managedBackendsDir] : []),
    paths.backendsDir,
    ...(paths.legacyBackendsDir === paths.backendsDir || (pkg && isLegacyBackendDisabled(pkg))
      ? []
      : [paths.legacyBackendsDir]),
  ];
  // Windows：cross-spawn 认 .cmd shim；POSIX：.bin/<name> 是带 shebang 的可执行软链。
  const candidates = roots.flatMap((root) => {
    const dir = join(root, 'node_modules', '.bin');
    return process.platform === 'win32'
      ? [join(dir, `${binName}.cmd`), join(dir, binName)]
      : [join(dir, binName)];
  });
  return candidates.find((p) => existsSync(p)) ?? null;
}

/** 一个 bin 类后端是否已装进用户私装目录（.bin 存在即装了）。绝不抛错。 */
export function isBackendBinInstalled(binName: string, pkg?: string): boolean {
  return backendsBinPath(binName, pkg) !== null;
}

/**
 * 一条 npm 管理的后端是否已装（catalog/doctor/detect 的统一判定，按 dep 形态分派）：
 *   bin 类（dep.binName）—— 查 node_modules/.bin（被 spawn 的可执行）。
 *   库类（仅 dep.pkg）—— 查 require.resolve（被 import 的库）。
 *   external-cli（codex）—— 不归此判（走 PATH，由 doctor/locate 负责）→ false。
 * 绝不抛错。
 */
export function isBackendEntryInstalled(entry: BackendCatalogEntry): boolean {
  const { kind, binName, pkg } = entry.dep;
  if (kind === 'external-cli') return false;
  if (binName) return isBackendBinInstalled(binName, pkg);
  return pkg ? isBackendDepInstalled(pkg) : false;
}

/**
 * 一个后端是否可由当前宿主管理/卸载（而非 bridge 自身 node_modules / dev devDep）。
 * 纯上游模式保持原语义，只检查 backendsDir。桌面模式检查 managed copy；如果只有
 * 尚未禁用的只读 legacy copy，也返回 true，让 Web 的「卸载」写 tombstone 而不删除
 * 旧源。bin 类查 .bin，库类查 require.resolve 后再复验解析目标仍存在。
 */
export function isBackendInstalledInUserDir(entry: BackendCatalogEntry): boolean {
  const { binName, pkg } = entry.dep;
  if (paths.managedBackendsDir !== undefined) {
    if (binName && backendBinExists(paths.managedBackendsDir, binName)) return true;
    if (pkg && backendPackageResolves(paths.managedBackendsDir, pkg)) return true;
    if (paths.legacyBackendsDir === paths.backendsDir || !pkg || isLegacyBackendDisabled(pkg)) {
      return false;
    }
    return binName
      ? backendBinExists(paths.legacyBackendsDir, binName)
      : backendPackageResolves(paths.legacyBackendsDir, pkg);
  }
  if (binName) {
    return backendBinExists(paths.backendsDir, binName);
  }
  if (!pkg) return false;
  return backendPackageResolves(paths.backendsDir, pkg);
}

/**
 * 已装后端的有效版本号（读其 package.json 的 version）。依次检查 managed、桌面
 * writable、未被 tombstone 的 legacy，最后检查 bridge 自身 node_modules
 *（dev/worktree）。读不到 → null。绝不抛错。
 */
export function installedBackendVersion(pkg: string): string | null {
  const readVer = (file: string): string | null => {
    try {
      const j = JSON.parse(readFileSync(file, 'utf8')) as { version?: string };
      return typeof j.version === 'string' ? j.version : null;
    } catch {
      return null;
    }
  };
  // ① 用户私装目录。
  const inManaged = paths.managedBackendsDir
    ? join(paths.managedBackendsDir, 'node_modules', ...pkg.split('/'), 'package.json')
    : undefined;
  const managedVersion = inManaged ? readVer(inManaged) : null;
  if (managedVersion) return managedVersion;
  const inUser = join(paths.backendsDir, 'node_modules', ...pkg.split('/'), 'package.json');
  const v1 = readVer(inUser);
  if (v1) return v1;
  if (
    paths.legacyBackendsDir !== paths.backendsDir
    && !isLegacyBackendDisabled(pkg)
  ) {
    const inLegacy = join(paths.legacyBackendsDir, 'node_modules', ...pkg.split('/'), 'package.json');
    const legacyVersion = readVer(inLegacy);
    if (legacyVersion) return legacyVersion;
  }
  for (const root of paths.systemNodeModulesDirs) {
    const systemVersion = readVer(join(root, ...pkg.split('/'), 'package.json'));
    if (systemVersion) return systemVersion;
  }
  // ② bridge 自身（dev/worktree）：用 createRequire 解析包的 package.json 路径。
  try {
    const resolved = createRequire(runtimeRequireAnchor()).resolve(`${pkg}/package.json`);
    return readVer(resolved);
  } catch {
    return null;
  }
}

function backendPackageResolves(root: string, pkg: string): boolean {
  try {
    return resolveExisting(join(root, '__backend_anchor__.cjs'), pkg) !== undefined;
  } catch {
    return false;
  }
}

function backendBinExists(root: string, binName: string): boolean {
  const dir = join(root, 'node_modules', '.bin');
  const candidates = process.platform === 'win32'
    ? [join(dir, `${binName}.cmd`), join(dir, binName)]
    : [join(dir, binName)];
  return candidates.some((candidate) => existsSync(candidate));
}

function resolveExisting(anchor: string, pkg: string): string | undefined {
  const resolved = createRequire(anchor).resolve(pkg);
  // Node caches successful resolution paths. An uninstall can remove the
  // target while resolve() still returns that stale path in this process.
  return existsSync(resolved) ? resolved : undefined;
}
