import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../src/agent/types';
import { buildRunCard } from '../src/card/run-card';
import { initialState, reasoningContent, reduce, type Block, type RunState } from '../src/card/run-state';

function run(events: AgentEvent[]): RunState {
  let s = initialState;
  for (const ev of events) s = reduce(s, ev);
  return s;
}

const texts = (s: RunState): string[] =>
  s.blocks.filter((b): b is Extract<Block, { kind: 'text' }> => b.kind === 'text').map((b) => b.content);
const tools = (s: RunState): Extract<Block, { kind: 'tool' }>[] =>
  s.blocks.filter((b): b is Extract<Block, { kind: 'tool' }> => b.kind === 'tool');

describe('reduce', () => {
  it('starts running with no blocks', () => {
    const s = run([]);
    expect(s.terminal).toBe('running');
    expect(s.blocks).toHaveLength(0);
  });

  it('accumulates text deltas per item, preserving first-seen order', () => {
    const s = run([
      { type: 'text_delta', itemId: 'a', delta: 'hello' },
      { type: 'text_delta', itemId: 'b', delta: 'second' },
      { type: 'text_delta', itemId: 'a', delta: ' world' },
      { type: 'done', turnId: 'turn-1' },
    ]);
    expect(texts(s)).toEqual(['hello world', 'second']);
    expect(s.terminal).toBe('done');
  });

  it('reconciles a streamed item with its completed text', () => {
    const s = run([
      { type: 'text_delta', itemId: 'a', delta: 'partial' },
      { type: 'text', itemId: 'a', text: 'final text' },
    ]);
    expect(texts(s)).toEqual(['final text']);
  });

  it('derives tool status from exit code', () => {
    const s = run([
      { type: 'tool_use', itemId: 'ok', title: 'npm test' },
      { type: 'tool_use', itemId: 'fail', title: 'npm run build' },
      { type: 'tool_result', itemId: 'ok', exitCode: 0 },
      { type: 'tool_result', itemId: 'fail', exitCode: 2 },
    ]);
    const t = tools(s);
    expect(t.map((b) => b.tool.status)).toEqual(['done', 'error']);
  });

  it('treats a missing exit code as success', () => {
    const s = run([
      { type: 'tool_use', itemId: 't1', title: 'custom tool' },
      { type: 'tool_result', itemId: 't1' },
    ]);
    expect(tools(s)[0]!.tool.status).toBe('done');
  });

  it('accumulates reasoning deltas and reconciles the final text', () => {
    const streaming = run([
      { type: 'thinking_delta', itemId: 'r', delta: 'think' },
      { type: 'thinking_delta', itemId: 'r', delta: 'ing' },
    ]);
    expect(reasoningContent(streaming)).toBe('thinking');
    expect(streaming.reasoningActive).toBe(true);

    const final = run([
      { type: 'thinking_delta', itemId: 'r', delta: 'partial' },
      { type: 'thinking', itemId: 'r', text: 'full reasoning' },
    ]);
    expect(reasoningContent(final)).toBe('full reasoning');
  });

  it('captures error terminal state', () => {
    const s = run([
      { type: 'text', itemId: 'm', text: 'hello' },
      { type: 'error', message: 'boom', willRetry: false },
    ]);
    expect(s.terminal).toBe('error');
    expect(s.errorMsg).toBe('boom');
  });
});

describe('buildRunCard', () => {
  it('renders no header and streams while running', () => {
    const rs = run([{ type: 'text_delta', itemId: 'a', delta: 'hi' }]);
    const card = buildRunCard({ rs, cardKey: 'm1' }) as { header?: unknown; config: { streaming_mode?: boolean } };
    expect(card.header).toBeUndefined();
    expect(card.config.streaming_mode).toBe(true);
  });

  it('drops tool blocks when showTools is false', () => {
    const rs = run([
      { type: 'tool_use', itemId: 't1', title: 'npm test' },
      { type: 'text', itemId: 'm1', text: 'text only' },
      { type: 'done', turnId: 'turn-1' },
    ]);
    const json = JSON.stringify(buildRunCard({ rs, showTools: false }));
    expect(json).not.toContain('npm test');
    expect(json).toContain('text only');
  });
});
