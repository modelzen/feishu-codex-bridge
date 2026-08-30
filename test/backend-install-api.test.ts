import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BackendProbe } from '../src/agent/types';

// 隔离 listBackendCatalog（状态聚合）与 installBackend（installer 委托 + 501 预览态）。
// mock 整个 ../src/agent：给受控 catalog + 受控 doctor + effectiveDefaultBackend，
// 避免真机探测（codex 是否装会让断言飘）。installBackendDep 这里不用（service 走
// 注入的 deps.installBackend），但 index 仍需导出它（service import 了）。
//
// 现实只有 codex-appserver 一个真实后端（external-cli，非 installable）。为保住「安装
// API 通用机制」（版本 pin 拼包名、库类/ bin 类 binName 透传、501 预览态）的覆盖，本
// mock 额外塞两条**纯合成的假后端**（fake-lib / fake-bin，npm-ondemand），走 installable
// 分支验证委托逻辑——它们不对应任何真实后端，只是 catalog 派生机制的最小夹具。

// vi.mock 会被 hoist 到文件顶部 → 共享常量也得 hoist（vi.hoisted）才能被工厂引用。
const { CATALOG, doctorResults } = vi.hoisted(() => {
  const doctorResults: Record<string, BackendProbe> = {
    'codex-appserver': { ok: true, version: '1.2.3' },
    'fake-lib': { ok: false, version: null, hint: '未安装，点下载', depState: 'not-installed', installable: true },
    'fake-bin': { ok: false, version: null, hint: '未安装，点下载', depState: 'not-installed', installable: true },
    'fake-bundle': { ok: false, version: null, hint: '未安装，点下载', depState: 'not-installed', installable: true },
  };
  const CATALOG = [
    {
      id: 'codex-appserver',
      agentFamily: 'codex',
      displayName: 'Codex',
      access: 'app-server',
      dep: { kind: 'external-cli', pkg: 'codex', detectHint: '未找到 codex' },
      blurb: '能力最全',
    },
    // 合成「库类」按需后端（无 binName）：装完走 require.resolve；带 version pin。
    {
      id: 'fake-lib',
      agentFamily: 'fake',
      displayName: '假后端（库类）',
      access: 'sdk',
      dep: {
        kind: 'npm-ondemand',
        pkg: '@example/fake-lib',
        version: '0.3.175',
        approxSizeMB: 224,
        detectHint: '未安装，点下载',
        installCmd: '点「下载假后端（库类）」',
      },
      supportedModes: ['full'],
      blurb: '库类按需装夹具',
    },
    // 合成「bin 类」按需后端（有 binName，无 version pin）：装完走 .bin 校验；latest 不拼 @ver。
    {
      id: 'fake-bin',
      agentFamily: 'fake',
      displayName: '假后端（bin 类）',
      access: 'acp',
      dep: {
        kind: 'npm-ondemand',
        pkg: 'fake-bin-cli',
        binName: 'fake-bin-cli',
        approxSizeMB: 65,
        detectHint: '未安装，点下载',
        installCmd: '点「下载假后端（bin 类）」',
      },
      supportedModes: ['full'],
      blurb: 'bin 类按需装夹具',
    },
    // 合成「多包 + bin」按需后端：一次安装同版本运行包集合，并校验入口。
    {
      id: 'fake-bundle',
      agentFamily: 'fake',
      displayName: '假后端（包集合）',
      access: 'jsonrpc',
      dep: {
        kind: 'npm-ondemand',
        pkg: '@example/fake-runtime',
        binName: 'fake-jsonrpc-agent',
        version: '1.2.3',
        installSpecs: [
          '@example/fake-runtime@1.2.3',
          '@example/fake-protocol@1.2.3',
        ],
        approxSizeMB: 80,
        detectHint: '未安装，点下载',
      },
      supportedModes: ['full'],
      blurb: '多包按需装夹具',
    },
  ];
  return { CATALOG, doctorResults };
});

vi.mock('../src/agent', () => ({
  DEFAULT_BACKEND_ID: 'codex-appserver',
  BACKEND_CATALOG: CATALOG,
  // 镜像真实 visibleCatalog：滤掉 hidden（本 mock 三条均不 hidden → 全列，验证聚合机制本身）。
  visibleCatalog: () => CATALOG.filter((e) => !(e as { hidden?: boolean }).hidden),
  backendIds: () => CATALOG.map((e) => e.id),
  createBackend: (id: string) => ({
    id,
    displayName: CATALOG.find((e) => e.id === id)?.displayName ?? id,
    doctor: async (): Promise<BackendProbe> => doctorResults[id] ?? { ok: false, version: null },
  }),
  catalogById: (id: string) => CATALOG.find((e) => e.id === id),
  isInstallable: (entry: { dep: { kind: string } }) => entry.dep.kind === 'npm-ondemand',
  effectiveDefaultBackend: async () => 'codex-appserver',
  installBackendDep: vi.fn(),
  isBackendInstalledInUserDir: () => false,
  installedBackendVersion: () => null,
  latestNpmVersion: async () => null,
}));

