import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BACKEND_CATALOG,
  catalogBackendIds,
  catalogById,
  catalogByFamily,
  isInstallable,
  projectCreatableBackends,
  visibleCatalog,
} from '../src/agent/catalog';
import { backendIds, createBackend } from '../src/agent';
import {
  BackendNotInstalledError,
  isBackendDepInstalled,
  loadBackendDep,
} from '../src/agent/backend-loader';
import { buildInstallCommand, stripVersion } from '../src/agent/installer';
import { paths } from '../src/config/paths';

/**
 * 棒A 地基：catalog↔REGISTRY 配对、按需加载器三路径、installer 命令构建（不真跑
 * npm）、智能默认规则、ensureAnyAgent 放行。当前内置后端仅 codex（claude 系已移除）。
 */

describe('catalog ↔ REGISTRY 配对（防漏注册）', () => {
  it('catalogBackendIds == backendIds（两处都注册才不红）', () => {
    expect([...catalogBackendIds()].sort()).toEqual([...backendIds()].sort());
  });

  it('每条 catalog id 都能 createBackend 出一个实例（工厂存在）', () => {
    for (const entry of BACKEND_CATALOG) {
      const be = createBackend(entry.id);
      expect(be.id).toBe(entry.id);
    }
  });

  it('catalog 的 supportedModes 与 backend 实例声明一致', () => {
    for (const entry of BACKEND_CATALOG) {
      const be = createBackend(entry.id);
      expect(entry.supportedModes).toEqual(be.supportedModes);
    }
  });

  it('唯一内置后端 codex 是 external-cli（bridge 不负责装，doctor 探 PATH）', () => {
    expect(catalogById('codex-appserver')?.dep.kind).toBe('external-cli');
  });

  it('external-cli（codex）不可一键下载（isInstallable=false）', () => {
    expect(isInstallable(catalogById('codex-appserver')!)).toBe(false);
  });

  it('catalogByFamily 分组：codex 组 / claude 组各 1 条', () => {
    expect(catalogByFamily('codex').map((e) => e.id)).toEqual(['codex-appserver']);
    expect(catalogByFamily('claude').map((e) => e.id)).toEqual(['claude-agent']);
  });
});

describe('projectCreatableBackends —— 飞书新建/绑定卡的「可选后端」过滤（创建时选定）', () => {
  const ids = (mode: 'qa' | 'write' | 'full', inst: (e: { id: string }) => boolean) =>
    projectCreatableBackends(mode, inst).map((e) => e.id);

  it('codex 是默认基线 → 即便都「未下载」也始终可选；claude-agent 未装则不出现', () => {
    expect(ids('full', () => false)).toEqual(['codex-appserver']);
  });

  it('qa 档（外部群）→ codex + 已装的 claude-agent 都可选（两者都支持 qa 档）', () => {
    expect(ids('qa', () => true)).toEqual(['codex-appserver', 'claude-agent']);
  });

  it('任意权限档：codex 恒在；claude-agent 仅在「已装」时出现（按下载态过滤）', () => {
    for (const mode of ['qa', 'write', 'full'] as const) {
      expect(ids(mode, () => true)).toEqual(['codex-appserver', 'claude-agent']);
      expect(ids(mode, () => false)).toEqual(['codex-appserver']);
    }
  });
});

describe('可见 catalog 与注册派生（codex + claude-agent）', () => {
  it('visibleCatalog() 含 codex 与 claude-agent（Web 后端页 / 体检页 / picker 数据源）', () => {
    expect(visibleCatalog().map((e) => e.id)).toEqual(['codex-appserver', 'claude-agent']);
  });

  it('catalogBackendIds 与 REGISTRY 配对不破（两条）', () => {
    expect([...catalogBackendIds()].sort()).toEqual(['claude-agent', 'codex-appserver']);
    // 工厂存在：两个 id 都能构造出实例。
    expect(createBackend('codex-appserver').id).toBe('codex-appserver');
    expect(createBackend('claude-agent').id).toBe('claude-agent');
  });

  it('createBackend 未注册 id 仍抛错（错误信息含 codex-appserver）', () => {
    expect(() => createBackend('no-such-backend')).toThrow(/未知 agent 后端/);
    expect(() => createBackend('no-such-backend')).toThrow(/codex-appserver/);
  });
});

