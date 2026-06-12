import type { LarkChannel } from '@larksuiteoapi/node-sdk';
import type { CardDispatcher } from '../card/dispatcher';
import { getCliBridgePreferences, resolveCliBridgeTarget, type AppConfig } from '../config/schema';
import { log } from '../core/logger';
import { sendManagedCard, updateManagedCard } from '../card/managed';
import { startCliBridgeIpcServer, type CliBridgeIpcServer } from './ipc';
import { buildCliBridgeApprovalCard, buildCliBridgeQuestionCard, buildCliBridgeQuestionCustomCard, buildCliBridgeTaskCompletionCard, CLI } from './cards';
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
  onMessage: (msg: { parentId?: string; rootId?: string; text?: string }) => boolean;
  register: (dispatcher: CardDispatcher) => void;
  start?: () => Promise<void>;
  shutdown?: () => Promise<void>;
}

export interface CliBridgeService extends CliBridgeRuntimeHooks {
  start: () => Promise<void>;
  shutdown: () => Promise<void>;
  handleMessage: (msg: CliHookMessage) => Promise<CliHookResponse>;
  resolveAction: (action: { id?: string; actionId: string; label?: string; answer?: string }) => boolean;
  resolveReply: (reply: { parentId?: string; rootId?: string; text?: string }) => boolean;
}

export function createCliBridgeService(opts: {
  cfg: AppConfig;
  channel: LarkChannel;
  socketPath: string;
  presence?: () => Promise<CliPresenceRoute>;
  localActivity?: () => Promise<boolean>;
  localReturnPollMs?: number;
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
  const sessionKey = (input: { source: string; sessionId: string }): string => `${input.source}:${input.sessionId}`;
  const sendOwnerCard = (target: { receiveIdType: 'open_id'; receiveId: string }, cardObject: object) =>
    sendManagedCard(opts.channel, target.receiveId, cardObject, undefined, false, target.receiveIdType);

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
      selectedOptionLabel?: string;
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
        question: pending.question || 'question',
        options: pending.options ?? [],
        header: pending.header,
        hookEventName: pending.hookEventName,
        createdAt: pending.createdAt,
        status: overrides.status,
        selectedOptionLabel: overrides.selectedOptionLabel,
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
          if (active && getPendingCliInteraction(id)) {
            resolvePendingCliInteraction(id, onLocalReturn);
          }
        })
        .catch(() => {});
    };
    checkLocalReturn();
    const poll = setInterval(checkLocalReturn, localReturnPollMs);
    try {
      return await waiter;
    } finally {
      clearInterval(poll);
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

    if (msg.type === 'task_complete') {
      if (msg.stopHookActive) return { decision: 'allow', reason: 'stop_hook_active' };
      if (!p.taskCompletion.enabled) return { decision: 'fallback_local', reason: 'task_completion_disabled' };
      // away_only：人在本机敲键盘时（route 仍指向本地）就别打扰飞书，让 Stop 静默正常
      // 结束，与下面的权限/问答分支一致。只有判定“离开”才转发完成卡。
      if (!route.routeToFeishu) return { decision: 'fallback_local', reason: route.reason };
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

    if (msg.source === 'claude' && msg.toolName === 'AskUserQuestion') {
      const ask = extractAskUserQuestion(msg.toolInput);
      if (!ask) return { decision: 'fallback_local', reason: 'unsupported_ask_user_question' };
      const pending = createPendingCliInteraction({
        kind: 'question',
        source: msg.source,
        sessionId: msg.sessionId,
        cwd: msg.cwd,
        question: ask.question,
        options: ask.options,
        header: ask.header,
        hookEventName: msg.hookEventName,
        toolInput: msg.toolInput,
      });
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
    if (p.allowCache.enabled && allowedSessions.has(sessionKey(msg))) return { decision: 'allow' };

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
    const answer = action.actionId === CLI.questionOption ? action.label
      : action.actionId === CLI.questionCustomSubmit ? action.answer
        : undefined;
    if (answer) {
      const pending = getPendingCliInteraction(action.id);
      if (!pending || pending.kind !== 'question') return false;
      const question = pending.question || 'question';
      updatePendingCard(pending, renderPendingCard(pending, { status: 'approved', selectedOptionLabel: answer }));
      return resolvePendingCliInteraction(action.id, {
        decision: 'allow',
        // 必须保留原始 toolInput（含 questions），仅追加 answers——否则 Claude Code
        // 用 updatedInput 整体替换入参后 questions 变 undefined，渲染时崩 "H.map"。
        updatedInput: { ...(pending.toolInput ?? {}), answers: { [question]: answer } },
      });
    }
    return false;
  }

  function resolveReply(reply: { parentId?: string; rootId?: string; text?: string }): boolean {
    const pending = findPendingCliInteractionByMessageReply(reply);
    const text = reply.text?.trim();
    // {decision:'block', reason} is the Stop-hook continuation contract for BOTH
    // Claude Code and Codex (verified against OpenAI's Codex hooks docs): the agent
    // turns `reason` into a fresh user prompt. reason must be non-empty — the `!text`
    // guard guarantees that.
    if (!pending || pending.kind !== 'task_completion' || !text) return false;
    return resolvePendingCliInteraction(pending.id, { decision: 'allow', stdout: JSON.stringify({ decision: 'block', reason: text }) });
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
    },
    handleMessage,
    resolveAction,
    resolveReply,
    onMessage: (msg) => {
      const reply = { parentId: msg.parentId, rootId: msg.rootId, text: msg.text };
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
        .on(CLI.questionOption, ({ value }) => {
          resolveAction({
            actionId: CLI.questionOption,
            id: String(value.id ?? ''),
            label: typeof value.label === 'string' ? value.label : undefined,
          });
        })
        .on(CLI.questionCustom, async ({ value }) => {
          // Open the free-text form in-place. If the original CardKit mapping was
          // lost across restart, fall back to a fresh card so the user still has a
          // way to answer.
          const id = String(value.id ?? '');
          const pending = getPendingCliInteraction(id);
          const target = resolveCliBridgeTarget(opts.cfg);
          if (!pending || pending.kind !== 'question' || !target) return;
          const cardObject = buildCliBridgeQuestionCard({
            id,
            source: 'claude',
            cwd: pending.cwd,
            question: pending.question ?? 'Custom answer',
            options: pending.options ?? [],
            header: pending.header,
            hookEventName: pending.hookEventName,
            createdAt: pending.createdAt,
            awaitingText: true,
          });
          if (pending.messageId && await updateManagedCard(opts.channel, pending.messageId, cardObject)) return;
          await sendOwnerCard(target, buildCliBridgeQuestionCustomCard({ id, question: pending.question ?? 'Custom answer' }));
        })
        .on(CLI.questionCustomSubmit, ({ value, formValue }) => {
          resolveAction({
            actionId: CLI.questionCustomSubmit,
            id: String(value.id ?? ''),
            answer: typeof formValue?.answer === 'string' ? formValue.answer : undefined,
          });
        });
    },
  };
}

export function shouldStartCliBridge(cfg: AppConfig): boolean {
  const prefs = getCliBridgePreferences(cfg);
  return prefs.enabled && Boolean(resolveCliBridgeTarget(cfg));
}
