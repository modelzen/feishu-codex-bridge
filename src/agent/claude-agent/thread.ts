import { readFile } from 'node:fs/promises';
import type { Options, Query, SDKMessage, SDKUserMessage, SettingSource } from '@anthropic-ai/claude-agent-sdk';
import { log } from '../../core/logger';
import type {
  AgentEvent,
  AgentInput,
  AgentRun,
  AgentThread,
  CompactResult,
  ReasoningEffort,
  TurnOptions,
} from '../types';
import { createTurnMapper, resultErrorText } from './event-map';
import type { ClaudePermissionOptions } from './permission';

/** Config the backend hands the thread to stand up its persistent query(). */
export interface ClaudeThreadConfig {
  /** self-assigned UUID (start: options.sessionId) or the id to resume. */
  sessionId: string;
  /** true → resume an existing session; false → a fresh one. */
  resume: boolean;
  cwd: string;
  model?: string;
  effort?: ReasoningEffort;
  permission: ClaudePermissionOptions;
  /** appended to Claude Code's default system prompt (bridge developer guidance). */
  systemPromptAppend?: string;
  /** Which filesystem settings the SDK loads. The SDK default is none — so
   * project/user CLAUDE.md, skills and `.claude/settings.json` are NOT read
   * unless set. The backend passes ['user','project'] to make a claude session
   * behave like Claude Code in its cwd (read CLAUDE.md + user skills). */
  settingSources?: SettingSource[];
  /** Env for the SDK's spawned CLI subprocess. NOTE: the SDK does NOT merge this
   * with process.env — callers must spread it themselves. The backend passes
   * `{ ...process.env, FEISHU_CODEX_BRIDGE: '1',
   * CLAUDE_CODE_ENTRYPOINT: 'feishu-codex-bridge' }`
   * so inherited cli-bridge hooks recognize a bridge-owned session and don't
   * self-forward, while Claude Code's native `/resume` picker treats a newly
   * created Bridge conversation like a selectable local CLI session. `cli`
   * itself cannot be used because headless Claude rewrites it to `sdk-cli`. */
  env?: Record<string, string>;
  /** the SDK's `query()` function, injected by the backend (lazy-loaded via
   * loadBackendDep) so thread.ts carries no static runtime dep on the SDK —
   * the on-demand package can be absent until downloaded. */
  query: (params: { prompt: AsyncIterable<SDKUserMessage>; options?: Options }) => Query;
}

/** Hard ceiling on a manual /compact (a summarization turn) so a wedged process
 * can't hang the「压缩中」card forever. Mirrors codex's COMPACT_TIMEOUT_MS. */
const COMPACT_TIMEOUT_MS = 120_000;

/** ⏹: how long to wait for interrupt() to end the turn before hard-aborting the
 * query. interrupt() reliably stops a STREAMING turn but HANGS when a blocking
 * tool (sleep / long build) is mid-execution (verified) — so we escalate to a
 * hard AbortController.abort() (thread dies → resolveThread resumes next message).
 * Generous enough that a normal interrupt (streaming) settles first and keeps the
 * warm process; short enough that ⏹ on a stuck tool feels responsive. */
const ABORT_ESCALATE_MS = 4_000;

type TurnItem =
  | { kind: 'msg'; msg: SDKMessage }
  | { kind: 'end' }
  | { kind: 'error'; err: unknown };

/** A minimal single-consumer async queue (push now, await later). */
class Inbox<T> {
  private readonly buf: T[] = [];
  private readonly waiters: ((v: T) => void)[] = [];
  push(v: T): void {
    const w = this.waiters.shift();
    if (w) w(v);
    else this.buf.push(v);
  }
  next(): Promise<T> {
    const v = this.buf.shift();
    if (v !== undefined) return Promise.resolve(v);
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

/** A push-able AsyncIterable used as the query's streaming `prompt` source. */
class PushablePrompt {
  private readonly buf: SDKUserMessage[] = [];
  private readonly waiters: ((v: SDKUserMessage | null) => void)[] = [];
  private closed = false;
  push(msg: SDKUserMessage): void {
    if (this.closed) return;
    const w = this.waiters.shift();
    if (w) w(msg);
    else this.buf.push(msg);
  }
  close(): void {
    this.closed = true;
    while (this.waiters.length) this.waiters.shift()!(null);
  }
  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      const v = this.buf.shift();
      if (v !== undefined) {
        yield v;
        continue;
      }
      if (this.closed) return;
      const next = await new Promise<SDKUserMessage | null>((resolve) => this.waiters.push(resolve));
      if (next == null) return;
      yield next;
    }
  }
}

