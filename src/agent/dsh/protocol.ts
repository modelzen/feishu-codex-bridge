export type DshRequestMethod = 'initialize' | 'session/prompt' | 'shutdown';

export interface DshNotification {
  method: string;
  params: Record<string, unknown>;
}

export interface DshSessionEventEnvelope {
  type: string;
  seq?: number;
  time?: number;
  data?: unknown;
}

export interface DshSessionEventNotificationParams extends Record<string, unknown> {
  sessionId: string;
  event: DshSessionEventEnvelope;
}

export interface DshSessionStatusNotificationParams extends Record<string, unknown> {
  sessionId: string;
  status: 'idle' | 'running';
}
