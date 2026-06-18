import type { LarkChannel } from '@larksuiteoapi/node-sdk';
import type { CardDispatcher } from '../card/dispatcher';
import { getCliBridgePreferences, resolveCliBridgeTarget, type AppConfig } from '../config/schema';
import { log } from '../core/logger';
import { sendManagedCard, updateManagedCard } from '../card/managed';
import { startCliBridgeIpcServer, type CliBridgeIpcServer } from './ipc';
import { buildCliBridgeApprovalCard, buildCliBridgeAwayNoticeCard, buildCliBridgeQuestionCard, buildCliBridgeTaskCompletionCard, CLI, questionChoiceField, questionCustomField } from './cards';
import { extractAskUserQuestion } from './parser';
import {
  createPendingCliInteraction,
  findPendingCliInteractionByMessageReply,
  getPendingCliInteraction,
  resolvePendingCliInteraction,
  setPendingCliMessageId,
  waitForPendingCliInteraction,
} from './store';
import { resolveCliLocalActivity, resolveCliPresenceRoute, type CliPresenceRoute } from './presence';
import { createKeepAwakeController, type KeepAwakeController } from './keep-awake';
import type { CliHookMessage, CliHookResponse } from './types';

// Marks a task_completion resolved by the user clicking 等待确认: resolveAction
// already re-rendered that card, so handleMessage's post-wait close skips it to
// avoid a duplicate update. Internal-only — buildHookStdout ignores `reason`.
const TASK_DONE_CLICKED = 'task_done_clicked';
// Marks a wait released because the user came back to the local machine. Drives
// the post-wait card close; carried on a fallback_local so the terminal regains
// its own prompt. Internal-only — buildHookStdout ignores `reason`.
const LOCAL_RETURN = 'local_return';

/** The subset of {@link CliBridgeService} the orchestrator consumes: a card-action
 *  registrar and a p2p-reply consumer (Stop 续聊). Exported as the single source of
 *  truth so handle-message imports it rather than redeclaring it (which would let
 *  the two shapes drift); structural so bridge.ts can pass the full service without
 *  a circular import. */
export interface CliBridgeRuntimeHooks {
  onMessage: (msg: { parentId?: string; rootId?: string; text?: string; messageId?: string }) => boolean;
  register: (dispatcher: CardDispatcher) => void;
  start?: () => Promise<void>;
  shutdown?: () => Promise<void>;
}

export interface CliBridgeService extends CliBridgeRuntimeHooks {
  start: () => Promise<void>;
  shutdown: () => Promise<void>;
  handleMessage: (msg: CliHookMessage) => Promise<CliHookResponse>;
  resolveAction: (action: { id?: string; actionId: string; label?: string; answer?: string }) => boolean;
  resolveQuestionSubmit: (id: string, formValue: Record<string, unknown>) => boolean;
  resolveReply: (reply: { parentId?: string; rootId?: string; text?: string; messageId?: string }) => boolean;
}