/** Our ReasoningEffort → the SDK's EffortLevel ('low'|'medium'|'high'|'xhigh'|'max'). */
function toSdkEffort(e: ReasoningEffort | undefined): Options['effort'] | undefined {
  if (!e) return undefined;
  if (e === 'none' || e === 'minimal') return 'low';
  if (e === 'ultra') return 'max'; // Claude has no delegation-aware ultra tier
  return e; // low/medium/high/xhigh/max pass through
}

/** Content blocks the SDK accepts in a streaming user message, derived from the
 * SDK's own MessageParam so this file carries no static dep on `@anthropic-ai/sdk`. */
type UserContentBlock = Exclude<SDKUserMessage['message']['content'], string>[number];

/** Skip a single image this large (raw bytes): a pathological upload must not
 * bloat the one stream-json line handed to the CLI. Normal chat images are far
 * under this, and the CLI down-scales what it forwards to the API. */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/**
 * Detect an image's type from its MAGIC BYTES, not its filename — media.ts derives
 * the on-disk extension from the HTTP content-type, which Feishu may omit (then it
 * defaults to `.png`), so a JPEG could land as `x.png`; trusting the extension
 * would mislabel it and the Anthropic API would reject the base64 for not matching
 * `media_type`. Returns the API media_type for the ONLY four types base64 image
 * blocks accept, or undefined for anything else (heic/bmp/tiff/unknown — the API
 * can't take those without transcoding, which the bridge doesn't do).
 */
function sniffImageType(b: Buffer): 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | undefined {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png'; // ‰PNG
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'; // JFIF/EXIF
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif'; // GIF8(7|9)a
  if (b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return undefined;
}

/** Read one downloaded image into a base64 image content block, or undefined when
 * it can't be shown (unreadable / empty / oversized / a type the API rejects).
 * Best-effort — never throws, so one bad image can't break the turn. */
async function toImageBlock(path: string): Promise<UserContentBlock | undefined> {
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (err) {
    log.warn('agent', 'image-read-failed', { backend: 'claude-agent', err: String(err) });
    return undefined;
  }
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) {
    log.warn('agent', 'image-skip-size', { backend: 'claude-agent', bytes: bytes.byteLength });
    return undefined;
  }
  const mediaType = sniffImageType(bytes);
  if (!mediaType) {
    // heic/bmp/tiff or unrecognized bytes — see sniffImageType; log the header so a
    // surprising type is diagnosable, then skip (best-effort).
    log.info('agent', 'image-skip-unsupported', { backend: 'claude-agent', head: bytes.toString('hex', 0, 4) });
    return undefined;
  }
  return { type: 'image', source: { type: 'base64', media_type: mediaType, data: bytes.toString('base64') } };
}

/** A text-only user message (the common, I/O-free path). */
function textUserMessage(text: string): SDKUserMessage {
  return { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null } as SDKUserMessage;
}

/**
 * Build the SDK user message for a turn. Text-only → a plain string (fast path,
 * no I/O). With images (input.images = the local paths the bridge downloaded, the
 * same source codex reads as `localImage`) → an array of content blocks (optional
 * text + one base64 image block per readable image) so Claude actually SEES the
 * pixels — parity with codex. If every image drops (unsupported/unreadable), fall
 * back to plain text so a text-bearing turn is never blanked. Exported for tests.
 */
export async function toUserMessage(input: AgentInput): Promise<SDKUserMessage> {
  const text = input.text ?? '';
  const paths = input.images ?? [];
  if (paths.length === 0) return textUserMessage(text);

  const blocks: UserContentBlock[] = [];
  if (text) blocks.push({ type: 'text', text });
  for (const path of paths) {
    const block = await toImageBlock(path);
    if (block) blocks.push(block);
  }
  const imageCount = blocks.filter((b) => b.type === 'image').length;
  if (imageCount === 0) return textUserMessage(text); // every image dropped → plain text
  log.info('agent', 'images-attached', { backend: 'claude-agent', count: imageCount, of: paths.length });
  return { type: 'user', message: { role: 'user', content: blocks }, parent_tool_use_id: null } as SDKUserMessage;
}

