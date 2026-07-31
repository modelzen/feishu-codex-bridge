import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AdminService,
  AdminServiceDeps,
} from '../src/admin/service';
import type { MountedWebConsole } from '../src/web/mount';

const mocks = vi.hoisted(() => ({
  configurePathRoots: vi.fn(),
  createAdminService: vi.fn(),
  mountWebConsole: vi.fn(),
}));

vi.mock('../src/config/paths', () => ({
  configurePathRoots: mocks.configurePathRoots,
}));
vi.mock('../src/admin/service', () => ({
  createAdminService: mocks.createAdminService,
}));
vi.mock('../src/web/mount', () => ({
  mountWebConsole: mocks.mountWebConsole,
}));
vi.mock('../src/core/version', () => ({
  bridgeVersion: () => '0.6.10',
}));

const admin = {} as AdminService;
const mounted: MountedWebConsole = {
  url: 'http://127.0.0.1:51847/?token=test',
  port: 51847,
  close: async () => undefined,
};

const requiredRoutes = {
  executeWrite: vi.fn(async () => undefined),
  liveStatus: vi.fn(async () => ({ running: true })),
  resolveBotSecret: vi.fn(async () => 'secret'),
  registerBotByQr: vi.fn(async () => ({
    ok: false as const,
    code: 'abort' as const,
    reason: 'cancelled',
  })),
  setBotEnabled: vi.fn(async () => ({ ok: true as const })),
  deleteBot: vi.fn(async () => ({ ok: true as const })),
  daemonStatus: vi.fn(async () => ({
    installed: true,
    running: true,
    selfHosted: false,
    version: '1.0.0',
    supported: true,
  })),
  restartDaemon: vi.fn(async () => undefined),
  stopDaemon: vi.fn(async () => undefined),
  checkUpdate: vi.fn(async () => ({
    mode: 'manual' as const,
    state: 'unpublished' as const,
    current: '1.0.0',
    compatVersion: '0.6.10',
    latest: null,
    hasUpdate: false,
    dev: false,
    message: '桌面更新通道尚未发布，当前为测试构建。',
  })),
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createAdminService.mockReturnValue(admin);
  mocks.mountWebConsole.mockResolvedValue(mounted);
});

describe('desktop Web console host adapter', () => {
  it('binds shared host paths and routes every desktop-owned mutation', async () => {
    const { createDesktopAdminService } = await import(
      '../src/kernel/desktop-host'
    );

    expect(
      createDesktopAdminService({
        dataDir: '/tmp/vonvon',
        hostDataDir: '/tmp/vonvon-host',
        legacyAssetsDir: '/tmp/legacy',
        writableAssetsDir: '/tmp/vonvon-assets',
        managedToolsDir: '/tmp/tools',
        ...requiredRoutes,
      }),
    ).toBe(admin);

    expect(mocks.configurePathRoots).toHaveBeenCalledWith({
      dataDir: '/tmp/vonvon',
      hostDataDir: '/tmp/vonvon-host',
      legacyAssetsDir: '/tmp/legacy',
      writableAssetsDir: '/tmp/vonvon-assets',
      managedToolsDir: '/tmp/tools',
    });
    const deps = mocks.createAdminService.mock.calls[0]?.[0] as AdminServiceDeps;
    expect(deps).toMatchObject(requiredRoutes);
    expect(await deps.checkUpdate?.()).toEqual({
      mode: 'manual',
      state: 'unpublished',
      current: '1.0.0',
      compatVersion: '0.6.10',
      latest: null,
      hasUpdate: false,
      dev: false,
      message: '桌面更新通道尚未发布，当前为测试构建。',
    });
    expect(deps.updateStatus?.()).toBeNull();
    expect(deps.applyUpdate).toBeUndefined();
  });

  it('mounts the unchanged Web console with the desktop-backed AdminService', async () => {
    const { mountDesktopWebConsole } = await import(
      '../src/kernel/desktop-host'
    );

    await expect(
      mountDesktopWebConsole({
        dataDir: '/tmp/vonvon',
        legacyAssetsDir: '/tmp/legacy',
        ...requiredRoutes,
      }),
    ).resolves.toBe(mounted);

    expect(mocks.configurePathRoots).toHaveBeenCalledWith({
      dataDir: '/tmp/vonvon',
      hostDataDir: '/tmp/vonvon',
      legacyAssetsDir: '/tmp/legacy',
    });
    expect(mocks.mountWebConsole).toHaveBeenCalledWith(admin);
  });
});
