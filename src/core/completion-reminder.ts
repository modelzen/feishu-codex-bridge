export type CompletionReminderMode = 'manual' | 'long' | 'failures' | 'always';
export type CompletionReminderOutcome = 'done' | 'error' | 'idle_timeout' | 'interrupted' | 'cancelled';

export interface CompletionReminderPolicy {
  mode: CompletionReminderMode;
  longTaskMinutes: number;
}

export interface CompletionReminderDecision {
  outcome: CompletionReminderOutcome;
  elapsedMs: number;
  manuallyRequested?: boolean;
}

export interface NormalizeCompletionReminderPolicyOptions {
  defaultMode?: CompletionReminderMode;
  defaultLongTaskMinutes?: number;
  minLongTaskMinutes?: number;
  maxLongTaskMinutes?: number;
}

/** Normalize one host's stored reminder values without importing its settings schema. */
export function normalizeCompletionReminderPolicy(
  raw: { mode?: unknown; longTaskMinutes?: unknown } | undefined,
  options: NormalizeCompletionReminderPolicyOptions = {},
): CompletionReminderPolicy {
  const defaultMode = options.defaultMode ?? 'failures';
  const defaultMinutes = options.defaultLongTaskMinutes ?? 3;
  const min = options.minLongTaskMinutes ?? 1;
  const max = options.maxLongTaskMinutes ?? 1_440;
  const mode = raw?.mode === 'manual' || raw?.mode === 'long' || raw?.mode === 'failures' || raw?.mode === 'always'
    ? raw.mode
    : defaultMode;
  const minutes = raw?.longTaskMinutes;
  const longTaskMinutes = typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes <= 0
    ? defaultMinutes
    : Math.min(max, Math.max(min, Math.floor(minutes)));
  return { mode, longTaskMinutes };
}

/** Shared four-mode reminder decision used by Bridge and every Runtime host. */
export function shouldSendCompletionReminderPolicy(
  policy: CompletionReminderPolicy,
  decision: CompletionReminderDecision,
): boolean {
  if (decision.outcome === 'interrupted' || decision.outcome === 'cancelled') return false;
  switch (policy.mode) {
    case 'manual':
      return decision.manuallyRequested === true;
    case 'long': {
      const elapsedMs = Number.isFinite(decision.elapsedMs) ? Math.max(0, decision.elapsedMs) : 0;
      return elapsedMs >= policy.longTaskMinutes * 60_000;
    }
    case 'always':
      return true;
    case 'failures':
      return decision.outcome === 'error' || decision.outcome === 'idle_timeout';
  }
}
