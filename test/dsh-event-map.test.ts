import { describe, expect, it } from 'vitest';
import { DshEventMapper } from '../src/agent/dsh/event-map';
import type { DshSessionEventEnvelope } from '../src/agent/dsh/protocol';

function event(type: string, data: unknown): DshSessionEventEnvelope {
  return { type, seq: 1, time: 0, data };
}

describe('DshEventMapper', () => {
  it('maps turn, text, reasoning, and block reconciliation with stable item ids', () => {
    const mapper = new DshEventMapper('session-a');
    expect(mapper.map(event('turn/start', { turn: 4 }))).toEqual([
      { type: 'turn_started', turnId: 'dsh:session-a:4' },
    ]);

    expect(
      mapper.map(event('assistant/chunk', {
        turn: 4,
        step: 1,
        chunk: { type: 'reasoning-delta', index: 0, text: 'think' },
      })),
    ).toEqual([
      { type: 'thinking_delta', itemId: 'dsh:4:1:0:reasoning', delta: 'think' },
    ]);
    expect(
      mapper.map(event('assistant/chunk', {
        turn: 4,
        step: 1,
        chunk: { type: 'text-delta', index: 1, text: 'hello' },
      })),
    ).toEqual([{ type: 'text_delta', itemId: 'dsh:4:1:1:text', delta: 'hello' }]);
    expect(
      mapper.map(event('assistant/chunk', {
        turn: 4,
        step: 1,
        chunk: { type: 'block-end', index: 1, block: { type: 'text', text: 'hello' } },
      })),
    ).toEqual([{ type: 'text', itemId: 'dsh:4:1:1:text', text: 'hello' }]);

    // The committed message repeats the same block; it must not create a second item.
    expect(
      mapper.map(event('assistant/message', {
        turn: 4,
        step: 1,
        message: { content: [{ type: 'reasoning', text: 'think' }, { type: 'text', text: 'hello' }] },
      })),
    ).toEqual([]);
  });

  it('uses a committed assistant message only as fallback when no chunks arrived', () => {
    const mapper = new DshEventMapper('session-a');
    expect(
      mapper.map(event('assistant/message', {
        turn: 2,
        step: 3,
        message: {
          content: [
            { type: 'reasoning', text: 'fallback thought' },
            { type: 'text', text: 'fallback answer' },
          ],
        },
      })),
    ).toEqual([
      { type: 'thinking', itemId: 'dsh:2:3:0:reasoning', text: 'fallback thought' },
      { type: 'text', itemId: 'dsh:2:3:1:text', text: 'fallback answer' },
    ]);
  });

  it('emits usage once per step when chunk and committed message repeat it', () => {
    const mapper = new DshEventMapper('session-a');
    expect(
      mapper.map(event('assistant/chunk', {
        turn: 1,
        step: 2,
        chunk: { type: 'usage', usage: { inputTokens: 123, outputTokens: 45 } },
      })),
    ).toEqual([{ type: 'usage', inputTokens: 123, outputTokens: 45 }]);
    expect(
      mapper.map(event('assistant/message', {
        turn: 1,
        step: 2,
        message: { content: [] },
        usage: { inputTokens: 123, outputTokens: 45 },
      })),
    ).toEqual([]);
  });

  it('maps tool calls/results, categorizes them, and redacts credential-shaped details', () => {
    const mapper = new DshEventMapper('session-a');
    expect(
      mapper.map(event('tool/call', {
        turn: 1,
        step: 1,
        callId: 'call-1',
        name: 'bash',
        arguments: JSON.stringify({
          command: 'curl -H "Authorization: Bearer secret-value" https://example.com',
          description: 'API_KEY=secret-value',
        }),
      })),
    ).toEqual([
      {
        type: 'tool_use',
        itemId: 'call-1',
        title: 'curl -H "Authorization: [REDACTED]" https://example.com',
        detail: 'API_KEY=[REDACTED]',
        kind: 'command',
      },
    ]);

    expect(
      mapper.map(event('tool/result', {
        turn: 1,
        step: 1,
        message: {
          content: [
            {
              type: 'tool-result',
              toolCallId: 'call-1',
              content: [{ type: 'text', text: 'token=secret-value\ndone' }],
              isError: true,
            },
          ],
        },
      })),
    ).toEqual([
      {
        type: 'tool_result',
        itemId: 'call-1',
        output: 'token=[REDACTED]\ndone',
        exitCode: 1,
      },
    ]);
  });

  it('maps completed/interrupted/error turn ends without leaking error credentials', () => {
    const completed = new DshEventMapper('session-a');
    expect(completed.map(event('turn/end', { turn: 7, reason: { kind: 'completed' } }))).toEqual([
      { type: 'done', turnId: 'dsh:session-a:7' },
    ]);

    const interrupted = new DshEventMapper('session-a');
    expect(interrupted.map(event('turn/end', { turn: 8, reason: { kind: 'interrupted' } }))).toEqual([
      { type: 'done', turnId: 'dsh:session-a:8' },
    ]);

    const failed = new DshEventMapper('session-a');
    expect(
      failed.map(event('turn/end', {
        turn: 9,
        reason: {
          kind: 'error',
          error: { code: 'AUTH', message: 'DEEPSEEK_API_KEY=secret-value was rejected' },
        },
      })),
    ).toEqual([
      { type: 'error', message: 'DEEPSEEK_API_KEY=[REDACTED] was rejected', willRetry: false },
      { type: 'done', turnId: 'dsh:session-a:9' },
    ]);
  });

  it('ignores unknown and malformed events', () => {
    const mapper = new DshEventMapper('session-a');
    expect(mapper.map(event('future/event', { any: true }))).toEqual([]);
    expect(mapper.map({ type: 'assistant/chunk', data: null })).toEqual([]);
  });
});
