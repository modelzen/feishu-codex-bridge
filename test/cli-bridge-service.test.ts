import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/core/logger', () => ({
  log: {
    info: () => undefined,
    warn: () => undefined,
    fail: () => undefined,
  },
  withTrace: async (_ctx: unknown, fn: () => Promise<void> | void) => fn(),
}));

import { sendCliHookMessage, startCliBridgeIpcServer } from '../src/cli-bridge/ipc';
import { createCliBridgeService, shouldStartCliBridge } from '../src/cli-bridge/service';
import {
  createPendingCliInteraction,
  getPendingCliInteraction,
  setPendingCliMessageId,
  waitForPendingCliInteraction,
} from '../src/cli-bridge/store';
import { buildCliBridgeQuestionCard, CLI } from '../src/cli-bridge/cards';
import type { AppConfig } from '../src/config/schema';
import { CardDispatcher } from '../src/card/dispatcher';
import { sendManagedCard } from '../src/card/managed';

describe('cli bridge ipc', () => {
  it('accepts a hook message and returns a response', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fcb-ipc-'));
    const socketPath = join(dir, 'sock');
    const server = await startCliBridgeIpcServer({
      socketPath,
      handleMessage: async (msg) => ({ decision: msg.source === 'codex' ? 'allow' : 'fallback_local' }),
    });
    try {
      const response = await sendCliHookMessage(socketPath, {
        type: 'permission_request',
        source: 'codex',
        sessionId: 's',
        cwd: '/repo',
        toolInput: {},
        bridgeOwned: false,
        rawPayloadBytes: 2,
      });
      expect(response).toEqual({ decision: 'allow' });
    } finally {
      await server.close();
    }
  });
});

function cfg(delivery: 'always' | 'away_only' = 'always'): AppConfig {
  return {
    accounts: { app: { id: 'app', secret: 'secret', tenant: 'feishu' } },
    preferences: {
      access: { ownerOpenId: 'ou_owner' },
      cliBridge: { enabled: true, delivery },
    },
  };
}

function managedChannel() {
  let nextCard = 0;
  let nextMessage = 0;
  let nextReaction = 0;
  const createdCards: string[] = [];
  const updatedCards: string[] = [];
  const reactionsAdded: { messageId: string; emoji: string; reactionId: string }[] = [];
  const reactionsRemoved: { messageId: string; reactionId: string }[] = [];
  const channel = {
    rawClient: {
      cardkit: {
        v1: {
          card: {
            create: vi.fn(async ({ data }: { data: { data: string } }) => {
              createdCards.push(data.data);
              nextCard += 1;
              return { data: { card_id: `card_${nextCard}` } };
            }),
            update: vi.fn(async ({ data }: { data: { card: { data: string } } }) => {
              updatedCards.push(data.card.data);
              return {};
            }),
          },
        },
      },
      im: {
        v1: {
          message: {
            create: vi.fn(async () => {
              nextMessage += 1;
              return { data: { message_id: `message_${nextMessage}` } };
            }),
            reply: vi.fn(async () => {
              nextMessage += 1;
              return { data: { message_id: `message_${nextMessage}` } };
            }),
          },
          messageReaction: {
            create: vi.fn(async ({ path, data }: { path: { message_id: string }; data: { reaction_type: { emoji_type: string } } }) => {
              nextReaction += 1;
              const reaction_id = `reaction_${nextReaction}`;
              reactionsAdded.push({ messageId: path.message_id, emoji: data.reaction_type.emoji_type, reactionId: reaction_id });
              return { data: { reaction_id } };
            }),
            delete: vi.fn(async ({ path }: { path: { message_id: string; reaction_id: string } }) => {
              reactionsRemoved.push({ messageId: path.message_id, reactionId: path.reaction_id });
              return {};
            }),
          },
        },
      },
    },
  };
  return { channel: channel as never, createdCards, updatedCards, reactionsAdded, reactionsRemoved };
}

function shortApprovalCfg(): AppConfig {
  return {
    accounts: { app: { id: 'app', secret: 'secret', tenant: 'feishu' } },
    preferences: {
      access: { ownerOpenId: 'ou_owner' },
      cliBridge: { enabled: true, delivery: 'always', approval: { timeoutSeconds: 1 } },
    },
  };
}

function actionValue(node: unknown, actionId: string): Record<string, unknown> | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = actionValue(child, actionId);
      if (found) return found;
    }
    return undefined;
  }
  if (!node || typeof node !== 'object') return undefined;
  const obj = node as Record<string, unknown>;
  const behaviors = obj.behaviors;
  if (Array.isArray(behaviors)) {
    for (const behavior of behaviors) {
      const value = (behavior as { value?: Record<string, unknown> }).value;
      if (value?.a === actionId) return value;
    }
  }
  for (const value of Object.values(obj)) {
    const found = actionValue(value, actionId);
    if (found) return found;
  }
  return undefined;
}

