import type { AdminWriteOp } from '../admin/ops.js';
import {
  startBridge,
  type BridgeHandle,
  type BridgeLifecycleEvent,
} from '../bot/bridge.js';
import { configurePathRoots, useBotDir } from '../config/paths.js';
import { provideRuntimeFileSecret } from '../config/secret-resolver.js';
import { loadConfig } from '../config/store.js';
import { configureEmbeddedRuntimeHost } from '../core/runtime-context.js';
import { DesktopReleaseProvider } from '../service/desktop-release.js';
import { buildEventConfigUrl } from '../config/scopes.js';
import type {
  AppAccess,
  AppConfig,
  AppPreferences,
  TenantBrand,
} from '../config/schema.js';
import {
  diagnoseEventSubscription,
  summarizeEventDiagnosis,
  type EventDiagnosis,
} from '../utils/event-diagnosis.js';
export {
  runHookCommand,
  type HookPathRoots,
} from '../cli-bridge/index.js';

export type BotPreferences = Omit<AppPreferences, 'access'> & {
  access?: Omit<AppAccess, 'ownerOpenId' | 'admins'>;
};

export interface BotSpec {
  appId: string;
  appSecret: string;
  /** Opaque id persisted in config; the plaintext is process-only. */
  accountSecretRef: string;
  tenant: TenantBrand;
  ownerOpenId: string;
  admins: readonly string[];
  preferences?: BotPreferences;
  dataDir: string;
  /** Shared desktop host root for Web console discovery and aggregated logs. */
  hostDataDir?: string;
  /** Existing CLI assets are resolution-only and must remain untouched. */
  legacyAssetsDir: string;
  /** Desktop-owned root for media, hooks, installs, and blank projects. */
  writableAssetsDir: string;
  managedToolsDir?: string;
  /** User-controlled global npm roots selected by the desktop environment scan. */
  systemNodeModulesDirs?: readonly string[];
  fallbackCwd: string;
  /** Desktop application release channel; omitted only outside the desktop host. */
  desktopRelease?: {
    currentVersion: string;
    manifestUrl?: string;
  };
}

export type BotConnection =
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'disconnected'
  | 'unknown';

export interface BotStatus {
  connection: BotConnection;
  lastError?: string;
  /**
   * The socket can be connected while Feishu still delivers no messages
   * because the required event was never published. Keep that failure separate
   * from transport errors so reconnects do not accidentally hide it.
   */
  eventSubscriptionWarning?: string;
}

export type BotRuntimeEvent =
  | {
      type: 'status';
      appId: string;
      status: BotStatus;
      at: number;
    }
  | {
      type: 'restart-requested';
      appId: string;
      at: number;
    };

export type BotEventSink = (event: BotRuntimeEvent) => void;

