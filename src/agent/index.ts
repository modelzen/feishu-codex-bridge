import type { AgentBackend } from './types';
import { CodexAppServerBackend } from './codex-appserver/backend';

/** Construct the agent backend. Single impl for now (codex app-server). */
export function createBackend(): AgentBackend {
  return new CodexAppServerBackend();
}

export type * from './types';
