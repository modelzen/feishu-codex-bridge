/** Persisted diagnostics contain no credentials or transcripts. */
export type VoiceState =
  | 'unchecked'
  | 'testing'
  | 'permission_ready'
  | 'ready'
  | 'missing_permission'
  | 'unavailable'
  | 'temporary_error';
export type VoiceIssue = 'permission' | 'unsupported_plan' | 'rate_limit' | 'quota' | 'authentication' | 'network' | 'rejected';

export interface VoiceHealth {
  state: VoiceState;
  message: string;
  checkedAt?: number;
  retryAt?: number;
  issue?: VoiceIssue;
  code?: string;
  /** Redacted provider diagnostics, shown separately from the actionable explanation. */
  detail?: string;
}

export interface VoiceConfig {
  enabled: boolean;
  feishu?: VoiceHealth;
}

export type VoiceAction = { action: 'enable' | 'test' | 'disable' | 'refreshPermission' };

export type Transcription = { text: string; provider: 'feishu' } | { reason: string };

export interface VoiceService {
  action(action: VoiceAction): Promise<void>;
  /** Await pending settings writes and diagnostics without starting a probe. */
  settled(): Promise<void>;
  transcribe(audio: Buffer, durationMs?: number): Promise<Transcription>;
}

export interface VoiceView {
  enabled: boolean;
  feishu: VoiceHealth;
  result: string;
  grantUrl: string;
}

export class VoiceFailure extends Error {
  constructor(
    message: string,
    readonly kind: 'missing_permission' | 'unavailable' | 'temporary_error' | 'audio',
    readonly diagnostics: { issue?: VoiceIssue; code?: string; detail?: string; retryAfterMs?: number } = {},
  ) {
    super(message);
  }
}

/** Bridge-owned reply decoration. Never sent to the agent as an instruction. */
export interface VoiceReply {
  messageId: string;
  text: string;
  transcribed: boolean;
}
