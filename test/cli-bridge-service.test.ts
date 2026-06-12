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
  const createdCards: string[] = [];
  const updatedCards: string[] = [];
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
        },
      },
    },
  };
  return { channel: channel as never, createdCards, updatedCards };
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
      toolInput: { questions: [{ question: 'Pick', multiSelect: true, options: [{ label: 'A' }, { label: 'B' }] }] },
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
    expect(updatedCards[0]).toContain('✅ **已允许**');
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
    expect(createdCards[0]).toContain('✅ **任务完成**');
    expect(createdCards[0]).not.toContain('回复此消息可继续 Agent 执行');
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
    await vi.waitFor(() => expect(createdCards).toHaveLength(1));
    const done = actionValue(JSON.parse(createdCards[0] ?? '{}'), CLI.taskCompletionDone);
    expect(typeof done?.id).toBe('string');
    expect(service.resolveAction({ actionId: CLI.taskCompletionDone, id: String(done?.id) })).toBe(true);
    // The done-click marker keeps handleMessage's post-wait close from re-rendering
    // the card (resolveAction already did); it's internal-only and ignored downstream.
    await expect(pending).resolves.toEqual({ decision: 'allow', reason: 'task_done_clicked' });
    await vi.waitFor(() => expect(updatedCards).toHaveLength(1));
    expect(updatedCards[0]).toContain('✅ **已确认完成**');
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
    // the original card offered the reply continuation …
    expect(createdCards).toHaveLength(1);
    expect(createdCards[0]).toContain('回复此消息可继续 Agent 执行');
    // … and it gets refreshed to a no-button closed state once the window ends.
    await vi.waitFor(() => expect(updatedCards).toHaveLength(1));
    expect(updatedCards[0]).not.toContain('回复此消息可继续 Agent 执行');
    expect(updatedCards[0]).not.toContain('⏳ 等待确认');
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
    expect(createdCards).toHaveLength(1);
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
    expect(createdCards).toHaveLength(1);
    // Codex's Stop hook honors {decision:'block', reason} just like Claude, so the
    // completion card offers the reply-continuation affordance.
    expect(createdCards[0]).toContain('回复此消息可继续 Agent 执行');
  });

  it('does not re-forward Claude Stop events that are already continuing from a Stop hook', async () => {
    const { channel, createdCards } = managedChannel();
    const service = createCliBridgeService({
      cfg: cfg('always'),
      channel,
      socketPath: '/tmp/unused',
      presence: async () => ({ routeToFeishu: true, reason: 'always' }),
    });

    await expect(service.handleMessage({
      type: 'task_complete',
      source: 'claude',
      sessionId: 's',
      cwd: '/repo',
      taskStatus: 'completed',
      toolInput: {},
      stopHookActive: true,
      bridgeOwned: false,
      rawPayloadBytes: 2,
    })).resolves.toEqual({ decision: 'allow', reason: 'stop_hook_active' });
    expect(createdCards).toHaveLength(0);
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
    await vi.waitFor(() => expect(createdCards).toHaveLength(1));
    const result = await Promise.race([
      pending,
      new Promise((resolve) => setTimeout(() => resolve({ decision: 'too_slow' }), 80)),
    ]);
    if ((result as { decision?: string }).decision === 'too_slow') {
      const approve = actionValue(JSON.parse(createdCards[0] ?? '{}'), CLI.approveOnce);
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
    await vi.waitFor(() => expect(createdCards).toHaveLength(1));
    const result = await Promise.race([
      pending,
      new Promise((resolve) => setTimeout(() => resolve({ decision: 'too_slow' }), 80)),
    ]);
    if ((result as { decision?: string }).decision === 'too_slow') {
      const option = actionValue(JSON.parse(createdCards[0] ?? '{}'), CLI.questionOption);
      service.resolveAction({ actionId: CLI.questionOption, id: String(option?.id), label: String(option?.label) });
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
    const questions = [{ question: 'Pick?', options: [{ label: 'A' }, { label: 'B' }] }];
    const pending = createPendingCliInteraction({
      kind: 'question',
      source: 'claude',
      sessionId: 's',
      cwd: '/repo',
      question: 'Pick?',
      toolInput: { questions },
    });
    const waiter = waitForPendingCliInteraction(pending.id, 500);
    expect(service.resolveAction({ actionId: CLI.questionOption, id: pending.id, label: 'A' })).toBe(true);
    await expect(waiter).resolves.toEqual({
      decision: 'allow',
      updatedInput: { questions, answers: { 'Pick?': 'A' } },
    });
  });

  it('registers the custom-answer button action and opens the custom answer form', async () => {
    const { channel, createdCards, updatedCards } = managedChannel();
    const service = createCliBridgeService({
      cfg: cfg('always'),
      channel,
      socketPath: '/tmp/unused',
      presence: async () => ({ routeToFeishu: true, reason: 'always' }),
    });
    const dispatcher = new CardDispatcher(channel, cfg('always'));
    service.register(dispatcher);
    const pending = createPendingCliInteraction({
      kind: 'question',
      source: 'claude',
      sessionId: 'question-session',
      cwd: '/repo',
      question: 'Pick a mode?',
    });
    const sent = await sendManagedCard(
      channel,
      'ou_owner',
      buildCliBridgeQuestionCard({
        id: pending.id,
        source: 'claude',
        cwd: '/repo',
        question: 'Pick a mode?',
        options: [{ label: 'Fast' }],
      }),
      undefined,
      false,
      'open_id',
    );
    setPendingCliMessageId(pending.id, sent.messageId);

    await dispatcher.handle({
      chatId: 'ou_owner',
      messageId: sent.messageId,
      operator: { openId: 'ou_owner' },
      action: { tag: 'button', value: { a: CLI.questionCustom, id: pending.id } },
    } as never);

    expect(createdCards).toHaveLength(1);
    await vi.waitFor(() => expect(updatedCards).toHaveLength(1));
    expect(updatedCards[0]).toContain('✍️ **等待输入**');
    expect(updatedCards[0]).toContain('提交自定义输入');
    expect(updatedCards[0]).toContain('Pick a mode?');
  });

  it('updates question cards after an option is selected', async () => {
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
    const option = actionValue(JSON.parse(createdCards[0] ?? '{}'), CLI.questionOption);
    expect(service.resolveAction({ actionId: CLI.questionOption, id: String(option?.id), label: String(option?.label) })).toBe(true);
    await expect(pending).resolves.toEqual({
      decision: 'allow',
      updatedInput: {
        questions: [{ question: 'Pick a mode?', options: [{ label: 'Fast' }, { label: 'Safe' }] }],
        answers: { 'Pick a mode?': 'Fast' },
      },
    });
    await vi.waitFor(() => expect(updatedCards).toHaveLength(1));
    expect(updatedCards[0]).toContain('✅ **已选择**');
    expect(updatedCards[0]).toContain('已选择：Fast');
    expect(actionValue(JSON.parse(updatedCards[0] ?? '{}'), CLI.questionOption)).toBeUndefined();
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
