import type { ToolKind } from '../agent/types';
import type { CardObject } from '../card/cards';
import {
  buildQueuedCard,
  buildRunCard,
  RC,
  type RunCardState,
} from '../card/run-card';
import type { Block, FooterStatus, RunState, Terminal, ToolStatus } from '../card/run-state';

/** Stable action ids shared by every host that renders Runtime task cards. */
export const RUNTIME_TASK_CARD_ACTIONS = {
  cancel: RC.stop,
  remind: RC.remind,
} as const;

export type RuntimeTaskCardStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'idle-timeout'
  | 'cancelled';

/** Public, user-visible activity only. Private reasoning and tool output stay host-owned. */
export interface RuntimeTaskCardActivity {
  id: string;
  title: string;
  detail?: string;
  kind?: ToolKind;
  state: 'running' | 'completed' | 'failed';
  /** Optional public output. Hosts must not pass private logs or reasoning here. */
  output?: string;
}

/**
 * Host-neutral view model for the shared Runtime run-card renderer.
 *
 * Hosts adapt their own task lifecycle into this small interface; card schema,
 * process folding, status language, controls, and model placement remain owned
 * by the public Runtime instead of being copied into each host.
 */
export interface RuntimeTaskCardState {
  taskId: string;
  status: RuntimeTaskCardStatus;
  answer: string;
  activities: readonly RuntimeTaskCardActivity[];
  showActivities: boolean;
  model?: string;
  reasoningEffort?: string;
  modelDisplay?: 'off' | 'running' | 'always';
  completionReminder?: 'available' | 'requested';
  queuePosition?: number;
  idleTimeoutSeconds?: number;
  error?: string;
}

export interface RuntimeTaskCardAction {
  action:
    | typeof RUNTIME_TASK_CARD_ACTIONS.cancel
    | typeof RUNTIME_TASK_CARD_ACTIONS.remind;
  taskId: string;
}

/** Build the exact run-card layout used by Bridge CLI and external Runtime hosts. */
export function buildRuntimeTaskCard(state: RuntimeTaskCardState): CardObject {
  if (state.status === 'queued') {
    return buildQueuedCard({
      position: state.queuePosition,
      cardKey: state.taskId,
      completionReminder: state.completionReminder,
    });
  }

  const rs = runtimeRunState(state);
  const showModel = state.modelDisplay !== 'off' && state.model !== undefined;
  const rc: RunCardState = {
    rs,
    cardKey: rs.terminal === 'running' ? state.taskId : undefined,
    showTools: state.showActivities,
    completionReminder: state.completionReminder,
    ...(showModel
      ? {
          model: state.model,
          effort: state.reasoningEffort,
          modelOnTerminal: state.modelDisplay === 'always',
        }
      : {}),
  };
  return buildRunCard(rc);
}

/** Parse only callback payloads emitted by {@link buildRuntimeTaskCard}. */
export function parseRuntimeTaskCardAction(value: unknown): RuntimeTaskCardAction | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = value as { a?: unknown; m?: unknown };
  if (
    (candidate.a !== RUNTIME_TASK_CARD_ACTIONS.cancel && candidate.a !== RUNTIME_TASK_CARD_ACTIONS.remind)
    || typeof candidate.m !== 'string'
    || candidate.m.trim() === ''
  ) return undefined;
  return { action: candidate.a, taskId: candidate.m };
}

function runtimeRunState(state: RuntimeTaskCardState): RunState {
  const running = state.status === 'running';
  const blocks: Block[] = state.showActivities
    ? state.activities.map((activity): Block => ({
        kind: 'tool',
        tool: {
          id: activity.id,
          title: activity.title,
          detail: activity.detail,
          kind: activity.kind,
          status: toolStatus(activity.state),
          ...(activity.output !== undefined
            ? { output: activity.output }
            : activity.kind !== 'command' && activity.detail
              ? { output: activity.detail }
              : {}),
        },
      }))
    : [];
  const answer = state.answer.trim();
  if (answer !== '') {
    blocks.push({ kind: 'text', id: 'answer', content: answer, streaming: running });
  }

  return {
    blocks,
    reasoning: [],
    reasoningActive: false,
    footer: running ? runningFooter(state, answer) : null,
    terminal: terminal(state.status),
    ...(state.status === 'failed' && state.error ? { errorMsg: state.error } : {}),
    ...(state.status === 'idle-timeout'
      ? { idleTimeoutSeconds: Math.max(0, state.idleTimeoutSeconds ?? 0) }
      : {}),
  };
}

function toolStatus(state: RuntimeTaskCardActivity['state']): ToolStatus {
  return state === 'completed' ? 'done' : state === 'failed' ? 'error' : 'running';
}

function runningFooter(state: RuntimeTaskCardState, answer: string): FooterStatus {
  if (answer !== '') return 'streaming';
  return state.activities.some((activity) => activity.state === 'running') ? 'tool_running' : 'thinking';
}

function terminal(status: RuntimeTaskCardStatus): Terminal {
  if (status === 'completed') return 'done';
  if (status === 'failed') return 'error';
  if (status === 'idle-timeout') return 'idle_timeout';
  if (status === 'cancelled') return 'interrupted';
  return 'running';
}
