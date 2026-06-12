import type { CliHookMessage, CliHookResponse } from './types';

export function buildHookStdout(msg: CliHookMessage, response: CliHookResponse): string {
  if (response.stdout !== undefined) return response.stdout;
  if (msg.type === 'post_tool_use') return '{}';
  if (response.decision === 'fallback_local') return '';
  if (msg.type === 'task_complete') return '{}';

  const decision = response.decision === 'deny' ? 'deny' : 'allow';
  if (msg.source === 'codex') {
    if (msg.hookEventName === 'PermissionRequest') {
      const decisionObj: Record<string, unknown> = { behavior: decision };
      if (decision === 'deny') decisionObj.message = response.reason || 'Denied by feishu-codex-bridge.';
      return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: decisionObj } });
    }
    if (msg.hookEventName === 'PreToolUse' && decision === 'deny') {
      return JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: response.reason || 'Denied by feishu-codex-bridge.',
        },
      });
    }
    return '{}';
  }

  const decisionObj: Record<string, unknown> = { behavior: decision };
  if (decision === 'allow' && response.updatedInput) decisionObj.updatedInput = response.updatedInput;
  if (decision === 'deny') {
    // Claude carries the denial reason in `message` (PermissionResult shape:
    // { behavior:'deny', message, interrupt? }); without it the model sees a bare
    // denial. Mirrors the codex branch above.
    decisionObj.message = response.reason || 'Denied by feishu-codex-bridge.';
    if (response.interrupt) decisionObj.interrupt = true;
  }
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: decisionObj } });
}
