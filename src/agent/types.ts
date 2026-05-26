/**
 * Backend-agnostic agent interface. The codex app-server implementation lives
 * in ./codex-appserver; this layer lets the bot orchestrator stay decoupled
 * from codex internals (and lets us swap to exec / SDK / remote later).
 */

export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

export interface AgentInput {
  text?: string;
  /** absolute local image paths (codex reads them directly) */
  images?: string[];
}

export interface ModelInfo {
  id: string;
  displayName: string;
  description: string;
  supportedEfforts: ReasoningEffort[];
  defaultEffort: ReasoningEffort;
  isDefault: boolean;
  hidden: boolean;
}

/** Normalized stream events, mapped from app-server notifications. */
export type AgentEvent =
  | { type: 'system'; threadId: string }
  | { type: 'turn_started'; turnId: string }
  | { type: 'text_delta'; itemId: string; delta: string }
  | { type: 'text'; itemId: string; text: string }
  | { type: 'thinking_delta'; itemId: string; delta: string }
  | { type: 'thinking'; itemId: string; text: string }
  | { type: 'tool_use'; itemId: string; title: string; detail?: string }
  | { type: 'tool_result'; itemId: string; output?: string; exitCode?: number | null }
  | { type: 'usage'; inputTokens?: number; outputTokens?: number }
  | { type: 'done'; turnId: string }
  | { type: 'error'; message: string; willRetry: boolean };

export interface AgentRun {
  events: AsyncIterable<AgentEvent>;
  /** current turn id, available after `turn_started` */
  turnId(): string | undefined;
}

export interface AgentThread {
  readonly codexThreadId: string;
  /** start a turn, streaming events until turn completion/error */
  runStreamed(input: AgentInput): AgentRun;
  /** inject input into the in-flight turn (引导) */
  steer(input: AgentInput, expectedTurnId: string): Promise<void>;
  /** interrupt the in-flight turn (watchdog 中止) */
  abort(turnId: string): Promise<void>;
  /** terminate the underlying app-server process */
  close(): Promise<void>;
}

export interface StartThreadOptions {
  cwd: string;
  model?: string;
  effort?: ReasoningEffort;
}

export interface ResumeThreadOptions extends StartThreadOptions {
  codexThreadId: string;
}

export interface AgentBackend {
  readonly id: string;
  readonly displayName: string;
  isAvailable(): Promise<boolean>;
  listModels(): Promise<ModelInfo[]>;
  startThread(opts: StartThreadOptions): Promise<AgentThread>;
  resumeThread(opts: ResumeThreadOptions): Promise<AgentThread>;
}