/** Frame a /goal objective so Claude runs it autonomously to completion in one
 * turn (its agent loop already does multi-step; this nudges it not to stop and
 * ask mid-way, matching the "自主多轮跑到完成" expectation). */
function goalPrompt(objective: string): string {
  return [
    '【自主目标】请连续、自主地完成下面的目标：按需使用工具，一步步做到完成为止，',
    '中途不要停下来等我确认；完成后用一段话总结做了什么。',
    '',
    `目标：${objective}`,
  ].join('\n');
}

/** Synthesize a codex-style terminal goal status from a non-success result. */
function goalStatusFromResult(subtype: string | undefined): string {
  if (subtype === 'error_max_budget_usd') return 'budgetLimited';
  return 'blocked'; // error_max_turns / error_during_execution / other → blocked
}

/**
 * A Claude Agent SDK session as one persistent streaming-input `query()`.
 *
 * Design (verified by spike, SDK 0.3.178):
 *  - ONE query() per thread, prompt = a push-able AsyncIterable. Each user turn
 *    pushes one message; a single background `pump()` reads the query's message
 *    stream and routes each message to the CURRENT turn's inbox. Turns are strictly
 *    sequential (the orchestrator never starts a turn on a busy thread), so one
 *    "current sink" suffices. Reusing the warm process keeps 2nd+ turns fast
 *    (~2s to first token vs ~14s cold) — the reason we don't do per-turn query().
 *  - sessionId is self-assigned (options.sessionId on start / options.resume on
 *    resume), so it's known immediately without waiting on the init message.
 *  - interrupt() ends the in-flight turn (result subtype 'error_during_execution');
 *    the same query stays usable for the next turn (verified). We tell apart an
 *    interrupt from a real failure via `interruptRequested`.
 */
export class ClaudeAgentThread implements AgentThread {
  readonly sessionId: string;
  private readonly cwd: string;
  private model: string | undefined;
  private effort: ReasoningEffort | undefined;
  private readonly input = new PushablePrompt();
  private readonly query: Query;
  private readonly abortController = new AbortController();
  private dead = false;
  private interruptRequested = false;
  /** true while a runGoal() turn is in flight — clearGoal() only hard-stops then. */
  private goalRunning = false;
  /** true while ANY turn (runStreamed/runGoal) is in flight — gates abort escalation. */
  private turnInFlight = false;
  private escalateTimer: ReturnType<typeof setTimeout> | undefined;
  private turnSeq = 0;
  private currentTurnId: string | undefined;
  private lastActivityAt = Date.now();
  private sink: ((item: TurnItem) => void) | undefined;

  constructor(cfg: ClaudeThreadConfig) {
    this.sessionId = cfg.sessionId;
    this.cwd = cfg.cwd;
    this.model = cfg.model;
    this.effort = cfg.effort;

    const options: Options = {
      cwd: cfg.cwd,
      abortController: this.abortController,
      includePartialMessages: true,
      ...(cfg.model ? { model: cfg.model } : {}),
      ...(toSdkEffort(cfg.effort) ? { effort: toSdkEffort(cfg.effort) } : {}),
      ...(cfg.resume ? { resume: cfg.sessionId } : { sessionId: cfg.sessionId }),
      ...(cfg.systemPromptAppend
        ? { systemPrompt: { type: 'preset', preset: 'claude_code', append: cfg.systemPromptAppend } }
        : {}),
      ...(cfg.settingSources ? { settingSources: cfg.settingSources } : {}),
      ...(cfg.env ? { env: cfg.env } : {}),
      // permission tier (permissionMode / sandbox / canUseTool / disallowedTools)
      ...cfg.permission,
      stderr: (d: string) => {
        const s = String(d).trim();
        // file-only (not in stdout allowlist) — handy for diagnosing auth/sandbox.
        if (s) log.info('agent', 'sdk-stderr', { backend: 'claude-agent', line: s.slice(0, 300) });
      },
    };

    this.query = cfg.query({ prompt: this.input, options });
    void this.pump();
  }

