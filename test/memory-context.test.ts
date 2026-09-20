import { expect, it } from 'vitest';
import { loadMemoryContext } from '../src/bot/memory-context';
import type { AppConfig } from '../src/config/schema';
it('does not block memory results on verbose stderr', async () => {
  const cfg = { preferences: { memoryContext: { command: process.execPath, args: ['-e', "process.stderr.write('x'.repeat(2 * 1024 * 1024), () => process.stdout.write('useful memory'))"], timeoutMs: 1500 } } } as AppConfig;
  expect(await loadMemoryContext(cfg, { chat_id: 'test', message_id: 'test', query: 'hello' })).toBe('useful memory');
});

it.each([undefined, { enabled: false }])('keeps memory injection when briefing is inactive (%j)', async contextBriefing => {
  const cfg = { preferences: { contextBriefing, memoryContext: { command: process.execPath, args: ['-e', "process.stdout.write('retained memory')"] } } } as AppConfig;
  expect(await loadMemoryContext(cfg, { chat_id: 'test', message_id: 'test', query: 'hello' })).toBe('retained memory');
});
it.each([{ enabled: true }, {}])('suppresses legacy injection when briefing is active (%j)', async contextBriefing => {
  const cfg = { preferences: { contextBriefing, memoryContext: { command: process.execPath, args: ['-e', "process.stdout.write('duplicate memory')"] } } } as AppConfig;
  expect(await loadMemoryContext(cfg, { chat_id: 'test', message_id: 'test', query: 'hello' })).toBe('');
});
