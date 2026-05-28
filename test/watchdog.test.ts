import { afterEach, describe, expect, it, vi } from 'vitest';
import { Semaphore, withIdleTimeout } from '../src/bot/watchdog';

async function* delayedValues<T>(values: Array<{ delayMs: number; value: T }>): AsyncGenerator<T> {
  for (const { delayMs, value } of values) {
    await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    yield value;
  }
}

async function* neverEnding<T>(first: T): AsyncGenerator<T> {
  yield first;
  await new Promise<never>(() => {});
}

describe('Semaphore', () => {
  it('blocks acquire calls beyond max until release is called', async () => {
    const sem = new Semaphore(2);
    const release1 = await sem.acquire();
    const release2 = await sem.acquire();

    let acquired = false;
    const third = sem.acquire().then((release) => {
      acquired = true;
      return release;
    });
    await Promise.resolve();
    expect(acquired).toBe(false);

    release1();
    const release3 = await third;
    expect(acquired).toBe(true);

    release2();
    release3();
  });

  it('releases waiters in FIFO order', async () => {
    const sem = new Semaphore(1);
    const release1 = await sem.acquire();
    const order: string[] = [];

    const second = sem.acquire().then((release) => {
      order.push('second');
      return release;
    });
    const third = sem.acquire().then((release) => {
      order.push('third');
      return release;
    });
    await Promise.resolve();
    expect(order).toEqual([]);

    release1();
    const release2 = await second;
    expect(order).toEqual(['second']);

    release2();
    const release3 = await third;
    expect(order).toEqual(['second', 'third']);
    release3();
  });
});

describe('withIdleTimeout', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('passes through every source value when each arrives before the idle timeout', async () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const out: string[] = [];
    const done = (async () => {
      for await (const value of withIdleTimeout(
        delayedValues([
          { delayMs: 10, value: 'a' },
          { delayMs: 10, value: 'b' },
        ]),
        50,
        onTimeout,
      )) {
        out.push(value);
      }
    })();

    await vi.advanceTimersByTimeAsync(10);
    expect(out).toEqual(['a']);
    await vi.advanceTimersByTimeAsync(10);
    await done;

    expect(out).toEqual(['a', 'b']);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it('calls onTimeout and ends the generator when the source goes idle', async () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const iter = withIdleTimeout(neverEnding('first'), 50, onTimeout)[Symbol.asyncIterator]();

    await expect(iter.next()).resolves.toEqual({ done: false, value: 'first' });
    const second = iter.next();
    await vi.advanceTimersByTimeAsync(50);

    await expect(second).resolves.toEqual({ done: true, value: undefined });
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it('directly passes through the source when idleMs is disabled', async () => {
    const onTimeout = vi.fn();
    const values: string[] = [];

    for await (const value of withIdleTimeout(delayedValues([{ delayMs: 1, value: 'a' }]), 0, onTimeout)) {
      values.push(value);
    }

    expect(values).toEqual(['a']);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it('ends the generator when the stop signal resolves (⏹), without firing onTimeout', async () => {
    const onTimeout = vi.fn();
    let resolveStop!: () => void;
    const stop = new Promise<void>((res) => {
      resolveStop = res;
    });
    const out: string[] = [];
    const iter = withIdleTimeout(neverEnding('first'), 0, onTimeout, stop)[Symbol.asyncIterator]();

    await expect(iter.next()).resolves.toEqual({ done: false, value: 'first' });
    const second = iter.next();
    resolveStop();

    await expect(second).resolves.toEqual({ done: true, value: undefined });
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it('still passes through values when a stop signal is provided but unresolved', async () => {
    const onTimeout = vi.fn();
    const stop = new Promise<void>(() => {}); // never resolves
    const out: string[] = [];

    for await (const value of withIdleTimeout(
      delayedValues([
        { delayMs: 1, value: 'a' },
        { delayMs: 1, value: 'b' },
      ]),
      0,
      onTimeout,
      stop,
    )) {
      out.push(value);
    }

    expect(out).toEqual(['a', 'b']);
    expect(onTimeout).not.toHaveBeenCalled();
  });
});

describe('Semaphore.hasFree', () => {
  it('reports free slots until max is reached, then again after release', async () => {
    const sem = new Semaphore(1);
    expect(sem.hasFree()).toBe(true);
    const release = await sem.acquire();
    expect(sem.hasFree()).toBe(false);
    release();
    expect(sem.hasFree()).toBe(true);
  });
});
