// THROWAWAY — live-validates the full app-server turn lifecycle our backend wraps:
// initialize → thread/start (danger-full-access) → turn/start → stream → turn/completed.
// Trivial side-effect-free prompt, low effort → minimal token cost.
// Run: node turn-probe.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const CODEX = process.env.CODEX_BIN || '/Users/clay/.superset/bin/codex';
const cwd = mkdtempSync(join(tmpdir(), 'codex-turn-probe-'));
execFileSync('git', ['init', '-q'], { cwd });
console.log('cwd:', cwd);

const child = spawn(CODEX, ['app-server', '--listen', 'stdio://'], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
let buf = '', id = 0;
const pending = new Map();
const send = (method, params) => {
  const rid = ++id;
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: rid, method, params }) + '\n');
  return new Promise((res) => pending.set(rid, res));
};
const notify = (method, params) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params: params ?? {} }) + '\n');

let turnDone;
const turnComplete = new Promise((r) => { turnDone = r; });

child.stdout.on('data', (d) => {
  buf += d.toString('utf8');
  let nl;
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (typeof m.id === 'number' && pending.has(m.id) && !m.method) { pending.get(m.id)(m); pending.delete(m.id); continue; }
    if (typeof m.id === 'number' && m.method) { child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'nh' } }) + '\n'); continue; }
    if (m.method) {
      const p = m.params || {};
      if (m.method === 'item/agentMessage/delta') process.stdout.write(`  …delta: ${JSON.stringify(p.delta)}\n`);
      else if (m.method === 'item/completed') console.log(`  item/completed type=${p.item?.type} text=${JSON.stringify((p.item?.text || '').slice(0,60))}`);
      else console.log(`EVENT ${m.method}${m.method === 'turn/started' ? ' turnId=' + p.turn?.id : ''}`);
      if (m.method === 'turn/completed') turnDone();
      if (m.method === 'error') { console.log('  ERROR:', JSON.stringify(p.error)); }
    }
  }
});
child.stderr.on('data', (d) => { const l = d.toString().trim(); if (l) process.stderr.write('[stderr] ' + l.slice(0, 160) + '\n'); });

const fail = setTimeout(() => { console.log('TIMEOUT'); child.kill('SIGKILL'); process.exit(1); }, 90000);

(async () => {
  const init = await send('initialize', { clientInfo: { name: 'turn-probe', version: '0' }, capabilities: null });
  console.log('initialize ok:', !!init.result);
  notify('initialized');
  const ts = await send('thread/start', { cwd, approvalPolicy: 'never', sandbox: 'danger-full-access' });
  const threadId = ts.result?.thread?.id;
  console.log('thread/start → threadId:', threadId);
  console.log('--- turn ---');
  send('turn/start', { threadId, input: [{ type: 'text', text: 'Reply with exactly the two words: hello world. Do not run any commands or tools.', text_elements: [] }], effort: 'low' });
  await turnComplete;
  clearTimeout(fail);
  console.log('--- turn complete ✓ ---');
  child.kill('SIGTERM');
  setTimeout(() => process.exit(0), 300);
})();
