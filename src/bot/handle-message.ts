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
} from '../config/schema';
import { saveConfig } from '../config/store';
import { CardDispatcher } from '../card/dispatcher';
import { sendManagedCard, updateManagedCard } from '../card/managed';
import { RunRender } from '../card/run-render';
import {
  buildConfigDoneCard,
  buildConfigErrorCard,
  buildConfigLaunchingCard,
  buildSessionConfigCard,
  SC,
  type SessionConfigState,
} from '../card/session-config-card';
import { buildRunCard, buildRunCardPlain, RC, type RunCardState, type RunStatus } from '../card/run-card';
import { log, withTrace } from '../core/logger';
import {
  buildDmMenuCard,
  buildGroupsCard,
  buildNewProjectHintCard,
  buildProjectListCard,
  buildRmConfirmCard,
  buildSettingsCard,
  DM,
} from '../card/dm-cards';
import { currentBranch } from '../project/git-info';
import { getProjectByChatId, listProjects, removeProject } from '../project/registry';
import { refreshBranch } from '../project/banner';
import { listBotGroups, transferOwnership } from '../project/group-ops';
import { getSession, patchSession, upsertSession } from './session-store';
import { handleDmConsole } from './dm-console';
import { Semaphore, withIdleTimeout } from './watchdog';