  /** Single background consumer: route every query message to the current turn. */
  private async pump(): Promise<void> {
    try {
      for await (const msg of this.query) {
        this.lastActivityAt = Date.now();
        this.sink?.({ kind: 'msg', msg });
      }
      this.dead = true;
      this.sink?.({ kind: 'end' });
    } catch (err) {
      this.dead = true;
      log.fail('agent', err, { backend: 'claude-agent', phase: 'pump' });
      this.sink?.({ kind: 'error', err });
    }
  }

  runStreamed(input: AgentInput, turn?: TurnOptions): AgentRun {
    const turnId = `t${++this.turnSeq}`;
    this.currentTurnId = turnId;
    this.interruptRequested = false;
    this.turnInFlight = true;

    // Per-turn model override persists (mirrors codex). Effort can only be set at
    // query creation in the SDK, so a mid-session effort change is recorded but
    // takes effect on the next thread (documented limitation).
    if (turn?.model && turn.model !== this.model) {
      this.model = turn.model;
      this.query.setModel(turn.model).catch((err) => log.fail('agent', err, { phase: 'setModel' }));
    }
    if (turn?.effort) this.effort = turn.effort;

    const mapper = createTurnMapper({ cwd: this.cwd });
    const inbox = new Inbox<TurnItem>();
    const mySink = (item: TurnItem): void => inbox.push(item);
    this.sink = mySink;

    // Fire the turn (push the user message) so inference overlaps the caller's
    // card setup; messages buffer in `inbox` until the for-await below drains
    // them. Text-only resolves on the next microtask; an image turn reads +
    // base64-encodes the files first (async), pushed as soon as ready. A build
    // failure (encoding is best-effort, so this shouldn't fire) still pushes the
    // text alone rather than leaving the turn waiting forever on `inbox`.
    void toUserMessage(input).then(
      (m) => this.input.push(m),
      (err) => {
        log.fail('agent', err, { backend: 'claude-agent', phase: 'build-user-message' });
        this.input.push(textUserMessage(input.text ?? ''));
      },
    );

    const self = this;
    async function* gen(): AsyncGenerator<AgentEvent> {
      yield { type: 'turn_started', turnId };
      try {
        while (true) {
          const item = await inbox.next();
          if (item.kind === 'end' || item.kind === 'error') {
            // A deliberate ⏹ (interrupt or the hard-abort escalation) ends here too —
            // treat it as a clean `done` (the orchestrator marks it interrupted), not
            // a scary error; a genuine crash surfaces the error.
            if (self.interruptRequested) {
              yield { type: 'done', turnId };
              return;
            }
            const msg = item.kind === 'error' && item.err instanceof Error ? item.err.message : 'Claude 会话进程已退出';
            yield { type: 'error', message: msg || 'Claude 会话出错', willRetry: false };
            return;
          }
          const msg = item.msg as unknown as { type?: string; subtype?: string };
          self.lastActivityAt = Date.now();
          for (const ev of mapper.map(item.msg)) yield ev;
          if (msg.type === 'result') {
            const ok = msg.subtype === 'success' || self.interruptRequested;
            if (ok) {
              // Authoritative context gauge — matches Claude's native /context
              // (totalTokens used, maxTokens window). Overrides the event-map's
              // fallback estimate. Best-effort: a control RTT that may fail.
              try {
                const cu = await self.query.getContextUsage();
                if (cu && typeof cu.totalTokens === 'number' && typeof cu.maxTokens === 'number') {
                  yield { type: 'context_usage', usedTokens: cu.totalTokens, contextWindow: cu.maxTokens };
                }
              } catch (err) {
                log.fail('agent', err, { backend: 'claude-agent', phase: 'getContextUsage' });
              }
              yield { type: 'done', turnId };
            } else {
              yield { type: 'error', message: resultErrorText(msg as Record<string, unknown>), willRetry: false };
            }
            return;
          }
        }
      } finally {
        self.endTurn();
        if (self.sink === mySink) self.sink = undefined;
      }
    }

    return {
      events: gen(),
      turnId: () => self.currentTurnId,
      lastActivity: () => self.lastActivityAt,
    };
  }

