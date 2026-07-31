import type {
  BotPreferences,
  BotRuntimeEvent,
  BotSpec,
} from '../kernel/start-bot.js';
import type {
  BridgeRuntimeAdminOp,
} from './worker-protocol.js';
import type {
  BridgeRuntimeBotLauncher,
  BridgeRuntimeBotLiveStatus,
} from './bot-process.js';

export interface RuntimeWorker {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export type BridgeRuntimeBotSpec = Omit<BotSpec, 'appSecret'> & {
  preferences?: BotPreferences;
};

export interface BridgeRuntimeHost {
  loadBotSpecs(): Promise<readonly BridgeRuntimeBotSpec[]>;
  resolveAppSecret(
    secretRef: string,
    appId: string,
  ): Promise<string | undefined>;
  createBotLauncher(): BridgeRuntimeBotLauncher;
  onRuntimeEvent?(event: BotRuntimeEvent): void;
}

export interface RunningBridgeRuntime {
  status(appId: string): BridgeRuntimeBotLiveStatus | undefined;
  executeAdmin(appId: string, operation: BridgeRuntimeAdminOp): Promise<void>;
  restart(): Promise<void>;
  stop(): Promise<void>;
}