describe('cli bridge service routing', () => {
  it('ignores bridge-owned sessions by default', async () => {
    const service = createCliBridgeService({
      cfg: cfg('always'),
      channel: { send: async () => ({ messageId: 'm' }) } as never,
      socketPath: '/tmp/unused',
      presence: async () => ({ routeToFeishu: true, reason: 'always' }),
    });
    await expect(service.handleMessage({
      type: 'permission_request',
      source: 'codex',
      sessionId: 's',
      cwd: '/repo',
      toolInput: {},
      bridgeOwned: true,
      rawPayloadBytes: 2,
    })).resolves.toEqual({ decision: 'fallback_local', reason: 'bridge_owned_session' });
  });

  it('falls back locally when away_only and local machine is active', async () => {
    const service = createCliBridgeService({
      cfg: cfg('away_only'),
      channel: { send: async () => ({ messageId: 'm' }) } as never,
      socketPath: '/tmp/unused',
      presence: async () => ({ routeToFeishu: false, reason: 'local_active' }),
    });
    await expect(service.handleMessage({
      type: 'permission_request',
      source: 'claude',
      sessionId: 's',
      cwd: '/repo',
      toolInput: {},
      bridgeOwned: false,
      rawPayloadBytes: 2,
    })).resolves.toEqual({ decision: 'fallback_local', reason: 'local_active' });
  });

  it('does not forward permission requests when approval.enabled is false', async () => {
    const service = createCliBridgeService({
      cfg: {
        accounts: { app: { id: 'app', secret: 'secret', tenant: 'feishu' } },
        preferences: { access: { ownerOpenId: 'ou_owner' }, cliBridge: { enabled: true, delivery: 'always', approval: { enabled: false } } },
      },
      channel: { send: async () => ({ messageId: 'm' }) } as never,
      socketPath: '/tmp/unused',
      presence: async () => ({ routeToFeishu: true, reason: 'always' }),
    });
    await expect(service.handleMessage({
      type: 'permission_request', source: 'codex', sessionId: 's', cwd: '/repo', toolInput: {}, bridgeOwned: false, rawPayloadBytes: 2,
    })).resolves.toEqual({ decision: 'fallback_local', reason: 'approval_disabled' });
  });

  it('does not forward task completion when taskCompletion.enabled is false', async () => {
    const service = createCliBridgeService({
      cfg: {
        accounts: { app: { id: 'app', secret: 'secret', tenant: 'feishu' } },
        preferences: { access: { ownerOpenId: 'ou_owner' }, cliBridge: { enabled: true, delivery: 'always', taskCompletion: { enabled: false } } },
      },
      channel: { send: async () => ({ messageId: 'm' }) } as never,
      socketPath: '/tmp/unused',
      presence: async () => ({ routeToFeishu: true, reason: 'always' }),
    });
    await expect(service.handleMessage({
      type: 'task_complete', source: 'claude', sessionId: 's', cwd: '/repo', toolInput: {}, bridgeOwned: false, rawPayloadBytes: 2,
    })).resolves.toEqual({ decision: 'fallback_local', reason: 'task_completion_disabled' });
  });

  it('falls back locally for unsupported Claude AskUserQuestion payloads', async () => {
    const service = createCliBridgeService({
      cfg: cfg('always'),
      channel: { send: async () => ({ messageId: 'm' }) } as never,
      socketPath: '/tmp/unused',
      presence: async () => ({ routeToFeishu: true, reason: 'always' }),
    });
    await expect(service.handleMessage({
      type: 'permission_request',
      source: 'claude',
      sessionId: 's',
      cwd: '/repo',
      toolName: 'AskUserQuestion',
      // Malformed: a question needs ≥2 options — the parser rejects it → local fallback.
      toolInput: { questions: [{ question: 'Pick', options: [{ label: 'A' }] }] },
      bridgeOwned: false,
      rawPayloadBytes: 2,
    })).resolves.toEqual({ decision: 'fallback_local', reason: 'unsupported_ask_user_question' });
  });

  it('resolves approval actions', async () => {
    const { channel, createdCards, updatedCards } = managedChannel();
    const service = createCliBridgeService({
      cfg: cfg('always'),
      channel,
      socketPath: '/tmp/unused',
      presence: async () => ({ routeToFeishu: true, reason: 'always' }),
    });
    const pending = service.handleMessage({
      type: 'permission_request',
      source: 'codex',
      sessionId: 's',
      cwd: '/repo',
      toolName: 'Bash',
      hookEventName: 'PermissionRequest',
      toolInput: { command: 'git status' },
      bridgeOwned: false,
      rawPayloadBytes: 2,
    });
    await vi.waitFor(() => expect(createdCards).toHaveLength(1));
    const approve = actionValue(JSON.parse(createdCards[0] ?? '{}'), CLI.approveOnce);
    expect(typeof approve?.id).toBe('string');
    expect(service.resolveAction({ actionId: CLI.approveOnce, id: String(approve?.id) })).toBe(true);
    await expect(pending).resolves.toEqual({ decision: 'allow' });
    await vi.waitFor(() => expect(updatedCards).toHaveLength(1));
    expect(updatedCards[0]).toContain('✅ 已允许');
    expect(actionValue(JSON.parse(updatedCards[0] ?? '{}'), CLI.approveOnce)).toBeUndefined();
  });

  it('releases the task-completion wait when the user returns to the local machine', async () => {
    const { channel } = managedChannel();
    let calls = 0;
    const service = createCliBridgeService({
      cfg: cfg('away_only'),
      channel,
      socketPath: '/tmp/unused',
      // Entry sees the user away (route to Feishu); the poll then sees them back,
      // so the wait must resolve to allow long before the 600s reply timeout.
      presence: async () => {
        calls += 1;
        return calls <= 1
          ? { routeToFeishu: true, reason: 'away' }
          : { routeToFeishu: false, reason: 'local_active' };
      },
      localReturnPollMs: 10,
    });
    await expect(service.handleMessage({
      type: 'task_complete',
      source: 'claude',
      sessionId: 's',
      cwd: '/repo',
      taskStatus: 'completed',
      toolInput: {},
      bridgeOwned: false,
      rawPayloadBytes: 2,
    })).resolves.toEqual({ decision: 'allow' });
  });

  it('releases task-completion waits on local activity even when delivery is always', async () => {
    const { channel, createdCards } = managedChannel();
    const service = createCliBridgeService({
      cfg: cfg('always'),
      channel,
      socketPath: '/tmp/unused',
      presence: async () => ({ routeToFeishu: true, reason: 'always' }),
      localActivity: async () => true,
      localReturnPollMs: 10,
    });
    await expect(service.handleMessage({
      type: 'task_complete',
      source: 'codex',
      sessionId: 's',
      cwd: '/repo',
      taskStatus: 'completed',
      toolInput: {},
      bridgeOwned: false,
      rawPayloadBytes: 2,
    })).resolves.toEqual({ decision: 'allow' });
    expect(createdCards).toHaveLength(1);
  });

  it('sends active task-completion notifications without opening a reply window', async () => {
    const { channel, createdCards } = managedChannel();
    const service = createCliBridgeService({
      cfg: cfg('always'),
      channel,
      socketPath: '/tmp/unused',
      presence: async () => ({ routeToFeishu: true, reason: 'always' }),
      localActivity: async () => true,
      localReturnPollMs: 10,
    });
    await expect(service.handleMessage({
      type: 'task_complete',
      source: 'codex',
      sessionId: 's-active',
      cwd: '/repo',
      taskStatus: 'completed',
      toolInput: {},
      bridgeOwned: false,
      rawPayloadBytes: 2,
    })).resolves.toEqual({ decision: 'allow' });
    expect(createdCards).toHaveLength(1);
    expect(createdCards[0]).toContain('Vonvon Bridge');
    expect(createdCards[0]).not.toContain('等待确认'); // no reply window when you're active
  });

  it('does not send task-completion notifications when away_only sees local activity', async () => {
    const { channel, createdCards } = managedChannel();
    const service = createCliBridgeService({
      cfg: cfg('away_only'),
      channel,
      socketPath: '/tmp/unused',
      presence: async () => ({ routeToFeishu: false, reason: 'local_active' }),
    });
    // User is at the keyboard → let the Stop finish silently, same as permission/
    // question, instead of pinging Feishu for every completion.
    await expect(service.handleMessage({
      type: 'task_complete',
      source: 'claude',
      sessionId: 's-local',
      cwd: '/repo',
      taskStatus: 'completed',
      toolInput: {},
      bridgeOwned: false,
      rawPayloadBytes: 2,
    })).resolves.toEqual({ decision: 'fallback_local', reason: 'local_active' });
    expect(createdCards).toHaveLength(0);
  });

  it('releases task-completion waits when the done action is clicked', async () => {
    const { channel, createdCards, updatedCards } = managedChannel();
    const service = createCliBridgeService({
      cfg: cfg('away_only'),
      channel,
      socketPath: '/tmp/unused',
      presence: async () => ({ routeToFeishu: true, reason: 'away' }),
      localActivity: async () => false,
      localReturnPollMs: 10,
    });
    const pending = service.handleMessage({
      type: 'task_complete',
      source: 'claude',
      sessionId: 's-away',
      cwd: '/repo',
      taskStatus: 'completed',
      toolInput: {},
      bridgeOwned: false,
      rawPayloadBytes: 2,
    });
    // [0] is the one-time away heads-up; [1] is the completion card.
    await vi.waitFor(() => expect(createdCards).toHaveLength(2));
    const done = actionValue(JSON.parse(createdCards[1] ?? '{}'), CLI.taskCompletionDone);
    expect(typeof done?.id).toBe('string');
    expect(service.resolveAction({ actionId: CLI.taskCompletionDone, id: String(done?.id) })).toBe(true);
    // The done-click marker keeps handleMessage's post-wait close from re-rendering
    // the card (resolveAction already did); it's internal-only and ignored downstream.
    await expect(pending).resolves.toEqual({ decision: 'allow', reason: 'task_done_clicked' });
    await vi.waitFor(() => expect(updatedCards).toHaveLength(1));
    expect(updatedCards[0]).toContain('✅ 已确认完成');
    expect(updatedCards[0]).toContain('✅ 已完成');
  });

  it('closes the task-completion card after the reply window ends without a done click', async () => {
    const { channel, createdCards, updatedCards } = managedChannel();
    let activityCalls = 0;
    const service = createCliBridgeService({
      cfg: cfg('away_only'),
      channel,
      socketPath: '/tmp/unused',
      presence: async () => ({ routeToFeishu: true, reason: 'away' }),
      // away when the reply window opens, then the user returns → the wait releases
      // via local-return (not a done click), so the card must be refreshed closed.
      localActivity: async () => { activityCalls += 1; return activityCalls > 1; },
      localReturnPollMs: 10,
    });
    await expect(service.handleMessage({
      type: 'task_complete',
      source: 'claude',
      sessionId: 's-return',
      cwd: '/repo',
      taskStatus: 'completed',
      toolInput: {},
      bridgeOwned: false,
      rawPayloadBytes: 2,
    })).resolves.toEqual({ decision: 'allow' });
    // [0] is the away heads-up; [1] is the completion card offering the reply continuation …
    expect(createdCards).toHaveLength(2);
    expect(createdCards[1]).toContain('等待确认');
    // … and it gets refreshed to a no-button closed state once the window ends.
    await vi.waitFor(() => expect(updatedCards).toHaveLength(1));
    expect(updatedCards[0]).not.toContain('等待确认'); // closed: no reply affordance left
  });

  it('hands a forwarded permission back to the terminal when the user returns', async () => {
    const { channel, createdCards, updatedCards } = managedChannel();
    let activityCalls = 0;
    const service = createCliBridgeService({
      cfg: cfg('away_only'),
      channel,
      socketPath: '/tmp/unused',
      presence: async () => ({ routeToFeishu: true, reason: 'away' }),
      // away when the card is sent, then the user returns → the wait releases as
      // fallback_local (NOT allow) so the terminal regains its own prompt.
      localActivity: async () => { activityCalls += 1; return activityCalls > 1; },
      localReturnPollMs: 10,
    });
    await expect(service.handleMessage({
      type: 'permission_request',
      source: 'codex',
      sessionId: 's-perm',
      cwd: '/repo',
      toolName: 'Bash',
      toolInput: { command: 'git status' },
      bridgeOwned: false,
      rawPayloadBytes: 2,
    })).resolves.toEqual({ decision: 'fallback_local', reason: 'local_return' });
    // [0] away heads-up, [1] the permission card (then refreshed to 已转交本机)
    expect(createdCards).toHaveLength(2);
    await vi.waitFor(() => expect(updatedCards).toHaveLength(1));
    expect(updatedCards[0]).toContain('已转交本机');
  });

  it('opens a reply window for codex task completion when away (codex shares the Stop continuation contract)', async () => {
    const { channel, createdCards } = managedChannel();
    let activityCalls = 0;
    const service = createCliBridgeService({
      cfg: cfg('away_only'),
      channel,
      socketPath: '/tmp/unused',
      presence: async () => ({ routeToFeishu: true, reason: 'away' }),
      // away when the window opens (offers reply), then the user returns so the wait
      // releases — keeps the test from hanging on the 600s reply timeout.
      localActivity: async () => { activityCalls += 1; return activityCalls > 1; },
      localReturnPollMs: 10,
    });
    await expect(service.handleMessage({
      type: 'task_complete',
      source: 'codex',
      sessionId: 's-codex',
      cwd: '/repo',
      taskStatus: 'completed',
      toolInput: {},
      bridgeOwned: false,
      rawPayloadBytes: 2,
    })).resolves.toEqual({ decision: 'allow' });
    // [0] away heads-up, [1] completion card.
    expect(createdCards).toHaveLength(2);
    // Codex's Stop hook honors {decision:'block', reason} just like Claude, so the
    // completion card offers the reply-continuation affordance.
    expect(createdCards[1]).toContain('等待确认');
  });

  it('re-forwards a Stop that is continuing from a Feishu reply, so multi-turn results come back', async () => {
    const { channel, createdCards } = managedChannel();
    let activityCalls = 0;
    const service = createCliBridgeService({
      cfg: cfg('away_only'),
      channel,
      socketPath: '/tmp/unused',
      presence: async () => ({ routeToFeishu: true, reason: 'away' }),
      // away when the reply window opens, then the user returns so the wait releases.
      localActivity: async () => { activityCalls += 1; return activityCalls > 1; },
      localReturnPollMs: 10,
    });

    // stop_hook_active=true is precisely the Stop that fires after a Feishu reply continued
    // the agent — its result must still reach Feishu (and offer another reply window).
    await expect(service.handleMessage({
      type: 'task_complete',
      source: 'claude',
      sessionId: 's',
      cwd: '/repo',
      taskStatus: 'completed',
      summary: 'continuation result',
      toolInput: {},
      stopHookActive: true,
      bridgeOwned: false,
      rawPayloadBytes: 2,
    })).resolves.toEqual({ decision: 'allow' });
    // [0] away heads-up, [1] the continuation's completion card
    expect(createdCards).toHaveLength(2);
    expect(createdCards[1]).toContain('continuation result');
    expect(createdCards[1]).toContain('等待确认');
  });

  it('allows later permission requests from an approved session without another card', async () => {
    const { channel, createdCards } = managedChannel();
    const service = createCliBridgeService({
      cfg: cfg('always'),
      channel,
      socketPath: '/tmp/unused',
      presence: async () => ({ routeToFeishu: true, reason: 'always' }),
    });
    const first = service.handleMessage({
      type: 'permission_request',
      source: 'codex',
      sessionId: 'session-1',
      cwd: '/repo',
      toolName: 'Bash',
      toolInput: { command: 'git status' },
      bridgeOwned: false,
      rawPayloadBytes: 2,
    });
    await vi.waitFor(() => expect(createdCards).toHaveLength(1));
    const approve = actionValue(JSON.parse(createdCards[0] ?? '{}'), CLI.approveSession);
    expect(typeof approve?.id).toBe('string');
    expect(service.resolveAction({ actionId: CLI.approveSession, id: String(approve?.id) })).toBe(true);
    await expect(first).resolves.toEqual({ decision: 'allow' });

    await expect(service.handleMessage({
      type: 'permission_request',
      source: 'codex',
      sessionId: 'session-1',
      cwd: '/repo',
      toolName: 'Bash',
      toolInput: { command: 'git diff' },
      bridgeOwned: false,
      rawPayloadBytes: 2,
    })).resolves.toEqual({ decision: 'allow' });
    expect(createdCards).toHaveLength(1);
  });

  it('falls back to local permission handling when the user returns to the terminal', async () => {
    const { channel, createdCards } = managedChannel();
    const service = createCliBridgeService({
      cfg: shortApprovalCfg(),
      channel,
      socketPath: '/tmp/unused',
      presence: async () => ({ routeToFeishu: true, reason: 'away' }),
      localActivity: async () => true,
      localReturnPollMs: 10,
    });

    const pending = service.handleMessage({
      type: 'permission_request',
      source: 'codex',
      sessionId: 'session-return',
      cwd: '/repo',
      toolName: 'Bash',
      toolInput: { command: 'git status' },
      bridgeOwned: false,
      rawPayloadBytes: 2,
    });
    await vi.waitFor(() => expect(createdCards).toHaveLength(2)); // [0] away heads-up, [1] permission card
    const result = await Promise.race([
      pending,
      new Promise((resolve) => setTimeout(() => resolve({ decision: 'too_slow' }), 80)),
    ]);
    if ((result as { decision?: string }).decision === 'too_slow') {
      const approve = actionValue(JSON.parse(createdCards[1] ?? '{}'), CLI.approveOnce);
      service.resolveAction({ actionId: CLI.approveOnce, id: String(approve?.id) });
      await pending;
    }
    expect(result).toEqual({ decision: 'fallback_local', reason: 'local_return' });
  });

  it('falls back to local AskUserQuestion handling when the user returns to the terminal', async () => {
    const { channel, createdCards } = managedChannel();
    const service = createCliBridgeService({
      cfg: shortApprovalCfg(),
      channel,
      socketPath: '/tmp/unused',
      presence: async () => ({ routeToFeishu: true, reason: 'away' }),
      localActivity: async () => true,
      localReturnPollMs: 10,
    });

    const pending = service.handleMessage({
      type: 'permission_request',
      source: 'claude',
      sessionId: 'question-return',
      cwd: '/repo',
      toolName: 'AskUserQuestion',
      toolInput: { questions: [{ question: 'Pick?', options: [{ label: 'A' }, { label: 'B' }] }] },
      bridgeOwned: false,
      rawPayloadBytes: 2,
    });
    await vi.waitFor(() => expect(createdCards).toHaveLength(2)); // [0] away heads-up, [1] question card
    const result = await Promise.race([
      pending,
      new Promise((resolve) => setTimeout(() => resolve({ decision: 'too_slow' }), 80)),
    ]);
    if ((result as { decision?: string }).decision === 'too_slow') {
      const submit = actionValue(JSON.parse(createdCards[1] ?? '{}'), CLI.questionSubmit);
      service.resolveQuestionSubmit(String(submit?.id), { q0_choice: 'A' });
      await pending;
    }
    expect(result).toEqual({ decision: 'fallback_local', reason: 'local_return' });
  });

  it('does not cache session approvals when allowCache is disabled', async () => {
    const { channel, createdCards } = managedChannel();
    const appCfg = cfg('always');
    appCfg.preferences!.cliBridge = { ...appCfg.preferences!.cliBridge, allowCache: { enabled: false } };
    const service = createCliBridgeService({
      cfg: appCfg,
      channel,
      socketPath: '/tmp/unused',
      presence: async () => ({ routeToFeishu: true, reason: 'always' }),
    });

    const first = service.handleMessage({
      type: 'permission_request',
      source: 'codex',
      sessionId: 'session-no-cache',
      cwd: '/repo',
      toolName: 'Bash',
      toolInput: { command: 'git status' },
      bridgeOwned: false,
      rawPayloadBytes: 2,
    });
    await vi.waitFor(() => expect(createdCards).toHaveLength(1));
    expect(actionValue(JSON.parse(createdCards[0] ?? '{}'), CLI.approveSession)).toBeUndefined();
    const firstApprove = actionValue(JSON.parse(createdCards[0] ?? '{}'), CLI.approveOnce);
    expect(service.resolveAction({ actionId: CLI.approveOnce, id: String(firstApprove?.id) })).toBe(true);
    await expect(first).resolves.toEqual({ decision: 'allow' });

    const second = service.handleMessage({
      type: 'permission_request',
      source: 'codex',
      sessionId: 'session-no-cache',
      cwd: '/repo',
      toolName: 'Bash',
      toolInput: { command: 'git diff' },
      bridgeOwned: false,
      rawPayloadBytes: 2,
    });
    await vi.waitFor(() => expect(createdCards).toHaveLength(2));
    const secondApprove = actionValue(JSON.parse(createdCards[1] ?? '{}'), CLI.approveOnce);
    expect(service.resolveAction({ actionId: CLI.approveOnce, id: String(secondApprove?.id) })).toBe(true);
    await expect(second).resolves.toEqual({ decision: 'allow' });
  });

  it('answers questions with updatedInput that preserves the original questions', async () => {
    const service = createCliBridgeService({
      cfg: cfg('always'),
      channel: { send: async () => ({ messageId: 'm' }) } as never,
      socketPath: '/tmp/unused',
      presence: async () => ({ routeToFeishu: true, reason: 'always' }),
    });
    const questions = [{ question: 'Pick?', multiSelect: false, options: [{ label: 'A' }, { label: 'B' }] }];
    const pending = createPendingCliInteraction({
      kind: 'question',
      source: 'claude',
      sessionId: 's',
      cwd: '/repo',
      questions,
      question: 'Pick?',
      toolInput: { questions },
    });
    const waiter = waitForPendingCliInteraction(pending.id, 500);
    expect(service.resolveQuestionSubmit(pending.id, { q0_choice: 'A' })).toBe(true);
    await expect(waiter).resolves.toEqual({
      decision: 'allow',
      updatedInput: { questions, answers: { 'Pick?': 'A' } },
    });
  });

  it('resolves the whole multi-question form on one submit (dropdown + custom override)', async () => {
    const { channel, updatedCards } = managedChannel();
    const service = createCliBridgeService({
      cfg: cfg('always'),
      channel,
      socketPath: '/tmp/unused',
      presence: async () => ({ routeToFeishu: true, reason: 'always' }),
    });
    const dispatcher = new CardDispatcher(channel, cfg('always'));
    service.register(dispatcher);
    const questions = [
      { question: 'Pick a mode?', multiSelect: false, options: [{ label: 'Fast' }, { label: 'Safe' }] },
      { question: 'Extra note?', multiSelect: false, options: [{ label: 'None' }, { label: 'Some' }] },
    ];
    const pending = createPendingCliInteraction({
      kind: 'question',
      source: 'claude',
      sessionId: 'question-session',
      cwd: '/repo',
      questions,
      question: 'Pick a mode?',
      toolInput: { questions },
    });
    const waiter = waitForPendingCliInteraction(pending.id, 500);
    const sent = await sendManagedCard(
      channel,
      'ou_owner',
      buildCliBridgeQuestionCard({ id: pending.id, source: 'claude', cwd: '/repo', questions }),
      undefined,
      false,
      'open_id',
    );
    setPendingCliMessageId(pending.id, sent.messageId);

    // q0 picked from the dropdown; q1 left to its custom text box → the free text wins.
    const formValue = { q0_choice: 'Fast', q1_custom: '自己写的答案' };
    await dispatcher.handle({
      chatId: 'ou_owner',
      messageId: sent.messageId,
      operator: { openId: 'ou_owner' },
      action: { tag: 'button', value: { a: CLI.questionSubmit, id: pending.id }, form_value: formValue },
      raw: { action: { form_value: formValue } },
    } as never);

    await expect(waiter).resolves.toEqual({
      decision: 'allow',
      updatedInput: { questions, answers: { 'Pick a mode?': 'Fast', 'Extra note?': '自己写的答案' } },
    });
    await vi.waitFor(() => expect(updatedCards).toHaveLength(1));
    expect(updatedCards[0]).toContain('✅ 已回答');
    expect(updatedCards[0]).toContain('自己写的答案');
  });

  it('updates the question card to the answered view after submit', async () => {
    const { channel, createdCards, updatedCards } = managedChannel();
    const service = createCliBridgeService({
      cfg: cfg('always'),
      channel,
      socketPath: '/tmp/unused',
      presence: async () => ({ routeToFeishu: true, reason: 'always' }),
    });
    const pending = service.handleMessage({
      type: 'permission_request',
      source: 'claude',
      sessionId: 'question-session',
      cwd: '/repo',
      toolName: 'AskUserQuestion',
      toolInput: { questions: [{ question: 'Pick a mode?', options: [{ label: 'Fast' }, { label: 'Safe' }] }] },
      hookEventName: 'PermissionRequest',
      bridgeOwned: false,
      rawPayloadBytes: 2,
    });
    await vi.waitFor(() => expect(createdCards).toHaveLength(1));
    const submit = actionValue(JSON.parse(createdCards[0] ?? '{}'), CLI.questionSubmit);
    expect(service.resolveQuestionSubmit(String(submit?.id), { q0_choice: 'Fast' })).toBe(true);
    await expect(pending).resolves.toEqual({
      decision: 'allow',
      updatedInput: {
        // updatedInput preserves the agent's ORIGINAL toolInput verbatim, then adds answers.
        questions: [{ question: 'Pick a mode?', options: [{ label: 'Fast' }, { label: 'Safe' }] }],
        answers: { 'Pick a mode?': 'Fast' },
      },
    });
    await vi.waitFor(() => expect(updatedCards).toHaveLength(1));
    expect(updatedCards[0]).toContain('✅ 已回答');
    expect(actionValue(JSON.parse(updatedCards[0] ?? '{}'), CLI.questionSubmit)).toBeUndefined();
  });

  it('resolves Stop replies by parent message id', async () => {
    const service = createCliBridgeService({
      cfg: cfg('always'),
      channel: { send: async () => ({ messageId: 'm' }) } as never,
      socketPath: '/tmp/unused',
      presence: async () => ({ routeToFeishu: true, reason: 'always' }),
    });
    const pending = createPendingCliInteraction({
      kind: 'task_completion',
      source: 'claude',
      sessionId: 's',
      cwd: '/repo',
    });
    setPendingCliMessageId(pending.id, 'om_parent');
    const waiter = waitForPendingCliInteraction(pending.id, 500);
    expect(service.resolveReply({ parentId: 'om_parent', text: 'continue with tests' })).toBe(true);
    await expect(waiter).resolves.toEqual({
      decision: 'allow',
      stdout: JSON.stringify({ decision: 'block', reason: 'continue with tests' }),
    });
  });

  it('stamps a Typing reaction on the reply while续聊 runs, then clears it on the next result', async () => {
    const { channel, reactionsAdded, reactionsRemoved } = managedChannel();
    const service = createCliBridgeService({
      cfg: cfg('always'),
      channel,
      socketPath: '/tmp/unused',
      presence: async () => ({ routeToFeishu: true, reason: 'away' }),
      localActivity: async () => true, // no reply window on the continuation card → returns immediately
      localReturnPollMs: 10,
    });
    const pending = createPendingCliInteraction({
      kind: 'task_completion',
      source: 'claude',
      sessionId: 's',
      cwd: '/repo',
    });
    setPendingCliMessageId(pending.id, 'om_card');
    const waiter = waitForPendingCliInteraction(pending.id, 500);

    // owner replies to the completion card → continuation handed to the agent + Typing on the reply
    expect(service.resolveReply({ parentId: 'om_card', text: '最近的 git 信息呢', messageId: 'om_reply' })).toBe(true);
    await waiter;
    await vi.waitFor(() => expect(reactionsAdded).toHaveLength(1));
    expect(reactionsAdded[0]).toMatchObject({ messageId: 'om_reply', emoji: 'Typing' });
    expect(reactionsRemoved).toHaveLength(0);

    // the continuation's result arrives (next Stop, stop_hook_active) → Typing cleared
    await service.handleMessage({
      type: 'task_complete',
      source: 'claude',
      sessionId: 's',
      cwd: '/repo',
      taskStatus: 'completed',
      summary: 'git info here',
      toolInput: {},
      stopHookActive: true,
      bridgeOwned: false,
      rawPayloadBytes: 2,
    });
    await vi.waitFor(() => expect(reactionsRemoved).toHaveLength(1));
    expect(reactionsRemoved[0]).toMatchObject({ messageId: 'om_reply', reactionId: reactionsAdded[0]?.reactionId });
  });

  it('resolves Stop replies for codex pendings too (shared {decision:block} continuation contract)', async () => {
    const service = createCliBridgeService({
      cfg: cfg('always'),
      channel: { send: async () => ({ messageId: 'm' }) } as never,
      socketPath: '/tmp/unused',
      presence: async () => ({ routeToFeishu: true, reason: 'always' }),
    });
    const pending = createPendingCliInteraction({
      kind: 'task_completion',
      source: 'codex',
      sessionId: 's',
      cwd: '/repo',
    });
    setPendingCliMessageId(pending.id, 'om_codex');
    const waiter = waitForPendingCliInteraction(pending.id, 500);
    expect(service.resolveReply({ parentId: 'om_codex', text: 'keep going' })).toBe(true);
    await expect(waiter).resolves.toEqual({
      decision: 'allow',
      stdout: JSON.stringify({ decision: 'block', reason: 'keep going' }),
    });
  });

  it('onMessage swallows a stray reply aimed at a live approval card without resolving it', () => {
    const service = createCliBridgeService({
      cfg: cfg('always'),
      channel: { send: async () => ({ messageId: 'm' }) } as never,
      socketPath: '/tmp/unused',
      presence: async () => ({ routeToFeishu: true, reason: 'always' }),
    });
    const pending = createPendingCliInteraction({
      kind: 'permission',
      source: 'claude',
      sessionId: 's',
      cwd: '/repo',
    });
    setPendingCliMessageId(pending.id, 'om_perm');
    // A text reply to the still-pending approval card is swallowed (true) so it does
    // not fall through to the DM 菜单, but it must NOT resolve the permission — only
    // the card buttons do that.
    expect(service.onMessage({ parentId: 'om_perm', text: 'please allow' })).toBe(true);
    expect(getPendingCliInteraction(pending.id)?.kind).toBe('permission');
  });

  it('onMessage lets unrelated p2p messages through to the console', () => {
    const service = createCliBridgeService({
      cfg: cfg('always'),
      channel: { send: async () => ({ messageId: 'm' }) } as never,
      socketPath: '/tmp/unused',
      presence: async () => ({ routeToFeishu: true, reason: 'always' }),
    });
    expect(service.onMessage({ parentId: 'om_nope', text: 'hello' })).toBe(false);
  });

  it('starts only when enabled and owner exists', () => {
    expect(shouldStartCliBridge(cfg('always'))).toBe(true);
    expect(shouldStartCliBridge({
      accounts: { app: { id: 'app', secret: 'secret', tenant: 'feishu' } },
      preferences: { cliBridge: { enabled: true } },
    })).toBe(false);
  });
});

