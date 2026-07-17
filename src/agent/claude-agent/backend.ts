import { randomUUID } from 'node:crypto';
import type {
  EffortLevel,
  ModelInfo as ClaudeModelInfo,
  Query,
  SettingSource,
} from '@anthropic-ai/claude-agent-sdk';
import { log } from '../../core/logger';
import type {
  AgentBackend,
  AgentCapabilities,
  AgentThread,
  BackendProbe,
  GenerateSessionTitleOptions,
  ModelInfo,
  PermissionMode,
  ReasoningEffort,
  ResumeThreadOptions,
  StartThreadOptions,
  ThreadHistory,
  ThreadSummary,
} from '../types';
import { BRIDGE_DEVELOPER_INSTRUCTIONS } from '../bridge-instructions';
import { isBackendDepInstalled, installedBackendVersion, loadBackendDep } from '../backend-loader';
import { permissionOptions } from './permission';
import { foldSessionMessages, mapSessionSummary } from './history';
import { ClaudeAgentThread } from './thread';

/** The on-demand npm package backing this backend. */
const SDK_PKG = '@anthropic-ai/claude-agent-sdk';

/**
 * Make every bridge-started claude session behave like Claude Code in its cwd:
 * load project + user `CLAUDE.md`, skills, and `.claude/settings.json`. The SDK
 * default is `[]` (load nothing), which is why a project's CLAUDE.md / the user's
 * lark-* skills were previously ignored. The programmatic permission tier
 * (permission.ts: bypassPermissions + sandbox) still takes precedence, so a
 * loaded settings.json cannot weaken the sandbox.
 *
 * TRADEOFF (intentional): loading 'user'/'project' also loads any hooks / mcpServers
 * declared in those `.claude/settings.json` files — and the SDK WILL execute them in
 * bridge-owned sessions. The FEISHU_CODEX_BRIDGE marker below only stops the cli-bridge
 * from self-forwarding its OWN Stop/PermissionRequest notifications (no loop); it does
 * NOT suppress other user-defined hooks (PreToolUse/Stop/etc.). A user whose global
 * settings has an output-mutating hook will see it run here too. Accepted as the cost
 * of "claude backend = Claude Code in cwd"; revert to ['project'] (or drop 'user') if
 * that's undesirable. */
const BRIDGE_SETTING_SOURCES: SettingSource[] = ['user', 'project'];

/**
 * Env for the SDK's spawned CLI. The SDK does NOT merge with process.env, so we
 * spread it and add the re-entrancy marker the cli-bridge hook handler reads
 * (parser.ts `bridgeOwned`). That marker prevents a Bridge-owned session from
 * self-forwarding to Feishu by default.
 *
 * Persistent Bridge chats also get a dedicated entrypoint: Claude Code's
 * native `/resume` picker intentionally filters `sdk-ts`/`sdk-py`/`sdk-cli`
 * sessions even when they have a customTitle. Plain `cli` is not usable here:
 * headless Claude normalizes it back to `sdk-cli`. An unknown, honest Bridge
 * value is preserved and currently falls through Claude's CLI client path,
 * while the stream-json/control protocol still comes from SDK CLI flags. This
 * compatibility boundary depends on Claude's upstream picker/entrypoint rules
 * and must be rechecked when upgrading the bundled Claude Code runtime.
 *
 * NOTE: FEISHU_CODEX_BRIDGE only governs the cli-bridge's own forwarding — it
 * does not gate other SDK hooks loaded via settingSources (see
 * BRIDGE_SETTING_SOURCES). Mirrors the codex app-server child. */
function bridgeClaudeEnv(): Record<string, string> {
  const base: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string') base[k] = v;
  base.FEISHU_CODEX_BRIDGE = '1';
  base.CLAUDE_CODE_ENTRYPOINT = 'feishu-codex-bridge';
  return base;
}

/** The SDK's runtime surface we use (typed off the package, erased at build). */
type ClaudeSdk = typeof import('@anthropic-ai/claude-agent-sdk');
export type ClaudeSdkFacade = Pick<
  ClaudeSdk,
  'query' | 'listSessions' | 'getSessionInfo' | 'getSessionMessages' | 'renameSession'
>;

