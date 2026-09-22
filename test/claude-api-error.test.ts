import { afterEach, describe, expect, it } from 'vitest';
import type { Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { createTurnMapper, resultErrorText } from '../src/agent/claude-agent/event-map';
import { ClaudeAgentThread } from '../src/agent/claude-agent/thread';
import type { AgentEvent } from '../src/agent/types';
import { buildRunCard } from '../src/card/run-card';
import { initialState, reduce } from '../src/card/run-state';

// Sanitized SDK fixtures: no provider requests, credentials or local session data.
const msg = (value: unknown): SDKMessage => value as SDKMessage;
const apiErrorText = "API Error: 403 You've reached your 5-hour usage limit.";
const assistant = (fields: Record<string, unknown> = {}, text = apiErrorText) => msg({
  type: 'assistant', uuid: 'test-assistant', session_id: 'test-session', parent_tool_use_id: null,
  message: { role: 'assistant', content: [{ type: 'text', text }] }, ...fields,
});
const apiError = assistant({ error: 'authentication_failed' });
const success = msg({
  type: 'result', subtype: 'success', is_error: false, result: '',
  session_id: 'test-session', usage: { input_tokens: 0, output_tokens: 0 },
});
const failure = msg({
  type: 'result', subtype: 'error_during_execution', is_error: true,
  session_id: 'test-session', errors: ['Provider request rejected'],
  usage: { input_tokens: 0, output_tokens: 0 },
});
const reply = [
  msg({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } }),
  msg({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '正常回复' } } }),
  msg({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } }),
  success,
];

const threads: ClaudeAgentThread[] = [];
afterEach(async () => {
  await Promise.all(threads.splice(0).map((thread) => thread.close()));
});

/** Only replace the external SDK query; exercise the real thread, mapper and card. */
function makeThread(turns: SDKMessage[][], endAfterTurn = false): ClaudeAgentThread {
  let turn = 0;
  const thread = new ClaudeAgentThread({
    sessionId: 'test-session', resume: false, cwd: process.cwd(), permission: {}, settingSources: [],
    query: ({ prompt }) => Object.assign((async function* () {
      for await (const _ of prompt) {
        yield* turns[turn++] ?? [];
        if (endAfterTurn) return;
      }
    })(), {
      getContextUsage: async () => null,
      interrupt: async () => {},
      close: () => {},
    }) as unknown as Query,
  });
  threads.push(thread);
  return thread;
}

async function collect(thread: ClaudeAgentThread, goal = false): Promise<AgentEvent[]> {
  const run = goal ? thread.runGoal('test objective') : thread.runStreamed({ text: 'test input' });
  const events: AgentEvent[] = [];
  for await (const event of run.events) events.push(event);
  return events;
}

describe('Claude API error mapping', () => {
  it.each([
    { error: 'authentication_failed' },
    { isApiErrorMessage: true },
  ])('surfaces explicitly marked assistant errors: %j', (fields) => {
    expect(createTurnMapper().map(assistant(fields))).toEqual([
      { type: 'error', message: apiErrorText, willRetry: false },
    ]);
  });

  it('joins error text blocks without rendering them as a successful answer', () => {
    const events = createTurnMapper().map(assistant({
      error: 'rate_limit', message: { content: [
        { type: 'text', text: 'Request rejected' },
        { type: 'image' },
        { type: 'text', text: 'Try again later' },
      ] },
    }));
    expect(events).toEqual([{ type: 'error', message: 'Request rejected\nTry again later', willRetry: false }]);
  });

  it('retains the error code when the API supplies no text', () => {
    expect(createTurnMapper().map(assistant({ error: 'billing_error' }, ''))).toEqual([
      { type: 'error', message: expect.stringContaining('billing_error'), willRetry: false },
    ]);
  });

  it('does not classify ordinary assistant text by error keywords', () => {
    expect(createTurnMapper().map(assistant())).toEqual([]);
  });

  it.each([false, true])('does not make recoverable max_output_tokens terminal (API flag: %s)', (flag) => {
    expect(createTurnMapper().map(assistant({ error: 'max_output_tokens', isApiErrorMessage: flag }))).toEqual([]);
  });

  it('uses concrete result errors before the generic result/subtype fallback', () => {
    expect(resultErrorText({ errors: ['First failure', '', '  ', null, 'Second failure'], result: 'fallback' }))
      .toBe('First failure\nSecond failure');
  });

  it('retains existing fallbacks when result errors are empty', () => {
    expect(resultErrorText({ errors: [], result: ' legacy detail ' })).toBe('legacy detail');
    expect(resultErrorText({ errors: [' '], subtype: 'error_max_turns' })).toBe('已达到最大轮次限制');
  });
});