describe('cli bridge notify scope + keep-awake', () => {
  const baseMsg = {
    type: 'permission_request' as const,
    source: 'codex' as const,
    sessionId: 's',
    cwd: '/repo',
    toolName: 'Bash',
    hookEventName: 'PermissionRequest',
    toolInput: { command: 'git status' },
    bridgeOwned: false,
    rawPayloadBytes: 2,
  };

  function scopeCfg(notifyScope: 'all' | 'bound_projects' | 'none'): AppConfig {
    return {
      accounts: { app: { id: 'app', secret: 'secret', tenant: 'feishu' } },
      preferences: {
        access: { ownerOpenId: 'ou_owner' },
        cliBridge: { enabled: true, delivery: 'always', notifyScope },
      },
    };
  }

  it('swallows everything when notify scope is none', async () => {
    const service = createCliBridgeService({
      cfg: scopeCfg('none'),
      channel: { send: async () => ({ messageId: 'm' }) } as never,
      socketPath: '/tmp/unused',
      presence: async () => ({ routeToFeishu: true, reason: 'always' }),
    });
    await expect(service.handleMessage({ ...baseMsg })).resolves.toEqual({
      decision: 'fallback_local',
      reason: 'notify_scope',
    });
  });

  it('skips cwds outside any bound project under bound_projects scope', async () => {
    const service = createCliBridgeService({
      cfg: scopeCfg('bound_projects'),
      channel: { send: async () => ({ messageId: 'm' }) } as never,
      socketPath: '/tmp/unused',
      presence: async () => ({ routeToFeishu: true, reason: 'always' }),
      isBoundProject: (cwd) => cwd === '/bound',
    });
    await expect(service.handleMessage({ ...baseMsg, cwd: '/elsewhere' })).resolves.toEqual({
      decision: 'fallback_local',
      reason: 'notify_scope',
    });
  });

  it('forwards cwds inside a bound project under bound_projects scope', async () => {
    const { channel, createdCards } = managedChannel();
    const service = createCliBridgeService({
      cfg: scopeCfg('bound_projects'),
      channel,
      socketPath: '/tmp/unused',
      presence: async () => ({ routeToFeishu: true, reason: 'always' }),
      isBoundProject: (cwd) => cwd === '/bound',
    });
    const pending = service.handleMessage({ ...baseMsg, cwd: '/bound' });
    await vi.waitFor(() => expect(createdCards).toHaveLength(1));
    const approve = actionValue(JSON.parse(createdCards[0] ?? '{}'), CLI.approveOnce);
    service.resolveAction({ actionId: CLI.approveOnce, id: String(approve?.id) });
    await expect(pending).resolves.toEqual({ decision: 'allow' });
  });

  it('holds a keep-awake assertion only for the duration of a Feishu wait', async () => {
    const { channel, createdCards } = managedChannel();
    const events: string[] = [];
    const keepAwake = {
      acquire: () => { events.push('acquire'); },
      release: () => { events.push('release'); },
      shutdown: () => { events.push('shutdown'); },
      isActive: () => false,
    };
    const service = createCliBridgeService({
      cfg: cfg('always'),
      channel,
      socketPath: '/tmp/unused',
      presence: async () => ({ routeToFeishu: true, reason: 'always' }),
      keepAwake,
    });
    const pending = service.handleMessage({ ...baseMsg });
    await vi.waitFor(() => expect(createdCards).toHaveLength(1));
    // acquired while blocking on the wait, not yet released
    expect(events).toContain('acquire');
    expect(events).not.toContain('release');
    const approve = actionValue(JSON.parse(createdCards[0] ?? '{}'), CLI.approveOnce);
    service.resolveAction({ actionId: CLI.approveOnce, id: String(approve?.id) });
    await expect(pending).resolves.toEqual({ decision: 'allow' });
    expect(events).toEqual(['acquire', 'release']);
  });

  it('does not keep the machine awake when local and no Feishu wait happens', async () => {
    const events: string[] = [];
    const keepAwake = {
      acquire: () => { events.push('acquire'); },
      release: () => { events.push('release'); },
      shutdown: () => { events.push('shutdown'); },
      isActive: () => false,
    };
    const service = createCliBridgeService({
      cfg: cfg('away_only'),
      channel: { send: async () => ({ messageId: 'm' }) } as never,
      socketPath: '/tmp/unused',
      presence: async () => ({ routeToFeishu: false, reason: 'local_active' }),
      keepAwake,
    });
    await expect(service.handleMessage({ ...baseMsg })).resolves.toEqual({
      decision: 'fallback_local',
      reason: 'local_active',
    });
    expect(events).toEqual([]);
  });

  it('keeps auto-allowing a session-approved session after notify scope is narrowed', async () => {
    const { channel, createdCards } = managedChannel();
    const liveCfg: AppConfig = {
      accounts: { app: { id: 'app', secret: 'secret', tenant: 'feishu' } },
      preferences: {
        access: { ownerOpenId: 'ou_owner' },
        cliBridge: { enabled: true, delivery: 'always', notifyScope: 'all' },
      },
    };
    const service = createCliBridgeService({
      cfg: liveCfg,
      channel,
      socketPath: '/tmp/unused',
      presence: async () => ({ routeToFeishu: true, reason: 'always' }),
    });
    // 1) blanket-approve session S in an unbound cwd (scope is still 'all')
    const first = service.handleMessage({ ...baseMsg, sessionId: 'S', cwd: '/unbound' });
    await vi.waitFor(() => expect(createdCards).toHaveLength(1));
    const approve = actionValue(JSON.parse(createdCards[0] ?? '{}'), CLI.approveSession);
    service.resolveAction({ actionId: CLI.approveSession, id: String(approve?.id) });
    await expect(first).resolves.toEqual({ decision: 'allow' });
    // 2) narrow the notify scope at runtime so /unbound is now out of scope
    liveCfg.preferences!.cliBridge!.notifyScope = 'none';
    // 3) the same session must still SILENTLY auto-allow (the 本会话放行 contract),
    //    not drop to a local re-prompt — and no new card is forwarded.
    await expect(service.handleMessage({ ...baseMsg, sessionId: 'S', cwd: '/unbound' }))
      .resolves.toEqual({ decision: 'allow' });
    expect(createdCards).toHaveLength(1);
  });
});

