import type { CardActionEvent, LarkChannel, NormalizedMessage } from '@larksuiteoapi/node-sdk';
import { createBackend } from '../agent';
import type { AgentRun, AgentThread, ModelInfo, ReasoningEffort } from '../agent/types';
import {
  getMaxConcurrentRuns,
  getPendingPolicy,
  getRunIdleTimeoutMs,
  isChatAllowed,
  isUserAllowed,
  type AppConfig,
} from '../config/schema';
import { CardDispatcher } from '../card/dispatcher';
import { RunRender } from '../card/run-render';
import {
  buildConfigDoneCard,
  buildSessionConfigCard,
  SC,
  type SessionConfigState,
} from '../card/session-config-card';
import { buildRunCard, buildRunCardPlain, RC, type RunCardState, type RunStatus } from '../card/run-card';
import { log, withTrace } from '../core/logger';
import { currentBranch } from '../project/git-info';
import { getProjectByChatId } from '../project/registry';
import { refreshBranch } from '../project/banner';
import { getSession, patchSession, upsertSession } from './session-store';
import { handleDmConsole } from './dm-console';
import { Semaphore, withIdleTimeout } from './watchdog';

interface ActiveState {
  thread: AgentThread;
  run?: AgentRun;
  queue: string[];
}

export interface Orchestrator {
  onMessage: (msg: NormalizedMessage) => Promise<void>;
  dispatcher: CardDispatcher;
}