  /** End-of-turn bookkeeping: clear the in-flight flag + any pending ⏹ escalation. */
  private endTurn(): void {
    this.turnInFlight = false;
    if (this.escalateTimer) {
      clearTimeout(this.escalateTimer);
      this.escalateTimer = undefined;
    }
  }

  /**
   * /goal —— Claude 没有 codex 那种「目标引擎 + 多轮自动续跑」，但 Claude Code 的
   * agent loop 本身就能在 ONE query turn 内自主多步跑完一个目标。所以这里把目标当作
   * 「一个自主轮」：发带自主提示的目标 → 流式跑 → 合成 goal_update 状态（active 起、
   * complete/blocked/budgetLimited 收）。
   *
   * ── 与 codex 的差异（如实）──────────────────────────────────────────────
   *  - codex：N 个自动续跑的 turn（N 张卡片）+ 原生状态机（active/paused/complete/
   *    budgetLimited/usageLimited/blocked）+ token 预算。
   *  - claude：1 个自主 turn（1 张卡片，内部多步）+ 合成状态（仅 active→complete/
   *    blocked/budgetLimited）。无 paused/usageLimited、无预算。
   *  - ⏹ 终止 / 🎯 结束：经 clearGoal() 用 abortController 硬停（spike 实测 ~2s 停，
   *    且 abort 后会话可 resume 续聊）——比工具执行中途的 interrupt() 可靠。
   */
  runGoal(objective: string): AgentRun {
    const turnId = `g${++this.turnSeq}`;
    this.currentTurnId = turnId;
    this.interruptRequested = false;
    this.goalRunning = true;
    this.turnInFlight = true;
    const startedAt = Date.now();
    const mapper = createTurnMapper({ cwd: this.cwd });
    const inbox = new Inbox<TurnItem>();
    const mySink = (item: TurnItem): void => inbox.push(item);
    this.sink = mySink;

    this.input.push(textUserMessage(goalPrompt(objective)));

    const self = this;
    async function* gen(): AsyncGenerator<AgentEvent> {
      yield { type: 'goal_update', status: 'active', objective, tokensUsed: 0, timeUsedSeconds: 0, tokenBudget: null };
      yield { type: 'turn_started', turnId };
      let tokensUsed = 0;
      const finishGoal = (status: string): AgentEvent => ({
        type: 'goal_update',
        status,
        objective,
        tokensUsed,
        timeUsedSeconds: Math.round((Date.now() - startedAt) / 1000),
        tokenBudget: null,
      });
      try {
        while (true) {
          const item = await inbox.next();
          if (item.kind === 'end' || item.kind === 'error') {
            // Deliberate ⏹/🎯 (clearGoal aborted the query) → finish cleanly; a real
            // crash → surface the error.
            if (self.interruptRequested) {
              yield { type: 'done', turnId };
            } else {
              const m = item.kind === 'error' && item.err instanceof Error ? item.err.message : 'Claude 会话进程已退出';
              yield finishGoal('blocked');
              yield { type: 'error', message: m, willRetry: false };
            }
            return;
          }
          const msg = item.msg as unknown as { type?: string; subtype?: string; usage?: Record<string, number> };
          self.lastActivityAt = Date.now();
          for (const ev of mapper.map(item.msg)) {
            if (ev.type === 'usage') tokensUsed = (ev.inputTokens ?? 0) + (ev.outputTokens ?? 0);
            yield ev;
          }
          if (msg.type === 'result') {
            self.goalRunning = false;
            const status = msg.subtype === 'success' || self.interruptRequested ? 'complete' : goalStatusFromResult(msg.subtype);
            try {
              const cu = await self.query.getContextUsage();
              if (cu && typeof cu.totalTokens === 'number' && typeof cu.maxTokens === 'number') {
                yield { type: 'context_usage', usedTokens: cu.totalTokens, contextWindow: cu.maxTokens };
              }
            } catch {
              /* best-effort */
            }
            yield finishGoal(status);
            yield { type: 'done', turnId };
            return;
          }
        }
      } finally {
        self.goalRunning = false;
        self.endTurn();
        if (self.sink === mySink) self.sink = undefined;
      }
    }

    return { events: gen(), turnId: () => self.currentTurnId, lastActivity: () => self.lastActivityAt };
  }

