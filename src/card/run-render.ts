import type { AgentEvent } from '../agent/types';
import {
  finalizeIfRunning,
  initialState,
  markIdleTimeout,
  markInterrupted,
  reduce,
  type RunState,
  type Terminal,
} from './run-state';

/**
 * Folds AgentEvents into a structured {@link RunState} (see {@link reduce}).
 * {@link buildRunCard} renders the snapshot — reasoning and tool calls become
 * collapsible panels, text streams in arrival order. The whole card is
 * re-rendered and pushed on each tick (see {@link RunCardStream}).
 */
export class RunRender {
  private state: RunState = initialState;
  /** when false, tool blocks are dropped from the rendered card (pref) */
  showTools = true;

  apply(ev: AgentEvent): void {
    this.state = reduce(this.state, ev);
  }

  /** Current structured state for rendering. */
  snapshot(): RunState {
    return this.state;
  }

  /** Lifecycle terminal, for the run loop's status/logging. */
  terminal(): Terminal {
    return this.state.terminal;
  }

  /** Mark the run as watchdog-killed (idle timeout). */
  timeout(minutes: number): void {
    this.state = markIdleTimeout(this.state, minutes);
  }

  /** Mark the run as user-interrupted (⏹). */
  interrupt(): void {
    this.state = markInterrupted(this.state);
  }

  /** Force a terminal state if the stream ended without done/error. */
  finalize(): void {
    this.state = finalizeIfRunning(this.state);
  }
}
