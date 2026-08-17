/**
 * Stable embedding interface for Bridge CLI and trusted desktop hosts.
 *
 * The CLI and Vonvon Bridge consume this same implementation. Product hosts
 * inject data roots and genuinely external capabilities; message handling,
 * robot lifecycle, Agent execution, and common disk behavior remain here.
 */
export { log, withTrace, newTraceId } from '../core/logger';
export {
  paths,
  botDir,
  botPaths,
  configurePathRoots,
  useBotDir,
  type PathRoots,
} from '../config/paths';
export * from '../config/scopes';
export {
  OPTIONAL_EVENTS,
  REQUIRED_EVENTS,
  diagnoseEventSubscription,
  pollEventSubscription,
  summarizeEventDiagnosis,
  type EventDiagnosis,
  type EventDiagnosisState,
} from '../utils/event-diagnosis';
export {
  startBot,
  runHookCommand,
  type BotConnection,
  type BotEventSink,
  type BotPreferences,
  type BotRuntimeEvent,
  type BotSpec,
  type BotStatus,
  type HookPathRoots,
  type RunningBot,
} from '../kernel/start-bot';
export type { AdminWriteOp } from '../admin/ops';
export {
  classifyReaction,
  CONTINUE_EMOJIS,
  createRunReaction,
  STOP_EMOJIS,
  type MessageReactionPort,
  type ReactionIntent,
  type RunReaction,
  type RunReactionErrorContext,
  type RunReactionOptions,
} from './run-reaction';
export {
  buildEmbeddedBridgeHookCommand,
  inspectCliBridgeHooks,
  installCliBridgeHooks,
  transformLegacyBridgeHookCommands,
  type EmbeddedBridgeHookCommandOptions,
  type HookCommand,
  type HookGroup,
  type HookRoot,
  type TransformLegacyBridgeHookCommandsOptions,
  type TransformLegacyBridgeHookCommandsResult,
} from '../cli-bridge/hooks';
export {
  loadCommentInstructions,
  saveCommentInstructions,
  syncAllCommentInstructions,
} from '../bot/comments';
export {
  createDesktopAdminService,
  mountDesktopWebConsole,
  type DesktopWebConsoleHostOptions,
  type MountedWebConsole,
} from '../kernel/desktop-host';
export {
  createBackend,
  type ModelInfo,
  type ReasoningEffort,
} from '../agent';
export type { PermissionMode } from '../agent/types';
export {
  LEGACY_BACKEND_TOMBSTONE_DIRECTORY,
  legacyBackendTombstonePath,
} from '../agent/backend-tombstone';
export { AppServerClient } from '../agent/codex-appserver/app-server-client';
export type {
  GetAccountRateLimitsResponse,
  GetAccountResponse,
  PlanType,
} from '../agent/codex-appserver/protocol';
export {
  resolveAppSecret,
  type AppConfig,
} from '../kernel/secret-resolver';
export {
  provisionDesktopProjectGroup,
  finalizeDesktopProjectGroup,
  rollbackDesktopProjectGroup,
  type DesktopProjectGroupCredentials,
  type ProvisionDesktopProjectGroupInput,
  type FinalizeDesktopProjectGroupInput,
  type RollbackDesktopProjectGroupInput,
} from '../project/desktop-project-provisioning';
export {
  DesktopReleaseProvider,
  type DesktopReleaseProviderOptions,
  type DesktopManualUpdateCheck,
} from '../service/desktop-release';
export {
  acquireHostRuntimeLease,
  defaultHostRuntimeLockFile,
  RuntimeAlreadyOwnedError,
  type AcquireHostRuntimeLeaseOptions,
  type HostRuntimeLease,
  type RuntimeOwnerKind,
  type RuntimeOwnerRecord,
} from '../core/runtime-lock';
export {
  prepareBridgeRuntime,
  startBridgeRuntime,
  BridgeRuntimeNotConfiguredError,
  BridgeRuntimeWorkerGroup,
  type BridgeRuntimeCompositionOptions,
  type BridgeRuntimeWorkerFactoryInput,
} from './bridge-runtime';
export {
  BridgeRuntimeBotProcess,
  BridgeRuntimeBotAdminError,
  createBridgeRuntimeBotLauncher,
  resolveBridgeRuntimeWorkerInvocation,
  type BridgeRuntimeBotLauncher,
  type BridgeRuntimeBotLiveStatus,
  type BridgeRuntimeBotProcessOptions,
  type BridgeRuntimeChildProcess,
  type BridgeRuntimeInvocation,
  type BridgeRuntimeScheduler,
  type BridgeRuntimeWorkerInvocation,
  type ManagedBridgeRuntimeWorker,
  type RestartableRuntimeWorker,
} from './bot-process';
export {
  BRIDGE_RUNTIME_WORKER_ARG,
  isBridgeRuntimeChildMessage,
  isBridgeRuntimeParentMessage,
  isBridgeRuntimeWorkerProcess,
  type BridgeRuntimeAdminOp,
  type BridgeRuntimeChildMessage,
  type BridgeRuntimeParentMessage,
} from './worker-protocol';
export {
  runBridgeRuntimeWorker,
  type BridgeRuntimeChildEndpoint,
  type RunBridgeRuntimeWorkerOptions,
} from './worker-child';
export type {
  BridgeRuntimeBotSpec,
  BridgeRuntimeHost,
  RunningBridgeRuntime,
  RuntimeWorker,
} from './types';
export {
  BRIDGE_BOTS_SCHEMA_VERSION,
  BRIDGE_PROJECTS_SCHEMA_VERSION,
  BRIDGE_SESSIONS_SCHEMA_VERSION,
  BridgeDataPaths,
  BridgeDataStore,
  UnsupportedBridgeDataVersionError,
  assertBridgeBotAppId,
  readBridgeBotsFile,
  readBridgeConfigFile,
  readBridgeProjectsFile,
  readBridgeSessionsFile,
  writeBridgeBotsFile,
  writeBridgeConfigFile,
  writeBridgeProjectsFile,
  writeBridgeSessionsFile,
  type BridgeBotDataPaths,
  type BridgeDataStoreOptions,
  type BridgeDataSnapshot,
  type BridgeBotDataSnapshot,
  type BridgeProjectsFile,
  type BridgeSessionsFile,
} from './data-store';
export type {
  AppPreferences,
  AppAccess,
  AppCredentials,
  SecretInput,
  SecretRef,
  TenantBrand,
} from '../config/schema';
export type { BotEntry, BotsRegistry } from '../config/bots';
export type { Project } from '../project/registry';
export type {
  SessionRecord,
  SessionTitleJob,
  SessionTitleOutcome,
  SessionTitlePhase,
  SessionTitlePolicySnapshot,
} from '../bot/session-store';
