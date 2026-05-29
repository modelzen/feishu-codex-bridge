import type { CardActionEvent, LarkChannel, NormalizedMessage } from '@larksuiteoapi/node-sdk';
import { createBackend } from '../agent';
import type { AgentRun, AgentThread, ModelInfo, ReasoningEffort } from '../agent/types';
import {
  getMaxConcurrentRuns,
  getPendingPolicy,
  getRunIdleTimeoutMs,
  getShowToolCalls,
  isAdmin,
  isChatAllowed,
  isUserAllowed,
  type AppConfig,
  type AppPreferences,
  type PendingPolicy,
} from '../config/schema';
import { saveConfig } from '../config/store';
import { CardDispatcher } from '../card/dispatcher';
import { sendManagedCard, updateManagedCard } from '../card/managed';
import { RunRender } from '../card/run-render';
import {
  buildHelpCard,
  buildModelCard,
  buildResumeCard,
  buildResumeDoneCard,
  buildResumeErrorCard,
  buildResumeLaunchingCard,
  MC,
  RES,
  type HelpScope,
  type ModelCardState,
  type ResumeCardState,
} from '../card/command-cards';
import { buildHistoryCard, type HistoryCardState } from '../card/history-card';
import { buildRunCard, buildRunCardPlain, RC, type RunCardState } from '../card/run-card';
import { RunCardStream } from '../card/run-card-stream';
import { log, withTrace } from '../core/logger';
import {
  buildDmMenuCard,
  buildGroupSettingsCard,
  buildNewProjectDoneCard,
  buildNewProjectFormCard,
  buildProjectListCard,
  buildRmConfirmCard,
  buildSettingsCard,
  DM,
  GS,
} from '../card/dm-cards';
import { getProjectByChatId, listProjects, removeProject, updateProject, type Project } from '../project/registry';
import { createProject } from '../project/lifecycle';
import { refreshBranch } from '../project/announcement';
import { transferOwnership } from '../project/group-ops';
import { getSession, listSessions, patchSession, upsertSession, type SessionRecord } from './session-store';
import { handleDmConsole } from './dm-console';
import { Semaphore, withIdleTimeout } from './watchdog';

interface ActiveState {
  /** unset only during the brief "reserved, still resolving the thread" window */
  thread?: AgentThread;
  run?: AgentRun;
  queue: string[];
  /** who started this run — gates destructive ⏹ (design §5) */
  requesterOpenId?: string;
  /** ⏹ 终止: abort the codex turn AND end the local consume loop. Set per-turn
   * while a run is in flight; codex emits no mappable terminal on interrupt, so
   * the loop must be stopped locally rather than waiting on the backend. */
  interrupt?: () => void;
}

/** Message-reaction lifecycle controller (see {@link runReaction}). */
interface RunReaction {
  /** the run acquired a concurrency slot and is now running → Typing */
  started: () => void;
  /** the run ended (complete / ⏹ / timeout / error) → DONE */
  done: () => void;
}

export interface Orchestrator {
  onMessage: (msg: NormalizedMessage) => Promise<void>;
  dispatcher: CardDispatcher;
}

/**
 * The group orchestrator owns all per-bridge run state (codex threads, active
 * turns, concurrency, pending command cards) and exposes both the inbound
 * message handler and the card-action dispatcher so they share that state.
 *
 * Flow (design §3):
 *   p2p                       → DM console (never runs codex).
 *   group @bot, no thread     → reply_in_thread creates the topic → run codex
 *                               (default model/effort; tune later with /model).
 *   group @bot /resume        → history picker → resume a codex thread in a new topic.
 *   group @bot, inside thread → a turn in that session (steer/queue mid-turn);
 *                               /model opens the model/effort picker for it.
 *
 * Group kinds (project.kind): 'multi' (default) = a topic per session, keyed by
 * threadId (the flow above); 'single' = the whole group is one session keyed by
 * chatId, replies quote the message (no topic, runs serialize). 免@ (noMention,
 * default on) lets non-@ messages run too — multi only inside a topic, single
 * whole-group (needs the im:message.group_msg scope). @bot /settings toggles it.
 */