let sdkPromise: Promise<ClaudeSdkFacade> | undefined;
/**
 * Lazy-load the SDK via the on-demand loader (bridge/global node_modules → user
 * private install dir). Cached after first success. Throws BackendNotInstalledError
 * when absent — so a fresh install that hasn't downloaded Claude yet fails with a
 * clear "未安装" instead of crashing at module import. If the user already has the
 * package anywhere on the resolve path (e.g. a global `npm i -g`), this finds it
 * and never re-downloads.
 */
function loadSdk(): Promise<ClaudeSdkFacade> {
  sdkPromise ??= loadBackendDep<ClaudeSdkFacade>(SDK_PKG);
  return sdkPromise;
}

const TITLE_GENERATION_TIMEOUT_MS = 30_000;
const TITLE_OUTPUT_SCHEMA = {
  type: 'object',
  properties: { title: { type: 'string', maxLength: 36 } },
  required: ['title'],
  additionalProperties: false,
} as const;

function parseGeneratedTitle(text: string): string | undefined {
  const clean = text.trim();
  if (!clean) return undefined;
  try {
    const parsed = JSON.parse(clean) as { title?: unknown };
    if (typeof parsed.title === 'string') return parsed.title.trim() || undefined;
  } catch {
    // Structured output is preferred, but preserve a plain-text result from an
    // older SDK/CLI so the coordinator can sanitize/fallback in one place.
  }
  return clean;
}

function titleFromStructuredOutput(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const title = (value as { title?: unknown }).title;
  return typeof title === 'string' ? title.trim() || undefined : undefined;
}

/** Consume a title query until its terminal SDK result. Exported for a mock-only
 * unit test; runtime errors deliberately propagate to the coordinator. */
export async function consumeClaudeTitleQuery(query: Query): Promise<string | undefined> {
  for await (const message of query) {
    if (message.type !== 'result') continue;
    if (message.subtype !== 'success') {
      throw new Error(message.errors.join('; ') || `Claude title query failed: ${message.subtype}`);
    }
    return titleFromStructuredOutput(message.structured_output) ?? parseGeneratedTitle(message.result);
  }
  throw new Error('Claude title query closed before returning a result');
}