/**
 * The group orchestrator owns all per-bridge run state (codex threads, active
 * turns, concurrency, pending config cards) and exposes both the inbound
 * message handler and the card-action dispatcher so they share that state.
 *
 * Flow (design §3):
 *   p2p                       → DM console (never runs codex).
 *   group @bot, no thread     → post 会话配置卡 (pick model/effort, 创建/恢复).
 *   group @bot, inside thread → a turn in that session (steer/queue mid-turn).
 *   card 创建/恢复             → reply_in_thread creates the topic → run codex.
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
  const policy = getPendingPolicy(cfg);
  /** pending config cards, keyed by the card's messageId */
  const pending = new Map<string, SessionConfigState>();
  /** active runs indexed by their run card's messageId (for ⏹ 中止) */
  const runsByCard = new Map<string, ActiveState>();
  /** final run-card state by messageId (for ⚙️ settings on the latest card) */
  const runCards = new Map<string, RunCardState>();
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
    if (!msg.mentionedBot) return;
    if (!isChatAllowed(cfg, msg.chatId) || !isUserAllowed(cfg, msg.senderId)) {
      log.info('intake', 'reject', { reason: 'not_allowed', chatId: msg.chatId.slice(-6) });
      return;
    }

    const text = msg.content.trim();

    // Inside a topic → a turn in that session.
    if (msg.threadId) {
      await handleThreadTurn(msg, text);
      return;
    }
    // Main group area → offer the session config card.
    await postConfigCard(msg, text);
  };

  async function handleThreadTurn(msg: NormalizedMessage, text: string): Promise<void> {
    const threadId = msg.threadId!;
    // Mid-turn: steer (引导) or queue (排队).
    const existing = active.get(threadId);
    if (existing) {
      if (policy === 'steer' && existing.run) {
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

    await withTrace({ chatId: msg.chatId, msgId: msg.messageId }, async () => {
      const thread = await resolveThread(threadId, msg.chatId);
      if (!thread) {
        // Unknown topic (e.g. created before this bridge, or store lost): treat
        // as a fresh session bound to the resolved cwd.
        const project = await getProjectByChatId(msg.chatId);
        const cwd = project?.cwd ?? fallbackCwd;
        const fresh = await backend.startThread({ cwd });
        sessions.set(threadId, fresh);
        await upsertSession({
          threadId,
          chatId: msg.chatId,
          cwd,
          codexThreadId: fresh.codexThreadId,
          summary: text.slice(0, 80),
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
        await launchRun({ chatId: msg.chatId, replyTo: msg.messageId, thread: fresh, firstText: text, knownThreadId: threadId });
        return;
      }
      await launchRun({ chatId: msg.chatId, replyTo: msg.messageId, thread, firstText: text, knownThreadId: threadId });
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

  async function postConfigCard(msg: NormalizedMessage, text: string): Promise<void> {
    await withTrace({ chatId: msg.chatId, msgId: msg.messageId }, async () => {
      const project = await getProjectByChatId(msg.chatId);
      const cwd = project?.cwd ?? fallbackCwd;
      // lazy banner branch refresh (design §3.2) — best-effort, non-blocking
      if (project) void refreshBranch(channel, project).catch(() => undefined);
      const [models, branch] = await Promise.all([listModels(), currentBranch(cwd)]);
      const { model, effort } = pickDefault(models);
      const state: SessionConfigState = {
        chatId: msg.chatId,
        originalMsgId: msg.messageId,
        requesterOpenId: msg.senderId,
        text,
        cwd,
        projectName: project?.name,
        branch: branch ?? undefined,
        models,
        model,
        effort,
        mode: 'config',
      };
      const res = await channel.send(
        msg.chatId,
        { card: buildSessionConfigCard(state) },
        { replyTo: msg.messageId },
      );
      pending.set(res.messageId, state);
      log.info('card', 'config', { project: project?.name ?? '(unregistered)', model, effort });
    });
  }

  // ── card actions ──────────────────────────────────────────────────
  const dispatcher = new CardDispatcher(channel, cfg);

  function refresh(cardMsgId: string, state: SessionConfigState): Promise<void> {
    return channel.updateCard(cardMsgId, buildSessionConfigCard(state)).catch(() => undefined) as Promise<void>;
  }

  dispatcher
    .on(SC.model, async ({ evt, option }) => {
      const state = pending.get(evt.messageId);
      if (!state || !option) return;
      state.model = option;
      // re-pick a valid effort if the new model doesn't support the current one
      const m = state.models.find((x) => x.id === option);
      if (m && m.supportedEfforts.length && !m.supportedEfforts.includes(state.effort)) {
        state.effort = m.defaultEffort;
      }
      await refresh(evt.messageId, state);
    })
    .on(SC.effort, async ({ evt, option }) => {
      const state = pending.get(evt.messageId);
      if (!state || !option) return;
      state.effort = option as ReasoningEffort;
      await refresh(evt.messageId, state);
    })
    .on(SC.resume, async ({ evt }) => {
      const state = pending.get(evt.messageId);
      if (!state) return;
      state.mode = 'resume';
      state.threads = await backend.listThreads(state.cwd);
      await refresh(evt.messageId, state);
    })
    .on(SC.back, async ({ evt }) => {
      const state = pending.get(evt.messageId);
      if (!state) return;
      state.mode = 'config';
      await refresh(evt.messageId, state);
    })
    .on(SC.create, async ({ evt }) => {
      const state = pending.get(evt.messageId);
      if (!state) return;
      pending.delete(evt.messageId);
      await channel.updateCard(evt.messageId, buildConfigDoneCard(state, 'created')).catch(() => undefined);
      const thread = await backend.startThread({ cwd: state.cwd, model: state.model, effort: state.effort });
      log.info('card', 'launch', { kind: 'create', model: state.model, effort: state.effort });
      await launchSessionFromCard(state, thread, 'created');
    })
    .on(SC.pick, async ({ evt, value }) => {
      const state = pending.get(evt.messageId);
      const codexThreadId = typeof value.t === 'string' ? value.t : undefined;
      if (!state || !codexThreadId) return;
      pending.delete(evt.messageId);
      await channel.updateCard(evt.messageId, buildConfigDoneCard(state, 'resumed')).catch(() => undefined);
      const thread = await backend.resumeThread({
        cwd: state.cwd,
        codexThreadId,
        model: state.model,
        effort: state.effort,
      });
      log.info('card', 'launch', { kind: 'resume', codexThreadId });
      await launchSessionFromCard(state, thread, 'resumed');
    });

  // run card buttons (design §3.3)
  dispatcher
    .on(RC.stop, async ({ evt, value }) => {
      const key = typeof value.m === 'string' ? value.m : evt.messageId;
      const st = runsByCard.get(key);
      const tid = st?.run?.turnId();
      if (st && tid) {
        await st.thread.abort(tid).catch(() => undefined);
        log.info('card', 'action', { actionId: 'run.stop', aborted: tid });
      }
    })
    .on(RC.settings, async ({ evt }) => {
      const rc = runCards.get(evt.messageId);
      if (!rc) return;
      rc.expanded = !rc.expanded;
      rc.settingsNote = undefined;
      if (rc.expanded) {
        rc.models = await listModels();
        if (rc.cwd) rc.branch = (await currentBranch(rc.cwd)) ?? undefined;
      }
      await channel.updateCard(evt.messageId, buildRunCard(rc)).catch(() => undefined);
    })
    .on(RC.model, async ({ evt, option }) => {
      const rc = runCards.get(evt.messageId);
      if (!rc || !option) return;
      rc.model = option;
      const m = rc.models?.find((x) => x.id === option);
      if (m && m.supportedEfforts.length && rc.effort && !m.supportedEfforts.includes(rc.effort)) {
        rc.effort = m.defaultEffort;
      }
      if (rc.threadId) await patchSession(rc.threadId, { model: rc.model, effort: rc.effort });
      rc.settingsNote = `✅ 已切换模型「${m?.displayName ?? option}」，下一轮生效`;
      await channel.updateCard(evt.messageId, buildRunCard(rc)).catch(() => undefined);
    })
    .on(RC.effort, async ({ evt, option }) => {
      const rc = runCards.get(evt.messageId);
      if (!rc || !option) return;
      rc.effort = option as ReasoningEffort;
      if (rc.threadId) await patchSession(rc.threadId, { effort: rc.effort });
      rc.settingsNote = `✅ 已设置 effort，下一轮生效`;
      await channel.updateCard(evt.messageId, buildRunCard(rc)).catch(() => undefined);
    });

  /** Create the topic (reply_in_thread) and run the first turn from a config card. */
  async function launchSessionFromCard(
    state: SessionConfigState,
    thread: AgentThread,
    _kind: 'created' | 'resumed',
  ): Promise<void> {
    await withTrace({ chatId: state.chatId, msgId: state.originalMsgId }, async () => {
      const firstText = state.text || '你好，我们开始吧。';
      await launchRun({
        chatId: state.chatId,
        replyTo: state.originalMsgId,
        replyInThread: true,
        thread,
        firstText,
        model: state.model,
        effort: state.effort,
        cwd: state.cwd,
        summary: state.text.slice(0, 80) || '(空)',
      });
    });
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
  }

  async function launchRun(opts: LaunchOpts): Promise<void> {
    const release = await sema.acquire();
    let activeKey = opts.knownThreadId ?? `pending:${opts.replyTo}`;
    let topicThreadId = opts.knownThreadId;
    const state: ActiveState = { thread: opts.thread, queue: [] };
    active.set(activeKey, state);
    if (opts.knownThreadId) sessions.set(opts.knownThreadId, opts.thread);
    const models = modelsCache ?? (await listModels());

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
        if (prevState) void channel.updateCard(prev, buildRunCardPlain(prevState)).catch(() => undefined);
        runCards.delete(prev);
      }
      lastRunCard.set(topicThreadId, cardMsgId);
      runCards.set(cardMsgId, rc);
    };

    try {
      let turnText = opts.firstText;
      let replyTo = opts.replyTo;
      let replyInThread = opts.replyInThread ?? Boolean(opts.knownThreadId);
      for (;;) {
        // per-turn model/effort: prefer latest persisted (⚙️ may have changed it)
        const rec = topicThreadId ? await getSession(topicThreadId) : undefined;
        const turnModel = rec?.model ?? opts.model;
        const turnEffort = rec?.effort ?? opts.effort;
        const run = state.thread.runStreamed({ text: turnText }, { model: turnModel, effort: turnEffort });
        state.run = run;
        const render = new RunRender();
        let terminal: RunStatus = 'done';
        let cardMsgId: string | undefined;
        const rc: RunCardState = { body: '', status: 'running', model: turnModel, effort: turnEffort, cwd: opts.cwd, models };

        const adoptThreadId = async (messageId: string): Promise<void> => {
          if (activeKey.startsWith('pending:')) {
            const tid = await getThreadId(channel, messageId);
            if (tid) {
              active.delete(activeKey);
              active.set(tid, state);
              sessions.set(tid, state.thread);
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

        const res = await channel.stream(
          opts.chatId,
          {
            card: {
              initial: buildRunCard(rc),
              producer: async (ctrl) => {
                cardMsgId = ctrl.messageId;
                rc.cardKey = ctrl.messageId;
                runsByCard.set(ctrl.messageId, state);
                await adoptThreadId(ctrl.messageId);
                await ctrl.update(buildRunCard(rc));

                const guarded = withIdleTimeout(run.events, idleMs, () => {
                  terminal = 'timeout';
                  const tid = run.turnId();
                  if (tid) void state.thread.abort(tid).catch(() => undefined);
                });
                for await (const ev of guarded) {
                  if (ev.type === 'error') terminal = 'error';
                  render.apply(ev);
                  rc.body = render.markdown();
                  await ctrl.update(buildRunCard(rc));
                }
                if (terminal === 'timeout') {
                  render.apply({ type: 'error', message: '⏱ 似乎卡住了（无响应），已中止，可重试', willRetry: false });
                }
                rc.body = render.markdown();
                rc.status = terminal === 'timeout' ? 'timeout' : render.state() === 'error' ? 'error' : 'done';
                await ctrl.update(buildRunCard(rc));
              },
            },
          },
          { replyTo, replyInThread },
        );

        const finalMsgId = cardMsgId ?? res.messageId;
        await adoptThreadId(finalMsgId);
        // re-render terminal card now that threadId is known (adds ⚙️)
        rc.cardKey = finalMsgId;
        await channel.updateCard(finalMsgId, buildRunCard(rc)).catch(() => undefined);
        if (cardMsgId) runsByCard.delete(cardMsgId);
        promoteCard(finalMsgId, rc);
        if (topicThreadId) await patchSession(topicThreadId, { updatedAt: Date.now() });
        replyTo = finalMsgId;
        replyInThread = true; // stay in the topic for queued turns
        log.info('card', 'final', { terminal });

        if (state.queue.length === 0) break;
        turnText = state.queue.shift()!;
      }
    } catch (err) {
      log.fail('intake', err);
      await channel
        .send(opts.chatId, { markdown: `❌ ${err instanceof Error ? err.message : String(err)}` }, { replyTo: opts.replyTo, replyInThread: true })
        .catch(() => undefined);
    } finally {
      active.delete(activeKey);
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
    return items?.[0]?.thread_id;
  } catch {
    return undefined;
  }
}