  /**
   * Clear/terminate the goal. Claude has no goal engine, so "clear" = hard-stop the
   * in-flight goal turn via the AbortController (interrupt() can hang mid-tool;
   * abort reliably stops in ~2s and the session stays resumable, so chat continues
   * via resolveThread's resume on the next message). No-op when no goal is running
   * (this is also the orchestrator's idempotent end-of-run cleanup — keep the warm
   * query alive on natural completion).
   */
  async clearGoal(): Promise<void> {
    if (!this.goalRunning) return;
    this.goalRunning = false;
    this.interruptRequested = true;
    this.dead = true; // aborted → resolveThread evicts + resumes on next message
    try {
      this.abortController.abort();
    } catch {
      /* ignore */
    }
  }
  async steer(): Promise<void> {
    // capabilities.steer=false → orchestrator queues the steer as the next turn.
    throw new Error('claude-agent 后端暂不支持飞行中引导（steer），将自动改为下一轮发送');
  }
  /**
   * Manual /compact. Claude Code's `/compact` IS a real slash command (verified:
   * `supportedCommands()` lists it, and sending "/compact" as input is intercepted
   * and executed, not echoed). We send it through the persistent query and drain to
   * the result; a `compact_boundary`(trigger:manual) means it actually compacted —
   * "Not enough messages to compact." just ends with no boundary (compacted=false).
   */
  async compact(): Promise<CompactResult> {
    if (this.dead) throw new Error('Claude 会话已结束，无法压缩');
    const inbox = new Inbox<TurnItem>();
    const mySink = (item: TurnItem): void => inbox.push(item);
    this.sink = mySink;
    this.interruptRequested = false;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), COMPACT_TIMEOUT_MS);
    });

    let compacted = false;
    try {
      this.input.push(textUserMessage('/compact'));
      while (true) {
        const step = await Promise.race([inbox.next(), timeout]);
        if (step === 'timeout') throw new Error(`压缩超时（Claude 未在 ${COMPACT_TIMEOUT_MS / 1000}s 内完成）`);
        if (step.kind === 'end') throw new Error('Claude 会话进程已退出');
        if (step.kind === 'error') throw step.err instanceof Error ? step.err : new Error(String(step.err));
        const msg = step.msg as unknown as { type?: string; subtype?: string };
        this.lastActivityAt = Date.now();
        if (msg.type === 'system' && msg.subtype === 'compact_boundary') compacted = true;
        if (msg.type === 'result') break; // the /compact turn ended
      }
    } finally {
      if (timer) clearTimeout(timer);
      if (this.sink === mySink) this.sink = undefined;
    }

    let usage: CompactResult['usage'] = null;
    try {
      const cu = await this.query.getContextUsage();
      if (cu && typeof cu.totalTokens === 'number' && typeof cu.maxTokens === 'number') {
        usage = { usedTokens: cu.totalTokens, contextWindow: cu.maxTokens };
      }
    } catch {
      /* best-effort post-compaction usage */
    }
    return { compacted, usage };
  }

  async abort(_turnId: string): Promise<void> {
    this.interruptRequested = true;
    try {
      await this.query.interrupt();
    } catch (err) {
      log.fail('agent', err, { backend: 'claude-agent', phase: 'interrupt' });
    }
    // interrupt() ends a streaming turn cleanly (keeps the warm process), but HANGS
    // when a blocking tool is mid-execution — so escalate to a hard abort if the
    // turn hasn't ended shortly, guaranteeing ⏹ always stops.
    if (this.escalateTimer || !this.turnInFlight) return;
    this.escalateTimer = setTimeout(() => {
      this.escalateTimer = undefined;
      if (this.dead || !this.turnInFlight) return; // interrupt already ended it
      log.info('agent', 'interrupt-escalate', { backend: 'claude-agent' });
      this.dead = true; // hard abort → resolveThread evicts + resumes next message
      try {
        this.abortController.abort();
      } catch {
        /* ignore */
      }
    }, ABORT_ESCALATE_MS);
  }

  isAlive(): boolean {
    return !this.dead;
  }

  async close(): Promise<void> {
    this.dead = true;
    this.endTurn();
    try {
      this.input.close();
    } catch {
      /* ignore */
    }
    try {
      this.abortController.abort();
    } catch {
      /* ignore */
    }
    try {
      this.query.close?.();
    } catch {
      /* ignore */
    }
  }
}
