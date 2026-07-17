import { randomUUID } from 'node:crypto';
import type { AgentBackend } from '../agent/types';
import { log } from '../core/logger';
import {
  createSessionTitleJob,
  getSessionTitleJob,
  listSessionTitleJobs,
  sessionTitleJobKey,
  updateSessionTitleJob,
  type SessionTitleJob,
  type SessionTitlePolicySnapshot,
} from './session-store';
import {
  cleanInboundSessionTitleSource,
  cleanGeneratedSessionTitle,
  prepareSessionTitle,
  type SessionTitleSource,
} from './session-title';

const DEFAULT_LEASE_MS = 60_000;
const DEFAULT_RETRY_MS = 15_000;
const MAX_RETRY_MS = 10 * 60_000;
const DEFAULT_RECOVERY_INTERVAL_MS = 30_000;

export interface SessionTitleStore {
  create(job: SessionTitleJob): Promise<boolean>;
  get(key: string): Promise<SessionTitleJob | undefined>;
  list(): Promise<SessionTitleJob[]>;
  update(
    key: string,
    predicate: (job: Readonly<SessionTitleJob>) => boolean,
    updater: (job: Readonly<SessionTitleJob>) => SessionTitleJob,
  ): Promise<boolean>;
}

const defaultStore: SessionTitleStore = {
  create: createSessionTitleJob,
  get: getSessionTitleJob,
  list: listSessionTitleJobs,
  update: updateSessionTitleJob,
};

export interface RegisterSessionTitleInput {
  backend: string;
  sessionId: string;
  cwd: string;
  /** The first user message, captured before Bridge prompt weaving. */
  source?: SessionTitleSource;
  /** Captured now so later settings changes cannot alter an existing job. */
  policy: SessionTitlePolicySnapshot;
}

export interface SessionTitleCoordinatorOptions {
  backendFor(id: string): AgentBackend;
  /** Test seams; runtime callers should leave these unset. */
  store?: SessionTitleStore;
  now?: () => number;
  leaseMs?: number;
  retryMs?: number;
  recoveryIntervalMs?: number;
}

