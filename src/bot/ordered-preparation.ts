/** Prepare and deliver in intake order, independently for each session. The
 * next preparation sees the previous successful delivery's checkpoint.
 * A cancelled generation can
 * never deliver into a replacement session, even if its work ignores abort. */
export class OrderedPreparation {
  private lanes = new Map<string, { tail: Promise<void>; jobs: Set<AbortController>; scope?: string }>();
  private closed = false;

  submit<T>(key: string, work: (signal: AbortSignal) => Promise<T>, deliver: (value: T) => Promise<void>,
    failed: (error: unknown) => void, scope?: string): void {
    if (this.closed) return;
    let lane = this.lanes.get(key);
    if (!lane) { lane = { tail: Promise.resolve(), jobs: new Set(), scope }; this.lanes.set(key, lane); }
    const owner = lane;
    const controller = new AbortController();
    owner.jobs.add(controller);
    const task = owner.tail.then(async () => {
      if (controller.signal.aborted || this.closed) return;
      const value = await work(controller.signal);
      if (controller.signal.aborted || this.closed) return;
      await deliver(value);
    }).catch(error => { if (!controller.signal.aborted && !this.closed) failed(error); }).finally(() => {
      owner.jobs.delete(controller);
      if (owner.jobs.size === 0 && this.lanes.get(key) === owner) this.lanes.delete(key);
    });
    owner.tail = task;
  }

  hasPending(key: string): boolean {
    return this.lanes.has(key);
  }

  cancel(key: string): number {
    const lane = this.lanes.get(key);
    if (!lane) return 0;
    this.lanes.delete(key);
    const count = lane.jobs.size;
    for (const job of lane.jobs) job.abort();
    return count;
  }

  /** Cancel every preparation lane belonging to a chat, including unloaded sessions. */
  cancelScope(scope: string): number {
    let count = 0;
    for (const [key, lane] of this.lanes) if (lane.scope === scope) count += this.cancel(key);
    return count;
  }

  close(): void {
    this.closed = true;
    for (const key of this.lanes.keys()) this.cancel(key);
  }
}
