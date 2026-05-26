// THROWAWAY probe — validates codex app-server stdio handshake + model/list.
// No turn is started, so no model inference / token cost. Run: node probe.mjs
import { spawn } from 'node:child_process';

const CODEX = process.env.CODEX_BIN || '/Users/clay/.superset/bin/codex';
const child = spawn(CODEX, ['app-server', '--listen', 'stdio://'], { stdio: ['pipe', 'pipe', 'pipe'] });

let buf = '';
let id = 0;
const pending = new Map();
function send(method, params) {
  const rid = ++id;
  const msg = { jsonrpc: '2.0', id: rid, method, params };
  child.stdin.write(JSON.stringify(msg) + '\n');
  return new Promise((res) => pending.set(rid, res));
}
function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params: params ?? {} }) + '\n');
}

child.stdout.on('data', (d) => {
  buf += d.toString('utf8');
  let nl;
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { console.log('NONJSON:', line.slice(0, 120)); continue; }
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    else console.log('EVENT/NOTIFY:', JSON.stringify(m).slice(0, 200));
  }
});
child.stderr.on('data', (d) => process.stderr.write('[stderr] ' + d));

const done = (code) => { child.kill('SIGTERM'); process.exit(code); };
setTimeout(() => { console.log('TIMEOUT'); done(1); }, 20000);

(async () => {
  const init = await send('initialize', { clientInfo: { name: 'feishu-codex-bridge-probe', version: '0.0.0' }, capabilities: null });
  console.log('INITIALIZE →', JSON.stringify(init.result ?? init.error).slice(0, 300));
  notify('initialized');

  const ml = await send('model/list', { limit: 50 });
  if (ml.error) { console.log('MODEL/LIST error →', JSON.stringify(ml.error)); }
  else {
    const items = ml.result?.items || ml.result?.models || ml.result || [];
    console.log('MODEL/LIST → count:', Array.isArray(items) ? items.length : '(shape?)');
    console.log(JSON.stringify(ml.result).slice(0, 800));
  }
  done(0);
})();