function normalizedPolicy(policy: SessionTitlePolicySnapshot): SessionTitlePolicySnapshot {
  if (
    policy.strategy === 'model' &&
    typeof policy.model === 'string' &&
    policy.model.trim() &&
    policy.effort
  ) {
    return { strategy: 'model', model: policy.model.trim(), effort: policy.effort };
  }
  return { strategy: 'truncate' };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isUnsupportedError(err: unknown): boolean {
  return /method not found|unknown (?:method|request)|not supported|unsupported|-32601/i.test(errorMessage(err));
}

/** Build a terminal replacement that drops the source/model/candidate/lease. */
function terminalJob(
  current: Readonly<SessionTitleJob>,
  outcome: NonNullable<SessionTitleJob['outcome']>,
  finalTitle?: string,
  lastError?: string,
): SessionTitleJob {
  return {
    key: current.key,
    backend: current.backend,
    sessionId: current.sessionId,
    cwd: current.cwd,
    phase: outcome === 'written' ? 'done' : 'skipped',
    attempts: current.attempts,
    outcome,
    ...(finalTitle ? { finalTitle } : {}),
    ...(lastError ? { lastError } : {}),
    createdAt: current.createdAt,
    updatedAt: current.updatedAt,
  };
}

function withoutClaim(
  current: Readonly<SessionTitleJob>,
  patch: Partial<SessionTitleJob>,
): SessionTitleJob {
  const { claimId: _claimId, leaseUntil: _leaseUntil, ...rest } = current;
  return { ...rest, ...patch } as SessionTitleJob;
}

/**
 * Durable, at-most-once coordinator for backend-native resume titles.
 *
 * The generated candidate and a writeAttempted marker are persisted before the
 * native mutation. Once marked, recovery may read the host to classify the
 * outcome but can never issue the mutation again. This deliberately prefers a
 * missing title after a crash in the tiny marker→call window over violating the
 * product guarantee that Bridge modifies a host title only once. Cross-process
 * serialization is supplied by the bridge's existing per-bot single-instance
 * lock.
 */
export class SessionTitleCoordinator {
  private readonly store: SessionTitleStore;
  private readonly now: () => number;
  private readonly leaseMs: number;
  private readonly retryMs: number;
  private readonly recoveryIntervalMs: number;
  private readonly preparing = new Map<string, Promise<void>>();
  private readonly applying = new Map<string, Promise<void>>();
  private recoveryTimer?: ReturnType<typeof setInterval>;
  private stopped = false;

  constructor(private readonly opts: SessionTitleCoordinatorOptions) {
    this.store = opts.store ?? defaultStore;
    this.now = opts.now ?? Date.now;
    this.leaseMs = opts.leaseMs ?? DEFAULT_LEASE_MS;
    this.retryMs = opts.retryMs ?? DEFAULT_RETRY_MS;
    this.recoveryIntervalMs = opts.recoveryIntervalMs ?? DEFAULT_RECOVERY_INTERVAL_MS;
  }

  async register(input: RegisterSessionTitleInput): Promise<string> {
    const key = sessionTitleJobKey(input.backend, input.sessionId);
    const now = this.now();
    const clean =
      input.source === undefined ? undefined : cleanInboundSessionTitleSource(input.source);
    const hasSource = Boolean(clean);
    await this.store.create({
      key,
      backend: input.backend,
      sessionId: input.sessionId,
      cwd: input.cwd,
      // A session can be created before its first turn actually starts (notably
      // /clear and a run waiting in the global queue). Recovery must not title
      // that empty/cancelled session, so source-ready jobs wait for an explicit
      // first-turn activation from the run loop.
      phase: input.source === undefined ? 'waiting_source' : hasSource ? 'waiting_turn' : 'skipped',
      ...(hasSource ? { source: clean } : {}),
      ...(input.source === undefined || hasSource ? { policy: normalizedPolicy(input.policy) } : {}),
      attempts: 0,
      ...(!hasSource && input.source !== undefined ? { outcome: 'excluded' as const } : {}),
      createdAt: now,
      updatedAt: now,
    });
    return key;
  }

  /** Attach the first post-/clear prompt. Missing jobs (including manual resume)
   * are deliberately ignored rather than implicitly registered. */
  async attachSource(key: string, rawSource: SessionTitleSource): Promise<boolean> {
    const source = cleanInboundSessionTitleSource(rawSource);
    return this.store.update(
      key,
      // `waiting_turn` has not been accepted by the host yet, so a queued run
      // cancelled before runStreamed may safely replace its stale source with
      // the next message that actually gets a chance to start.
      (job) => job.phase === 'waiting_source' || job.phase === 'waiting_turn',
      (job) =>
        source
          ? { ...job, phase: 'waiting_turn', source }
          : terminalJob(job, 'excluded'),
    );
  }

  /** Arm a source-ready job immediately after runStreamed/runGoal has issued the
   * host's first turn. Until this durable transition, restart recovery ignores it. */
  async activate(key: string): Promise<boolean> {
    await this.store.update(
      key,
      (job) => job.phase === 'waiting_turn',
      (job) => ({ ...job, phase: 'pending' }),
    );
    const current = await this.store.get(key);
    return Boolean(
      current && current.phase !== 'waiting_source' && current.phase !== 'waiting_turn',
    );
  }

  /** Generate/directly prepare a candidate while the main first turn is running. */
  prepare(key: string): Promise<void> {
    return this.singleFlight(this.preparing, key, () => this.prepareImpl(key));
  }

  /** Apply after the first host turn has started. Safe to call again at turn end. */
  async apply(key: string): Promise<void> {
    await this.prepare(key);
    await this.singleFlight(this.applying, key, () => this.applyImpl(key));
  }

  /** Resume interrupted jobs after daemon restart. Old v1/v2 sessions have no
   * ledger rows, so this cannot backfill pre-upgrade history. */
  async recover(): Promise<void> {
    if (this.stopped) return;
    const now = this.now();
    const due = (await this.store.list()).filter((job) => {
      if (
        job.phase === 'done' ||
        job.phase === 'skipped' ||
        job.phase === 'waiting_source' ||
        job.phase === 'waiting_turn'
      ) return false;
      if (job.nextRetryAt !== undefined && job.nextRetryAt > now) return false;
      if ((job.phase === 'generating' || job.phase === 'applying') && (job.leaseUntil ?? 0) > now) return false;
      return true;
    });
    // Recovery is deliberately serial: after a long outage there may be many
    // rows, and fan-out would create an unexpected burst of paid model calls.
    for (const job of due) await this.apply(job.key);
  }

  startRecovery(): void {
    if (this.recoveryTimer || this.stopped) return;
    void this.recover().catch((err) => log.fail('agent', err, { phase: 'session-title-recovery' }));
    this.recoveryTimer = setInterval(() => {
      void this.recover().catch((err) => log.fail('agent', err, { phase: 'session-title-recovery' }));
    }, this.recoveryIntervalMs);
    this.recoveryTimer.unref?.();
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    if (this.recoveryTimer) clearInterval(this.recoveryTimer);
    this.recoveryTimer = undefined;
    await Promise.allSettled([...this.preparing.values(), ...this.applying.values()]);
  }

  private singleFlight(
    map: Map<string, Promise<void>>,
    key: string,
    work: () => Promise<void>,
  ): Promise<void> {
    const existing = map.get(key);
    if (existing) return existing;
    const run = work()
      .catch((err) => {
        log.fail('agent', err, { phase: 'session-title', key });
      })
      .finally(() => {
        if (map.get(key) === run) map.delete(key);
      });
    map.set(key, run);
    return run;
  }

  private retryAt(attempts: number): number {
    return this.now() + Math.min(this.retryMs * 2 ** Math.max(0, attempts - 1), MAX_RETRY_MS);
  }

  private async prepareImpl(key: string): Promise<void> {
    if (this.stopped) return;
    const initial = await this.store.get(key);
    if (
      !initial ||
      initial.phase === 'done' ||
      initial.phase === 'skipped' ||
      initial.phase === 'waiting_source' ||
      initial.phase === 'waiting_turn'
    ) return;
    if (initial.phase === 'prepared' || initial.phase === 'applying') return;

    const claimId = randomUUID();
    const now = this.now();
    const claimed = await this.store.update(
      key,
      (job) =>
        job.phase === 'pending' ||
        (job.phase === 'generating' && (job.leaseUntil ?? 0) <= now),
      (job) => ({
        ...job,
        phase: 'generating',
        claimId,
        leaseUntil: now + this.leaseMs,
        attempts: job.attempts + 1,
        nextRetryAt: undefined,
        lastError: undefined,
      }),
    );
    if (!claimed) return;

    const job = await this.store.get(key);
    if (!job || job.claimId !== claimId || job.phase !== 'generating') return;
    let backend: AgentBackend;
    try {
      backend = this.opts.backendFor(job.backend);
    } catch (err) {
      await this.finishClaim(job, claimId, 'unsupported', undefined, errorMessage(err));
      return;
    }
    if (!backend.readSessionTitle || !backend.setSessionTitle) {
      await this.finishClaim(job, claimId, 'unsupported');
      return;
    }

    try {
      const existing = (await backend.readSessionTitle(job.cwd, job.sessionId))?.trim();
      if (existing) {
        await this.finishClaim(job, claimId, 'preexisting', existing);
        return;
      }
    } catch (err) {
      if (isUnsupportedError(err)) {
        await this.finishClaim(job, claimId, 'unsupported', undefined, errorMessage(err));
      } else {
        await this.releaseClaim(job, claimId, 'pending', err);
      }
      return;
    }

    const source = job.source ?? '';
    const plan = prepareSessionTitle(source);
    if (!plan.source || !plan.fallbackTitle) {
      await this.finishClaim(job, claimId, 'excluded');
      return;
    }

    let candidate = plan.directTitle ?? plan.fallbackTitle;
    let generationError: string | undefined;
    const policy = normalizedPolicy(job.policy ?? { strategy: 'truncate' });
    if (!plan.short && policy.strategy === 'model' && policy.model && policy.effort) {
      if (backend.generateSessionTitle) {
        try {
          const generated = await backend.generateSessionTitle({
            cwd: job.cwd,
            prompt: plan.prompt,
            model: policy.model,
            effort: policy.effort,
          });
          candidate = cleanGeneratedSessionTitle(generated ?? '', plan.fallbackTitle);
        } catch (err) {
          // Third-party/removed/unsupported model: never substitute another model.
          // The deterministic no-cost first-sentence title is the complete fallback.
          generationError = errorMessage(err);
          candidate = plan.fallbackTitle;
          log.info('agent', 'session-title-model-fallback', { backend: job.backend, sessionId: job.sessionId });
        }
      } else {
        generationError = 'backend does not support isolated title generation';
      }
    }

    await this.store.update(
      key,
      (current) => current.phase === 'generating' && current.claimId === claimId,
      (current) =>
        withoutClaim(current, {
          phase: 'prepared',
          candidate,
          nextRetryAt: undefined,
          lastError: generationError,
        }),
    );
  }

  private async applyImpl(key: string): Promise<void> {
    if (this.stopped) return;
    const initial = await this.store.get(key);
    if (!initial || initial.phase === 'done' || initial.phase === 'skipped') return;
    if (initial.phase !== 'prepared' && initial.phase !== 'applying') return;

    const claimId = randomUUID();
    const now = this.now();
    const claimed = await this.store.update(
      key,
      (job) =>
        job.phase === 'prepared' ||
        (job.phase === 'applying' && (job.leaseUntil ?? 0) <= now),
      (job) => ({
        ...job,
        phase: 'applying',
        claimId,
        leaseUntil: now + this.leaseMs,
        attempts: job.attempts + 1,
        nextRetryAt: undefined,
      }),
    );
    if (!claimed) return;

    const job = await this.store.get(key);
    if (!job || job.claimId !== claimId || job.phase !== 'applying' || !job.candidate) return;
    let backend: AgentBackend;
    try {
      backend = this.opts.backendFor(job.backend);
    } catch (err) {
      await this.finishClaim(job, claimId, 'unsupported', undefined, errorMessage(err));
      return;
    }
    if (!backend.readSessionTitle || !backend.setSessionTitle) {
      await this.finishClaim(job, claimId, 'unsupported');
      return;
    }

    let existing: string | undefined;
    try {
      existing = (await backend.readSessionTitle(job.cwd, job.sessionId))?.trim();
    } catch (err) {
      // No native mutation is possible before the durable write boundary, so a
      // transient read failure remains safely retryable.
      if (isUnsupportedError(err)) {
        await this.finishClaim(job, claimId, 'unsupported', undefined, errorMessage(err));
      } else {
        await this.releaseClaim(job, claimId, 'prepared', err);
      }
      return;
    }

    if (existing) {
      // Equal means the single native call landed before its ledger terminal
      // transition. Different means a user/native client won; never overwrite.
      await this.finishClaim(
        job,
        claimId,
        existing === job.candidate ? 'written' : 'preexisting',
        existing,
      );
      return;
    }

    if (job.writeAttempted) {
      // A prior process reached the durable write boundary. An empty native
      // read can mean either "crashed before the call" or "host cache has not
      // observed the commit"; both are intentionally terminal so Bridge never
      // calls setSessionTitle twice.
      await this.finishClaim(
        job,
        claimId,
        'failed',
        undefined,
        job.lastError ?? 'native title write outcome is unknown; not retried',
      );
      return;
    }

    const armed = await this.store.update(
      key,
      (current) => current.phase === 'applying' && current.claimId === claimId && !current.writeAttempted,
      (current) => ({ ...current, writeAttempted: true }),
    );
    if (!armed) return;

    try {
      await backend.setSessionTitle(job.cwd, job.sessionId, job.candidate);
      await this.finishClaim(job, claimId, 'written', job.candidate);
      log.info('agent', 'session-title-written', { backend: job.backend, sessionId: job.sessionId });
    } catch (err) {
      if (isUnsupportedError(err)) {
        await this.finishClaim(job, claimId, 'unsupported', undefined, errorMessage(err));
      } else {
        // The native call may have committed before reporting an error. Verify
        // once for diagnostics, but never release to `prepared` (which would
        // permit a second mutation after a stale/lagged read).
        try {
          const observed = (await backend.readSessionTitle(job.cwd, job.sessionId))?.trim();
          await this.finishClaim(
            job,
            claimId,
            observed === job.candidate ? 'written' : observed ? 'preexisting' : 'failed',
            observed || undefined,
            observed === job.candidate ? undefined : errorMessage(err),
          );
        } catch (readErr) {
          await this.finishClaim(
            job,
            claimId,
            'failed',
            undefined,
            `${errorMessage(err)}; verification failed: ${errorMessage(readErr)}`,
          );
        }
      }
    }
  }

  private async finishClaim(
    job: Readonly<SessionTitleJob>,
    claimId: string,
    outcome: NonNullable<SessionTitleJob['outcome']>,
    finalTitle?: string,
    lastError?: string,
  ): Promise<void> {
    await this.store.update(
      job.key,
      (current) => current.claimId === claimId,
      (current) => terminalJob(current, outcome, finalTitle, lastError),
    );
  }

  private async releaseClaim(
    job: Readonly<SessionTitleJob>,
    claimId: string,
    phase: 'pending' | 'prepared',
    err: unknown,
  ): Promise<void> {
    await this.store.update(
      job.key,
      (current) => current.claimId === claimId,
      (current) =>
        withoutClaim(current, {
          phase,
          nextRetryAt: this.retryAt(current.attempts),
          lastError: errorMessage(err),
        }),
    );
  }
}
