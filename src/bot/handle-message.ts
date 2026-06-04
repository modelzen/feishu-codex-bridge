import type { BotAddedEvent, CardActionEvent, CommentEvent, LarkChannel, NormalizedMessage } from '@larksuiteoapi/node-sdk';
import { createBackend } from '../agent';
import type { AgentInput, AgentRun, AgentThread, ModelInfo, ReasoningEffort } from '../agent/types';
import {
  getMaxConcurrentRuns,
  getPendingPolicy,
  getRunIdleTimeoutMs,
  getShowToolCalls,
  isAdmin,
  isChatAllowed,
  isUserAllowed,
  secretKeyForApp,
  type AppConfig,
  type AppPreferences,
  type PendingPolicy,
} from '../config/schema';
import { saveConfig } from '../config/store';
import { CardDispatcher } from '../card/dispatcher';
import { sendManagedCard, updateManagedCard } from '../card/managed';
import { RunRender } from '../card/run-render';
import { finalMessageText, initialState, reduce, type RunState } from '../card/run-state';
import {
  buildHelpCard,
  buildModelCard,
  buildResumeCard,
  buildResumeDoneCard,
  buildResumeErrorCard,
  buildResumeLaunchingCard,
  EFFORT_LABEL,
  MC,
  RES,
  type HelpScope,
  type ModelCardState,
  type ResumeCardState,
} from '../card/command-cards';
import { buildHistoryCard, type HistoryCardState } from '../card/history-card';
import { ANSWER_EID, buildRunCard, buildRunCardPlain, RC, type RunCardState } from '../card/run-card';
import { RunCardStream } from '../card/run-card-stream';
import { buildCleanCard, extractCardFences } from '../card/markdown-render';
import { imageSources, uploadOutboundImages } from '../card/outbound-images';
import { log, withTrace } from '../core/logger';
import {
  buildDmMenuCard,
  buildDoctorCard,
  buildGroupSettingsCard,
  buildJoinGroupFormCard,
  buildNewProjectDoneCard,
  buildNewProjectFormCard,
  buildProjectListCard,
  buildRmConfirmCard,
  buildSettingsCard,
  buildUpdateCard,
  DM,
  GS,
  type DoctorInfo,
} from '../card/dm-cards';
import {
  currentVersion,
  daemonRunning,
  installLatest,
  isDevSource,
  isNewer,
  latestVersion,
  restartDaemon,
} from '../service/update';
import { resolveCodexBin, codexVersion } from '../agent/codex-appserver/locate';
import { serviceStdoutPath, serviceStderrPath } from '../service/launchd';
import { bridgeVersion } from '../core/version';
import { paths } from '../config/paths';
import { getSecret } from '../config/keystore';
import { buildScopeGrantUrl, JOIN_GROUP_SCOPES } from '../config/scopes';
import { validateAppCredentials } from '../utils/feishu-auth';
import {
  defaultNoMention,
  getProjectByChatId,
  listProjects,
  removeProject,
  updateProject,
  type Project,
} from '../project/registry';
import { createProject, joinExistingGroup } from '../project/lifecycle';
import { refreshBranch } from '../project/announcement';
import { leaveChat, transferOwnership } from '../project/group-ops';
import { getSession, listSessions, patchSession, upsertSession, type SessionRecord } from './session-store';
import { handleDmConsole } from './dm-console';
import { collectInboundImages, messageHasImages } from './media';
import {
  addCommentReaction,
  buildCommentPrompt,
  postCommentReply,
  removeCommentReaction,
  REPLY_MAX_CHARS,
  resolveComment,
  stripMarkdown,
  SUPPORTED_FILE_TYPES,
} from './comments';
import { Semaphore, withIdleTimeout } from './watchdog';

interface ActiveState {
  /** unset only during the brief "reserved, still resolving the thread" window */
  thread?: AgentThread;
  run?: AgentRun;
  /** follow-up turns queued mid-run; each carries its own text + downloaded images */
  queue: AgentInput[];
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

type SlashCommand = 'resume' | 'model' | 'effort' | 'settings' | 'help';

const FALLBACK_EFFORTS: ReasoningEffort[] = ['low', 'medium', 'high', 'xhigh'];
const ALL_EFFORTS: ReasoningEffort[] = ['none', 'minimal', ...FALLBACK_EFFORTS];

export interface Orchestrator {
  onMessage: (msg: NormalizedMessage) => Promise<void>;
  /** `comment` event handler: @bot in a cloud-doc comment → reply in-thread. */
  onComment: (evt: CommentEvent) => Promise<void>;
  /** `botAdded` event: a human added the bot to a group → DM the (admin) adder
   * a bind card to register it as a `joined` project. */
  onBotAddedToChat: (evt: BotAddedEvent) => Promise<void>;
  /** bot removed from a group (im.chat.member.bot.deleted_v1, tapped on the raw
   * dispatcher) → auto-unbind the bound project, if any. */
  onBotRemovedFromChat: (chatId: string) => Promise<void>;
  dispatcher: CardDispatcher;
  /** Close every live codex session (SIGKILLs the app-server children) so a
   *  graceful exit leaves no orphan processes. */
  shutdown: () => Promise<void>;
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
  /** Per-doc serialization for comment runs (see {@link withDocLock}). */
  const docLocks = new Map<string, Promise<void>>();
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