it('includes final SDK usage in the failed goal summary', async () => {
  const result = msg({ ...success, usage: { input_tokens: 12, output_tokens: 3 } });
  const events = await collect(makeThread([[apiError, result]]), true);
  expect(events.filter((event) => event.type === 'goal_update').at(-1))
    .toMatchObject({ status: 'blocked', tokensUsed: 15 });
});

describe.each([false, true])('Claude terminal errors (goal: %s)', (goal) => {
  it('keeps the visible failure when the SDK follows it with an empty success result', async () => {
    const events = await collect(makeThread([[apiError, success]]), goal);
    expect(events.filter((event) => event.type === 'error')).toEqual([
      { type: 'error', message: apiErrorText, willRetry: false },
    ]);
    expect(events.some((event) => event.type === 'done')).toBe(false);
    expect(events).toContainEqual({ type: 'usage', inputTokens: 0, outputTokens: 0 });
    const state = events.reduce(reduce, initialState);
    expect(state.terminal).toBe('error');
    expect(JSON.stringify(buildRunCard({ rs: state }))).toContain(apiErrorText);
    if (goal) {
      expect(events.filter((event) => event.type === 'goal_update').map((event) => event.status))
        .toEqual(['active', 'blocked']);
    }
  });

  it('does not replace the first assistant error with duplicate or generic result errors', async () => {
    const events = await collect(makeThread([[apiError, apiError, failure]]), goal);
    expect(events.filter((event) => event.type === 'error')).toEqual([
      { type: 'error', message: apiErrorText, willRetry: false },
    ]);
    expect(events.some((event) => event.type === 'done')).toBe(false);
  });

  it('does not replace a specific API error with a generic process-exit error', async () => {
    const events = await collect(makeThread([[apiError]], true), goal);
    expect(events.filter((event) => event.type === 'error')).toEqual([
      { type: 'error', message: apiErrorText, willRetry: false },
    ]);
  });

  it('drains the failed turn and resets error state for the next turn on the warm query', async () => {
    const thread = makeThread([[apiError, success], reply]);
    await collect(thread, goal);
    const events = await collect(thread, goal);
    expect(events.some((event) => event.type === 'error')).toBe(false);
    expect(events).toContainEqual({ type: 'text', itemId: 'b1', text: '正常回复' });
    expect(events.at(-1)?.type).toBe('done');
    expect(thread.isAlive()).toBe(true);
  });

  it('surfaces a failed result even without an assistant error message', async () => {
    const events = await collect(makeThread([[failure]]), goal);
    expect(events).toContainEqual({ type: 'error', message: 'Provider request rejected', willRetry: false });
    expect(events.some((event) => event.type === 'done')).toBe(false);
  });

  it('does not make a contained subagent API error fail a successful parent turn', async () => {
    const nestedError = assistant({ error: 'rate_limit', parent_tool_use_id: 'test-task' });
    const events = await collect(makeThread([[nestedError, ...reply]]), goal);
    expect(events.some((event) => event.type === 'error' && !event.willRetry)).toBe(false);
    expect(events.reduce(reduce, initialState).terminal).toBe('done');
  });

  it('allows the SDK system/api_retry message to recover normally', async () => {
    const retry = msg({
      type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 3,
      retry_delay_ms: 1000, error_status: 429, error: 'rate_limit',
      uuid: 'test-retry', session_id: 'test-session',
    });
    const events = await collect(makeThread([[retry, ...reply]]), goal);
    expect(events.some((event) => event.type === 'error' && !event.willRetry)).toBe(false);
    expect(events.reduce(reduce, initialState).terminal).toBe('done');
  });

  it('preserves retry feedback for the existing legacy api_retry alias', async () => {
    const events = await collect(makeThread([[msg({ type: 'api_retry' }), ...reply]]), goal);
    expect(events).toContainEqual({ type: 'error', message: '网络波动，正在重试…', willRetry: true });
    expect(events.at(-1)?.type).toBe('done');
    expect(events.reduce(reduce, initialState).terminal).toBe('done');
  });

  it('preserves deliberate interrupt completion for an error result', async () => {
    const thread = makeThread([[failure]]);
    const run = goal ? thread.runGoal('test objective') : thread.runStreamed({ text: 'test input' });
    await thread.abort(run.turnId()!);
    const events: AgentEvent[] = [];
    for await (const event of run.events) events.push(event);
    expect(events.some((event) => event.type === 'error')).toBe(false);
    expect(events.at(-1)?.type).toBe('done');
  });
});
