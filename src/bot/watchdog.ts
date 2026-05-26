/**
 * Wrap an async iterable with a per-event idle timeout. If no event arrives
 * within `idleMs`, calls `onTimeout()` and ends the stream (the caller's
 * onTimeout should abort the underlying turn). `idleMs <= 0` disables.
 */
export async function* withIdleTimeout<T>(
  source: AsyncIterable<T>,
  idleMs: number,
  onTimeout: () => void,
): AsyncGenerator<T> {
  if (!idleMs || idleMs <= 0) {
    yield* source;
    return;
  }
  const iter = source[Symbol.asyncIterator]();
  while (true) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'__idle__'>((res) => {
      timer = setTimeout(() => res('__idle__'), idleMs);
    });
    const raced = await Promise.race([iter.next(), timeout]);
    if (timer) clearTimeout(timer);
    if (raced === '__idle__') {
      onTimeout();
      return;
    }
    const r = raced as IteratorResult<T>;
    if (r.done) return;
    yield r.value;
  }
}

/** Minimal FIFO semaphore for the global concurrent-run cap. */
export class Semaphore {
  private active = 0;
  private waiters: (() => void)[] = [];
  constructor(private readonly max: number) {}

  async acquire(): Promise<() => void> {
    if (this.active >= this.max) {
      await new Promise<void>((res) => this.waiters.push(res));
    }
    this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      const next = this.waiters.shift();
      if (next) next();
    };
  }
}