  function effortOptionsForModel(models: ModelInfo[], modelId: string): ReasoningEffort[] {
    const model = models.find((m) => m.id === modelId);
    return model?.supportedEfforts.length ? model.supportedEfforts : FALLBACK_EFFORTS;
  }

  function formatEfforts(efforts: ReasoningEffort[]): string {
    return efforts.map((e) => `\`${e}\`${EFFORT_LABEL[e] ? `（${EFFORT_LABEL[e]}）` : ''}`).join(' / ');
  }

  function parseEffortArg(text: string): string | undefined {
    return /^\/effort(?:\s+(\S+))?/i.exec(text.trim())?.[1]?.toLowerCase();
  }

  function normalizeEffort(raw: string | undefined): ReasoningEffort | undefined {
    if (!raw) return undefined;
    return ALL_EFFORTS.includes(raw as ReasoningEffort) ? (raw as ReasoningEffort) : undefined;
  }

  // Feishu gives bots no way to mark a message "已读" (read receipts are a
  // human-client signal), so a reaction stands in for one. Best-effort — a
  // missing im:message.reactions:write_only scope just means no reaction appears.
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

    // The bot is in a group not bound to any project (e.g. it was just added and
    // the admin hasn't finished binding in DM yet). Don't run codex in the
    // fallback cwd for an unbound group — only nudge toward binding when @ed.
    if (!project) {
      log.info('intake', 'unbound-group', { chatId: msg.chatId.slice(-6), atBot: msg.mentionedBot });
      if (msg.mentionedBot) {
        await channel
          .send(
            msg.chatId,
            { markdown: '本群还没绑定为项目。请**把我拉进群的管理员**在与我的私聊里完成绑定后再 @我。' },
            { replyTo: msg.messageId },
          )
          .catch(() => undefined);
      }
      return;
    }

    const text = msg.content.trim();
    const cmd = parseCommand(text);

    // Single-session group: the whole group is one session keyed by chatId. No
    // topics — reply by quoting (引用回复); runs serialize per chatId (active[chatId]).
    // Commands: /settings (群设置) + /model. /resume has no topic list here.
    if ((project?.kind ?? 'multi') === 'single') {
      if (cmd === 'help') {
        await postHelpCard(msg, 'single', false, project);
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
      if (cmd === 'effort') {
        await postEffortCommand(msg, msg.chatId, false);
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
        await postHelpCard(msg, 'topic', true, project);
        return;
      }
      if (cmd === 'model') {
        await postModelCard(msg, msg.threadId);
        return;
      }
      if (cmd === 'effort') {
        await postEffortCommand(msg, msg.threadId, true);
        return;
      }
      handleTurn(msg, text, msg.threadId, false, project);
      return;
    }
    // Main group area: /resume opens the history picker; /settings opens the
    // group-settings card; /model only makes sense inside a topic; anything else
    // directly creates a topic + runs.
    if (cmd === 'help') {
      await postHelpCard(msg, 'main', false, project);
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
    if (cmd === 'effort') {
      await channel
        .send(msg.chatId, { markdown: '`/effort` 需要在话题里使用（先 @我 开个话题）。' }, { replyTo: msg.messageId })
        .catch(() => undefined);
      return;
    }
    startTopicDirectly(msg, text, project);
  };

  /** Parse a leading slash command (`/resume`, `/model`, `/effort`, `/settings`); null otherwise. */
  function parseCommand(text: string): SlashCommand | null {
    const m = /^\/(\w+)/.exec(text);
    const name = m?.[1]?.toLowerCase();
    return name === 'resume' || name === 'model' || name === 'effort' || name === 'settings' || name === 'help'
      ? name
      : null;
  }

  /** Whether to respond to a non-@ message in a project group (免@ default on).
   * single: whole group. multi: inside a topic, OR a slash command in the main
   * area — plain chatter in the main area still needs @ (开新话题 是明确意图，
   * 不能让随便一句话就开话题)，but explicit commands (/help /resume /settings
   * /model) respond without @ since they're unambiguous intent.
   * 即使开了免@，若消息 @了所有人 或 @了具体的(非机器人)用户,说明是定向给别人的,
   * bot 不插话。(此函数仅在 !mentionedBot 时调用,故 @到 bot 的情况已被排除。) */
  function shouldRespondWithoutMention(project: Project, msg: NormalizedMessage): boolean {
    if (!(project.noMention ?? defaultNoMention(project))) return false;
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
      // Download any images first (best-effort) so the steered/queued turn can
      // carry them. Awaited here — the session is already held by a running
      // turn, so there's no reservation race to protect; gated on
      // messageHasImages so the common text path stays await-free and fast.
      const images = messageHasImages(msg) ? await collectInboundImages(channel, msg) : undefined;
      // The turn may have finished while images downloaded — re-read the session.
      // If it's gone, start a fresh run (carrying the images we already fetched).
      const cur = active.get(sessionKey);
      if (!cur) {
        startReservedRun(msg, text, sessionKey, flat, project, images);
        return;
      }
      if (getPendingPolicy(cfg) === 'steer' && cur.run && cur.thread) {
        const tid = cur.run.turnId();
        if (tid) {
          try {
            await cur.thread.steer({ text, images }, tid);
            log.info('intake', 'steer', { tid, images: images?.length ?? 0 });
            return;
          } catch (err) {
            log.warn('intake', 'steer-failed', { err: String(err) });
          }
        }
      }
      cur.queue.push({ text, images });
      log.info('intake', 'queued', { depth: cur.queue.length });
      return;
    }

    startReservedRun(msg, text, sessionKey, flat, project);
  }

