import type {
  AppConfig,
  AppPreferences,
  SecretRef,
} from '../config/schema';
import { resolveOwner, secretKeyForApp } from '../config/schema';
import type { BotEntry } from '../config/bots';
import { botPaths, paths } from '../config/paths';
import { loadConfig } from '../config/store';
import { resolveAppSecret } from '../config/secret-resolver';
import {
  createBridgeRuntimeBotLauncher,
  type BotPreferences,
  type BotRuntimeEvent,
  type BridgeRuntimeBotSpec,
  type BridgeRuntimeHost,
} from '../runtime/index';

export interface PreparedCliBot {
  entry: BotEntry;
  config: AppConfig;
  initialSecret: string;
}

export interface CliRuntimeHostOptions {
  bots: readonly PreparedCliBot[];
  fallbackCwd?: string;
  onRuntimeEvent?: (event: BotRuntimeEvent) => void;
}

export class CliRuntimeHost implements BridgeRuntimeHost {
  readonly #bots: readonly PreparedCliBot[];
  readonly #initialSecrets: Map<string, string>;
  readonly #fallbackCwd: string;
  readonly #onRuntimeEvent: ((event: BotRuntimeEvent) => void) | undefined;

  constructor(options: CliRuntimeHostOptions) {
    this.#bots = options.bots.map((bot) => ({
      entry: { ...bot.entry },
      config: structuredClone(bot.config),
      initialSecret: bot.initialSecret,
    }));
    this.#initialSecrets = new Map(
      this.#bots.map((bot) => [bot.entry.appId, bot.initialSecret]),
    );
    this.#fallbackCwd = options.fallbackCwd ?? process.env.FEISHU_CODEX_CWD ?? process.cwd();
    this.#onRuntimeEvent = options.onRuntimeEvent;
  }

  async loadBotSpecs(): Promise<readonly BridgeRuntimeBotSpec[]> {
    const specs: BridgeRuntimeBotSpec[] = [];
    for (const { entry, config } of this.#bots) {
      const ownerOpenId = runtimeOwner(config);
      if (!ownerOpenId) {
        const message = ownerMissingMessage(entry);
        console.error(`✗ ${message}；该机器人本次保持离线，其余机器人继续启动。`);
        this.#publishConfigurationFailure(entry.appId, message);
        continue;
      }
      const preferences = runtimePreferences(config.preferences);
      const projectsRoot = preferences?.projectsRootDir;
      const dataDir = botPaths(entry.appId).dir;
      specs.push({
        appId: entry.appId,
        accountSecretRef: secretReference(config.accounts.app.secret, entry.appId),
        tenant: entry.tenant,
        ownerOpenId,
        admins: [...(config.preferences?.access?.admins ?? [])],
        ...(preferences === undefined ? {} : { preferences }),
        dataDir,
        hostDataDir: paths.appDir,
        legacyAssetsDir: paths.appDir,
        writableAssetsDir: paths.appDir,
        fallbackCwd: typeof projectsRoot === 'string' && projectsRoot.trim()
          ? projectsRoot
          : this.#fallbackCwd,
      });
    }
    return specs;
  }

  async resolveAppSecret(_secretRef: string, appId: string): Promise<string | undefined> {
    const initial = this.#initialSecrets.get(appId);
    if (initial !== undefined) {
      this.#initialSecrets.delete(appId);
      return initial;
    }
    const config = await loadConfig(botPaths(appId).configFile);
    if (!config.accounts?.app) return undefined;
    return await resolveAppSecret(config as AppConfig);
  }

  createBotLauncher() {
    return createBridgeRuntimeBotLauncher({
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
  }

  onRuntimeEvent(event: BotRuntimeEvent): void {
    this.#onRuntimeEvent?.(event);
  }

  #publishConfigurationFailure(appId: string, message: string): void {
    try {
      this.#onRuntimeEvent?.({
        type: 'status',
        appId,
        status: { connection: 'disconnected', lastError: message },
        at: Date.now(),
      });
    } catch {
      // Diagnostics from one invalid robot cannot prevent healthy robots starting.
    }
  }
}

function runtimePreferences(
  preferences: AppPreferences | undefined,
): BotPreferences | undefined {
  if (!preferences) return undefined;
  const clone = structuredClone(preferences) as BotPreferences;
  if (!clone.access) return clone;
  const access = { ...clone.access };
  delete (access as { ownerOpenId?: unknown }).ownerOpenId;
  delete (access as { admins?: unknown }).admins;
  if (Object.keys(access).length === 0) delete clone.access;
  else clone.access = access;
  return clone;
}

function secretReference(
  secret: string | SecretRef,
  appId: string,
): string {
  return typeof secret === 'string'
    ? secretKeyForApp(appId)
    : secret.id;
}

function runtimeOwner(config: AppConfig): string | undefined {
  // Preserve v0.6.10 compatibility: legacy configs predate ownerOpenId and
  // resolve their first persisted admin as owner without rewriting user data.
  const owner = resolveOwner(config)?.trim();
  return owner || undefined;
}

function ownerMissingMessage(entry: BotEntry): string {
  return `机器人「${entry.name}」缺少 ownerOpenId，请重新扫码注册后再启动`;
}
