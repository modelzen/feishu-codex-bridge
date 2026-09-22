import { describe, expect, it } from 'vitest';
import { initialState, reduce } from '../src/card/run-state';
import { runSegment } from '../src/card/run-segment';

describe('steer display segments', () => {
  it('subtracts text and reasoning prefixes from deltas and final snapshots', () => {
    let state = reduce(initialState, { type: 'thinking_delta', itemId: 'r', delta: 'old thought' });
    state = reduce(state, { type: 'text_delta', itemId: 'a', delta: 'old answer' });
    const boundary = state;
    state = reduce(state, { type: 'thinking', itemId: 'r', text: 'old thought + new thought' });
    state = reduce(state, { type: 'text', itemId: 'a', text: 'old answer + new answer' });
    const segment = runSegment(state, boundary, 123);
    expect(segment.blocks).toMatchObject([
      { kind: 'reasoning', content: ' + new thought' },
      { kind: 'text', content: ' + new answer' },
    ]);
    expect(segment.reasoning).toEqual([{ id: 'r', text: ' + new thought' }]);
    expect(segment.startedAt).toBe(123);
    expect(runSegment(boundary, boundary).blocks).toEqual([]);
  });

  it('retains a corrected final answer when the backend rewrites its prefix', () => {
    const boundary = reduce(initialState, { type: 'text_delta', itemId: 'a', delta: 'draft' });
    const state = reduce(boundary, { type: 'text', itemId: 'a', text: 'corrected final' });
    expect(runSegment(state, boundary).blocks).toMatchObject([{ content: 'corrected final' }]);
  });

  it('keeps results for tools in flight at the boundary without replaying finished tools', () => {
    let state = reduce(initialState, { type: 'tool_use', itemId: 'done', title: 'done' });
    state = reduce(state, { type: 'tool_result', itemId: 'done', output: 'old result' });
    state = reduce(state, { type: 'tool_use', itemId: 'live', title: 'in flight' });
    const boundary = state;
    state = reduce(state, { type: 'tool_result', itemId: 'live', output: 'new result' });
    expect(runSegment(state, boundary).blocks).toMatchObject([
      { kind: 'tool', tool: { id: 'live', output: 'new result', status: 'done' } },
    ]);
  });
});
