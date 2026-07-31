import {
  createAdminService,
  type AdminService,
  type AdminServiceDeps,
} from '../admin/service.js';
import { configurePathRoots, type PathRoots } from '../config/paths.js';
import { mountWebConsole, type MountedWebConsole } from '../web/mount.js';

type RequiredRoute<K extends keyof AdminServiceDeps> =
  NonNullable<AdminServiceDeps[K]>;

/**
 * The complete desktop-owned mutation/lifecycle seam behind the legacy Web
 * console. Required routes are intentionally compile-time mandatory: falling
 * back to upstream QR registration, registry mutation, service control, or
 * secret storage would split desktop-index/runtime state from what users see.
 */
export interface DesktopWebConsoleHostOptions extends PathRoots {
  executeWrite: RequiredRoute<'executeWrite'>;
  liveStatus: RequiredRoute<'liveStatus'>;
  resolveBotSecret: RequiredRoute<'resolveBotSecret'>;
  registerBotByQr: RequiredRoute<'registerBotByQr'>;
  setBotEnabled: RequiredRoute<'setBotEnabled'>;
  deleteBot: RequiredRoute<'deleteBot'>;

  daemonStatus: RequiredRoute<'daemonStatus'>;
  restartDaemon: RequiredRoute<'restartDaemon'>;
  stopDaemon: RequiredRoute<'stopDaemon'>;
  startDaemon?: RequiredRoute<'startDaemon'>;

  /**
   * Desktop updater route. It is required so the Web console can never fall
   * back to the compat-kernel/npm version. Apply remains absent in manual mode.
   */
  checkUpdate: RequiredRoute<'checkUpdate'>;
  updateStatus?: RequiredRoute<'updateStatus'>;
  clearUpdateStatus?: RequiredRoute<'clearUpdateStatus'>;
  applyUpdate?: RequiredRoute<'applyUpdate'>;

  /** Optional desktop-managed backend package routes. */
  installBackend?: RequiredRoute<'installBackend'>;
  uninstallBackend?: RequiredRoute<'uninstallBackend'>;

  /** Stable sidecar start time used by legacy uptime projections. */
  startedAt?: number;
}

/**
 * Build the original AdminService with every unsafe host operation routed
 * through desktop ownership. Exported separately from mounting so runtime
 * composition tests can exercise the exact Web interface without opening a
 * socket.
 */
export function createDesktopAdminService(
  options: DesktopWebConsoleHostOptions,
): AdminService {
  configurePathRoots({
    dataDir: options.dataDir,
    hostDataDir: options.hostDataDir ?? options.dataDir,
    legacyAssetsDir: options.legacyAssetsDir,
    ...(options.writableAssetsDir === undefined
      ? {}
      : { writableAssetsDir: options.writableAssetsDir }),
    ...(options.managedToolsDir === undefined
      ? {}
      : { managedToolsDir: options.managedToolsDir }),
    ...(options.systemNodeModulesDirs === undefined
      ? {}
      : { systemNodeModulesDirs: options.systemNodeModulesDirs }),
  });

  return createAdminService({
    executeWrite: options.executeWrite,
    liveStatus: options.liveStatus,
    resolveBotSecret: options.resolveBotSecret,
    registerBotByQr: options.registerBotByQr,
    setBotEnabled: options.setBotEnabled,
    deleteBot: options.deleteBot,
    daemonStartedAt: options.startedAt,
    daemonStatus: options.daemonStatus,
    restartDaemon: options.restartDaemon,
    stopDaemon: options.stopDaemon,
    ...(options.startDaemon === undefined
      ? {}
      : { startDaemon: options.startDaemon }),
    checkUpdate: options.checkUpdate,
    updateStatus: options.updateStatus ?? (() => null),
    clearUpdateStatus: options.clearUpdateStatus ?? (() => undefined),
    ...(options.applyUpdate === undefined
      ? {}
      : { applyUpdate: options.applyUpdate }),
    ...(options.installBackend === undefined
      ? {}
      : { installBackend: options.installBackend }),
    ...(options.uninstallBackend === undefined
      ? {}
      : { uninstallBackend: options.uninstallBackend }),
  });
}

/**
 * Mount the unchanged upstream Web UI on localhost, backed by desktop-owned
 * routes. Listen failures remain non-fatal, preserving upstream behavior.
 */
export function mountDesktopWebConsole(
  options: DesktopWebConsoleHostOptions,
): Promise<MountedWebConsole | undefined> {
  return mountWebConsole(createDesktopAdminService(options));
}

export type { MountedWebConsole };
