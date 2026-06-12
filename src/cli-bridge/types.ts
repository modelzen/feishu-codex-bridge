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

export type CliHookInstallStatus = 'installed' | 'not_installed' | 'needs_repair' | 'conflict_agent2lark';

export interface CliHookStatus {
  agent: CliBridgeAgent;
  status: CliHookInstallStatus;
  details: string[];
}