describe('cli bridge away heads-up (检测到离开)', () => {
  const baseMsg = {
    type: 'permission_request' as const,
    source: 'codex' as const,
    sessionId: 's',
    cwd: '/repo',
    toolName: 'Bash',
    hookEventName: 'PermissionRequest',
    toolInput: { command: 'git status' },
    bridgeOwned: false,
    rawPayloadBytes: 2,
  };
  const idOf = (json: string | undefined, action: string): string =>
    String(actionValue(JSON.parse(json ?? '{}'), action)?.id);

  it('sends a one-time heads-up before the first forwarded card, not repeated within the away period', async () => {
    const { channel, createdCards } = managedChannel();
    const service = createCliBridgeService({
      cfg: cfg('away_only'),
      channel,
      socketPath: '/tmp/unused',
      presence: async () => ({ routeToFeishu: true, reason: 'away' }),
    });
    // first away forward → heads-up card FIRST, then the permission card
    const first = service.handleMessage({ ...baseMsg, sessionId: 'A' });
    await vi.waitFor(() => expect(createdCards).toHaveLength(2));
    expect(createdCards[0]).toContain('当前项目');
    expect(actionValue(JSON.parse(createdCards[1] ?? '{}'), CLI.approveOnce)).toBeTruthy();
    service.resolveAction({ actionId: CLI.approveOnce, id: idOf(createdCards[1], CLI.approveOnce) });
    await expect(first).resolves.toEqual({ decision: 'allow' });

    // second forward, same away period → NO new heads-up, just the permission card
    const second = service.handleMessage({ ...baseMsg, sessionId: 'B' });
    await vi.waitFor(() => expect(createdCards).toHaveLength(3));
    expect(createdCards[2]).not.toContain('当前项目');
    service.resolveAction({ actionId: CLI.approveOnce, id: idOf(createdCards[2], CLI.approveOnce) });
    await expect(second).resolves.toEqual({ decision: 'allow' });
  });

  it('does not announce when forwarding is gated off (only fires on genuine away)', async () => {
    const { channel, createdCards } = managedChannel();
    const service = createCliBridgeService({
      cfg: cfg('away_only'),
      channel: { send: async () => ({ messageId: 'm' }) } as never,
      socketPath: '/tmp/unused',
      presence: async () => ({ routeToFeishu: false, reason: 'local_active' }),
    });
    await expect(service.handleMessage({ ...baseMsg })).resolves.toEqual({ decision: 'fallback_local', reason: 'local_active' });
    expect(createdCards).toHaveLength(0);
  });

  it('re-announces after the user returns and then leaves again', async () => {
    const { channel, createdCards } = managedChannel();
    let phase = 'away';
    const service = createCliBridgeService({
      cfg: cfg('away_only'),
      channel,
      socketPath: '/tmp/unused',
      presence: async () => phase === 'home'
        ? ({ routeToFeishu: false, reason: 'local_active' as const })
        : ({ routeToFeishu: true, reason: 'away' as const }),
    });
    // away period 1 → heads-up + card
    const a1 = service.handleMessage({ ...baseMsg, sessionId: 'A' });
    await vi.waitFor(() => expect(createdCards).toHaveLength(2));
    expect(createdCards[0]).toContain('当前项目');
    service.resolveAction({ actionId: CLI.approveOnce, id: idOf(createdCards[1], CLI.approveOnce) });
    await expect(a1).resolves.toEqual({ decision: 'allow' });

    // user comes back: a hook while home → local fallback, which re-arms the heads-up
    phase = 'home';
    await expect(service.handleMessage({ ...baseMsg, sessionId: 'A' }))
      .resolves.toEqual({ decision: 'fallback_local', reason: 'local_active' });

    // leaves again → heads-up announced a second time
    phase = 'away';
    const a2 = service.handleMessage({ ...baseMsg, sessionId: 'C' });
    await vi.waitFor(() => expect(createdCards).toHaveLength(4));
    expect(createdCards[2]).toContain('当前项目');
    service.resolveAction({ actionId: CLI.approveOnce, id: idOf(createdCards[3], CLI.approveOnce) });
    await expect(a2).resolves.toEqual({ decision: 'allow' });
  });

  it('does not announce when the only away activity is silently session-allowed', async () => {
    const { channel, createdCards } = managedChannel();
    let phase = 'away';
    const service = createCliBridgeService({
      cfg: cfg('away_only'),
      channel,
      socketPath: '/tmp/unused',
      presence: async () => phase === 'home'
        ? ({ routeToFeishu: false, reason: 'local_active' as const })
        : ({ routeToFeishu: true, reason: 'away' as const }),
    });
    // away1: blanket-approve session S → heads-up(0) + card(1)
    const a1 = service.handleMessage({ ...baseMsg, sessionId: 'S' });
    await vi.waitFor(() => expect(createdCards).toHaveLength(2));
    service.resolveAction({ actionId: CLI.approveSession, id: idOf(createdCards[1], CLI.approveSession) });
    await expect(a1).resolves.toEqual({ decision: 'allow' });

    // return → re-arms heads-up
    phase = 'home';
    await expect(service.handleMessage({ ...baseMsg, sessionId: 'S' }))
      .resolves.toEqual({ decision: 'fallback_local', reason: 'local_active' });

    // leave again; S is now silently cache-allowed → NO heads-up, NO new card
    phase = 'away';
    await expect(service.handleMessage({ ...baseMsg, sessionId: 'S' })).resolves.toEqual({ decision: 'allow' });
    expect(createdCards).toHaveLength(2);
  });
});