import { createAdminService, NotWiredYetError } from '../src/admin/service';

afterEach(() => vi.clearAllMocks());

describe('listBackendCatalog · 状态聚合', () => {
  it('聚合 catalog + 三态 depState/installable/version/approxSize + 默认标记', async () => {
    const svc = createAdminService();
    const out = await svc.listBackendCatalog();
    expect(out.defaultBackend).toBe('codex-appserver');
    expect(out.entries.map((e) => e.id)).toEqual(['codex-appserver', 'fake-lib', 'fake-bin', 'fake-bundle']);

    const codex = out.entries.find((e) => e.id === 'codex-appserver')!;
    expect(codex).toMatchObject({
      depKind: 'external-cli',
      depState: 'installed',
      installable: false,
      version: '1.2.3',
      isDefault: true,
    });

    const lib = out.entries.find((e) => e.id === 'fake-lib')!;
    expect(lib).toMatchObject({
      depKind: 'npm-ondemand',
      depState: 'not-installed',
      installable: true,
      approxSizeMB: 224,
      version: null,
      isDefault: false,
    });
    expect(lib.hint).toContain('下载');
    expect(lib.supportedModes).toEqual(['full']);

    const bin = out.entries.find((e) => e.id === 'fake-bin')!;
    expect(bin).toMatchObject({
      depKind: 'npm-ondemand',
      depState: 'not-installed',
      installable: true,
      approxSizeMB: 65,
    });
  });
});

describe('installBackend · installer 委托 + 守门', () => {
  it('库类 installable 后端委托 installer（带版本 pin、binName=undefined），透传进度/结果', async () => {
    const installer = vi.fn(async (pkg: string | readonly string[], onProgress?: (c: string) => void) => {
      onProgress?.('added 1 package\n');
      void pkg;
      return { ok: true as const, code: 0, aborted: false, tail: 'done' };
    });
    const svc = createAdminService({ installBackend: installer });
    const chunks: string[] = [];
    const r = await svc.installBackend('fake-lib', (c) => chunks.push(c));
    expect(r.ok).toBe(true);
    // 带 pin 版本拼包名；库类 binName 透传 undefined（装完走 require.resolve 校验）
    expect(installer).toHaveBeenCalledWith(
      '@example/fake-lib@0.3.175',
      expect.any(Function),
      undefined,
      { binName: undefined },
    );
    expect(chunks).toEqual(['added 1 package\n']);
  });

  it('bin 类 installable 后端委托 installer（latest 无 pin、带 binName）', async () => {
    const installer = vi.fn(async () => ({ ok: true as const, code: 0, aborted: false, tail: 'done' }));
    const svc = createAdminService({ installBackend: installer });
    const r = await svc.installBackend('fake-bin');
    expect(r.ok).toBe(true);
    // version 省略 → 不拼 @ver（latest）；binName 透传 → 装完走 .bin 校验
    expect(installer).toHaveBeenCalledWith('fake-bin-cli', undefined, undefined, { binName: 'fake-bin-cli' });
  });

  it('多包后端把精确 installSpecs 原样交给 installer，并校验声明的 bin', async () => {
    const installer = vi.fn(async () => ({ ok: true as const, code: 0, aborted: false, tail: 'done' }));
    const svc = createAdminService({ installBackend: installer });
    const r = await svc.installBackend('fake-bundle');
    expect(r.ok).toBe(true);
    expect(installer).toHaveBeenCalledWith(
      ['@example/fake-runtime@1.2.3', '@example/fake-protocol@1.2.3'],
      undefined,
      undefined,
      { binName: 'fake-jsonrpc-agent' },
    );
  });

  it('非 installable 后端（external-cli codex）→ {ok:false} 给手动装法，不调 installer', async () => {
    const installer = vi.fn();
    const svc = createAdminService({ installBackend: installer });
    const r = await svc.installBackend('codex-appserver');
    expect(r.ok).toBe(false);
    expect(r.tail).toContain('不支持一键下载');
    expect(installer).not.toHaveBeenCalled();
  });

  it('未知后端 id → {ok:false}，不调 installer', async () => {
    const installer = vi.fn();
    const svc = createAdminService({ installBackend: installer });
    const r = await svc.installBackend('nope');
    expect(r.ok).toBe(false);
    expect(r.tail).toContain('未知后端');
    expect(installer).not.toHaveBeenCalled();
  });

  it('只读预览态（无 installer 注入）：installable 后端抛 NotWiredYetError（→ HTTP 501）', async () => {
    const svc = createAdminService(); // 无 deps.installBackend
    await expect(svc.installBackend('fake-lib')).rejects.toBeInstanceOf(NotWiredYetError);
    // bin 类同样是 installable（npm-ondemand bin 类）→ 同样走 501 引导起 daemon
    await expect(svc.installBackend('fake-bin')).rejects.toBeInstanceOf(NotWiredYetError);
  });
});
