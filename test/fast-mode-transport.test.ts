// Transport tests observe only the requested session, not background warm-up threads.
vi.mock('../src/agent/codex-appserver/client-pool', async original => ({
  ...await original<object>(), takeWarmClient: () => null, refillWarmPool: async () => undefined,
}));
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { CodexAppServerBackend } from '../src/agent/codex-appserver/backend';
import type { AgentThread, TurnOptions } from '../src/agent/types';

const dir = mkdtempSync(join(tmpdir(), 'bridge-fast-transport-'));
const bin = join(dir, 'codex');
const journal = join(dir, 'requests.jsonl');
const config = join(dir, 'config.json');
writeFileSync(config, JSON.stringify({ service_tier: 'fast' }));
writeFileSync(bin, `#!/usr/bin/env node
const fs = require('fs');
const readline = require('readline');
const send = obj => process.stdout.write(JSON.stringify(obj) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  m.pid = process.pid;
  fs.appendFileSync(${JSON.stringify(journal)}, JSON.stringify(m) + '\\n');
  if (m.method === 'config/read') {
    const cfg = JSON.parse(fs.readFileSync(${JSON.stringify(config)}, 'utf8'));
    if (cfg.fail) send({ id: m.id, error: { code: -32000, message: 'config unavailable' } });
    else send({ id: m.id, result: { config: cfg } });
  } else if (m.method === 'turn/start') {
    send({ id: m.id, result: { turn: { id: 'turn' } } });
    send({ method: 'turn/started', params: { threadId: 'host', turn: { id: 'turn' } } });
    send({ method: 'turn/completed', params: { threadId: 'host', turn: { id: 'turn' } } });
  } else send({ id: m.id, result: { thread: { id: 'host' } } });
});
`, { mode: 0o755 });
afterAll(() => rmSync(dir, { recursive: true, force: true }));
async function turn(thread: AgentThread, options?: TurnOptions) {
  for await (const _ of thread.runStreamed({ text: 'hello' }, options).events) { /* drain */ }
}
function requests(method: string) {
  return readFileSync(journal, 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(m => m.method === method);
}
async function withServer(fn: (be: CodexAppServerBackend) => Promise<void>) {
  const prev = process.env.CODEX_BIN;
  process.env.CODEX_BIN = bin;
  writeFileSync(journal, '');
  try { await fn(new CodexAppServerBackend()); }
  finally { if (prev === undefined) delete process.env.CODEX_BIN; else process.env.CODEX_BIN = prev; }
}

describe.skipIf(process.platform === 'win32')('Fast JSON-RPC transport', () => {
  it('starts Fast, explicitly clears it, and keeps off on subsequent turns', async () => {
    await withServer(async be => {
      const t = await be.startThread({ cwd: dir, fastMode: true });
      try {
        await turn(t);
        await turn(t, { fastMode: false });
        await turn(t);
        expect(requests('thread/start')[0].params.serviceTier).toBe('fast');
        expect(requests('turn/start').map(m => m.params.serviceTier)).toEqual(['fast', null, null]);
      } finally { await t.close(); }
    });
  });
  it.each([true, false])('restores persisted Fast=%s and passes it to the next turn', async fastMode => {
    await withServer(async be => {
      const t = await be.resumeThread({ cwd: dir, sessionId: 'host', fastMode });
      try {
        await turn(t);
        const expected = fastMode ? 'fast' : null;
        expect(requests('thread/resume')[0].params.serviceTier).toBe(expected);
        expect(requests('turn/start')[0].params.serviceTier).toBe(expected);
      } finally { await t.close(); }
    });
  });
  it('leaves unconfigured sessions untouched and can enable Fast later', async () => {
    await withServer(async be => {
      const t = await be.startThread({ cwd: dir });
      try {
        await turn(t);
        await turn(t, { fastMode: true });
        expect(requests('thread/start')[0].params).not.toHaveProperty('serviceTier');
        expect(requests('turn/start')[0].params).not.toHaveProperty('serviceTier');
        expect(requests('turn/start')[1].params.serviceTier).toBe('fast');
      } finally { await t.close(); }
    });
  });
});


describe('restore inherited Fast transport', () => {
  it.each(['fast', null])('restores configured tier %s for resume and queued turns', async service_tier => {
    writeFileSync(config, JSON.stringify({ service_tier }));
    await withServer(async be => {
      const t = await be.resumeThread({ cwd: dir, sessionId: 'host', fastMode: null });
      try {
        expect(requests('thread/resume')[0].params.serviceTier).toBe(service_tier);
        await turn(t, { fastMode: false });
        await turn(t, { fastMode: null });
        await turn(t);
        expect(requests('turn/start').map(m => m.params.serviceTier)).toEqual([null, service_tier, service_tier]);
        expect(t.getPreferences?.().fastMode).toBeNull();
      } finally { await t.close(); }
    });
  });
});


it('surfaces config failures without a turn and closes failed resume processes', async () => {
  writeFileSync(config, JSON.stringify({ fail: true }));
  await withServer(async be => {
    await expect(be.resumeThread({ cwd: dir, sessionId: 'host', fastMode: null })).rejects.toThrow('config unavailable');
    expect(requests('thread/resume')).toHaveLength(0);
    expect(() => process.kill(requests('config/read')[0].pid, 0)).toThrow();
    const t = await be.startThread({ cwd: dir, fastMode: true });
    try {
      const events = [];
      for await (const event of t.runStreamed({ text: 'must not run' }, { fastMode: null }).events) events.push(event);
      expect(events).toContainEqual(expect.objectContaining({ type: 'error', message: expect.stringContaining('config unavailable'), willRetry: false }));
      expect(requests('turn/start')).toHaveLength(0);
    } finally { await t.close(); }
  });
});


it('applies inherited configuration when creating a new session', async () => {
  writeFileSync(config, JSON.stringify({ service_tier: 'fast' }));
  await withServer(async be => {
    const t = await be.startThread({ cwd: dir, fastMode: null });
    try {
      expect(requests('thread/start')[0].params.serviceTier).toBe('fast');
      expect(requests('turn/start')).toHaveLength(0);
    } finally { await t.close(); }
  });
});
