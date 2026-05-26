import { describe, expect, it } from 'vitest';
import { mapNotification } from '../src/agent/codex-appserver/event-map';
import type { ServerNotification, ThreadItem } from '../src/agent/codex-appserver/protocol';

function notification(method: string, params: unknown): ServerNotification {
  return { method, params } as ServerNotification;
}

function itemStarted(item: ThreadItem): ServerNotification {
  return notification('item/started', { item, threadId: 'thread-1', turnId: 'turn-1', startedAtMs: 1 });
}

function itemCompleted(item: ThreadItem): ServerNotification {
  return notification('item/completed', { item, threadId: 'thread-1', turnId: 'turn-1', completedAtMs: 2 });
}

describe('mapNotification', () => {
  it('maps thread and turn lifecycle notifications', () => {
    expect(mapNotification(notification('thread/started', { thread: { id: 'thread-1' } }))).toEqual({
      type: 'system',
      threadId: 'thread-1',
    });
    expect(mapNotification(notification('turn/started', { turn: { id: 'turn-1' } }))).toEqual({
      type: 'turn_started',
      turnId: 'turn-1',
    });
    expect(mapNotification(notification('turn/completed', { turn: { id: 'turn-1' } }))).toEqual({
      type: 'done',
      turnId: 'turn-1',
    });
    expect(
      mapNotification(notification('error', {
        error: { message: 'network failed' },
        willRetry: true,
        threadId: 'thread-1',
        turnId: 'turn-1',
      })),
    ).toEqual({ type: 'error', message: 'network failed', willRetry: true });
  });

  it('maps agent message deltas and completed text', () => {
    expect(
      mapNotification(notification('item/agentMessage/delta', {
        itemId: 'msg-1',
        delta: 'hello',
        threadId: 'thread-1',
        turnId: 'turn-1',
      })),
    ).toEqual({ type: 'text_delta', itemId: 'msg-1', delta: 'hello' });

    expect(mapNotification(itemCompleted({ type: 'agentMessage', id: 'msg-1', text: 'hello world' } as ThreadItem))).toEqual({
      type: 'text',
      itemId: 'msg-1',
      text: 'hello world',
    });
  });

  it('maps reasoning deltas and completed reasoning text', () => {
    expect(
      mapNotification(notification('item/reasoning/textDelta', {
        itemId: 'reason-1',
        delta: 'thinking',
        threadId: 'thread-1',
        turnId: 'turn-1',
      })),
    ).toEqual({ type: 'thinking_delta', itemId: 'reason-1', delta: 'thinking' });

    expect(
      mapNotification(
        itemCompleted({ type: 'reasoning', id: 'reason-1', content: ['step 1', 'step 2'], summary: [] } as ThreadItem),
      ),
    ).toEqual({ type: 'thinking', itemId: 'reason-1', text: 'step 1\nstep 2' });

    expect(
      mapNotification(itemCompleted({ type: 'reasoning', id: 'reason-2', content: [], summary: ['summary'] } as ThreadItem)),
    ).toEqual({ type: 'thinking', itemId: 'reason-2', text: 'summary' });
  });

  it('maps command execution start and completion', () => {
    expect(
      mapNotification(itemStarted({ type: 'commandExecution', id: 'cmd-1', command: 'npm test', cwd: '/repo' } as ThreadItem)),
    ).toEqual({ type: 'tool_use', itemId: 'cmd-1', title: 'npm test', detail: '/repo' });

    expect(
      mapNotification(
        itemCompleted({
          type: 'commandExecution',
          id: 'cmd-1',
          aggregatedOutput: 'ok',
          exitCode: 0,
        } as ThreadItem),
      ),
    ).toEqual({ type: 'tool_result', itemId: 'cmd-1', output: 'ok', exitCode: 0 });

    expect(
      mapNotification(
        itemCompleted({ type: 'commandExecution', id: 'cmd-2', aggregatedOutput: null, exitCode: 1 } as ThreadItem),
      ),
    ).toEqual({ type: 'tool_result', itemId: 'cmd-2', output: undefined, exitCode: 1 });
  });

  it('maps supported non-command tool items to tool events', () => {
    expect(mapNotification(itemStarted({ type: 'fileChange', id: 'file-1' } as ThreadItem))).toEqual({
      type: 'tool_use',
      itemId: 'file-1',
      title: '编辑文件',
    });
    expect(mapNotification(itemStarted({ type: 'webSearch', id: 'search-1' } as ThreadItem))).toEqual({
      type: 'tool_use',
      itemId: 'search-1',
      title: '联网搜索',
    });
    expect(mapNotification(itemStarted({ type: 'mcpToolCall', id: 'mcp-1' } as ThreadItem))).toEqual({
      type: 'tool_use',
      itemId: 'mcp-1',
      title: '工具调用',
    });
    expect(mapNotification(itemCompleted({ type: 'dynamicToolCall', id: 'dyn-1' } as ThreadItem))).toEqual({
      type: 'tool_result',
      itemId: 'dyn-1',
    });
  });

  it('returns null for noisy or unsupported notifications', () => {
    for (const method of [
      'hook/started',
      'mcpServer/startupStatus/updated',
      'account/updated',
      'thread/status/changed',
    ]) {
      expect(mapNotification(notification(method, {}))).toBeNull();
    }
    expect(mapNotification(itemStarted({ type: 'userMessage', id: 'user-1' } as ThreadItem))).toBeNull();
  });
});
