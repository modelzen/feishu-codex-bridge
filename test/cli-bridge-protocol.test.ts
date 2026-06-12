import { describe, expect, it } from 'vitest';
import { buildHookStdout } from '../src/cli-bridge/protocol';
import type { CliHookMessage } from '../src/cli-bridge/types';

function msg(source: 'claude' | 'codex', hookEventName = 'PermissionRequest'): CliHookMessage {
  return {
    type: 'permission_request',
    source,
    sessionId: 's',
    cwd: '/repo',
    toolName: 'Bash',
    toolInput: { command: 'echo hi' },
    hookEventName,
    bridgeOwned: false,
    rawPayloadBytes: 10,
  };
}

describe('buildHookStdout', () => {
  it('formats Claude allow and deny decisions', () => {
    expect(JSON.parse(buildHookStdout(msg('claude'), { decision: 'allow' }))).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'allow' },
      },
    });
    expect(JSON.parse(buildHookStdout(msg('claude'), { decision: 'deny', interrupt: true }))).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'deny', message: 'Denied by feishu-codex-bridge.', interrupt: true },
      },
    });
    // The denial reason must reach the model via `message`, not be dropped.
    expect(JSON.parse(buildHookStdout(msg('claude'), { decision: 'deny', reason: 'nope' })).hookSpecificOutput.decision).toEqual({
      behavior: 'deny',
      message: 'nope',
    });
  });

  it('formats Codex PermissionRequest deny with message', () => {
    expect(JSON.parse(buildHookStdout(msg('codex'), { decision: 'deny', reason: 'no' }))).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'deny', message: 'no' },
      },
    });
  });

  it('returns empty stdout for fallback_local', () => {
    expect(buildHookStdout(msg('codex'), { decision: 'fallback_local' })).toBe('');
  });

  it('returns an empty object for legacy PostToolUse hooks', () => {
    const hook = {
      ...msg('claude', 'PostToolUse'),
      type: 'post_tool_use' as CliHookMessage['type'],
    };
    expect(buildHookStdout(hook, { decision: 'allow' })).toBe('{}');
  });

  it('formats Claude AskUserQuestion updated input preserving questions', () => {
    const questions = [{ question: 'Pick?', options: [{ label: 'A' }, { label: 'B' }] }];
    const stdout = buildHookStdout(msg('claude'), {
      decision: 'allow',
      updatedInput: { questions, answers: { 'Pick?': 'A' } },
    });
    expect(JSON.parse(stdout).hookSpecificOutput.decision.updatedInput).toEqual({
      questions,
      answers: { 'Pick?': 'A' },
    });
  });
});