export interface RunningBot {
  status(): BotStatus;
  executeAdmin(op: AdminWriteOp): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Start one complete upstream bot kernel in the current process.
 *
 * Upstream path selection is module-global, so the supervisor must isolate
 * bots by process. This adapter intentionally does not add an in-process
 * multi-bot supervisor or alter upstream message behavior.
 */
export async function startBot(
  spec: BotSpec,
  eventSink?: BotEventSink,
): Promise<RunningBot> {
  const appId = required('appId', spec.appId);
  const appSecret = required('appSecret', spec.appSecret);
  const accountSecretRef = required('accountSecretRef', spec.accountSecretRef);
  const ownerOpenId = required('ownerOpenId', spec.ownerOpenId);
  const fallbackCwd = required('fallbackCwd', spec.fallbackCwd);
  if (spec.tenant !== 'feishu' && spec.tenant !== 'lark') {
    throw new Error('tenant must be "feishu" or "lark"');
  }

  let current: BotStatus = { connection: 'connecting' };
  const emit = (event: BotRuntimeEvent): void => {
    if (!eventSink) return;
    try {
      eventSink(event);
    } catch {
      // Observation and host-control delivery must never take down the kernel.
    }
  };
  const publish = (status: BotStatus): void => {
    current = status;
    emit({
      type: 'status',
      appId,
      status: { ...status },
      at: Date.now(),
    });
  };
  publish(current);

  let handle: BridgeHandle;
  let revokeRuntimeSecret: (() => void) | undefined;
  let revokeEmbeddedHost: (() => void) | undefined;
  try {
    configurePathRoots({
      dataDir: spec.dataDir,
      ...(spec.hostDataDir === undefined
        ? {}
        : { hostDataDir: spec.hostDataDir }),
      legacyAssetsDir: spec.legacyAssetsDir,
      writableAssetsDir: spec.writableAssetsDir,
      ...(spec.managedToolsDir === undefined
        ? {}
        : { managedToolsDir: spec.managedToolsDir }),
      ...(spec.systemNodeModulesDirs === undefined
        ? {}
        : { systemNodeModulesDirs: spec.systemNodeModulesDirs }),
    });
    useBotDir(appId);
    revokeRuntimeSecret = provideRuntimeFileSecret(accountSecretRef, appSecret);
    const desktopRelease = spec.desktopRelease === undefined
      ? undefined
      : new DesktopReleaseProvider({
          currentVersion: spec.desktopRelease.currentVersion,
          ...(spec.desktopRelease.manifestUrl === undefined
            ? {}
            : { manifestUrl: spec.desktopRelease.manifestUrl }),
        });
    revokeEmbeddedHost = configureEmbeddedRuntimeHost({
      requestRestart() {
        emit({ type: 'restart-requested', appId, at: Date.now() });
      },
      ...(desktopRelease === undefined
        ? {}
        : { checkUpdate: () => desktopRelease.check() }),
    });

    const cfg = buildConfig(
      {
        ...spec,
        appId,
        appSecret,
        accountSecretRef,
        ownerOpenId,
        fallbackCwd,
      },
      await loadConfig(),
    );
    handle = await startBridge({
      cfg,
      appSecret,
      fallbackCwd,
      onLifecycleEvent: (event) => updateLifecycle(event, publish, () => current),
    });
  } catch (err) {
    revokeRuntimeSecret?.();
    revokeEmbeddedHost?.();
    publish({ connection: 'disconnected', lastError: errorMessage(err) });
    throw err;
  }

  publish({ connection: 'connected' });
  let stopped = false;
  let eventDiagnosisTimer: ReturnType<typeof setTimeout> | undefined;
  const eventDiagnosisDeadline = Date.now() + 10 * 60_000;
  const diagnoseEvents = async (polling = false): Promise<void> => {
    const diagnosis = await diagnoseEventSubscription(appId, appSecret, spec.tenant);
    if (stopped) return;
    if (!polling || diagnosis.state !== 'unchecked') {
      const warning = eventSubscriptionWarning(spec, diagnosis);
      if (warning !== current.eventSubscriptionWarning) {
        publish(withEventSubscriptionWarning(current, warning));
      }
    }
    const shouldPoll = polling
      ? diagnosis.state !== 'ok'
      : diagnosis.state === 'missing' || diagnosis.state === 'unpublished';
    if (!shouldPoll || Date.now() + 15_000 > eventDiagnosisDeadline) return;
    eventDiagnosisTimer = setTimeout(() => {
      eventDiagnosisTimer = undefined;
      void diagnoseEvents(true);
    }, 15_000);
    eventDiagnosisTimer.unref?.();
  };
  void diagnoseEvents().catch(() => {
    // Event diagnosis is notice-only and must never take down a live bridge.
  });
  let stopPromise: Promise<void> | undefined;

  return {
    status: () => ({ ...current }),
    executeAdmin: (op) => handle.adminExecute(op),
    stop: () => {
      stopPromise ??= (async () => {
        stopped = true;
        if (eventDiagnosisTimer !== undefined) {
          clearTimeout(eventDiagnosisTimer);
          eventDiagnosisTimer = undefined;
        }
        try {
          await handle.shutdown();
          publish({ connection: 'disconnected' });
        } catch (err) {
          publish({ connection: 'disconnected', lastError: errorMessage(err) });
          throw err;
        } finally {
          revokeRuntimeSecret?.();
          revokeEmbeddedHost?.();
        }
      })();
      return stopPromise;
    },
  };
}

function buildConfig(
  spec: BotSpec,
  existing: Partial<AppConfig>,
): AppConfig {
  const ownerOpenId = required('ownerOpenId', spec.ownerOpenId);
  const admins = Array.from(
    new Set(
      spec.admins
        .map((admin) => admin.trim())
        .filter((admin) => admin.length > 0 && admin !== ownerOpenId),
    ),
  );

  const root = objectRecord(existing);
  const accounts = objectRecord(root.accounts);
  const app = objectRecord(accounts.app);
  const existingPreferences = objectRecord(root.preferences);
  const suppliedPreferences = objectRecord(spec.preferences);
  const existingAccess = objectRecord(existingPreferences.access);
  const suppliedAccess = objectRecord(suppliedPreferences.access);

  return {
    ...root,
    accounts: {
      ...accounts,
      app: {
        ...app,
        id: spec.appId,
        secret: {
          source: 'file',
          id: spec.accountSecretRef,
        },
        tenant: spec.tenant,
      },
    },
    preferences: {
      ...existingPreferences,
      ...suppliedPreferences,
      access: {
        ...existingAccess,
        ...suppliedAccess,
        ownerOpenId,
        admins,
      },
    },
  } as unknown as AppConfig;
}

function updateLifecycle(
  event: BridgeLifecycleEvent,
  publish: (status: BotStatus) => void,
  current: () => BotStatus,
): void {
  if (event.type === 'reconnecting') {
    publish(withoutConnectionError(current(), 'reconnecting'));
    return;
  }
  if (event.type === 'reconnected') {
    publish(withoutConnectionError(current(), 'connected'));
    return;
  }
  publish({
    ...current(),
    lastError: errorMessage(event.error),
  });
}

function withoutConnectionError(
  status: BotStatus,
  connection: BotConnection,
): BotStatus {
  const { lastError: _lastError, ...rest } = status;
  return { ...rest, connection };
}

function withEventSubscriptionWarning(
  status: BotStatus,
  warning: string | undefined,
): BotStatus {
  const { eventSubscriptionWarning: _warning, ...rest } = status;
  return warning === undefined
    ? rest
    : { ...rest, eventSubscriptionWarning: warning };
}

function eventSubscriptionWarning(
  spec: Pick<BotSpec, 'appId' | 'tenant'>,
  diagnosis: EventDiagnosis,
): string | undefined {
  const eventUrl = buildEventConfigUrl(spec.appId, spec.tenant);
  if (diagnosis.state === 'missing' || diagnosis.state === 'unpublished') {
    return [
      `飞书事件订阅未生效：${summarizeEventDiagnosis(diagnosis)}。`,
      '私聊和群聊消息都会没有响应；请在「事件与回调 → 事件配置」选择长连接，',
      `添加 im.message.receive_v1 并发布版本：${eventUrl}`,
    ].join('');
  }
  if (diagnosis.state === 'ok' && diagnosis.missingOptional?.length) {
    return [
      `部分原版功能事件尚未订阅：${diagnosis.missingOptional.join('、')}。`,
      `请在飞书事件配置中补齐并发布版本：${eventUrl}`,
    ].join('');
  }
  return undefined;
}

function required(name: string, value: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${name} must be a non-empty string`);
  return normalized;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function objectRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