function withAbortDeadline<T>(
  work: Promise<T>,
  abortController: AbortController,
  timeoutMs = TITLE_GENERATION_TIMEOUT_MS,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      abortController.abort();
      reject(new Error(`Claude title generation timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** Start the SDK in streaming-input mode but never submit a user turn. The CLI
 * still emits its initialization payload (which contains supportedModels), and
 * aborting after discovery releases the waiting input iterator. */
async function* idleClaudeInput(signal: AbortSignal): AsyncGenerator<never, void, unknown> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

/**
 * Claude Agent SDK backend — drives Claude Code in-process via
 * `@anthropic-ai/claude-agent-sdk`'s `query()`. Mirrors the codex app-server
 * backend's contract (see ../codex-appserver/backend.ts) so the bot orchestrator,
 * card streamer, watchdog and session store work unchanged.
 *
 * Packaging: the SDK is an ON-DEMAND dependency (not bundled with the bridge) —
 * loaded lazily via {@link loadSdk}. When absent, the Web 后端页 shows a「下载」
 * button (catalog marks it npm-ondemand); an already-installed copy (bridge /
 * global / user dir) is detected and reused, never re-downloaded.
 *
 * Auth: the SDK's bundled CLI reuses the host's Claude login (verified: a query
 * runs with apiKeySource=none when the machine is logged in), else
 * ANTHROPIC_API_KEY. No separate login step in the bridge.
 */
export class ClaudeAgentBackend implements AgentBackend {
  readonly id = 'claude-agent';
  readonly displayName = 'Claude';
  /** Successful SDK discovery is stable for this backend process and avoids
   * spawning an auxiliary Claude CLI on every topic start/settings render.
   * Failures are deliberately not cached so installation/login recovery can
   * retry on the next call (same policy as the Codex backend). */
  private modelCache: ModelInfo[] | null = null;

  constructor(private readonly sdkLoader: () => Promise<ClaudeSdkFacade> = loadSdk) {}

  readonly capabilities: AgentCapabilities = {
    // /goal：goal-like —— 一个自主轮跑完目标 + 合成状态 + abort 硬停可终止续聊
    // （非 codex 的多轮目标引擎，差异见 thread.runGoal）。
    goal: true,
    steer: false,
    // /compact：Claude Code 原生斜杠命令（发 "/compact" 即触发，见 thread.compact）。
    compact: true,
    // resume 历史卡：读 ~/.claude/projects 会话存储（与 `claude -r` 同源，双向可见）。
    resume: true,
    approvals: false,
  };

  // Claude's sandbox supports macOS (Seatbelt) and Linux (bubblewrap), so all
  // three tiers are offered; qa/write fail-closed at runtime if the sandbox can't
  // start (permission.ts sets sandbox.failIfUnavailable). See the security delta
  // documented in permission.ts / CLAUDE_AGENT_PROGRESS.md.
  readonly supportedModes: readonly PermissionMode[] = ['qa', 'write', 'full'];

  async isAvailable(): Promise<boolean> {
    return (await this.doctor()).ok;
  }

  async doctor(): Promise<BackendProbe> {
    // "available" = the on-demand SDK is installed (bridge/global/user dir). When
    // not, report installable so the Web shows a「下载」button. Auth is verified
    // lazily at first turn (a missing login surfaces as a friendly run error).
    if (!isBackendDepInstalled(SDK_PKG)) {
      return {
        ok: false,
        version: null,
        installable: true,
        depState: 'not-installed',
        hint: '点「下载」安装 Claude Agent SDK（零 sudo，装到用户目录）',
      };
    }
    return {
      ok: true,
      version: installedBackendVersion(SDK_PKG),
      location: SDK_PKG,
      depState: 'installed',
      hint: '复用本机 Claude 登录态（未登录请先 `claude` 登录，或设置 ANTHROPIC_API_KEY）',
    };
  }

  async listModels(): Promise<ModelInfo[]> {
    if (this.modelCache) return this.modelCache;
    let query: Query | undefined;
    const abortController = new AbortController();
    try {
      const sdk = await this.sdkLoader();
      // supportedModels() is exposed on an initialized SDK Query rather than as
      // a package-level function. An idle streaming input lets the CLI initialize
      // without submitting a user turn or spending model tokens.
      query = sdk.query({
        prompt: idleClaudeInput(abortController.signal),
        options: {
          abortController,
          persistSession: false,
          maxTurns: 1,
          tools: [],
          skills: [],
          mcpServers: {},
          settingSources: [],
        },
      });
      const discovered = await withAbortDeadline(query.supportedModels(), abortController);
      if (!discovered.length) throw new Error('Claude SDK returned an empty model catalog');
      this.modelCache = discovered.map(mapClaudeModel);
      return this.modelCache;
    } catch (err) {
      log.fail('agent', err, { backend: 'claude-agent', phase: 'supportedModels' });
      return STATIC_MODELS;
    } finally {
      abortController.abort();
      query?.close();
    }
  }

  /** 最近会话（newest first），读 ~/.claude/projects/<cwd-hash> 的 JSONL 存储——
   * 与 `claude -r` 同源，故能列出本机用 `claude` 手开的会话。绝不抛错（契约）。 */
  async listThreads(cwd: string, limit = 15): Promise<ThreadSummary[]> {
    try {
      const sdk = await this.sdkLoader();
      const sessions = await sdk.listSessions({ dir: cwd, limit });
      return sessions
        .map(mapSessionSummary)
        .sort((a, b) => b.updatedAt - a.updatedAt);
    } catch (err) {
      log.fail('agent', err, { backend: 'claude-agent', phase: 'listSessions' });
      return [];
    }
  }

  /** 某会话的转写摘要（resume 历史卡）——读 getSessionMessages 折叠成 turns，不起会话、
   * 无 token 成本。绝不抛错（返回空）。 */
  async readHistory(cwd: string, sessionId: string, maxTurns = 10): Promise<ThreadHistory> {
    try {
      const sdk = await this.sdkLoader();
      const messages = await sdk.getSessionMessages(sessionId, { dir: cwd });
      return foldSessionMessages(messages, maxTurns, cwd);
    } catch (err) {
      log.fail('agent', err, { backend: 'claude-agent', phase: 'getSessionMessages', sessionId });
      return { turns: [], totalTurns: 0 };
    }
  }

  async readSessionTitle(cwd: string, sessionId: string): Promise<string | undefined> {
    const sdk = await this.sdkLoader();
    // Read the exact transcript metadata instead of a bounded list page: an old
    // resumed session may no longer be in the newest N entries. Only customTitle
    // counts here; summary/firstPrompt do not make Claude Code's resume picker
    // treat the session as explicitly named.
    const session = await sdk.getSessionInfo(sessionId, { dir: cwd });
    const title = session?.customTitle?.trim();
    return title || undefined;
  }

  async setSessionTitle(cwd: string, sessionId: string, title: string): Promise<void> {
    const clean = title.trim();
    if (!clean) throw new Error('Cannot set an empty Claude session title');
    const sdk = await this.sdkLoader();
    await sdk.renameSession(sessionId, clean, { dir: cwd });
  }

  async generateSessionTitle(opts: GenerateSessionTitleOptions): Promise<string | undefined> {
    const sdk = await this.sdkLoader();
    const abortController = new AbortController();
    const query = sdk.query({
      prompt: opts.prompt,
      options: {
        cwd: opts.cwd,
        model: opts.model,
        // Pass through verbatim. If a stale configuration names an effort the
        // installed SDK rejects, that error must reach the coordinator; never
        // downgrade or substitute behind the administrator's back.
        effort: opts.effort as EffortLevel,
        abortController,
        persistSession: false,
        maxTurns: 1,
        tools: [],
        skills: [],
        mcpServers: {},
        settingSources: [],
        outputFormat: { type: 'json_schema', schema: TITLE_OUTPUT_SCHEMA },
      },
    });
    try {
      return await withAbortDeadline(
        consumeClaudeTitleQuery(query),
        abortController,
      );
    } finally {
      query.close();
    }
  }

  async startThread(opts: StartThreadOptions): Promise<AgentThread> {
    const sdk = await this.sdkLoader();
    return new ClaudeAgentThread({
      sessionId: randomUUID(),
      resume: false,
      cwd: opts.cwd,
      model: opts.model,
      effort: opts.effort,
      permission: permissionOptions(opts.mode, opts.network, opts.cwd),
      systemPromptAppend: BRIDGE_DEVELOPER_INSTRUCTIONS,
      settingSources: BRIDGE_SETTING_SOURCES,
      env: bridgeClaudeEnv(),
      query: sdk.query,
    });
  }

  async resumeThread(opts: ResumeThreadOptions): Promise<AgentThread> {
    const sdk = await this.sdkLoader();
    return new ClaudeAgentThread({
      sessionId: opts.sessionId,
      resume: true,
      cwd: opts.cwd,
      model: opts.model,
      effort: opts.effort,
      permission: permissionOptions(opts.mode, opts.network, opts.cwd),
      systemPromptAppend: BRIDGE_DEVELOPER_INSTRUCTIONS,
      settingSources: BRIDGE_SETTING_SOURCES,
      env: bridgeClaudeEnv(),
      query: sdk.query,
    });
  }
}

const EFFORTS: ReasoningEffort[] = ['low', 'medium', 'high', 'xhigh'];

function mapClaudeModel(model: ClaudeModelInfo, index: number): ModelInfo {
  const reported = model.supportedEffortLevels as ReasoningEffort[] | undefined;
  const supportedEfforts = model.supportsEffort === false ? [] : (reported?.length ? reported : EFFORTS);
  const defaultEffort: ReasoningEffort = supportedEfforts.includes('high')
    ? 'high'
    : (supportedEfforts[0] ?? 'medium');
  return {
    id: model.value,
    displayName: model.displayName || model.value,
    description: model.description ?? '',
    supportedEfforts,
    defaultEffort,
    // The SDK does not currently expose an explicit default bit. Its catalog is
    // ordered for the picker, so mark the leading model as the bridge default.
    isDefault: index === 0,
    hidden: false,
  };
}

/** Failure-only fallback when SDK model discovery cannot initialize. Successful
 * discovery is cached above and remains the normal model-picker source. */
const STATIC_MODELS: ModelInfo[] = [
  {
    id: 'claude-opus-4-8',
    displayName: 'Claude Opus 4.8',
    description: '最强，复杂推理 / 长程 agentic',
    supportedEfforts: EFFORTS,
    defaultEffort: 'high',
    isDefault: true,
    hidden: false,
  },
  {
    id: 'claude-sonnet-4-6',
    displayName: 'Claude Sonnet 4.6',
    description: '均衡，日常编码',
    supportedEfforts: EFFORTS,
    defaultEffort: 'medium',
    isDefault: false,
    hidden: false,
  },
  {
    id: 'claude-haiku-4-5',
    displayName: 'Claude Haiku 4.5',
    description: '最快，轻量任务',
    supportedEfforts: ['low', 'medium', 'high'],
    defaultEffort: 'low',
    isDefault: false,
    hidden: false,
  },
];
