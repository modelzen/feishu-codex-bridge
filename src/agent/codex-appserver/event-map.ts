import type { AgentEvent } from '../types';
import type { ServerNotification, ThreadItem } from './protocol';

/**
 * Map one app-server ServerNotification to a normalized AgentEvent.
 * Returns null for notifications we don't surface (M1 subset).
 *
 * Streaming: token-level deltas via item/agentMessage/delta &
 * item/reasoning/textDelta; item/completed gives the final text for
 * reconciliation; commandExecution/fileChange map to tool blocks.
 */
export function mapNotification(n: ServerNotification): AgentEvent | null {
  switch (n.method) {
    case 'thread/started':
      return { type: 'system', threadId: n.params.thread.id };
    case 'turn/started':
      return { type: 'turn_started', turnId: n.params.turn.id };
    case 'item/agentMessage/delta':
      return { type: 'text_delta', itemId: n.params.itemId, delta: n.params.delta };
    case 'item/reasoning/textDelta':
      return { type: 'thinking_delta', itemId: n.params.itemId, delta: n.params.delta };
    case 'item/started':
      return mapItemStart(n.params.item);
    case 'item/completed':
      return mapItemComplete(n.params.item);
    case 'turn/completed':
      return { type: 'done', turnId: n.params.turn.id };
    case 'error':
      return { type: 'error', message: n.params.error.message, willRetry: n.params.willRetry };
    default:
      return null;
  }
}

function mapItemStart(item: ThreadItem): AgentEvent | null {
  switch (item.type) {
    case 'commandExecution':
      return { type: 'tool_use', itemId: item.id, title: item.command, detail: String(item.cwd) };
    case 'fileChange':
      return { type: 'tool_use', itemId: item.id, title: '编辑文件' };
    case 'webSearch':
      return { type: 'tool_use', itemId: item.id, title: '联网搜索' };
    case 'mcpToolCall':
    case 'dynamicToolCall':
      return { type: 'tool_use', itemId: item.id, title: '工具调用' };
    default:
      return null;
  }
}

function mapItemComplete(item: ThreadItem): AgentEvent | null {
  switch (item.type) {
    case 'agentMessage':
      return { type: 'text', itemId: item.id, text: item.text };
    case 'reasoning': {
      const text = item.content.length ? item.content.join('\n') : item.summary.join('\n');
      return { type: 'thinking', itemId: item.id, text };
    }
    case 'commandExecution':
      return {
        type: 'tool_result',
        itemId: item.id,
        output: item.aggregatedOutput ?? undefined,
        exitCode: item.exitCode,
      };
    case 'fileChange':
    case 'webSearch':
    case 'mcpToolCall':
    case 'dynamicToolCall':
      return { type: 'tool_result', itemId: item.id };
    default:
      return null;
  }
}
