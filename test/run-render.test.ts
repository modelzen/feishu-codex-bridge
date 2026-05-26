import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../src/agent/types';
import { RunRender } from '../src/card/run-render';

function render(events: AgentEvent[]): string {
  const r = new RunRender();
  for (const ev of events) r.apply(ev);
  return r.markdown();
}

describe('RunRender', () => {
  it('returns the running empty state before content arrives', () => {
    expect(new RunRender().markdown()).toBe('✍️ 正在输出…');
  });

  it('accumulates text deltas while preserving first-seen item order', () => {
    expect(
      render([
        { type: 'text_delta', itemId: 'a', delta: 'hello' },
        { type: 'text_delta', itemId: 'b', delta: 'second' },
        { type: 'text_delta', itemId: 'a', delta: ' world' },
        { type: 'done', turnId: 'turn-1' },
      ]),
    ).toBe('hello world\nsecond');
  });

  it('uses completed text as reconciliation for an item', () => {
    expect(
      render([
        { type: 'text_delta', itemId: 'a', delta: 'partial' },
        { type: 'text', itemId: 'a', text: 'final text' },
        { type: 'done', turnId: 'turn-1' },
      ]),
    ).toBe('final text');
  });

  it('renders tool state markers and keeps tools ahead of text', () => {
    expect(
      render([
        { type: 'tool_use', itemId: 'tool-ok', title: 'npm test' },
        { type: 'tool_use', itemId: 'tool-fail', title: 'npm run build' },
        { type: 'tool_result', itemId: 'tool-ok', exitCode: 0 },
        { type: 'tool_result', itemId: 'tool-fail', exitCode: 2 },
        { type: 'text', itemId: 'msg-1', text: 'done with tools' },
        { type: 'done', turnId: 'turn-1' },
      ]),
    ).toBe('✓ `npm test`\n✗ `npm run build`\n\ndone with tools');
  });

  it('marks unknown or missing tool exit codes as completed successfully', () => {
    expect(
      render([
        { type: 'tool_use', itemId: 'tool-1', title: 'custom tool' },
        { type: 'tool_result', itemId: 'tool-1' },
        { type: 'done', turnId: 'turn-1' },
      ]),
    ).toBe('✓ `custom tool`');
  });

  it('renders running, done, and error statuses', () => {
    expect(render([{ type: 'text', itemId: 'msg-1', text: 'hello' }])).toBe('hello\n\n✍️ 正在输出…');
    expect(
      render([
        { type: 'text', itemId: 'msg-1', text: 'hello' },
        { type: 'done', turnId: 'turn-1' },
      ]),
    ).toBe('hello');
    expect(
      render([
        { type: 'text', itemId: 'msg-1', text: 'hello' },
        { type: 'error', message: 'boom', willRetry: false },
      ]),
    ).toBe('hello\n\n❌ boom');
  });

  it('can hide tool calls without losing text output', () => {
    const r = new RunRender();
    r.showTools = false;
    r.apply({ type: 'tool_use', itemId: 'tool-1', title: 'npm test' });
    r.apply({ type: 'text', itemId: 'msg-1', text: 'text only' });
    r.apply({ type: 'done', turnId: 'turn-1' });

    expect(r.markdown()).toBe('text only');
  });
});
