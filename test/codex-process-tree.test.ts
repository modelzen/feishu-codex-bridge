import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OwnedCodexProcess } from '../src/agent/codex-appserver/owned-process';
import { AppServerClient } from '../src/agent/codex-appserver/app-server-client';
import { runSetupChild } from '../src/agent/codex-appserver/managed-install';
import { writeNodeExecutable } from './helpers/node-executable';

const roots: string[] = [];
const pids: number[] = [];
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
afterEach(async () => {
  for (const pid of pids.splice(0)) { try { process.kill(pid, 'SIGKILL'); } catch {} }
  await delay(50);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(inherit: boolean) {
  const root = mkdtempSync(join(tmpdir(), 'codex-tree-')); roots.push(root);
  const ready = join(root, 'grandchild.pid');
  const grandchild = join(root, 'grandchild.cjs');
  writeFileSync(grandchild, `
    process.on('SIGTERM',()=>{});
    require('node:fs').writeFileSync(${JSON.stringify(ready)}, String(process.pid));
    setInterval(()=>{},100);
  `);
  const start = `require('node:child_process').spawn(process.execPath,[${JSON.stringify(grandchild)}],{stdio:${inherit ? "['ignore',process.stdout,process.stderr]" : "'ignore'"}});`;
  return { root, ready, start };
}
async function descendant(ready: string): Promise<number> {
  await vi.waitFor(() => expect(existsSync(ready)).toBe(true));
  const pid = Number(readFileSync(ready, 'utf8')); pids.push(pid); return pid;
}

describe('owned Codex process trees', () => {
  it.skipIf(process.platform === 'win32')('keeps polling an EPERM liveness result until the owned group is absent', async () => {
    const f = fixture(false);
    const owned = new OwnedCodexProcess(process.execPath, ['-e', 'setInterval(()=>{},100)'], { cwd: f.root, stdio: 'ignore' });
    const pid = owned.child.pid!;
    pids.push(pid);
    const kill = process.kill.bind(process);
    let permissionDenied = false;
    const probe = vi.spyOn(process, 'kill').mockImplementation((target, signal) => {
      if (target === -pid && signal === 0 && !permissionDenied) {
        permissionDenied = true;
        throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
      }
      return kill(target, signal);
    });
    try {
      await owned.close(100);
      expect(permissionDenied).toBe(true);
      expect(alive(pid)).toBe(false);
    } finally { probe.mockRestore(); }
  });

  it('cancels immediately while the process owner is starting', async () => {
    const f = fixture(false);
    const abort = new AbortController();
    const running = runSetupChild(process.execPath, ['-e', 'setInterval(()=>{},100)'], { cwd: f.root, signal: abort.signal });
    abort.abort();
    await expect(running).rejects.toThrow();
  }, 10_000);

  it('cancellation awaits an ignored-stdio descendant that ignores TERM', async () => {
    const f = fixture(false);
    const parent = join(f.root, 'parent.cjs');
    writeFileSync(parent, `${f.start}setInterval(()=>{},100);`);
    const abort = new AbortController();
    const running = runSetupChild(process.execPath, [parent], { cwd: f.root, signal: abort.signal }).catch(error => error);
    const pid = await descendant(f.ready);
    abort.abort();
    await running;
    expect(alive(pid)).toBe(false);
  }, 10_000);

  it.each([false, true])('close reaps inherited pipes after leader already exited=%s', async earlyExit => {
    const f = fixture(true);
    const leaderFile = join(f.root, 'leader.pid');
    const server = writeNodeExecutable(f.root, 'server', `
      require('node:fs').writeFileSync(${JSON.stringify(leaderFile)},String(process.pid));
      ${f.start}
      require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
        const m=JSON.parse(line);
        if(m.method==='exit')process.exit(0);
        if(m.id)process.stdout.write(JSON.stringify({id:m.id,result:{}})+'\\n');
      });
    `);
    const client = new AppServerClient({ bin: server.bin, cwd: f.root, initializeTimeoutMs: 10_000 });
    await client.connect();
    if (client.pid) pids.push(client.pid);
    const pid = await descendant(f.ready);
    const leader = Number(readFileSync(leaderFile, 'utf8'));
    pids.push(leader);
    if (earlyExit) {
      client.notify('exit');
      await vi.waitFor(() => expect(alive(leader)).toBe(false));
      if (process.platform !== 'win32') expect(client.exited).toBe(true);
    }
    const result = await Promise.race([client.close(50).then(() => 'closed'), delay(8000).then(() => 'timeout')]);
    expect(result).toBe('closed');
    expect(alive(pid)).toBe(false);
  }, 20_000);
});
