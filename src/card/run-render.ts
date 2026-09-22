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
  private state: RunState = { ...initialState, startedAt: Date.now() };
  /** when false, tool blocks are dropped from the rendered card (pref) */
  showTools = true;

  apply(ev: AgentEvent): void {
    this.state = reduce(this.state, ev);
    this.freezeClock();
  }

  private freezeClock(): void {
    if (this.state.terminal !== 'running' && this.state.completedAt === undefined) {
      this.state = { ...this.state, completedAt: Date.now() };
    }
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
  timeout(seconds: number): void {
    this.state = markIdleTimeout(this.state, seconds);
    this.freezeClock();
  }

  /** Mark the run as user-interrupted (⏹). */
  interrupt(): void {
    this.state = markInterrupted(this.state);
    this.freezeClock();
  }

  /** Force a terminal state if the stream ended without done/error. */
  finalize(): void {
    this.state = finalizeIfRunning(this.state);
    this.freezeClock();
  }
}
