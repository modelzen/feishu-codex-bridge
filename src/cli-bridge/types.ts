import type { CliBridgeAgentKey } from '../config/schema';

export type CliBridgeAgent = CliBridgeAgentKey;
export type CliHookMessageType = 'permission_request' | 'pre_tool_use' | 'post_tool_use' | 'task_complete';
export type CliDecision = 'allow' | 'deny' | 'fallback_local';

export interface CliHookMessage {
  type: CliHookMessageType;
  source: CliBridgeAgent;
  sessionId: string;
  cwd: string;
  toolName?: string;
  toolInput: Record<string, unknown>;
  hookEventName?: string;
  stopHookActive?: boolean;
  permissionMode?: string;
  permissionSuggestions?: unknown[];
  taskStatus?: 'completed' | 'failed';
  summary?: string;
  bridgeOwned: boolean;
  rawPayloadBytes: number;
}

export interface CliHookResponse {
  decision: CliDecision;
  stdout?: string;
  reason?: string;
  updatedInput?: Record<string, unknown>;
  interrupt?: boolean;
}

/** One question in an AskUserQuestion / ask_user_question call. Claude Code sends
 *  1-4 of these (Codex 1-3) per tool call; each is single- or multi-select with
 *  2-4 labelled options. `multiSelect` picks the dropdown kind and answer join. */
export interface CliQuestionItem {
  question: string;
  header?: string;
  multiSelect: boolean;
  options: { label: string; description?: string; preview?: string }[];
}

export type CliHookInstallStatus = 'installed' | 'not_installed' | 'needs_repair' | 'conflict_agent2lark';

export interface CliHookStatus {
  agent: CliBridgeAgent;
  status: CliHookInstallStatus;
  details: string[];
}
