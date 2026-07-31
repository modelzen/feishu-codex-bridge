import type {
  BotRuntimeEvent,
  BotSpec,
  RunningBot,
} from '../kernel/start-bot.js';

export const BRIDGE_RUNTIME_WORKER_ARG = '--bridge-runtime-worker';

export type BridgeRuntimeAdminOp = Parameters<RunningBot['executeAdmin']>[0];

export type BridgeRuntimeParentMessage =
  | {
      type: 'bootstrap';
      spec: BotSpec;
    }
  | {
      type: 'admin';
      requestId: string;
      op: BridgeRuntimeAdminOp;
    }
  | {
      type: 'stop';
    };

export type BridgeRuntimeChildMessage =
  | {
      type: 'ready';
    }
  | {
      type: 'runtime-event';
      event: BotRuntimeEvent;
    }
  | {
      type: 'admin-result';
      requestId: string;
      error?: {
        message: string;
        code?: string;
      };
    }
  | {
      type: 'start-failed';
      error: string;
    }
  | {
      type: 'stopped';
      error?: string;
    };

export function isBridgeRuntimeWorkerProcess(
  argv: readonly string[] = process.argv,
): boolean {
  return argv.includes(BRIDGE_RUNTIME_WORKER_ARG);
}

export function isBridgeRuntimeParentMessage(
  value: unknown,
): value is BridgeRuntimeParentMessage {
  if (!isRecord(value) || typeof value.type !== 'string') return false;
  if (value.type === 'stop') return true;
  if (value.type === 'bootstrap') return isBotSpec(value.spec);
  return value.type === 'admin'
    && typeof value.requestId === 'string'
    && value.requestId.length > 0
    && isRecord(value.op);
}

export function isBridgeRuntimeChildMessage(
  value: unknown,
): value is BridgeRuntimeChildMessage {
  if (!isRecord(value) || typeof value.type !== 'string') return false;
  if (value.type === 'ready') return true;
  if (value.type === 'runtime-event') {
    if (
      !isRecord(value.event)
      || typeof value.event.appId !== 'string'
      || typeof value.event.at !== 'number'
    ) {
      return false;
    }
    if (value.event.type === 'restart-requested') return true;
    return value.event.type === 'status'
      && isRecord(value.event.status)
      && typeof value.event.status.connection === 'string';
  }
  if (value.type === 'admin-result') {
    return typeof value.requestId === 'string'
      && (
        value.error === undefined
        || (
          isRecord(value.error)
          && typeof value.error.message === 'string'
          && (value.error.code === undefined || typeof value.error.code === 'string')
        )
      );
  }
  return (value.type === 'start-failed' || value.type === 'stopped')
    && (value.error === undefined || typeof value.error === 'string');
}

function isBotSpec(value: unknown): value is BotSpec {
  if (!isRecord(value)) return false;
  return typeof value.appId === 'string'
    && typeof value.appSecret === 'string'
    && typeof value.accountSecretRef === 'string'
    && (value.tenant === 'feishu' || value.tenant === 'lark')
    && typeof value.ownerOpenId === 'string'
    && Array.isArray(value.admins)
    && value.admins.every((admin) => typeof admin === 'string')
    && typeof value.dataDir === 'string'
    && typeof value.legacyAssetsDir === 'string'
    && typeof value.writableAssetsDir === 'string'
    && typeof value.fallbackCwd === 'string'
    && (
      value.desktopRelease === undefined
      || (
        isRecord(value.desktopRelease)
        && typeof value.desktopRelease.currentVersion === 'string'
        && (
          value.desktopRelease.manifestUrl === undefined
          || typeof value.desktopRelease.manifestUrl === 'string'
        )
      )
    );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
