import { describe, expect, it } from 'vitest';
import { parseHookPayload } from '../src/cli-bridge/parser';

describe('parseHookPayload', () => {
  it('normalizes Claude Stop into task completion and extracts final answer', () => {
    const msg = parseHookPayload('claude', JSON.stringify({
      hook_event_name: 'Stop',
      session_id: 's1',
      cwd: '/repo',
      stop_hook_active: true,
      last_assistant_message: 'done',
    }), {});
    expect(msg).toMatchObject({
      type: 'task_complete',
      source: 'claude',
      sessionId: 's1',
      cwd: '/repo',
      taskStatus: 'completed',
      summary: 'done',
      stopHookActive: true,
      bridgeOwned: false,
    });
  });

  it('marks bridge-owned sessions from environment', () => {
    const msg = parseHookPayload('codex', JSON.stringify({
      hook_event_name: 'PermissionRequest',
      session_id: 's2',
      cwd: '/repo',
      tool_name: 'Bash',
      tool_input: { command: 'git status' },
    }), { FEISHU_CODEX_BRIDGE: '1' });
    expect(msg.bridgeOwned).toBe(true);
    expect(msg.type).toBe('permission_request');
  });

  it('extracts nested summary fields without raw payload logging', () => {
    const msg = parseHookPayload('codex', JSON.stringify({
      hook_event_name: 'Stop',
      session_id: 's3',
      cwd: '/repo',
      output: { answer: 'nested answer' },
    }), {});
    expect(msg.summary).toBe('nested answer');
    expect(msg.rawPayloadBytes).toBeGreaterThan(0);
  });

  it('normalizes legacy PostToolUse into a no-op hook message', () => {
    const msg = parseHookPayload('claude', JSON.stringify({
      hook_event_name: 'PostToolUse',
      session_id: 'post',
      cwd: '/repo',
      tool_name: 'Bash',
      tool_input: { command: 'echo already-ran' },
    }), {});
    expect(msg.type).toBe('post_tool_use');
  });

  it('extracts supported Claude AskUserQuestion payloads', () => {
    const msg = parseHookPayload('claude', JSON.stringify({
      hook_event_name: 'PermissionRequest',
      session_id: 'ask',
      cwd: '/repo',
      tool_name: 'AskUserQuestion',
      tool_input: {
        questions: [{
          question: 'Pick one',
          options: [{ label: 'A' }, { label: 'B', description: 'Bee' }],
        }],
      },
    }), {});
    expect(msg.type).toBe('permission_request');
    expect(msg.toolName).toBe('AskUserQuestion');
  });
});
