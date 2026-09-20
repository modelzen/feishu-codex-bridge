import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import type { AppConfig } from '../src/config/schema';
const mocked = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: mocked.spawn }));
afterEach(() => { vi.useRealTimers(); vi.resetModules(); mocked.spawn.mockReset(); });
it('kills a stuck sync and allows the next scheduled sync after child close', async () => {
  vi.useFakeTimers();
  const children: (EventEmitter & { kill: ReturnType<typeof vi.fn>; unref: ReturnType<typeof vi.fn> })[] = [];
  mocked.spawn.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), { kill: vi.fn(() => true), unref: vi.fn() });
    children.push(child); return child;
  });
  const { startMemorySync } = await import('../src/bot/memory-context');
  startMemorySync({ preferences: { memoryContext: { command: 'test-memory', syncArgs: ['sync'], syncTimeoutMs: 100, syncIntervalSeconds: 60 } } } as AppConfig);
  await vi.advanceTimersByTimeAsync(1000);
  expect(children).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(100);
  expect(children[0]!.kill).toHaveBeenCalledWith('SIGKILL');
  await vi.advanceTimersByTimeAsync(60_000);
  expect(children).toHaveLength(1); // A surviving child must not overlap its replacement.
  children[0]!.emit('close', null);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(children).toHaveLength(2);
  children[1]!.emit('error', new Error('spawn failed'));
  await vi.advanceTimersByTimeAsync(60_000);
  expect(children).toHaveLength(3);
});