  /**
   * Reserve `sessionKey` synchronously (before any await) so a second message
   * racing in through the SDK's per-chatId queue sees it and queues instead of
   * double-launching — including a message whose image download just finished
   * and discovered the prior run had ended (handleTurn's fall-through). The
   * synchronous check-then-set is the critical section; everything slow (image
   * download, thread resolution, the codex run) runs **detached** so onMessage
   * returns fast — holding the chatId queue would block sibling topics and the
   * ⏹ card-action (design: 话题=独立 session，应并行).
   */
  function startReservedRun(
    msg: NormalizedMessage,
    text: string,
    sessionKey: string,
    flat: boolean,
    project?: Project,
    preloadedImages?: string[],
  ): void {
    const existing = active.get(sessionKey);
    if (existing) {
      // A run appeared between handleTurn's check and here (we awaited an image
      // download) — queue onto it rather than launch a second turn.
      existing.queue.push({ text, images: preloadedImages });
      log.info('intake', 'queued', { depth: existing.queue.length });
      return;
    }
    const reserved: ActiveState = { queue: [], requesterOpenId: msg.senderId };
    active.set(sessionKey, reserved);
    void withTrace({ chatId: msg.chatId, msgId: msg.messageId }, async () => {
      const reaction = runReaction(msg.messageId, !sema.hasFree());
      try {
        // Images preloaded by handleTurn's fall-through, else fetch them now
        // (inside the detached run, after the synchronous reservation).
        const images =
          preloadedImages ?? (messageHasImages(msg) ? await collectInboundImages(channel, msg) : undefined);
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
            images,
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
      // Download any attached/forwarded images so the opening turn can see them.
      const images = messageHasImages(msg) ? await collectInboundImages(channel, msg) : undefined;
      log.info('card', 'start', { project: project?.name ?? '(unregistered)', model, effort, images: images?.length ?? 0 });
      await launchRun(
        {
          chatId: msg.chatId,
          replyTo: msg.messageId,
          replyInThread: true,
          thread,
          firstText,
          images,
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

  /** `/effort [level]`: text shortcut for changing only the current session's reasoning effort. */
  async function postEffortCommand(msg: NormalizedMessage, sessionKey: string, inThread: boolean): Promise<void> {
    await withTrace({ chatId: msg.chatId, msgId: msg.messageId }, async () => {
      const [models, rec] = await Promise.all([listModels(), getSession(sessionKey)]);
      const def = pickDefault(models);
      const model = rec?.model ?? def.model;
      const current = rec?.effort ?? def.effort;
      const supported = effortOptionsForModel(models, model);
      const raw = parseEffortArg(msg.content);
      const reply = (markdown: string): Promise<void> =>
        channel
          .send(msg.chatId, { markdown }, { replyTo: msg.messageId, replyInThread: inThread })
          .then(() => undefined)
          .catch(() => undefined);

      if (!raw) {
        await reply(
          `当前模型：\`${model}\`\n` +
            `当前 effort：\`${current}\`${EFFORT_LABEL[current] ? `（${EFFORT_LABEL[current]}）` : ''}\n` +
            `可用：${formatEfforts(supported)}\n` +
            '用法：`/effort high`',
        );
        return;
      }

      const requested = raw === 'default' || raw === 'reset' ? def.effort : normalizeEffort(raw);
      if (!requested) {
        await reply(`未知 effort：\`${raw}\`。\n可用：${formatEfforts(supported)}`);
        return;
      }
      if (!supported.includes(requested)) {
        await reply(`当前模型 \`${model}\` 不支持 effort \`${requested}\`。\n可用：${formatEfforts(supported)}`);
        return;
      }
      if (!rec) {
        await reply('当前会话还没有完成初始化；请先让会话完成第一轮回复，再设置 `/effort`。');
        return;
      }

      await patchSession(sessionKey, { effort: requested });
      await reply(`✅ 已设置 effort：\`${requested}\`${EFFORT_LABEL[requested] ? `（${EFFORT_LABEL[requested]}）` : ''}，下一轮生效。`);
      log.info('card', 'effort', { threadId: sessionKey, effort: requested });
    });
  }

  /** `/help`: post the command cheat-sheet for the caller's current scope. */
  async function postHelpCard(
    msg: NormalizedMessage,
    scope: HelpScope,
    inThread = false,
    project?: Project,
  ): Promise<void> {
    const noMention = project ? (project.noMention ?? defaultNoMention(project)) : true;
    await withTrace({ chatId: msg.chatId, msgId: msg.messageId }, async () => {
      await sendManagedCard(channel, msg.chatId, buildHelpCard(scope, noMention), msg.messageId, inThread).catch((err) =>
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
    .on(DM.joinGroupSubmit, ({ evt, formValue, value }) => {
      const op = evt.operator?.openId;
      if (!dmAdmin(op)) return;
      const name = String((formValue?.name as string) ?? '').trim();
      const cwdIn = String((formValue?.cwd as string) ?? '').trim();
      const chatId = typeof value.chatId === 'string' ? value.chatId : '';
      const kind: 'multi' | 'single' = value.kind === 'single' ? 'single' : 'multi';
      // Same fresh-card pattern as DM.newProjectSubmit: a submitted form locks
      // its card_id, so the result goes to a new card while the form stays above
      // as a 留痕. Detached so the click acks immediately (join is slow).
      void (async () => {
        let result;
        if (!chatId)
          result = buildJoinGroupFormCard({ chatId: '', name, cwd: cwdIn, error: '缺少群标识，请重新从进群通知里打开绑定卡' });
        else if (!name) result = buildJoinGroupFormCard({ chatId, cwd: cwdIn, error: '项目名不能为空' });
        else if (!op) result = buildJoinGroupFormCard({ chatId, name, cwd: cwdIn, error: '无法识别操作者身份' });
        else {
          try {
            const p = await joinExistingGroup(channel, { name, chatId, addedBy: op, existingPath: cwdIn || undefined, kind });
            log.info('console', 'join-group', { name: p.name, blank: p.blank });
            result = buildNewProjectDoneCard(p);
          } catch (err) {
            result = buildJoinGroupFormCard({ chatId, name, cwd: cwdIn, error: err instanceof Error ? err.message : String(err) });
          }
        }
        await sendManagedCard(channel, evt.chatId, result).catch((e) =>
          log.fail('console', e, { phase: 'join-group-result' }),
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
      const codexBin = resolveCodexBin();
      // 飞书权限自检：读 keystore 里的 App Secret → 换 tenant_access_token → 查已开通
      // scope（application/v6/scopes 的 grant_status，含 im:message.group_msg 等事件订阅
      // 类）。任一步失败时 missingScopes 留 undefined，卡片显示「无法自动检查」而非误报
      // 缺失。复用 onboarding 同一条校验路径，单一事实源。
      const app = cfg.accounts.app;
      const secret = await getSecret(secretKeyForApp(app.id)).catch(() => undefined);
      const scopeCheck = secret
        ? await validateAppCredentials(app.id, secret, app.tenant).catch(() => undefined)
        : undefined;
      const missingScopes = scopeCheck?.missingScopes;
      const missingJoinScopes = scopeCheck?.missingJoinScopes;
      const info: DoctorInfo = {
        codexOk: await backend.isAvailable().catch(() => false),
        codexVer: codexBin ? codexVersion(codexBin) : null,
        conn: channel.getConnectionStatus?.()?.state ?? 'unknown',
        bridgeVer: bridgeVersion(),
        node: process.version,
        platform: `${process.platform}-${process.arch}`,
        logStdout: serviceStdoutPath(),
        logStderr: serviceStderrPath(),
        configFile: paths.configFile,
        missingScopes,
        // 缺失时预选缺失项（精准开通）；查不到/全开通时预选全部必需 scope 供核对。
        scopeGrantUrl: buildScopeGrantUrl(
          app.id,
          app.tenant,
          missingScopes && missingScopes.length ? missingScopes : undefined,
        ),
        missingJoinScopes,
        // 「加入存量群」按钮恒预选这两项 opt-in scope（它们不在必需清单里）。
        joinScopeGrantUrl: buildScopeGrantUrl(app.id, app.tenant, JOIN_GROUP_SCOPES),
      };
      // A reply card (not a patch of the menu) so the diagnosis persists below
      // the console; re-open the menu by messaging the bot.
      await sendManagedCard(channel, evt.chatId, buildDoctorCard(info), evt.messageId).catch((err) =>
        log.fail('console', err, { cmd: 'doctor' }),
      );
    })
    .on(DM.reconnect, async ({ evt }) => {
      if (!dmAdmin(evt.operator?.openId)) return;
      const conn = channel.getConnectionStatus?.()?.state ?? 'unknown';
      await channel
        .send(evt.chatId, { markdown: `🔄 长连接状态：**${conn}**\nSDK 会自动重连；若长期断开，请在终端重跑 \`feishu-codex-bridge run\`（前台）或 \`feishu-codex-bridge restart\`（后台守护）。` }, { replyTo: evt.messageId })
        .catch(() => undefined);
    })
    // 版本更新（检查）：查 npm 最新版，渲染结果。npm view 走异步 execFile —— 卡片
    // 回调里**绝不能** spawnSync，否则冻结整条 event loop。先 settle 再更新，避开
    // 点击回调窗口；checking→checked 是顺序 await，天然有序。
    .on(DM.update, ({ evt }) => {
      if (!dmAdmin(evt.operator?.openId)) return;
      void (async () => {
        await new Promise((r) => setTimeout(r, CARD_SETTLE_MS));
        await updateManagedCard(channel, evt.messageId, buildUpdateCard({ phase: 'checking' })).catch(
          () => undefined,
        );
        const current = currentVersion();
        const latest = await latestVersion().catch(() => null);
        const hasUpdate = !!latest && isNewer(latest, current);
        log.info('console', 'update-check', { current, latest, hasUpdate });
        await updateManagedCard(
          channel,
          evt.messageId,
          buildUpdateCard({ phase: 'checked', current, latest, hasUpdate, dev: isDevSource() }),
        ).catch((e) => log.fail('console', e, { phase: 'update-check' }));
      })();
    })
    // 版本更新（执行）：npm i -g 最新版（async spawn），成功后**先发完成卡再**重启
    // daemon —— restart 会 kill 掉当前这个 daemon 进程（卡片回调就跑在它里面），所以
    // 必须等完成卡渲染落地后再触发 restart，否则用户看不到结果。
    .on(DM.updateDo, ({ evt }) => {
      if (!dmAdmin(evt.operator?.openId)) return;
      void (async () => {
        await new Promise((r) => setTimeout(r, CARD_SETTLE_MS));
        const from = currentVersion();
        await updateManagedCard(channel, evt.messageId, buildUpdateCard({ phase: 'updating', from })).catch(
          () => undefined,
        );
        const res = await installLatest();
        if (!res.ok) {
          log.info('console', 'update-failed', { from });
          await updateManagedCard(
            channel,
            evt.messageId,
            buildUpdateCard({ phase: 'error', from, message: res.message }),
          ).catch((e) => log.fail('console', e, { phase: 'update-error' }));
          return;
        }
        const to = currentVersion();
        const willRestart = daemonRunning();
        log.info('console', 'update-done', { from, to, willRestart });
        await updateManagedCard(
          channel,
          evt.messageId,
          buildUpdateCard({ phase: 'done', from, to, willRestart }),
        ).catch((e) => log.fail('console', e, { phase: 'update-done' }));
        if (willRestart) {
          // 给完成卡一点渲染时间，再让 launchd 重启（kill 自己）。
          await new Promise((r) => setTimeout(r, 800));
          await restartDaemon().catch((e) => log.fail('console', e, { phase: 'update-restart' }));
        }
      })();
    })
    .on(DM.rmConfirm, async ({ evt, value }) => {
      const name = typeof value.n === 'string' ? value.n : undefined;
      if (!dmAdmin(evt.operator?.openId) || !name) return;
      const proj = (await listProjects()).find((p) => p.name === name);
      await patch(evt, buildRmConfirmCard(name, proj?.origin));
    })
    .on(DM.rmCancel, ({ evt }) => {
      if (!dmAdmin(evt.operator?.openId)) return;
      patch(evt, renderProjectList);
    })
    .on(DM.rmDo, ({ evt, value }) => {
      const name = typeof value.n === 'string' ? value.n : undefined;
      const op = evt.operator?.openId;
      if (!dmAdmin(op) || !name) return;
      // all the slow work (remove + owner transfer/leave + reply) runs in the
      // settle builder so the click acks immediately. The announcement vanishes
      // with the group once the owner dissolves it, so nothing to clean up here.
      patch(evt, async () => {
        const removed = await removeProject(name);
        let tail: string;
        if (removed && (removed.origin ?? 'created') === 'joined') {
          // joined group: the bot is a plain member, not the owner — it just
          // leaves (never disbands; the group is the user's). Best-effort.
          const left = removed.chatId
            ? await leaveChat(channel, removed.chatId)
                .then(() => true)
                .catch((err) => {
                  log.fail('console', err, { phase: 'leave-chat' });
                  return false;
                })
            : false;
          log.info('console', 'rm', { name, origin: 'joined', left });
          tail = left
            ? '我已退出该群（群是你们的，不会解散）。'
            : '⚠️ 我退群失败（可能权限不足），可在群里手动把我移除。';
        } else {
          let transferred = false;
          if (removed?.chatId && op) {
            transferred = await transferOwnership(channel, removed.chatId, op)
              .then(() => true)
              .catch((err) => {
                log.fail('console', err, { phase: 'owner-transfer' });
                return false;
              });
          }
          log.info('console', 'rm', { name, origin: 'created', transferred });
          tail = transferred
            ? '群主已转给你 → 请在飞书里**自行解散该群**（机器人不主动解散）。'
            : '⚠️ 群主转让失败（可能 bot 非群主），请用「🚪 群管理」手动转让后解散。';
        }
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
    /** local image paths for the FIRST turn (codex reads them as localImage) */
    images?: string[];
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
      let turnInput: AgentInput = { text: opts.firstText, images: opts.images };
      let replyTo = opts.replyTo;
      let replyInThread = opts.flat ? false : (opts.replyInThread ?? Boolean(opts.knownThreadId));
      for (;;) {
        // per-turn model/effort: prefer latest persisted (⚙️ may have changed it)
        const rec = topicThreadId ? await getSession(topicThreadId) : undefined;
        const turnModel = rec?.model ?? opts.model;
        const turnEffort = rec?.effort ?? opts.effort;
        const run = opts.thread.runStreamed(turnInput, { model: turnModel, effort: turnEffort });
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
        // Per-turn stream-latency observability (file log `stream.timing`): locates
        // where a reply lags — first byte, backlog (lastEv vs done), push split, RTT.
        const tStart = Date.now();
        let firstEvAt = 0;
        let firstTextAt = 0;
        let lastEvAt = tStart;
        let evCount = 0;
        let textChars = 0;
        for await (const ev of guarded) {
          const tEv = Date.now();
          if (!firstEvAt) firstEvAt = tEv;
          const et = (ev as { type?: string }).type;
          if (et === 'text_delta') {
            if (!firstTextAt) firstTextAt = tEv;
            const d = (ev as { delta?: string }).delta;
            if (typeof d === 'string') textChars += d.length;
          }
          lastEvAt = tEv;
          evCount++;
          render.apply(ev);
          rc.rs = render.snapshot();
          // Non-blocking: never stall event consumption on a round-trip. The pump
          // coalesces and routes the latest snapshot — answer text → element
          // typewriter (cardElement.content), structure → whole-card update.
          stream.streamCoalesced(channel, buildRunCard(rc), ANSWER_EID);
        }
        const doneAt = Date.now(); // codex stopped emitting / loop ended
        await stream.drain(); // flush the last coalesced frame before terminal
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

        // Outbound images + 卡片围栏 — only at terminal (uploads are slow; while
        // streaming, ![](path) refs and ```feishu-card fences show as text). Scan
        // the final answer once: upload every image ref (cached; covers both the
        // run-card's inline images and any clean-card images), then post each
        // ```feishu-card fence as a standalone clean card. Best-effort: a failed
        // upload leaves the original markdown in place, a failed card is logged.
        const answerText = finalMessageText(rc.rs);
        const { fences } = extractCardFences(answerText);
        const imgSources = imageSources(answerText);
        if (imgSources.length > 0) {
          rc.images = await uploadOutboundImages(channel, imgSources, opts.cwd ?? fallbackCwd);
        }

        // terminal whole-card update: final render with streaming off (clears the
        // typewriter cursor) and no ⏹ button.
        await stream.updateCard(channel, buildRunCard(rc));
        // One-line per-turn timeline; all ms are relative to the turn's stream start.
        {
          const terminalAt = Date.now();
          const st = stream.stats();
          log.info('stream', 'timing', {
            firstEv: firstEvAt ? firstEvAt - tStart : -1,
            firstText: firstTextAt ? firstTextAt - tStart : -1,
            lastEv: lastEvAt - tStart,
            done: doneAt - tStart,
            terminal: terminalAt - tStart,
            doneToTerminal: terminalAt - doneAt,
            events: evCount,
            textChars,
            pushes: st.pushCount,
            cardPushes: st.cardPushes,
            elPushes: st.elPushes,
            rttAvg: st.pushCount ? Math.round(st.totalRttMs / st.pushCount) : 0,
            rttMax: st.maxRttMs,
          });
        }
        runsByCard.delete(cardMsgId);
        promoteCard(finalMsgId, rc);

        for (const fence of fences) {
          try {
            await sendManagedCard(channel, opts.chatId, buildCleanCard(fence, rc.images), finalMsgId, !opts.flat);
          } catch (err) {
            log.fail('card', err, { phase: 'clean-card' });
          }
        }
        if (topicThreadId) await patchSession(topicThreadId, { updatedAt: Date.now() });
        replyTo = finalMsgId;
        replyInThread = !opts.flat; // stay in the topic for queued turns (single: stay flat)
        log.info('card', 'final', { terminal: render.terminal() });

        // A kill (⏹ / watchdog) stops the whole run — drop any queued follow-ups
        // (they'd run on the recycled, now-closed thread).
        if (killed) break;
        if (state.queue.length === 0) break;
        turnInput = state.queue.shift()!;
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

  // ── cloud-doc comments ────────────────────────────────────────────
  /**
   * `comment` event: someone @-mentioned the bot in a Feishu doc comment
   * (drive.notice.comment_add_v1). There's no streaming card here — we mark the
   * triggering reply with a "Typing" reaction, run one codex turn, and post the
   * answer back into the same comment thread. One codex thread per document
   * (keyed `doc:<fileToken>`), so repeated @-mentions in a doc continue the same
   * conversation; it shares the session store + concurrency semaphore with the
   * group run loop. Comment runs aren't interruptible (no ⏹ card) — the idle
   * watchdog is the only kill switch.
   */
  const onComment = async (evt: CommentEvent): Promise<void> => {
    await withTrace({ chatId: 'comment' }, async () => {
      log.info('comment', 'enter', {
        doc: evt.fileToken,
        fileType: evt.fileType,
        commentId: evt.commentId,
        replyId: evt.replyId ?? null,
        mentionedBot: evt.mentionedBot,
        sender: evt.operator.openId,
      });
      if (!evt.mentionedBot) return log.info('comment', 'skip', { reason: 'not-mentioned' });
      if (!SUPPORTED_FILE_TYPES.has(evt.fileType))
        return log.info('comment', 'skip', { reason: 'unsupported-fileType', fileType: evt.fileType });
      if (!isUserAllowed(cfg, evt.operator.openId))
        return log.info('comment', 'skip', { reason: 'not-allowed' });

      const resolved = await resolveComment(channel, evt);
      if (!resolved) return log.info('comment', 'skip', { reason: 'no-target-or-empty' });
      const { target, ctx } = resolved;
      log.info('comment', 'parsed', { isWhole: ctx.isWhole, hasQuote: Boolean(ctx.quote) });

      const prompt = buildCommentPrompt(target, ctx, cfg.accounts.app.tenant);
      const sessionKey = `doc:${evt.fileToken}`;

      // Best-effort "received" feedback up-front (comments have no streaming
      // UI). Added before the per-doc lock so a queued mention still acks
      // immediately; cleared in the finally regardless of how the run ends.
      const reacted = ctx.targetReplyId
        ? await addCommentReaction(channel, target, ctx.targetReplyId)
        : false;

      try {
        // Serialize per document: one codex thread can't run two turns at once
        // (they'd both consume the thread's single app-server notification
        // stream and steal each other's events), so concurrent @-mentions in
        // the SAME doc must queue. Different docs run in parallel (distinct
        // threads); the global cap is still `sema`, acquired inside the lock.
        await withDocLock(sessionKey, async () => {
          const release = await sema.acquire();
          try {
            const thread = await resolveDocThread(sessionKey, ctx.question);
            const rec = await getSession(sessionKey);
            const run = thread.runStreamed({ text: prompt }, { model: rec?.model, effort: rec?.effort });

            let state: RunState = initialState;
            let timedOut = false;
            const guarded = withIdleTimeout(run.events, idleMs, () => {
              timedOut = true;
            });
            for await (const ev of guarded) state = reduce(state, ev);

            if (timedOut) {
              const tid = run.turnId();
              // Recycle the thread so the hung turn's never-terminating stream
              // doesn't poison the next comment; the doc resumes from the
              // persisted thread on its next @-mention. Fire-and-forget the
              // interrupt — turn/interrupt is an unbounded JSON-RPC round-trip,
              // and close() SIGKILLs the child anyway, so awaiting it here would
              // pin both the per-doc lock and a global semaphore slot if it
              // hangs. sessions.delete stays synchronous + before release() so
              // the next queued same-doc comment always starts fresh.
              if (tid) void thread.abort(tid).catch(() => undefined);
              void thread.close().catch(() => undefined);
              sessions.delete(sessionKey);
            } else {
              await patchSession(sessionKey, { updatedAt: Date.now() });
            }

            let reply = stripMarkdown(finalMessageText(state)).trim();
            if (state.terminal === 'error' && state.errorMsg) reply = `⚠️ 出错了：${state.errorMsg}`;
            if (!reply) reply = timedOut ? '（处理超时，请重试或把问题问得更具体些）' : '（没有可回复的内容）';
            if (reply.length > REPLY_MAX_CHARS) reply = `${reply.slice(0, REPLY_MAX_CHARS - 1)}…`;

            await postCommentReply(channel, target, evt, reply).catch((err) =>
              log.fail('comment', err, { step: 'postCommentReply' }),
            );
            log.info('comment', 'done', { terminal: state.terminal, timedOut, len: reply.length });
          } finally {
            release();
          }
        });
      } catch (err) {
        log.fail('comment', err, { step: 'run' });
      } finally {
        if (reacted && ctx.targetReplyId)
          await removeCommentReaction(channel, target, ctx.targetReplyId).catch(() => undefined);
      }
    }).catch((err) => log.fail('comment', err));
  };

  /**
   * Run `fn` serially per `key`: each call chains after the previous one for the
   * same key (so same-doc comment turns never overlap), while different keys run
   * concurrently. The map entry is dropped once its chain fully drains.
   */
  function withDocLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = docLocks.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn); // run regardless of the prior call's outcome
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    docLocks.set(key, tail);
    void tail.then(() => {
      if (docLocks.get(key) === tail) docLocks.delete(key);
    });
    return run;
  }

  /** Reuse the in-memory codex thread for a doc, else resume the persisted one,
   * else start a fresh thread bound to `doc:<fileToken>` (cwd = fallbackCwd —
   * doc replies rarely touch the filesystem, but we keep a sane default). */
  async function resolveDocThread(sessionKey: string, question: string): Promise<AgentThread> {
    const live = sessions.get(sessionKey);
    if (live) return live;
    const rec = await getSession(sessionKey);
    if (rec) {
      try {
        const resumed = await backend.resumeThread({
          cwd: rec.cwd,
          codexThreadId: rec.codexThreadId,
          model: rec.model,
          effort: rec.effort,
        });
        sessions.set(sessionKey, resumed);
        return resumed;
      } catch (err) {
        log.fail('agent', err, { phase: 'comment-resume', sessionKey });
      }
    }
    const { model, effort } = pickDefault(await listModels());
    const fresh = await backend.startThread({ cwd: fallbackCwd, model, effort });
    sessions.set(sessionKey, fresh);
    await upsertSession({
      threadId: sessionKey,
      chatId: sessionKey,
      cwd: fallbackCwd,
      codexThreadId: fresh.codexThreadId,
      model,
      effort,
      summary: question.slice(0, 80),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    return fresh;
  }

  /**
   * `botAdded` event: a human added the bot to a group. If the adder is an admin
   * (binding ties the group to a cwd on the operator's machine — privileged) and
   * the group isn't already bound, DM them a bind card with the project name
   * pre-filled from the group name. Groups the bridge created itself are already
   * registered (or added by the bot, not an admin), so they fall through.
   */
  async function onBotAddedToChat(evt: BotAddedEvent): Promise<void> {
    // The SDK fires botAdded fire-and-forget (no await around the handler), so a
    // rejection here would surface as an unhandled rejection — guard the whole
    // body (getProjectByChatId can throw on a corrupt/locked projects.json).
    await withTrace({ chatId: evt.chatId }, async () => {
      const op = evt.operator?.openId;
      if (await getProjectByChatId(evt.chatId)) {
        log.info('intake', 'bot-added-bound', { chatId: evt.chatId.slice(-6) });
        return;
      }
      if (!op || !isAdmin(cfg, op)) {
        log.info('intake', 'bot-added-nonadmin', { chatId: evt.chatId.slice(-6), op: op?.slice(-6) });
        return;
      }
      // Best-effort group name (needs im:chat:readonly); the bind card's name is
      // editable, so an empty/failed lookup just means the admin types one.
      const info = await channel.getChatInfo(evt.chatId).catch((err) => {
        log.fail('intake', err, { phase: 'bot-added-chatinfo' });
        return undefined;
      });
      const name = (info?.name ?? '').trim();
      await sendManagedCard(
        channel,
        op,
        buildJoinGroupFormCard({ chatId: evt.chatId, name }),
        undefined,
        false,
        'open_id',
      ).catch((err) => log.fail('intake', err, { phase: 'bot-added-bindcard' }));
      log.info('intake', 'bot-added', { chatId: evt.chatId.slice(-6), op: op.slice(-6), named: Boolean(name) });
    }).catch((err) => log.fail('intake', err, { phase: 'bot-added' }));
  }

  /**
   * Bot removed from a group (im.chat.member.bot.deleted_v1, tapped on the raw
   * dispatcher in bridge.ts — the SDK has no named event for it). Auto-unbind the
   * bound project: the bot is already out, so no me_leave. Notify the binder.
   */
  async function onBotRemovedFromChat(chatId: string): Promise<void> {
    const project = await getProjectByChatId(chatId);
    if (!project) return;
    // Remove first, then notify only if THIS call removed it — Feishu delivers
    // events at-least-once and this raw-tap path bypasses the SDK's dedup, so a
    // redelivery would otherwise double-notify the binder. removeProject returns
    // undefined when the entry is already gone.
    const removed = await removeProject(project.name);
    if (!removed) return;
    log.info('intake', 'bot-removed-unbind', { name: removed.name, chatId: chatId.slice(-6) });
    if (removed.addedBy) {
      await channel.rawClient.im.v1.message
        .create({
          params: { receive_id_type: 'open_id' },
          data: {
            receive_id: removed.addedBy,
            msg_type: 'text',
            content: JSON.stringify({ text: `ℹ️ 我已被移出群「${removed.name}」，对应项目已自动解绑。` }),
          },
        })
        .catch(() => undefined);
    }
  }

  async function shutdown(): Promise<void> {
    const live = [...sessions.values()];
    sessions.clear();
    // close() SIGKILLs each app-server child; settle all so one hang/throw
    // doesn't block reaping the rest.
    await Promise.allSettled(live.map((t) => t.close()));
    log.info('bridge', 'shutdown', { closed: live.length });
  }

  return { onMessage, onComment, onBotAddedToChat, onBotRemovedFromChat, dispatcher, shutdown };
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