interface ActiveState {
  thread: AgentThread;
  run?: AgentRun;
  queue: string[];
  /** who started this run — gates destructive ⏹ (design §5) */
  requesterOpenId?: string;
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
  // pendingPolicy is read per-message (settings card can change it live)
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
      if (getPendingPolicy(cfg) === 'steer' && existing.run) {
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
        await launchRun({ chatId: msg.chatId, replyTo: msg.messageId, thread: fresh, firstText: text, knownThreadId: threadId, requesterOpenId: msg.senderId });
        return;
      }
      await launchRun({ chatId: msg.chatId, replyTo: msg.messageId, thread, firstText: text, knownThreadId: threadId, requesterOpenId: msg.senderId });
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
        createdAt: Date.now(),
      };
      // CardKit entity so the model/effort/create/resume buttons can update it
      // in place (raw-JSON cards flash and revert on click).
      const res = await sendManagedCard(channel, msg.chatId, buildSessionConfigCard(state), msg.messageId);
      prunePending();
      pending.set(res.messageId, state);
      log.info('card', 'config', { project: project?.name ?? '(unregistered)', model, effort });
    });
  }

  // ── card actions ──────────────────────────────────────────────────
  const dispatcher = new CardDispatcher(channel, cfg);
  const PENDING_TTL_MS = 30 * 60_000; // abandoned config cards expire after 30 min

  // A card update issued from inside a cardAction handler must land AFTER the
  // callback's HTTP-200 ack — Feishu locks the card during the click's
  // interaction window and reverts any concurrent/earlier update to the
  // pre-click state (official "处理卡片回调"; cardkit err 200810; the symptom is
  // the card flashing then snapping back). So handlers return immediately
  // (letting the SDK ack) and we apply the update detached, after a short
  // settle. Cards must be CardKit entities (sendManagedCard) for the update to
  // target them — im.v1.message.patch only does "unconditional" updates.
  const CARD_SETTLE_MS = 500;
  const settleUpdate = (msgId: string, c: object): void => {
    void (async () => {
      await new Promise((r) => setTimeout(r, CARD_SETTLE_MS));
      await updateManagedCard(channel, msgId, c);
    })();
  };

  function prunePending(): void {
    const now = Date.now();
    for (const [k, s] of pending) if (now - s.createdAt > PENDING_TTL_MS) pending.delete(k);
  }

  /**
   * Resolve + authorize a config-card action. Only the original requester may
   * act on their card (design §5); the chat/user must still be allowed; expired
   * cards are dropped. Returns undefined (and ignores the action) otherwise.
   */
  function authConfig(evt: CardActionEvent): SessionConfigState | undefined {
    const state = pending.get(evt.messageId);
    if (!state) return undefined;
    if (Date.now() - state.createdAt > PENDING_TTL_MS) {
      pending.delete(evt.messageId);
      return undefined;
    }
    const op = evt.operator?.openId ?? '';
    if (op !== state.requesterOpenId || !isChatAllowed(cfg, state.chatId) || !isUserAllowed(cfg, op)) {
      log.info('card', 'action-denied', { actionId: evt.action?.value && 'cfg', reason: 'not-allowed' });
      return undefined;
    }
    return state;
  }

  function refresh(cardMsgId: string, state: SessionConfigState): void {
    settleUpdate(cardMsgId, buildSessionConfigCard(state));
  }

  dispatcher
    .on(SC.model, async ({ evt, option }) => {
      const state = authConfig(evt);
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
      const state = authConfig(evt);
      if (!state || !option) return;
      state.effort = option as ReasoningEffort;
      await refresh(evt.messageId, state);
    })
    .on(SC.resume, async ({ evt }) => {
      const state = authConfig(evt);
      if (!state) return;
      state.mode = 'resume';
      state.threads = await backend.listThreads(state.cwd);
      await refresh(evt.messageId, state);
    })
    .on(SC.back, async ({ evt }) => {
      const state = authConfig(evt);
      if (!state) return;
      state.mode = 'config';
      state.launching = false;
      await refresh(evt.messageId, state);
    })
    .on(SC.create, async ({ evt }) => {
      const state = authConfig(evt);
      if (!state || state.launching) return;
      state.launching = true;
      settleUpdate(evt.messageId, buildConfigLaunchingCard(state, 'created'));
      // detach: don't hold the cardAction callback for the whole Codex run
      void launchFromCard(evt, state, 'created', () =>
        backend.startThread({ cwd: state.cwd, model: state.model, effort: state.effort }),
      );
    })
    .on(SC.pick, async ({ evt, value }) => {
      const state = authConfig(evt);
      const codexThreadId = typeof value.t === 'string' ? value.t : undefined;
      if (!state || !codexThreadId || state.launching) return;
      state.launching = true;
      settleUpdate(evt.messageId, buildConfigLaunchingCard(state, 'resumed'));
      void launchFromCard(evt, state, 'resumed', () =>
        backend.resumeThread({ cwd: state.cwd, codexThreadId, model: state.model, effort: state.effort }),
      );
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

  // run card buttons (design §3.3)
  dispatcher
    .on(RC.stop, async ({ evt, value }) => {
      const key = typeof value.m === 'string' ? value.m : evt.messageId;
      const st = runsByCard.get(key);
      if (!st || !runOwnerOrAdmin(evt, st.requesterOpenId)) return;
      const tid = st.run?.turnId();
      if (tid) {
        await st.thread.abort(tid).catch(() => undefined);
        log.info('card', 'action', { actionId: 'run.stop', aborted: tid });
      }
    })
    .on(RC.settings, async ({ evt }) => {
      const rc = runCards.get(evt.messageId);
      if (!rc || !runOwnerOrAdmin(evt, rc.requesterOpenId)) return;
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
      if (!rc || !option || !runOwnerOrAdmin(evt, rc.requesterOpenId)) return;
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
      if (!rc || !option || !runOwnerOrAdmin(evt, rc.requesterOpenId)) return;
      rc.effort = option as ReasoningEffort;
      if (rc.threadId) await patchSession(rc.threadId, { effort: rc.effort });
      rc.settingsNote = `✅ 已设置 effort，下一轮生效`;
      await channel.updateCard(evt.messageId, buildRunCard(rc)).catch(() => undefined);
    });

  // DM management console buttons (design §3.1). Admin-gated; sub-views patch
  // the same card in place, each carrying a ⬅️ 菜单 back button.
  const dmAdmin = (openId?: string): boolean => isAdmin(cfg, openId ?? '');
  // DM cards are CardKit entities (sendManagedCard); update them via the
  // settle-then-cardkit path so the click's callback acks first.
  const patch = (msgId: string, c: object): void => settleUpdate(msgId, c);

  async function applyPref(evt: CardActionEvent, mut: (p: AppPreferences) => void): Promise<void> {
    if (!dmAdmin(evt.operator?.openId)) return;
    const prefs: AppPreferences = { ...(cfg.preferences ?? {}) };
    mut(prefs);
    cfg.preferences = prefs;
    await saveConfig(cfg).catch((err) => log.fail('console', err, { phase: 'save-config' }));
    await patch(evt.messageId, buildSettingsCard(cfg));
  }

  dispatcher
    .on(DM.menu, async ({ evt }) => {
      if (dmAdmin(evt.operator?.openId)) await patch(evt.messageId, buildDmMenuCard());
    })
    .on(DM.newProject, async ({ evt }) => {
      if (dmAdmin(evt.operator?.openId)) await patch(evt.messageId, buildNewProjectHintCard());
    })
    .on(DM.projects, async ({ evt }) => {
      if (!dmAdmin(evt.operator?.openId)) return;
      await patch(evt.messageId, buildProjectListCard(await listProjects()));
    })
    .on(DM.settings, async ({ evt }) => {
      if (dmAdmin(evt.operator?.openId)) await patch(evt.messageId, buildSettingsCard(cfg));
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
      await patch(evt.messageId, buildRmConfirmCard(name));
    })
    .on(DM.rmCancel, async ({ evt }) => {
      if (!dmAdmin(evt.operator?.openId)) return;
      await patch(evt.messageId, buildProjectListCard(await listProjects()));
    })
    .on(DM.rmDo, async ({ evt, value }) => {
      const name = typeof value.n === 'string' ? value.n : undefined;
      const op = evt.operator?.openId;
      if (!dmAdmin(op) || !name) return;
      const removed = await removeProject(name);
      // revoke the pinned banner (best-effort); never delete the code dir
      if (removed?.bannerMessageId) {
        await channel.rawClient.im.v1.pin
          .delete({ path: { message_id: removed.bannerMessageId } })
          .catch(() => undefined);
      }
      // bot owns the group → transfer ownership to the admin so they can disband
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
      await patch(evt.messageId, buildProjectListCard(await listProjects()));
    })
    .on(DM.groups, async ({ evt }) => {
      if (!dmAdmin(evt.operator?.openId)) return;
      const groups = await listBotGroups(channel).catch((err) => {
        log.fail('console', err, { phase: 'list-groups' });
        return [];
      });
      await patch(evt.messageId, buildGroupsCard(groups, evt.operator?.name));
    })
    .on(DM.transferOwner, async ({ evt, value }) => {
      const chatId = typeof value.c === 'string' ? value.c : undefined;
      const op = evt.operator?.openId;
      if (!dmAdmin(op) || !chatId || !op) return;
      const ok = await transferOwnership(channel, chatId, op)
        .then(() => true)
        .catch((err) => {
          log.fail('console', err, { phase: 'owner-transfer' });
          return false;
        });
      await channel
        .send(
          evt.chatId,
          {
            markdown: ok
              ? '✅ 群主已转给你。现在去那个群 → 设置 → **解散群聊**。'
              : '❌ 转让失败（可能 bot 不是该群群主，或缺 im:chat 权限）。',
          },
          { replyTo: evt.messageId },
        )
        .catch(() => undefined);
      const groups = await listBotGroups(channel).catch(() => []);
      await patch(evt.messageId, buildGroupsCard(groups, evt.operator?.name));
    })
    .on(DM.setTools, async ({ evt, option }) => {
      await applyPref(evt, (p) => (p.showToolCalls = option === 'on'));
    })
    .on(DM.setWatchdog, async ({ evt, option }) => {
      const n = Number(option);
      if (Number.isFinite(n)) await applyPref(evt, (p) => (p.runIdleTimeoutSeconds = n));
    })
    .on(DM.setPending, async ({ evt, option }) => {
      if (option === 'steer' || option === 'queue') await applyPref(evt, (p) => (p.pendingPolicy = option));
    })
    .on(DM.setConcurrency, async ({ evt, option }) => {
      const n = Number(option);
      if (Number.isFinite(n)) await applyPref(evt, (p) => (p.maxConcurrentRuns = n));
    });

  /**
   * From a config card: build the codex thread, then create the topic + run.
   * The config card is only finalized to "done" once the first topic card is
   * confirmed sent (onFirstCard); any failure before that keeps the pending
   * state and shows a retryable error card. Detached — never holds the
   * card-action callback for the whole run.
   */
  async function launchFromCard(
    evt: CardActionEvent,
    state: SessionConfigState,
    kind: 'created' | 'resumed',
    makeThread: () => Promise<AgentThread>,
  ): Promise<void> {
    let thread: AgentThread | undefined;
    try {
      thread = await makeThread();
      log.info('card', 'launch', { kind, model: state.model, effort: state.effort });
      await launchSessionFromCard(state, thread, () => {
        pending.delete(evt.messageId);
        void updateManagedCard(channel, evt.messageId, buildConfigDoneCard(state, kind));
      });
    } catch (err) {
      state.launching = false; // keep pending → card stays retryable
      log.fail('card', err, { phase: `${kind}-launch` });
      if (thread) void thread.close().catch(() => undefined);
      await updateManagedCard(channel, evt.messageId, buildConfigErrorCard(state, err instanceof Error ? err.message : String(err)));
    }
  }

  /** Create the topic (reply_in_thread) and run the first turn from a config card. */
  async function launchSessionFromCard(
    state: SessionConfigState,
    thread: AgentThread,
    onFirstCard: () => void,
  ): Promise<void> {
    await withTrace({ chatId: state.chatId, msgId: state.originalMsgId }, async () => {
      const firstText = state.text || '你好，我们开始吧。';
      await launchRun(
        {
          chatId: state.chatId,
          replyTo: state.originalMsgId,
          replyInThread: true,
          thread,
          firstText,
          model: state.model,
          effort: state.effort,
          cwd: state.cwd,
          summary: state.text.slice(0, 80) || '(空)',
          requesterOpenId: state.requesterOpenId,
        },
        onFirstCard,
      );
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
    /** who triggered this run (for ⏹/⚙️ ownership gating) */
    requesterOpenId?: string;
  }

  async function launchRun(opts: LaunchOpts, onFirstCard?: () => void): Promise<void> {
    const release = await sema.acquire();
    let firstCardSent = false;
    let activeKey = opts.knownThreadId ?? `pending:${opts.replyTo}`;
    let topicThreadId = opts.knownThreadId;
    const state: ActiveState = { thread: opts.thread, queue: [], requesterOpenId: opts.requesterOpenId };
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

    // tracks the latest run card key so the finally can clear runsByCard even
    // if the stream producer throws mid-turn (avoids leaking a stale stop target)
    let curCardKey: string | undefined;
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
        render.showTools = getShowToolCalls(cfg);
        let terminal: RunStatus = 'done';
        let cardMsgId: string | undefined;
        const rc: RunCardState = { body: '', status: 'running', model: turnModel, effort: turnEffort, cwd: opts.cwd, models, requesterOpenId: opts.requesterOpenId };

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
                curCardKey = ctrl.messageId;
                rc.cardKey = ctrl.messageId;
                runsByCard.set(ctrl.messageId, state);
                // first topic card is now live → let the config card finalize
                if (!firstCardSent) {
                  firstCardSent = true;
                  try {
                    onFirstCard?.();
                  } catch {
                    /* config-card finalize is best-effort */
                  }
                }
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
      // Config-card launches (onFirstCard set): if we failed before the first
      // card was sent (e.g. reply_in_thread couldn't create the topic), rethrow
      // so the caller shows a retryable error card. `finally` still runs cleanup
      // below, so don't release here (would double-release the semaphore).
      if (!firstCardSent && onFirstCard) throw err;
      log.fail('intake', err);
      await channel
        .send(opts.chatId, { markdown: `❌ ${err instanceof Error ? err.message : String(err)}` }, { replyTo: opts.replyTo, replyInThread: true })
        .catch(() => undefined);
    } finally {
      active.delete(activeKey);
      if (curCardKey) runsByCard.delete(curCardKey);
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