export function createOrchestrator(
  channel: LarkChannel,
  cfg: AppConfig,
  fallbackCwd: string,
): Orchestrator {
  const backend = createBackend();
  const sessions = new Map<string, AgentThread>();
  const active = new Map<string, ActiveState>();
  const sema = new Semaphore(getMaxConcurrentRuns(cfg));
  const idleMs = getRunIdleTimeoutMs(cfg) ?? 0;
  // pendingPolicy is read per-message (settings card can change it live)
  /** pending /resume cards, keyed by the card's messageId */
  const resumePending = new Map<string, ResumeCardState>();
  /** pending /model cards, keyed by the card's messageId */
  const modelPending = new Map<string, ModelCardState>();
  /** active runs indexed by their run card's messageId (for ⏹ 中止) */
  const runsByCard = new Map<string, ActiveState>();
  /** latest run-card state by messageId (to demote a previous turn's card) */
  const runCards = new Map<string, RunCardState>();
  /** CardKit entity backing each run card, by messageId — drives the native
   * typewriter stream and whole-card (button/settings) updates. */
  const runStreams = new Map<string, RunCardStream>();
  /** the latest settings-bearing run card per topic thread */
  const lastRunCard = new Map<string, string>();
  let modelsCache: ModelInfo[] | null = null;

  async function listModels(): Promise<ModelInfo[]> {
    if (!modelsCache) modelsCache = await backend.listModels();
    return modelsCache;
  }

  function pickDefault(models: ModelInfo[]): { model: string; effort: ReasoningEffort } {
    const def = models.find((m) => m.isDefault && !m.hidden) ?? models.find((m) => !m.hidden) ?? models[0];
    return { model: def?.id ?? 'gpt-5.5', effort: def?.defaultEffort ?? 'medium' };
  }

  // Feishu gives bots no way to mark a message "已读" (read receipts are a
  // human-client signal), so a reaction stands in for one. Best-effort — a
  // missing im:message.reaction:write scope just means no reaction appears.
  async function addReaction(messageId: string, emoji: string): Promise<string | undefined> {
    try {
      const r = await channel.rawClient.im.v1.messageReaction.create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: emoji } },
      });
      return (r as { data?: { reaction_id?: string } }).data?.reaction_id;
    } catch (err) {
      log.fail('card', err, { phase: 'reaction-add', emoji });
      return undefined;
    }
  }
  function removeReaction(messageId: string, reactionId: string): void {
    void channel.rawClient.im.v1.messageReaction
      .delete({ path: { message_id: messageId, reaction_id: reactionId } })
      .catch((err) => log.fail('card', err, { phase: 'reaction-del' }));
  }

  /**
   * Reaction lifecycle on the triggering message: ⏳ OneSecond while the run
   * waits for a free concurrency slot, 🫳 Typing while it's actually running,
   * then the emoji is removed entirely when it ends (complete / ⏹ 终止 /
   * timeout / error) — no "done" emoji. Transitions are serialized through
   * `chain` so each step removes the prior emoji first.
   */
  function runReaction(messageId: string, queued: boolean): RunReaction {
    let chain: Promise<string | undefined> = addReaction(messageId, queued ? 'OneSecond' : 'Typing');
    let phase = queued ? 0 : 1; // 0 = waiting(OneSecond), 1 = running(Typing), 2 = done(cleared)
    const swap = (emoji: string): void => {
      chain = chain.then(async (prevId) => {
        if (prevId) removeReaction(messageId, prevId);
        return addReaction(messageId, emoji);
      });
    };
    return {
      started: () => {
        if (phase < 1) {
          phase = 1;
          swap('Typing');
        }
      },
      done: () => {
        if (phase < 2) {
          phase = 2;
          chain = chain.then((prevId) => {
            if (prevId) removeReaction(messageId, prevId);
            return undefined;
          });
        }
      },
    };
  }

  // ── inbound messages ──────────────────────────────────────────────
  const onMessage = async (msg: NormalizedMessage): Promise<void> => {
    log.info('intake', 'recv', {
      chatType: msg.chatType,
      mentionedBot: msg.mentionedBot,
      threadId: msg.threadId ?? null,
      preview: msg.content.slice(0, 40),
    });

    if (msg.chatType === 'p2p') {
      await handleDmConsole(channel, cfg, msg);
      return;
    }

    const project = await getProjectByChatId(msg.chatId);
    // @门：没 @ 时只在「项目群 + 免@ 适用」才响应。免@默认开,但 multi 仅话题内、
    // single 整群;非项目群一律不响应非 @ 消息。
    if (!msg.mentionedBot && !(project && shouldRespondWithoutMention(project, msg))) return;
    if (!isChatAllowed(cfg, msg.chatId) || !isUserAllowed(cfg, msg.senderId)) {
      log.info('intake', 'reject', { reason: 'not_allowed', chatId: msg.chatId.slice(-6) });
      return;
    }

    const text = msg.content.trim();
    const cmd = parseCommand(text);

    // Single-session group: the whole group is one session keyed by chatId. No
    // topics — reply by quoting (引用回复); runs serialize per chatId (active[chatId]).
    // Commands: /settings (群设置) + /model. /resume has no topic list here.
    if ((project?.kind ?? 'multi') === 'single') {
      if (cmd === 'help') {
        await postHelpCard(msg, 'single');
        return;
      }
      if (cmd === 'settings') {
        await postGroupSettings(msg, project);
        return;
      }
      if (cmd === 'model') {
        await postModelCard(msg, msg.chatId);
        return;
      }
      handleTurn(msg, text, msg.chatId, true, project);
      return;
    }

    // Multi (default): inside a topic → a turn in that session. Only /model is a
    // command here; /settings + /resume aren't topic-scoped, so they fall through
    // as a normal turn (告诉 codex 的普通文本).
    if (msg.threadId) {
      if (cmd === 'help') {
        await postHelpCard(msg, 'topic', true);
        return;
      }
      if (cmd === 'model') {
        await postModelCard(msg, msg.threadId);
        return;
      }
      handleTurn(msg, text, msg.threadId, false, project);
      return;
    }
    // Main group area: /resume opens the history picker; /settings opens the
    // group-settings card; /model only makes sense inside a topic; anything else
    // directly creates a topic + runs.
    if (cmd === 'help') {
      await postHelpCard(msg, 'main');
      return;
    }
    if (cmd === 'resume') {
      await postResumeCard(msg);
      return;
    }
    if (cmd === 'settings') {
      await postGroupSettings(msg, project);
      return;
    }
    if (cmd === 'model') {
      await channel
        .send(msg.chatId, { markdown: '`/model` 需要在话题里使用（先 @我 开个话题）。' }, { replyTo: msg.messageId })
        .catch(() => undefined);
      return;
    }
    startTopicDirectly(msg, text, project);
  };

  /** Parse a leading slash command (`/resume`, `/model`, `/settings`); null otherwise. */
  function parseCommand(text: string): 'resume' | 'model' | 'settings' | 'help' | null {
    const m = /^\/(\w+)/.exec(text);
    const name = m?.[1]?.toLowerCase();
    return name === 'resume' || name === 'model' || name === 'settings' || name === 'help' ? name : null;
  }

  /** Whether to respond to a non-@ message in a project group (免@ default on).
   * single: whole group. multi: inside a topic, OR a slash command in the main
   * area — plain chatter in the main area still needs @ (开新话题 是明确意图，
   * 不能让随便一句话就开话题)，but explicit commands (/help /resume /settings
   * /model) respond without @ since they're unambiguous intent.
   * 即使开了免@，若消息 @了所有人 或 @了具体的(非机器人)用户,说明是定向给别人的,
   * bot 不插话。(此函数仅在 !mentionedBot 时调用,故 @到 bot 的情况已被排除。) */
  function shouldRespondWithoutMention(project: Project, msg: NormalizedMessage): boolean {
    if (!(project.noMention ?? true)) return false;
    if (msg.mentionAll || msg.mentions.some((m) => !m.isBot)) return false;
    if ((project.kind ?? 'multi') === 'single') return true;
    return Boolean(msg.threadId) || parseCommand(msg.content.trim()) !== null;
  }

  /** @bot /settings in a group: post the in-group settings card (admin-gated). */
  async function postGroupSettings(msg: NormalizedMessage, project?: Project): Promise<void> {
    if (!isAdmin(cfg, msg.senderId)) {
      await channel
        .send(msg.chatId, { markdown: '仅管理员可改群设置。' }, { replyTo: msg.messageId })
        .catch(() => undefined);
      return;
    }
    if (!project) {
      await channel
        .send(msg.chatId, { markdown: '本群未绑定项目，请先在私聊里新建项目。' }, { replyTo: msg.messageId })
        .catch(() => undefined);
      return;
    }
    await withTrace({ chatId: msg.chatId, msgId: msg.messageId }, async () => {
      await sendManagedCard(channel, msg.chatId, buildGroupSettingsCard(project), msg.messageId);
      log.info('card', 'group-settings', { project: project.name });
    });
  }

  /**
   * A turn in a session keyed by `sessionKey` — the topic's threadId (multi) or
   * the chatId (single, `flat`). steer/queue mid-turn; otherwise reserve + run.
   * `flat` = reply by quoting (no reply_in_thread / topic), for single groups.
   */
  async function handleTurn(
    msg: NormalizedMessage,
    text: string,
    sessionKey: string,
    flat: boolean,
    project?: Project,
  ): Promise<void> {
    // Mid-turn: steer (引导) or queue (排队).
    const existing = active.get(sessionKey);
    if (existing) {
      if (getPendingPolicy(cfg) === 'steer' && existing.run && existing.thread) {
        const tid = existing.run.turnId();
        if (tid) {
          try {
            await existing.thread.steer({ text }, tid);
            log.info('intake', 'steer', { tid });
            return;
          } catch (err) {
            log.warn('intake', 'steer-failed', { err: String(err) });
          }
        }
      }
      existing.queue.push(text);
      log.info('intake', 'queued', { depth: existing.queue.length });
      return;
    }

    // Reserve the session synchronously (before any await) so a second message
    // racing in through the SDK's per-chatId queue sees it and queues instead
    // of double-launching. Then run **detached**: onMessage must return fast or
    // it holds the chatId queue for the whole codex run, blocking sibling
    // topics and the ⏹ card-action (design: 话题=独立 session，应并行).
    const reserved: ActiveState = { queue: [], requesterOpenId: msg.senderId };
    active.set(sessionKey, reserved);
    void withTrace({ chatId: msg.chatId, msgId: msg.messageId }, async () => {
      const reaction = runReaction(msg.messageId, !sema.hasFree());
      try {
        let thread = await resolveThread(sessionKey, msg.chatId);
        if (!thread) {
          // Unknown session (created before this bridge, or store lost): treat as
          // a fresh session bound to the resolved cwd.
          const cwd = project?.cwd ?? fallbackCwd;
          thread = await backend.startThread({ cwd });
          sessions.set(sessionKey, thread);
          await upsertSession({
            threadId: sessionKey,
            chatId: msg.chatId,
            cwd,
            codexThreadId: thread.codexThreadId,
            summary: text.slice(0, 80),
            createdAt: Date.now(),
            updatedAt: Date.now(),
          });
        }
        reserved.thread = thread;
        await launchRun(
          {
            chatId: msg.chatId,
            replyTo: msg.messageId,
            replyInThread: !flat,
            flat,
            thread,
            firstText: text,
            knownThreadId: sessionKey,
            requesterOpenId: msg.senderId,
          },
          reaction,
        );
      } catch (err) {
        active.delete(sessionKey); // release the reservation so the session isn't wedged
        reaction.done();
        log.fail('intake', err);
        await channel
          .send(msg.chatId, { markdown: `❌ ${err instanceof Error ? err.message : String(err)}` }, { replyTo: msg.messageId, replyInThread: !flat })
          .catch(() => undefined);
      }
    });
  }

  /** Reuse an in-memory codex thread, else resume from the persisted store. */
  async function resolveThread(threadId: string, chatId: string): Promise<AgentThread | undefined> {
    const live = sessions.get(threadId);
    if (live) return live;
    const rec = await getSession(threadId);
    if (!rec) return undefined;
    try {
      const resumed = await backend.resumeThread({
        cwd: rec.cwd,
        codexThreadId: rec.codexThreadId,
        model: rec.model,
        effort: rec.effort,
      });
      sessions.set(threadId, resumed);
      return resumed;
    } catch (err) {
      log.fail('agent', err, { phase: 'resume-on-turn', threadId });
      const project = await getProjectByChatId(chatId);
      const cwd = project?.cwd ?? rec.cwd ?? fallbackCwd;
      const fresh = await backend.startThread({ cwd, model: rec.model, effort: rec.effort });
      sessions.set(threadId, fresh);
      return fresh;
    }
  }

  /** Group @bot (no topic): create the topic + run with the default model.
   * Detached — onMessage must return fast (see {@link handleTurn}); a new
   * topic has a unique reply target so no same-topic reservation is needed. */
  function startTopicDirectly(msg: NormalizedMessage, text: string, project?: Project): void {
    void withTrace({ chatId: msg.chatId, msgId: msg.messageId }, async () => {
      // 🫳 Typing on receive (⏳ OneSecond if a slot isn't free) → ✅ DONE once
      // the topic is created (onTopicCreated, below). For this path the acked
      // action is "建话题", not the full reply — so DONE fires on first card,
      // unlike an in-topic turn (see handleTurn).
      const reaction = runReaction(msg.messageId, !sema.hasFree());
      const cwd = project?.cwd ?? fallbackCwd;
      // lazy banner branch refresh (design §3.2) — best-effort, non-blocking
      if (project) void refreshBranch(channel, project).catch(() => undefined);
      const { model, effort } = pickDefault(await listModels());
      let thread: AgentThread;
      try {
        thread = await backend.startThread({ cwd, model, effort });
      } catch (err) {
        reaction.done();
        log.fail('card', err, { phase: 'start-topic' });
        await channel
          .send(msg.chatId, { markdown: `❌ 启动失败：${err instanceof Error ? err.message : String(err)}` }, { replyTo: msg.messageId })
          .catch(() => undefined);
        return;
      }
      const firstText = text || '你好，我们开始吧。';
      log.info('card', 'start', { project: project?.name ?? '(unregistered)', model, effort });
      await launchRun(
        {
          chatId: msg.chatId,
          replyTo: msg.messageId,
          replyInThread: true,
          thread,
          firstText,
          model,
          effort,
          cwd,
          summary: text.slice(0, 80) || '(空)',
          requesterOpenId: msg.senderId,
        },
        reaction,
        () => reaction.done(), // topic created → ✅ DONE (don't wait for the reply)
      );
    }).catch((err) => log.fail('intake', err));
  }

  /** Group @bot /resume: post the history picker for this project's cwd. */
  async function postResumeCard(msg: NormalizedMessage): Promise<void> {
    await withTrace({ chatId: msg.chatId, msgId: msg.messageId }, async () => {
      const project = await getProjectByChatId(msg.chatId);
      const cwd = project?.cwd ?? fallbackCwd;
      const threads = await backend.listThreads(cwd);
      const state: ResumeCardState = {
        chatId: msg.chatId,
        originalMsgId: msg.messageId,
        requesterOpenId: msg.senderId,
        cwd,
        projectName: project?.name,
        threads,
        createdAt: Date.now(),
      };
      const res = await sendManagedCard(channel, msg.chatId, buildResumeCard(state), msg.messageId);
      pruneResumePending();
      resumePending.set(res.messageId, state);
      log.info('card', 'resume', { project: project?.name ?? '(unregistered)', threads: threads.length });
    });
  }

  /** @bot /model: post the model/effort picker for the session keyed by
   * `sessionKey` (topic threadId for multi, chatId for single). */
  async function postModelCard(msg: NormalizedMessage, sessionKey: string): Promise<void> {
    await withTrace({ chatId: msg.chatId, msgId: msg.messageId }, async () => {
      const [models, rec] = await Promise.all([listModels(), getSession(sessionKey)]);
      const def = pickDefault(models);
      const state: ModelCardState = {
        chatId: msg.chatId,
        threadId: sessionKey,
        requesterOpenId: msg.senderId,
        models,
        model: rec?.model ?? def.model,
        effort: rec?.effort ?? def.effort,
        createdAt: Date.now(),
      };
      const res = await sendManagedCard(channel, msg.chatId, buildModelCard(state), msg.messageId, true);
      pruneModelPending();
      modelPending.set(res.messageId, state);
      log.info('card', 'model', { threadId: sessionKey, model: state.model, effort: state.effort });
    });
  }

  /** `/help`: post the command cheat-sheet for the caller's current scope. */
  async function postHelpCard(msg: NormalizedMessage, scope: HelpScope, inThread = false): Promise<void> {
    await withTrace({ chatId: msg.chatId, msgId: msg.messageId }, async () => {
      await sendManagedCard(channel, msg.chatId, buildHelpCard(scope), msg.messageId, inThread).catch((err) =>
        log.fail('card', err, { cmd: 'help', scope }),
      );
      log.info('card', 'help', { scope });
    });
  }

  // ── card actions ──────────────────────────────────────────────────
  const dispatcher = new CardDispatcher(channel, cfg);
  const PENDING_TTL_MS = 30 * 60_000; // abandoned config cards expire after 30 min

  // A card update issued from inside a cardAction handler must land AFTER Feishu
  // is done with the click's interaction window — Feishu locks the card during
  // that window and discards an update that arrives inside it (official "处理卡片
  //回调"). A hard collision throws cardkit err 200810 (caught + retried below);
  // but a near-miss returns HTTP 200 yet the *client* still snaps the card back
  // to its pre-click state — silent, so the 200810 retry never fires and the
  // update is simply lost (symptom: "点一下没反应 / 要点两下"). We learned 150ms is
  // inside that soft window; 500ms clears it reliably. These console cards aren't
  // high-frequency, so the latency is worth the determinism. Cards must be
  // CardKit entities (sendManagedCard) for the update to target them —
  // im.v1.message.patch only does "unconditional".
  const CARD_SETTLE_MS = 500;
  // `c` may be a card object or a (possibly async) builder. Passing a builder
  // lets a handler return *immediately* (so the SDK acks the click's callback
  // right away, closing the interaction window) while any slow work — API
  // calls, createProject — runs inside the settle, after the ack. Awaiting slow
  // work in the handler instead holds the callback open and the next click's
  // update collides with the still-open window (err 200810 → revert).
  //
  // `fallbackChatId`: byMessageId mappings are per-process (lost on restart), so
  // a card sent before a restart is an orphan — updateManagedCard finds no entity
  // and no-ops, leaving a dead card (the "返回菜单又没用了" after I restart). When a
  // chatId is given we self-heal by posting a fresh managed card instead (no
  // recall — the stale one just sits above).
  const settleUpdate = (
    msgId: string,
    c: object | (() => object | Promise<object>),
    fallbackChatId?: string,
  ): void => {
    const armedAt = Date.now();
    void (async () => {
      await new Promise((r) => setTimeout(r, CARD_SETTLE_MS));
      const card = typeof c === 'function' ? await c() : c;
      const ok = await updateManagedCard(channel, msgId, card);
      log.info('console', 'settle-update', { msgId, ok, waitedMs: Date.now() - armedAt, fallback: !ok && !!fallbackChatId });
      if (!ok && fallbackChatId) {
        await sendManagedCard(channel, fallbackChatId, card).catch((err) =>
          log.fail('console', err, { phase: 'settle-fallback' }),
        );
      }
    })();
  };
  function pruneResumePending(): void {
    const now = Date.now();
    for (const [k, s] of resumePending) if (now - s.createdAt > PENDING_TTL_MS) resumePending.delete(k);
  }
  function pruneModelPending(): void {
    const now = Date.now();
    for (const [k, s] of modelPending) if (now - s.createdAt > PENDING_TTL_MS) modelPending.delete(k);
  }

  /**
   * Resolve + authorize a command-card (/model, /resume) action. Only the
   * original requester may act on their card (design §5); chat/user must still
   * be allowed; expired cards are dropped.
   */
  function authPending<T extends { createdAt: number; requesterOpenId: string; chatId: string }>(
    map: Map<string, T>,
    evt: CardActionEvent,
  ): T | undefined {
    const state = map.get(evt.messageId);
    if (!state) return undefined;
    if (Date.now() - state.createdAt > PENDING_TTL_MS) {
      map.delete(evt.messageId);
      return undefined;
    }
    const op = evt.operator?.openId ?? '';
    if (op !== state.requesterOpenId || !isChatAllowed(cfg, state.chatId) || !isUserAllowed(cfg, op)) {
      log.info('card', 'action-denied', { reason: 'not-allowed' });
      return undefined;
    }
    return state;
  }

  dispatcher
    .on(MC.model, ({ evt, option }) => {
      const state = authPending(modelPending, evt);
      if (!state || !option) return;
      settleUpdate(evt.messageId, async () => {
        state.model = option;
        // re-pick a valid effort if the new model doesn't support the current one
        const m = state.models.find((x) => x.id === option);
        if (m && m.supportedEfforts.length && !m.supportedEfforts.includes(state.effort)) {
          state.effort = m.defaultEffort;
        }
        await patchSession(state.threadId, { model: state.model, effort: state.effort });
        state.note = `✅ 已切换模型「${m?.displayName ?? option}」，下一轮生效`;
        return buildModelCard(state);
      });
    })
    .on(MC.effort, ({ evt, option }) => {
      const state = authPending(modelPending, evt);
      if (!state || !option) return;
      settleUpdate(evt.messageId, async () => {
        state.effort = option as ReasoningEffort;
        await patchSession(state.threadId, { effort: state.effort });
        state.note = '✅ 已设置 effort，下一轮生效';
        return buildModelCard(state);
      });
    })
    .on(RES.pick, ({ evt, value }) => {
      const state = authPending(resumePending, evt);
      const codexThreadId = typeof value.t === 'string' ? value.t : undefined;
      if (!state || !codexThreadId || state.launching) return;
      state.launching = true;
      settleUpdate(evt.messageId, buildResumeLaunchingCard(state));
      // detach: don't hold the cardAction callback for the whole resume + run
      void resumeFromCard(evt, state, codexThreadId);
    });

  /** Run-card actions: gated by chat/user allow lists (design §5). */
  const runAllowed = (evt: CardActionEvent): boolean =>
    isChatAllowed(cfg, evt.chatId) && isUserAllowed(cfg, evt.operator?.openId ?? '');
  /**
   * Owner-or-admin gate for run-card controls. Killing/altering someone else's
   * run is destructive (design §5: 杀别人的 run 限 admins), and `allowedUsers`
   * defaults to "everyone", so the allow-list alone is not enough. Only the run
   * starter (requester) or an admin may ⏹/⚙️ it.
   */
  const runOwnerOrAdmin = (evt: CardActionEvent, ownerOpenId?: string): boolean => {
    if (!runAllowed(evt)) return false;
    const op = evt.operator?.openId ?? '';
    return op === ownerOpenId || isAdmin(cfg, op);
  };

  // run card buttons (design §3.3). ⏹ aborts the codex turn AND ends the local
  // consume loop (st.interrupt) — codex emits no mappable terminal on
  // turn/interrupt, so waiting on the backend would hang the card forever.
  dispatcher
    .on(RC.stop, ({ evt, value }) => {
      const key = typeof value.m === 'string' ? value.m : evt.messageId;
      const st = runsByCard.get(key);
      if (!st || !runOwnerOrAdmin(evt, st.requesterOpenId)) return;
      st.interrupt?.();
      log.info('card', 'action', { actionId: 'run.stop', stopped: Boolean(st.interrupt) });
    });

  // DM management console buttons (design §3.1). Admin-gated; sub-views patch
  // the same card in place, each carrying a ⬅️ 菜单 back button.
  const dmAdmin = (openId?: string): boolean => isAdmin(cfg, openId ?? '');
  // DM cards are CardKit entities (sendManagedCard); update them via the
  // settle-then-cardkit path so the click's callback acks first. Passing the
  // whole evt lets settleUpdate self-heal an orphaned (post-restart) card by
  // re-posting to evt.chatId.
  const patch = (evt: CardActionEvent, c: object | (() => object | Promise<object>)): void =>
    settleUpdate(evt.messageId, c, evt.chatId);

  function applyPref(evt: CardActionEvent, mut: (p: AppPreferences) => void): void {
    if (!dmAdmin(evt.operator?.openId)) return;
    const prefs: AppPreferences = { ...(cfg.preferences ?? {}) };
    mut(prefs);
    cfg.preferences = prefs;
    // persist in the background; the card only needs the in-memory cfg
    void saveConfig(cfg).catch((err) => log.fail('console', err, { phase: 'save-config' }));
    patch(evt, buildSettingsCard(cfg));
  }

  // Back-to-menu: the settings card is button-only (never locks) and the
  // new-project form isn't locked until it's submitted, so 返回 always lands on
  // a card we can update in place — no recall, no fresh entity needed.
  const freshMenu = (evt: CardActionEvent): void => {
    patch(evt, buildDmMenuCard());
  };

  // Build the project list card with each project's topics (sessions) grouped
  // by chatId, most-recent first — shared by the list/cancel/delete handlers.
  const renderProjectList = async (): Promise<object> => {
    const [projects, sessions] = await Promise.all([listProjects(), listSessions()]);
    const byChat = new Map<string, SessionRecord[]>();
    for (const s of sessions) {
      const arr = byChat.get(s.chatId);
      if (arr) arr.push(s);
      else byChat.set(s.chatId, [s]);
    }
    return buildProjectListCard(projects, byChat);
  };

  dispatcher
    .on(DM.menu, ({ evt }) => {
      if (dmAdmin(evt.operator?.openId)) freshMenu(evt);
    })
    .on(DM.newProject, ({ evt }) => {
      if (dmAdmin(evt.operator?.openId)) patch(evt, buildNewProjectFormCard());
    })
    .on(DM.newProjectSubmit, ({ evt, formValue, value }) => {
      const op = evt.operator?.openId;
      if (!dmAdmin(op)) return;
      const name = String((formValue?.name as string) ?? '').trim();
      const cwdIn = String((formValue?.cwd as string) ?? '').trim();
      const kind: 'multi' | 'single' = value.kind === 'single' ? 'single' : 'multi';
      // A submitted form locks its card_id (its buttons — retry/返回 on an error
      // re-render — stop firing, and an in-place update no-ops). So the result
      // goes to a *fresh* card; the submitted form stays above as a 留痕. Detach
      // so the submit callback acks immediately (createProject is slow).
      void (async () => {
        let result;
        if (!name) result = buildNewProjectFormCard({ cwd: cwdIn, error: '项目名不能为空' });
        else if (!op) result = buildNewProjectFormCard({ name, cwd: cwdIn, error: '无法识别操作者身份' });
        else {
          try {
            const p = await createProject(channel, { name, ownerOpenId: op, existingPath: cwdIn || undefined, kind });
            log.info('console', 'new-project', { name: p.name, blank: p.blank });
            result = buildNewProjectDoneCard(p);
          } catch (err) {
            result = buildNewProjectFormCard({ name, cwd: cwdIn, error: err instanceof Error ? err.message : String(err) });
          }
        }
        await sendManagedCard(channel, evt.chatId, result).catch((e) =>
          log.fail('console', e, { phase: 'new-project-result' }),
        );
      })();
    })
    .on(DM.projects, ({ evt }) => {
      if (!dmAdmin(evt.operator?.openId)) return;
      patch(evt, renderProjectList);
    })
    .on(DM.settings, async ({ evt }) => {
      if (dmAdmin(evt.operator?.openId)) await patch(evt, buildSettingsCard(cfg));
    })
    .on(DM.doctor, async ({ evt }) => {
      if (!dmAdmin(evt.operator?.openId)) return;
      const ok = await backend.isAvailable().catch(() => false);
      const conn = channel.getConnectionStatus?.()?.state ?? 'unknown';
      await channel
        .send(evt.chatId, { markdown: `🩺 **诊断**\n- codex: ${ok ? '✅ 可用' : '❌ 不可用（检查 CODEX_BIN/PATH）'}\n- 长连接: ${conn}` }, { replyTo: evt.messageId })
        .catch(() => undefined);
    })
    .on(DM.reconnect, async ({ evt }) => {
      if (!dmAdmin(evt.operator?.openId)) return;
      const conn = channel.getConnectionStatus?.()?.state ?? 'unknown';
      await channel
        .send(evt.chatId, { markdown: `🔄 长连接状态：**${conn}**\nSDK 会自动重连；若长期断开，请在终端重启 \`feishu-codex-bridge start\`。` }, { replyTo: evt.messageId })
        .catch(() => undefined);
    })
    .on(DM.rmConfirm, async ({ evt, value }) => {
      const name = typeof value.n === 'string' ? value.n : undefined;
      if (!dmAdmin(evt.operator?.openId) || !name) return;
      await patch(evt, buildRmConfirmCard(name));
    })
    .on(DM.rmCancel, ({ evt }) => {
      if (!dmAdmin(evt.operator?.openId)) return;
      patch(evt, renderProjectList);
    })
    .on(DM.rmDo, ({ evt, value }) => {
      const name = typeof value.n === 'string' ? value.n : undefined;
      const op = evt.operator?.openId;
      if (!dmAdmin(op) || !name) return;
      // all the slow work (remove + owner transfer + reply) runs in the
      // settle builder so the click acks immediately. The announcement vanishes
      // with the group once the owner dissolves it, so nothing to clean up here.
      patch(evt, async () => {
        const removed = await removeProject(name);
        let transferred = false;
        if (removed?.chatId && op) {
          transferred = await transferOwnership(channel, removed.chatId, op)
            .then(() => true)
            .catch((err) => {
              log.fail('console', err, { phase: 'owner-transfer' });
              return false;
            });
        }
        log.info('console', 'rm', { name, transferred });
        const tail = transferred
          ? '群主已转给你 → 请在飞书里**自行解散该群**（机器人不主动解散）。'
          : '⚠️ 群主转让失败（可能 bot 非群主），请用「🚪 群管理」手动转让后解散。';
        await channel
          .send(evt.chatId, { markdown: `✅ 已删除项目「${name}」（解绑，未删代码目录）。\n${tail}` }, { replyTo: evt.messageId })
          .catch(() => undefined);
        return renderProjectList();
      });
    })
    // Each setting is a row of option buttons; the click's `v` is the chosen value.
    .on(DM.setTools, ({ evt, value }) => {
      applyPref(evt, (p) => (p.showToolCalls = value.v === 'on'));
    })
    .on(DM.setWatchdog, ({ evt, value }) => {
      const n = Number(value.v);
      if (Number.isFinite(n)) applyPref(evt, (p) => (p.runIdleTimeoutSeconds = n));
    })
    .on(DM.setPending, ({ evt, value }) => {
      if (value.v === 'steer' || value.v === 'queue') applyPref(evt, (p) => (p.pendingPolicy = value.v as PendingPolicy));
    })
    .on(DM.setConcurrency, ({ evt, value }) => {
      const n = Number(value.v);
      if (Number.isFinite(n)) applyPref(evt, (p) => (p.maxConcurrentRuns = n));
    })
    // In-group settings: toggle 免@ for the project bound to evt.chatId. Admin-gated.
    .on(GS.setNoMention, ({ evt, value }) => {
      if (!isAdmin(cfg, evt.operator?.openId ?? '')) return;
      const on = value.v === 'on';
      patch(evt, async () => {
        const project = await getProjectByChatId(evt.chatId);
        if (project) {
          await updateProject(project.name, { noMention: on });
          log.info('console', 'group-nomention', { project: project.name, on });
          return buildGroupSettingsCard({ ...project, noMention: on });
        }
        return buildGroupSettingsCard({ name: '本群', kind: 'multi', noMention: on });
      });
    });

  /**
   * From a /resume card: read the past thread's transcript, post a collapsible
   * history card as reply_in_thread (which creates the topic) and bind the codex
   * thread to that topic. No filler turn — the session resumes lazily on the
   * topic's first message via {@link resolveThread}, so the user just continues.
   * Detached — never holds the card-action callback for the whole flow. On
   * failure the picker card flips to a (non-retryable) error and pending clears.
   */
  async function resumeFromCard(evt: CardActionEvent, state: ResumeCardState, codexThreadId: string): Promise<void> {
    try {
      // thread/read: fetch the transcript without starting a turn or holding the
      // session live (model/effort left to the thread's own remembered config).
      // Never throws — empty history just yields a minimal card.
      const history = await backend.readHistory(state.cwd, codexThreadId);
      resumePending.delete(evt.messageId);

      let bound = false;
      await withTrace({ chatId: state.chatId, msgId: state.originalMsgId }, async () => {
        const cardState: HistoryCardState = { cwd: state.cwd, projectName: state.projectName, history };
        // reply_in_thread on the /resume message turns it into the topic; the
        // history card is that topic's first message.
        const sent = await sendManagedCard(channel, state.chatId, buildHistoryCard(cardState), state.originalMsgId, true);
        // Binding the codex thread to the topic hinges entirely on resolving the
        // topic thread_id (no live thread to fall back on, unlike the run path) —
        // a miss would make the next message start a FRESH empty session. The
        // reply response omits thread_id and the raw lookup can lag right after
        // the reply, so retry a few times before giving up.
        let tid: string | undefined;
        for (let attempt = 0; attempt < 4 && !tid; attempt++) {
          if (attempt > 0) await new Promise((r) => setTimeout(r, 500));
          tid = await getThreadId(channel, sent.messageId);
        }
        if (tid) {
          const now = Date.now();
          await upsertSession({
            threadId: tid,
            chatId: state.chatId,
            cwd: state.cwd,
            codexThreadId,
            summary: history.name || history.preview || '(恢复会话)',
            createdAt: now,
            updatedAt: now,
          });
          bound = true;
        } else {
          log.warn('card', 'resume-no-threadid', { messageId: sent.messageId });
        }
        log.info('card', 'resume-done', { codexThreadId, threadId: tid ?? null, bound, turns: history.totalTurns });
      });

      // Only promise continuity once the thread is actually bound — else the
      // next message silently starts a fresh session, so say so instead of
      // claiming success. settleUpdate keeps this ordered after the launching
      // card the RES.pick handler settle-pushed (normally the done push runs
      // last; a 200810 retry on the launching push could in theory reorder, but
      // the 500ms settle window avoids that in practice).
      settleUpdate(
        evt.messageId,
        bound
          ? buildResumeDoneCard(state)
          : buildResumeErrorCard(state, '已建话题但未能绑定会话，请重新 /resume'),
      );
    } catch (err) {
      state.launching = false;
      log.fail('card', err, { phase: 'resume-launch' });
      settleUpdate(evt.messageId, buildResumeErrorCard(state, err instanceof Error ? err.message : String(err)));
    }
  }

  // ── shared run loop ───────────────────────────────────────────────
  interface LaunchOpts {
    chatId: string;
    replyTo: string;
    /** true on first reply that creates the topic; subsequent replies use replyTo only */
    replyInThread?: boolean;
    thread: AgentThread;
    firstText: string;
    /** when the topic thread_id is already known (turn in an existing topic) */
    knownThreadId?: string;
    model?: string;
    effort?: ReasoningEffort;
    cwd?: string;
    summary?: string;
    /** who triggered this run (for ⏹/⚙️ ownership gating) */
    requesterOpenId?: string;
    /** single-session group: reply by quoting (no reply_in_thread / topic). */
    flat?: boolean;
  }

  async function launchRun(
    opts: LaunchOpts,
    reaction?: RunReaction,
    onTopicCreated?: () => void,
  ): Promise<void> {
    const release = await sema.acquire();
    reaction?.started(); // slot acquired → flip OneSecond → Typing
    let firstCardSent = false;
    let activeKey = opts.knownThreadId ?? `pending:${opts.replyTo}`;
    let topicThreadId = opts.knownThreadId;
    // Reuse the reservation handleTurn made for this session (so messages
    // queued during startup aren't lost); fall back to a fresh state otherwise.
    const state: ActiveState = active.get(activeKey) ?? { queue: [], requesterOpenId: opts.requesterOpenId };
    state.thread = opts.thread;
    if (opts.requesterOpenId) state.requesterOpenId = opts.requesterOpenId;
    active.set(activeKey, state);
    if (opts.knownThreadId) sessions.set(opts.knownThreadId, opts.thread);

    const persist = async (threadId: string): Promise<void> => {
      await upsertSession({
        threadId,
        chatId: opts.chatId,
        cwd: opts.cwd ?? fallbackCwd,
        codexThreadId: opts.thread.codexThreadId,
        model: opts.model,
        effort: opts.effort,
        summary: opts.summary ?? opts.firstText.slice(0, 80),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }).catch(() => undefined);
    };

    /** Demote the previous turn's card (drop its ⚙️) and promote this one. */
    const promoteCard = (cardMsgId: string, rc: RunCardState): void => {
      if (!topicThreadId) return;
      const prev = lastRunCard.get(topicThreadId);
      if (prev && prev !== cardMsgId) {
        const prevState = runCards.get(prev);
        const prevStream = runStreams.get(prev);
        if (prevState && prevStream) void prevStream.updateCard(channel, buildRunCardPlain(prevState));
        runCards.delete(prev);
        runStreams.delete(prev);
      }
      lastRunCard.set(topicThreadId, cardMsgId);
      runCards.set(cardMsgId, rc);
    };

    // tracks the latest run card key so the finally can clear runsByCard even
    // if the stream producer throws mid-turn (avoids leaking a stale stop target)
    let curCardKey: string | undefined;
    try {
      let turnText = opts.firstText;
      let replyTo = opts.replyTo;
      let replyInThread = opts.flat ? false : (opts.replyInThread ?? Boolean(opts.knownThreadId));
      for (;;) {
        // per-turn model/effort: prefer latest persisted (⚙️ may have changed it)
        const rec = topicThreadId ? await getSession(topicThreadId) : undefined;
        const turnModel = rec?.model ?? opts.model;
        const turnEffort = rec?.effort ?? opts.effort;
        const run = opts.thread.runStreamed({ text: turnText }, { model: turnModel, effort: turnEffort });
        state.run = run;
        const render = new RunRender();
        render.showTools = getShowToolCalls(cfg);
        let cardMsgId: string | undefined;
        const rc: RunCardState = {
          rs: render.snapshot(),
          requesterOpenId: opts.requesterOpenId,
          showTools: render.showTools,
        };

        const adoptThreadId = async (messageId: string): Promise<void> => {
          if (activeKey.startsWith('pending:')) {
            const tid = await getThreadId(channel, messageId);
            if (tid) {
              active.delete(activeKey);
              active.set(tid, state);
              sessions.set(tid, opts.thread);
              activeKey = tid;
              topicThreadId = tid;
              rc.threadId = tid;
              await persist(tid);
            }
          } else {
            topicThreadId = activeKey;
            rc.threadId = activeKey;
          }
        };

        // CardKit streaming entity: body streams with the native typewriter,
        // ⏹/⚙️ ride whole-card updates — both on one card_id (see RunCardStream).
        const stream = new RunCardStream();
        cardMsgId = await stream.create(channel, opts.chatId, buildRunCard(rc), { replyTo, replyInThread });
        curCardKey = cardMsgId;
        rc.cardKey = cardMsgId;
        runsByCard.set(cardMsgId, state);
        runStreams.set(cardMsgId, stream);
        await adoptThreadId(cardMsgId);
        // first card is live = topic created. The 群@bot 建话题 path flips its
        // reaction to DONE here (creating the topic is the acked action), unlike
        // an in-topic turn which holds Typing until the reply itself ends.
        if (!firstCardSent) {
          firstCardSent = true;
          try {
            onTopicCreated?.();
          } catch {
            /* reaction is best-effort */
          }
        }

        // ⏹ 终止 / watchdog: end the consume loop locally. codex emits no
        // mappable terminal on turn/interrupt — the event stream just hangs (see
        // log 08:48: a stopped card never finalized) — so we must not wait on the
        // backend. `stopSignal` ends the loop instantly (card flips to 已中断);
        // the dead turn's process is then recycled below.
        let timedOut = false;
        let interrupted = false;
        let resolveStop!: () => void;
        const stopSignal = new Promise<void>((res) => {
          resolveStop = res;
        });
        state.interrupt = () => {
          if (interrupted) return;
          interrupted = true;
          resolveStop();
        };
        const guarded = withIdleTimeout(
          run.events,
          idleMs,
          () => {
            timedOut = true;
          },
          stopSignal,
        );
        for await (const ev of guarded) {
          render.apply(ev);
          rc.rs = render.snapshot();
          await stream.streamCard(channel, buildRunCard(rc));
        }
        state.interrupt = undefined; // turn done; nothing left to interrupt
        const killed = interrupted || timedOut;
        if (timedOut) render.timeout(Math.max(1, Math.round(idleMs / 60_000)));
        else if (interrupted) render.interrupt();
        else render.finalize();
        rc.rs = render.snapshot();

        // A killed turn leaves codex mid-turn with a notification stream that
        // never terminates. Recycle the process: closing it ends the stream
        // cleanly (no orphaned reader stealing the next turn's events) and frees
        // the turn. The topic resumes from the persisted thread on its next
        // message (resolveThread), so the session survives the kill.
        if (killed) {
          void opts.thread.close().catch(() => undefined);
          if (topicThreadId) sessions.delete(topicThreadId);
        }

        const finalMsgId = cardMsgId;
        await adoptThreadId(finalMsgId);
        rc.cardKey = finalMsgId;
        // terminal whole-card update: final render with streaming off (clears the
        // typewriter cursor) and no ⏹ button.
        await stream.updateCard(channel, buildRunCard(rc));
        runsByCard.delete(cardMsgId);
        promoteCard(finalMsgId, rc);
        if (topicThreadId) await patchSession(topicThreadId, { updatedAt: Date.now() });
        replyTo = finalMsgId;
        replyInThread = !opts.flat; // stay in the topic for queued turns (single: stay flat)
        log.info('card', 'final', { terminal: render.terminal() });

        // A kill (⏹ / watchdog) stops the whole run — drop any queued follow-ups
        // (they'd run on the recycled, now-closed thread).
        if (killed) break;
        if (state.queue.length === 0) break;
        turnText = state.queue.shift()!;
      }
    } catch (err) {
      log.fail('intake', err);
      await channel
        .send(opts.chatId, { markdown: `❌ ${err instanceof Error ? err.message : String(err)}` }, { replyTo: opts.replyTo, replyInThread: !opts.flat })
        .catch(() => undefined);
    } finally {
      active.delete(activeKey);
      if (curCardKey) runsByCard.delete(curCardKey);
      reaction?.done(); // run ended (complete / ⏹ / timeout / error) → ✅ DONE
      release();
    }
  }

  return { onMessage, dispatcher };
}

/** Resolve a message's thread_id via raw API (reply response omits it). */
async function getThreadId(channel: LarkChannel, messageId: string): Promise<string | undefined> {
  try {
    const res = await channel.rawClient.im.v1.message.get({ path: { message_id: messageId } });
    const items = (res.data as { items?: { thread_id?: string }[] } | undefined)?.items;
    const tid = items?.[0]?.thread_id;
    if (!tid) log.warn('intake', 'threadid-missing', { messageId });
    return tid;
  } catch (err) {
    log.warn('intake', 'threadid-lookup-failed', { messageId, err: String(err) });
    return undefined;
  }
}