export function createCliBridgeService(opts: {
  cfg: AppConfig;
  channel: LarkChannel;
  socketPath: string;
  presence?: () => Promise<CliPresenceRoute>;
  localActivity?: () => Promise<boolean>;
  localReturnPollMs?: number;
  /** Resolve whether a hook's cwd belongs to a registered project — gates the
   *  'bound_projects' notify scope. Omitted (e.g. in tests) ⇒ fail open (notify). */
  isBoundProject?: (cwd: string) => boolean | Promise<boolean>;
  /** Keep-awake controller (caffeinate). Defaults to one gated on keepAwake.enabled. */
  keepAwake?: KeepAwakeController;
}): CliBridgeService {
  let ipc: CliBridgeIpcServer | undefined;
  const allowedSessions = new Set<string>();
  const prefs = () => getCliBridgePreferences(opts.cfg);
  const hasCustomPresence = Boolean(opts.presence);
  const presence = opts.presence ?? (() => resolveCliPresenceRoute(prefs()));
  const localActivity = opts.localActivity ?? (hasCustomPresence
    ? async () => !(await presence()).routeToFeishu
    : async () => (await resolveCliLocalActivity(prefs())).localActive);
  const localReturnPollMs = opts.localReturnPollMs ?? 5000;
  const keepAwake = opts.keepAwake ?? createKeepAwakeController({ enabled: () => prefs().keepAwake.enabled });

  // notify-scope gate (applies once we'd otherwise forward to Feishu): 'none'
  // swallows everything, 'bound_projects' forwards only cwds under a registered
  // project. No resolver injected ⇒ fail open, mirroring the away_only philosophy
  // of never silently dropping a notification.
  async function notifyAllowedForCwd(cwd: string): Promise<boolean> {
    const scope = prefs().notifyScope;
    if (scope === 'none') return false;
    if (scope === 'bound_projects') return opts.isBoundProject ? Boolean(await opts.isBoundProject(cwd)) : true;
    return true;
  }
  const sessionKey = (input: { source: string; sessionId: string }): string => `${input.source}:${input.sessionId}`;
  const sendOwnerCard = (target: { receiveIdType: 'open_id'; receiveId: string }, cardObject: object) =>
    sendManagedCard(opts.channel, target.receiveId, cardObject, undefined, false, target.receiveIdType);

  // Mirror the group-chat "Typing" reaction for Stop 续聊: when the owner replies to a
  // completion card and we hand it back to the local agent, stamp 🫳 Typing on their
  // reply message; drop it the moment the continuation's result arrives (next
  // task_complete). Best-effort — a mock channel / missing reactions scope just no-ops.
  let replyReaction: { messageId: string; idPromise: Promise<string | undefined> } | undefined;
  async function addTypingReaction(messageId: string): Promise<string | undefined> {
    try {
      const r = await opts.channel.rawClient.im.v1.messageReaction.create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: 'Typing' } },
      });
      return (r as { data?: { reaction_id?: string } }).data?.reaction_id;
    } catch (err) {
      log.fail('cli-bridge', err, { phase: 'reply-typing-add' });
      return undefined;
    }
  }
  function armReplyTypingReaction(messageId: string): void {
    clearReplyTypingReaction();
    replyReaction = { messageId, idPromise: addTypingReaction(messageId) };
  }
  function clearReplyTypingReaction(): void {
    const r = replyReaction;
    replyReaction = undefined;
    if (!r) return;
    void r.idPromise
      .then((id) => {
        if (!id) return undefined;
        return opts.channel.rawClient.im.v1.messageReaction
          .delete({ path: { message_id: r.messageId, reaction_id: id } })
          .catch((err) => log.fail('cli-bridge', err, { phase: 'reply-typing-del' }));
      })
      .catch(() => {});
  }

  // One-time-per-away-period heads-up that closes the “did it even notice I left?”
  // gap: sent right before the first forwarded card of an away period. The caller
  // only invokes it on a genuine 'away' route (not the win32 fail-open, where we
  // don't actually know you left). markLocalActive() resets it on return so each
  // fresh away period re-announces. Set the flag synchronously before awaiting the
  // send so two near-simultaneous forwards can't double-announce.
  let awayNoticeSent = false;
  const markLocalActive = (): void => { awayNoticeSent = false; };
  async function ensureAwayNoticeSent(target: { receiveIdType: 'open_id'; receiveId: string }, msg: CliHookMessage): Promise<void> {
    if (awayNoticeSent) return;
    awayNoticeSent = true;
    await sendOwnerCard(target, buildCliBridgeAwayNoticeCard({ source: msg.source, cwd: msg.cwd, key: msg.sessionId })).catch((err) =>
      log.fail('cli-bridge', err, { phase: 'away-notice' }),
    );
  }

  const updatePendingCard = (pending: NonNullable<ReturnType<typeof getPendingCliInteraction>>, cardObject: object): void => {
    if (!pending.messageId) return;
    void updateManagedCard(opts.channel, pending.messageId, cardObject).catch((err) =>
      log.fail('cli-bridge', err, { phase: 'update-card' }),
    );
  };

  const closeCard = (messageId: string, cardObject: object, phase: string): void => {
    void updateManagedCard(opts.channel, messageId, cardObject).catch((err) =>
      log.fail('cli-bridge', err, { phase }),
    );
  };

  // Re-render a pending interaction's Feishu card straight from the stored record,
  // so the send / approve / deny / close paths don't each re-spell the builder args
  // (and silently drift). `overrides` carries the per-call bits not on the record:
  // status transitions, the allow-session affordance, and reply-window state.
  function renderPendingCard(
    pending: NonNullable<ReturnType<typeof getPendingCliInteraction>>,
    overrides: {
      status?: 'approved' | 'denied' | 'local';
      allowSession?: boolean;
      answers?: Record<string, string>;
      replyEnabled?: boolean;
      replyExpiresAt?: number;
      replyDoneAt?: number;
    } = {},
  ): object {
    if (pending.kind === 'permission') {
      return buildCliBridgeApprovalCard({
        id: pending.id,
        source: pending.source,
        cwd: pending.cwd,
        toolName: pending.toolName,
        command: pending.command,
        hookEventName: pending.hookEventName,
        sessionId: pending.sessionId,
        createdAt: pending.createdAt,
        allowSession: overrides.allowSession,
        status: overrides.status,
      });
    }
    if (pending.kind === 'question') {
      return buildCliBridgeQuestionCard({
        id: pending.id,
        source: 'claude',
        cwd: pending.cwd,
        questions: pending.questions ?? [],
        hookEventName: pending.hookEventName,
        createdAt: pending.createdAt,
        status: overrides.status,
        answers: overrides.answers,
      });
    }
    return buildCliBridgeTaskCompletionCard({
      id: pending.id,
      source: pending.source,
      cwd: pending.cwd,
      sessionId: pending.sessionId,
      hookEventName: pending.hookEventName,
      status: pending.taskStatus ?? 'completed',
      summary: pending.summary,
      replyEnabled: overrides.replyEnabled ?? false,
      replyExpiresAt: overrides.replyExpiresAt,
      replyDoneAt: overrides.replyDoneAt,
      createdAt: pending.createdAt,
    });
  }

  // 所有飞书等待都必须可被本地活动打断：人回到本机或继续在 CLI 输入时，立刻把终端
  // 控制权还回去，别让本地 CLI 一直挂在远端回复上。区别在“怎么还”：
  //   - task_complete → allow（让 Stop 正常结束）；
  //   - 审批/问答     → fallback_local（不自动放行，交回终端弹本地提示，安全）。
  // 调用方据 onLocalReturn 决定语义，并在命中本地回归时收尾对应卡片。
  async function waitWithLocalReturn(id: string, timeoutMs: number, onLocalReturn: CliHookResponse): Promise<CliHookResponse> {
    const waiter = waitForPendingCliInteraction(id, timeoutMs);
    const checkLocalReturn = () => {
      void localActivity()
        .then((active) => {
          if (!active) return;
          markLocalActive();
          if (getPendingCliInteraction(id)) resolvePendingCliInteraction(id, onLocalReturn);
        })
        .catch(() => {});
    };
    checkLocalReturn();
    const poll = setInterval(checkLocalReturn, localReturnPollMs);
    // We only reach here when away (route → Feishu) with a local agent blocked on
    // a Feishu wait. Hold a keep-awake assertion for exactly this window so the
    // Mac doesn't idle-sleep mid-wait (which would stall the bot from receiving
    // your reply and the agent from continuing). Released the instant the wait
    // ends — resolve / local-return / timeout — via finally.
    keepAwake.acquire();
    try {
      return await waiter;
    } finally {
      clearInterval(poll);
      keepAwake.release();
    }
  }

  async function handleMessage(msg: CliHookMessage): Promise<CliHookResponse> {
    const p = prefs();
    if (!p.enabled || !p.agents[msg.source]) return { decision: 'fallback_local', reason: 'disabled' };
    if (msg.bridgeOwned && !p.includeBridgeOwnedSessionsForDebugging) {
      return { decision: 'fallback_local', reason: 'bridge_owned_session' };
    }
    if (msg.type === 'post_tool_use') return { decision: 'allow' };
    const route = await presence();
    // Diagnostic: every forwarded hook arrival + how presence routed it. Lets us tell,
    // e.g., whether a Codex 续聊 result fired a 2nd Stop at all, and if so whether it was
    // handed back local (you'd returned to the keyboard) vs forwarded (away).
    log.info('cli-bridge', 'hook-recv', {
      type: msg.type,
      source: msg.source,
      event: msg.hookEventName,
      stopHookActive: msg.stopHookActive === true,
      route: route.reason,
    });
    // Back at the keyboard ⇒ arm the away heads-up to fire again next time we leave.
    if (route.reason === 'local_active') markLocalActive();

    if (msg.type === 'task_complete') {
      // This Stop is the continuation's result → drop the 🫳 Typing we put on the
      // owner's reply (no-op if there was no续聊 reply pending).
      clearReplyTypingReaction();
      // NB: 不因 stop_hook_active 提前 return。stop_hook_active=true 正是“用户从飞书回复→
      // 续聊”之后的那次 Stop——它的结果必须再发回飞书并再开一轮回复窗口，否则多轮对话在
      // 第一次回复后就断了（结果只留在终端）。不会死循环：本桥只在用户显式回复时才回
      // block+reason，无回复就超时 allow 让 Stop 正常结束，故续聊轮数恒由用户行为收敛。
      if (!p.taskCompletion.enabled) return { decision: 'fallback_local', reason: 'task_completion_disabled' };
      // away_only：人在本机敲键盘时（route 仍指向本地）就别打扰飞书，让 Stop 静默正常
      // 结束，与下面的权限/问答分支一致。只有判定“离开”才转发完成卡。
      if (!route.routeToFeishu) return { decision: 'fallback_local', reason: route.reason };
      if (!(await notifyAllowedForCwd(msg.cwd))) return { decision: 'fallback_local', reason: 'notify_scope' };
      const target = resolveCliBridgeTarget(opts.cfg);
      if (!target) return { decision: 'fallback_local', reason: 'missing_owner' };
      // route.routeToFeishu 已保证为 true（away）；仍复查 localActivity 以覆盖 presence()
      // 到此刻之间人刚回到本机的窗口——此时不开续聊，只发一张不带回复入口的完成卡。
      const canReplyFromFeishu = p.taskCompletion.replyEnabled && !(await localActivity());
      const replyExpiresAt = canReplyFromFeishu
        ? Date.now() + p.taskCompletion.replyTimeoutSeconds * 1000
        : undefined;
      // Only track a pending interaction when a reply can continue the session;
      // with reply disabled for the current local state nothing ever resolves it,
      // so registering one would leak into the store and falsely match later replies.
      const pending = canReplyFromFeishu
        ? createPendingCliInteraction({
            kind: 'task_completion',
            source: msg.source,
            sessionId: msg.sessionId,
            cwd: msg.cwd,
            hookEventName: msg.hookEventName,
            taskStatus: msg.taskStatus ?? 'completed',
            summary: msg.summary,
            replyExpiresAt,
          })
        : undefined;
      if (route.reason === 'away') await ensureAwayNoticeSent(target, msg);
      const sent = await sendOwnerCard(
        target,
        buildCliBridgeTaskCompletionCard({
          id: pending?.id ?? '',
          source: msg.source,
          cwd: msg.cwd,
          sessionId: msg.sessionId,
          hookEventName: msg.hookEventName,
          status: msg.taskStatus ?? 'completed',
          summary: msg.summary,
          replyEnabled: canReplyFromFeishu,
          replyExpiresAt,
          createdAt: pending?.createdAt,
        }),
      );
      if (!pending) return { decision: 'allow' };
      setPendingCliMessageId(pending.id, sent.messageId);
      const result = await waitWithLocalReturn(pending.id, p.taskCompletion.replyTimeoutSeconds * 1000, { decision: 'allow' });
      // 回复窗口结束（续聊回复 / 本机回归 / 超时）。把卡片刷成无按钮的收尾态，否则
      // “等待确认”按钮会一直挂着，点了也已无对应 pending。点“等待确认”自行结束的那条
      // 已由 resolveAction 改过卡（标记 TASK_DONE_CLICKED），这里跳过免重复刷。
      if (result.reason !== TASK_DONE_CLICKED) {
        closeCard(sent.messageId, renderPendingCard(pending), 'close-task-card');
      }
      return result;
    }

    if (!route.routeToFeishu) return { decision: 'fallback_local', reason: route.reason };
    const target = resolveCliBridgeTarget(opts.cfg);
    if (!target) return { decision: 'fallback_local', reason: 'missing_owner' };

    // 结构化选择卡仅 Claude 支持，且仅此一处入口。Codex 故意不进：其 request_user_input
    // 被源码锁在 Plan 模式（默认模式运行时直接拒绝），所以默认模式下 Codex 只会把问题当
    // 纯文字输出、根本不发结构化工具调用；即便 Plan 模式，Codex 的 PermissionRequest hook
    // 输出也只支持 systemMessage、无法像 Claude 那样回灌 updatedInput 答案。故 Codex 的问答
    // 一律走 Stop → 完成卡（文字 + 回复作答）这条已能闭环的路径，不在此特化。
    if (msg.source === 'claude' && msg.toolName === 'AskUserQuestion') {
      // 问答会真正转发一张卡 → 受通知范围网关约束（与下面的权限卡一致）。
      if (!(await notifyAllowedForCwd(msg.cwd))) return { decision: 'fallback_local', reason: 'notify_scope' };
      const ask = extractAskUserQuestion(msg.toolInput);
      if (!ask) return { decision: 'fallback_local', reason: 'unsupported_ask_user_question' };
      const pending = createPendingCliInteraction({
        kind: 'question',
        source: msg.source,
        sessionId: msg.sessionId,
        cwd: msg.cwd,
        questions: ask.questions,
        // First question text doubles as the reply-match anchor / log label.
        question: ask.questions[0]?.question,
        hookEventName: msg.hookEventName,
        toolInput: msg.toolInput,
      });
      if (route.reason === 'away') await ensureAwayNoticeSent(target, msg);
      const sent = await sendOwnerCard(target, renderPendingCard(pending));
      setPendingCliMessageId(pending.id, sent.messageId);
      const result = await waitWithLocalReturn(
        pending.id,
        p.approval.timeoutSeconds * 1000,
        { decision: 'fallback_local', reason: LOCAL_RETURN },
      );
      if (result.reason === LOCAL_RETURN) {
        closeCard(sent.messageId, renderPendingCard(pending, { status: 'local' }), 'close-question-card');
      }
      return result;
    }

    if (!p.approval.enabled) return { decision: 'fallback_local', reason: 'approval_disabled' };
    // 「本会话放行」是静默放行、不发任何卡 → 不算通知，故须在通知范围网关之前判定：否则
    // 中途把范围收窄会把已整会话放行的会话降级成本地终端再弹审批（人不在 → 卡住）。
    if (p.allowCache.enabled && allowedSessions.has(sessionKey(msg))) return { decision: 'allow' };
    // 权限卡会真正转发通知 → 按通知范围拦截。
    if (!(await notifyAllowedForCwd(msg.cwd))) return { decision: 'fallback_local', reason: 'notify_scope' };

    const command = typeof msg.toolInput.command === 'string' ? msg.toolInput.command : undefined;
    const pending = createPendingCliInteraction({
      kind: 'permission',
      source: msg.source,
      sessionId: msg.sessionId,
      cwd: msg.cwd,
      toolName: msg.toolName,
      command,
      hookEventName: msg.hookEventName,
      question: 'Permission request',
    });
    if (route.reason === 'away') await ensureAwayNoticeSent(target, msg);
    const sent = await sendOwnerCard(target, renderPendingCard(pending, { allowSession: p.allowCache.enabled }));
    setPendingCliMessageId(pending.id, sent.messageId);
    const result = await waitWithLocalReturn(
      pending.id,
      p.approval.timeoutSeconds * 1000,
      { decision: 'fallback_local', reason: LOCAL_RETURN },
    );
    if (result.reason === LOCAL_RETURN) {
      closeCard(sent.messageId, renderPendingCard(pending, { status: 'local' }), 'close-approval-card');
    }
    return result;
  }

  function resolveAction(action: { id?: string; actionId: string; label?: string; answer?: string }): boolean {
    if (!action.id) return false;
    if (action.actionId === CLI.approveOnce) {
      const pending = getPendingCliInteraction(action.id);
      if (!pending || pending.kind !== 'permission') return false;
      updatePendingCard(pending, renderPendingCard(pending, { status: 'approved' }));
      return resolvePendingCliInteraction(action.id, { decision: 'allow' });
    }
    if (action.actionId === CLI.approveSession) {
      const pending = getPendingCliInteraction(action.id);
      if (!pending || pending.kind !== 'permission') return false;
      updatePendingCard(pending, renderPendingCard(pending, { status: 'approved' }));
      const ok = resolvePendingCliInteraction(action.id, { decision: 'allow' });
      if (ok && prefs().allowCache.enabled) allowedSessions.add(sessionKey(pending));
      return ok;
    }
    if (action.actionId === CLI.deny) {
      const pending = getPendingCliInteraction(action.id);
      if (!pending || pending.kind !== 'permission') return false;
      updatePendingCard(pending, renderPendingCard(pending, { status: 'denied' }));
      return resolvePendingCliInteraction(action.id, { decision: 'deny', interrupt: true, reason: 'Denied from Feishu' });
    }
    if (action.actionId === CLI.taskCompletionDone) {
      const pending = getPendingCliInteraction(action.id);
      if (!pending || pending.kind !== 'task_completion') return false;
      updatePendingCard(pending, renderPendingCard(pending, { replyDoneAt: Date.now() }));
      return resolvePendingCliInteraction(action.id, { decision: 'allow', reason: TASK_DONE_CLICKED });
    }
    return false;
  }

  // The multi-question form's single ✅ 提交: collect every question's answer from
  // form_value in one shot. Per question, a filled free-text box wins over the
  // dropdown (the "都不合适，自己写" path); a multi-select dropdown comes back as an
  // array → joined with 、 (matches Claude/Codex's multi-answer join).
  function resolveQuestionSubmit(id: string, formValue: Record<string, unknown>): boolean {
    const pending = getPendingCliInteraction(id);
    if (!pending || pending.kind !== 'question') return false;
    const questions = pending.questions ?? [];
    const answers: Record<string, string> = {};
    questions.forEach((q, i) => {
      const custom = String(formValue[questionCustomField(i)] ?? '').trim();
      if (custom) { answers[q.question] = custom; return; }
      const choice = formValue[questionChoiceField(i)];
      if (Array.isArray(choice)) {
        const picked = choice.map((c) => String(c).trim()).filter(Boolean);
        if (picked.length) answers[q.question] = picked.join('、');
      } else if (typeof choice === 'string' && choice.trim()) {
        answers[q.question] = choice.trim();
      }
    });
    // Empty submit → leave the card live so it never answers for the user.
    if (Object.keys(answers).length === 0) return false;
    updatePendingCard(pending, renderPendingCard(pending, { status: 'approved', answers }));
    return resolvePendingCliInteraction(id, {
      decision: 'allow',
      // 必须保留原始 toolInput（含 questions），仅追加 answers——否则 Claude Code
      // 用 updatedInput 整体替换入参后 questions 变 undefined，渲染时崩 "H.map"。
      updatedInput: { ...(pending.toolInput ?? {}), answers },
    });
  }

  function resolveReply(reply: { parentId?: string; rootId?: string; text?: string; messageId?: string }): boolean {
    const pending = findPendingCliInteractionByMessageReply(reply);
    const text = reply.text?.trim();
    // {decision:'block', reason} is the Stop-hook continuation contract for BOTH
    // Claude Code and Codex (verified against OpenAI's Codex hooks docs): the agent
    // turns `reason` into a fresh user prompt. reason must be non-empty — the `!text`
    // guard guarantees that.
    if (!pending || pending.kind !== 'task_completion' || !text) return false;
    const ok = resolvePendingCliInteraction(pending.id, { decision: 'allow', stdout: JSON.stringify({ decision: 'block', reason: text }) });
    // Acknowledge on the owner's reply that we took it and handed it to the agent;
    // cleared when the continuation's result card arrives (next task_complete).
    if (ok && reply.messageId) armReplyTypingReaction(reply.messageId);
    return ok;
  }

  return {
    start: async () => {
      if (ipc) return;
      ipc = await startCliBridgeIpcServer({ socketPath: opts.socketPath, handleMessage });
      log.info('cli-bridge', 'started', { socketPath: opts.socketPath });
    },
    shutdown: async () => {
      await ipc?.close();
      ipc = undefined;
      allowedSessions.clear();
      keepAwake.shutdown();
    },
    handleMessage,
    resolveAction,
    resolveQuestionSubmit,
    resolveReply,
    onMessage: (msg) => {
      const reply = { parentId: msg.parentId, rootId: msg.rootId, text: msg.text, messageId: msg.messageId };
      if (resolveReply(reply)) return true;
      // A text reply aimed at a still-pending approval/question card (or a blank
      // reply to a completion card) shouldn't fall through to handleDmConsole and
      // pop an unrelated 菜单 card next to the live one — swallow it. The card's own
      // buttons remain the way to act; the stray reply is just dropped here.
      return Boolean(findPendingCliInteractionByMessageReply(reply));
    },
    register: (dispatcher) => {
      dispatcher
        .on(CLI.approveOnce, ({ value }) => { resolveAction({ actionId: CLI.approveOnce, id: String(value.id ?? '') }); })
        .on(CLI.approveSession, ({ value }) => { resolveAction({ actionId: CLI.approveSession, id: String(value.id ?? '') }); })
        .on(CLI.deny, ({ value }) => { resolveAction({ actionId: CLI.deny, id: String(value.id ?? '') }); })
        .on(CLI.taskCompletionDone, ({ value }) => {
          resolveAction({ actionId: CLI.taskCompletionDone, id: String(value.id ?? '') });
        })
        .on(CLI.questionSubmit, ({ value, formValue }) => {
          resolveQuestionSubmit(String(value.id ?? ''), formValue ?? {});
        });
    },
  };
}

export function shouldStartCliBridge(cfg: AppConfig): boolean {
  const prefs = getCliBridgePreferences(cfg);
  return prefs.enabled && Boolean(resolveCliBridgeTarget(cfg));
}