describe('backend-loader：按需依赖加载（三路径）', () => {
  const origBackendsDir = paths.backendsDir;
  let userDir: string;

  beforeEach(() => {
    userDir = mkdtempSync(join(tmpdir(), 'backends-'));
    paths.backendsDir = userDir;
  });
  afterEach(() => {
    paths.backendsDir = origBackendsDir;
    rmSync(userDir, { recursive: true, force: true });
  });

  it('① bridge 自身 node_modules 命中：bare import（dev/worktree 模式，不碰用户目录）', async () => {
    // cross-spawn 是 bridge 自身 dependency，必在 worktree node_modules —— 走第①条。
    // 用户目录是空临时目录，证明根本没用到它（第①条就命中了）。
    const mod = await loadBackendDep<{ default?: unknown }>('cross-spawn');
    expect(mod).toBeDefined();
    // cross-spawn 是 CJS 函数；ESM interop 下函数挂在 default（或模块本身）。
    expect(typeof (mod.default ?? mod)).toBe('function');
    expect(isBackendDepInstalled('cross-spawn')).toBe(true);
  });

  it('② 用户私装目录解析：bridge 自身没有的包，从 backendsDir 加载', async () => {
    // 在临时用户目录里造一个 bridge 自身绝无的假包，证明走第②条（createRequire 锚 backendsDir）。
    const pkgName = 'fcb-fake-ondemand-pkg';
    const pkgDir = join(userDir, 'node_modules', pkgName);
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: pkgName, version: '1.0.0', main: 'index.mjs' }));
    writeFileSync(join(pkgDir, 'index.mjs'), 'export const marker = "from-user-dir";\n');

    expect(isBackendDepInstalled(pkgName)).toBe(true);
    const mod = await loadBackendDep<{ marker: string }>(pkgName);
    expect(mod.marker).toBe('from-user-dir');
  });

  it('③ 两处都没有：抛 BackendNotInstalledError（携带包名）', async () => {
    const ghost = 'fcb-definitely-not-installed-anywhere';
    expect(isBackendDepInstalled(ghost)).toBe(false);
    await expect(loadBackendDep(ghost)).rejects.toBeInstanceOf(BackendNotInstalledError);
    await expect(loadBackendDep(ghost)).rejects.toMatchObject({ pkg: ghost });
  });
});

describe('installer：命令构建（不真跑 npm）', () => {
  it('buildInstallCommand：npm install <pkg> --prefix backendsDir --include=optional + 关进度', () => {
    const { command, args } = buildInstallCommand('@scope/some-ondemand-pkg@0.3.175', {
      prefix: '/u/backends',
      cacheDir: '/u/npm-cache',
    });
    expect(command).toBe('npm');
    expect(args).toContain('install');
    expect(args).toContain('@scope/some-ondemand-pkg@0.3.175');
    expect(args).toContain('--include=optional');
    expect(args).toContain('--no-progress'); // 关 npm 进度条避免流里乱码
    // 用默认 --save（多后端共存靠 package.json 记账；--no-save 会 prune 掉其它后端 → 互斥）
    expect(args).not.toContain('--no-save');
    const i = args.indexOf('--prefix');
    expect(args[i + 1]).toBe('/u/backends');
    const c = args.indexOf('--cache');
    expect(args[c + 1]).toBe('/u/npm-cache');
  });

  it('buildInstallCommand 默认用 paths.backendsDir / npmCacheDir', () => {
    const { args } = buildInstallCommand('some-pkg');
    expect(args[args.indexOf('--prefix') + 1]).toBe(paths.backendsDir);
    expect(args[args.indexOf('--cache') + 1]).toBe(paths.npmCacheDir);
  });

  it('buildInstallCommand：一条 npm 命令可原子安装多个精确包', () => {
    const { args } = buildInstallCommand(['@scope/runtime@1.2.3', '@scope/protocol@1.2.3'], {
      prefix: '/u/backends',
      cacheDir: '/u/npm-cache',
    });
    expect(args.slice(0, 3)).toEqual([
      'install',
      '@scope/runtime@1.2.3',
      '@scope/protocol@1.2.3',
    ]);
  });

  it('stripVersion：scoped/非 scoped 都正确去版本', () => {
    expect(stripVersion('@scope/some-ondemand-pkg@0.3.175')).toBe('@scope/some-ondemand-pkg');
    expect(stripVersion('@scope/some-ondemand-pkg')).toBe('@scope/some-ondemand-pkg');
    expect(stripVersion('nanoid@5.0.0')).toBe('nanoid');
    expect(stripVersion('nanoid')).toBe('nanoid');
  });
});

describe('按需依赖装没装的两态（isBackendDepInstalled —— 通用机制，codex 系内置后端不用但基础设施保留）', () => {
  it('bridge 自身依赖可解析 → true；两处都没有的幽灵包 → false', () => {
    // 已装样例用仍在的 bridge 自身依赖（cross-spawn），不耦合已删后端的包名。
    expect(isBackendDepInstalled('cross-spawn')).toBe(true);
    expect(isBackendDepInstalled('fcb-definitely-not-installed-anywhere')).toBe(false);
  });
});
