import type { CliBridgeAgent, CliHookMessage, CliHookMessageType, CliQuestionItem } from './types';

function normalizeEventName(eventName?: string): string | undefined {
  if (!eventName) return eventName;
  if (['PermissionRequest', 'permission_request', 'permission.asked', 'permission_requested'].includes(eventName)) return 'PermissionRequest';
  if (['PreToolUse', 'pre_tool_use'].includes(eventName)) return 'PreToolUse';
  if (['PostToolUse', 'post_tool_use'].includes(eventName)) return 'PostToolUse';
  if (['Stop', 'stop', 'SubagentStop', 'subagent_stop', 'session.idle', 'session_idle'].includes(eventName)) return 'TaskComplete';
  if (['StopFailure', 'stop_failure', 'session.error', 'session_error'].includes(eventName)) return 'TaskCompleteFailure';
  return eventName;
}

function stringifySummaryValue(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(stringifySummaryValue).filter(Boolean).join('\n').trim();
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    for (const key of ['last_assistant_message', 'lastAssistantMessage', 'assistant_message', 'assistantMessage', 'assistant', 'final', 'completion', 'answer', 'response', 'output', 'result', 'content', 'text', 'message', 'summary', 'error']) {
      const text = stringifySummaryValue(obj[key]);
      if (text) return text;
    }
  }
  return '';
}

export function parseHookPayload(
  source: CliBridgeAgent,
  rawPayload: string,
  env: Record<string, string | undefined> = process.env,
): CliHookMessage {
  let data: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(rawPayload);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) data = parsed as Record<string, unknown>;
  } catch {
    data = {};
  }

  // Both supported agents default to PermissionRequest when the payload omits an
  // event name; `source` is statically claude|codex, so there is no other case.
  const hookEventName = String(data.hook_event_name ?? data.event_type ?? 'PermissionRequest');
  const normalized = normalizeEventName(hookEventName);
  const typeByEvent: Record<string, CliHookMessageType> = {
    PermissionRequest: 'permission_request',
    PostToolUse: 'post_tool_use',
    TaskComplete: 'task_complete',
    TaskCompleteFailure: 'task_complete',
  };
  const type: CliHookMessageType = typeByEvent[normalized ?? ''] ?? 'pre_tool_use';
  const toolInput = data.tool_input ?? data.toolInput ?? data.metadata ?? data.properties ?? {};

  return {
    type,
    source,
    sessionId: String(data.session_id ?? data.sessionId ?? ''),
    cwd: String(data.cwd ?? ''),
    toolName: String(data.tool_name ?? data.toolName ?? data.permission ?? ''),
    toolInput: toolInput && typeof toolInput === 'object' && !Array.isArray(toolInput) ? toolInput as Record<string, unknown> : {},
    hookEventName,
    stopHookActive: data.stop_hook_active === true || data.stopHookActive === true,
    permissionMode: typeof data.permission_mode === 'string' ? data.permission_mode : typeof data.permissionMode === 'string' ? data.permissionMode : undefined,
    permissionSuggestions: Array.isArray(data.permission_suggestions) ? data.permission_suggestions : Array.isArray(data.permissionSuggestions) ? data.permissionSuggestions : undefined,
    taskStatus: normalized === 'TaskCompleteFailure' ? 'failed' : normalized === 'TaskComplete' ? 'completed' : undefined,
    summary: type === 'task_complete' ? stringifySummaryValue(data) : undefined,
    bridgeOwned: env.FEISHU_CODEX_BRIDGE === '1',
    rawPayloadBytes: Buffer.byteLength(rawPayload, 'utf8'),
  };
}

export interface CliAskUserQuestion {
  questions: CliQuestionItem[];
}

/** Parse an AskUserQuestion / ask_user_question tool_input into 1-4 validated
 *  questions. Single- and multi-select are both accepted (the old single-question,
 *  single-select-only restriction is gone — the card now renders a multi-question
 *  form). Returns undefined (→ fall back to the local terminal) if the shape is
 *  unrecognized or any one question is malformed, so we never half-render garbage. */
export function extractAskUserQuestion(toolInput: Record<string, unknown>): CliAskUserQuestion | undefined {
  const rawQuestions = toolInput.questions;
  if (!Array.isArray(rawQuestions) || rawQuestions.length < 1 || rawQuestions.length > 4) return undefined;
  const questions = rawQuestions.flatMap((raw): CliQuestionItem[] => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
    const obj = raw as Record<string, unknown>;
    const question = typeof obj.question === 'string' ? obj.question.trim() : '';
    if (!question) return [];
    const rawOptions = obj.options;
    if (!Array.isArray(rawOptions) || rawOptions.length < 2) return [];
    const options = rawOptions.flatMap((option) => {
      if (!option || typeof option !== 'object' || Array.isArray(option)) return [];
      const o = option as Record<string, unknown>;
      if (typeof o.label !== 'string' || !o.label.trim()) return [];
      return [{
        label: o.label.trim(),
        description: typeof o.description === 'string' && o.description.trim() ? o.description.trim() : undefined,
        preview: typeof o.preview === 'string' && o.preview.trim() ? o.preview.trim() : undefined,
      }];
    });
    if (options.length !== rawOptions.length) return [];
    return [{
      question,
      header: typeof obj.header === 'string' && obj.header.trim() ? obj.header.trim() : undefined,
      multiSelect: obj.multiSelect === true,
      options,
    }];
  });
  // Any one question failing validation drops the whole ask → local fallback.
  if (questions.length !== rawQuestions.length) return undefined;
  return { questions };
}
