import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { CodexProcessCleanupError, OwnedCodexProcess } from '../src/agent/codex-appserver/owned-process';
import { CodexSetupService } from '../src/agent/codex-appserver/setup';
import { resolveCodexBin } from '../src/agent/codex-appserver/locate';
import { writeNodeExecutable } from './helpers/node-executable';

const home = mkdtempSync(join(tmpdir(), 'codex-setup-home-'));
const log = join(home, 'calls.jsonl');
const auth = join(home, '.codex');
mkdirSync(auth);
const source = `
const fs = require('node:fs');
const path = require('node:path');
if (process.argv.includes('--version')) { console.log('codex-cli 0.156.1'); process.exit(0); }
const mode = process.env.FIXTURE_MODE;
const auth = path.join(process.env.CODEX_HOME, 'fixture-account');
const record = value => fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({...value, bin: process.argv[1], home: process.env.CODEX_HOME, pid: process.pid}) + '\\n');
record({event:'start'});
const response = (id, result) => process.stdout.write(JSON.stringify({id, result}) + '\\n');
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
 const m=JSON.parse(line); if(!m.id) return;
 record({method:m.method, params:m.params});
 if(m.method==='initialize') return response(m.id, {});
 if(m.method==='account/read') return response(m.id, mode==='malformed' ? {} : {account:fs.existsSync(auth) ? {type:'chatgpt', email:'fixture@example.invalid', planType:'free'} : null, requiresOpenaiAuth:mode!=='custom'});
 if(m.method==='account/login/cancel') return response(m.id, {status:'canceled'});
 if(m.method==='account/login/start') {
   if(mode==='unsupported') return response(m.id, {type:'chatgpt', loginId:'fixture-login', authUrl:'https://auth.openai.com/'});
   if(mode==='late'){setTimeout(()=>response(m.id,{type:'chatgptDeviceCode',loginId:'fixture-login',userCode:'TEST-CODE',verificationUrl:'https://auth.openai.com/codex/device'}),150);return;}
   response(m.id,{type:'chatgptDeviceCode', loginId:'fixture-login', userCode:'TEST-CODE', verificationUrl:mode==='foreign'?'https://evil.invalid/':'https://auth.openai.com/codex/device'});
   if(mode==='hold'||mode==='foreign') return;
   setTimeout(()=>{
    if(mode==='success')fs.writeFileSync(auth,'fixture only');
    process.stdout.write(JSON.stringify({method:'account/login/completed',params:{loginId:'fixture-login',success:mode!=='failure',error:null}})+'\\n');
   },50);
 }
});
`;
const fixture = writeNodeExecutable(home, 'codex fixture', source);
const services: CodexSetupService[] = [];
const service = (options?: ConstructorParameters<typeof CodexSetupService>[0]): CodexSetupService => { const value = new CodexSetupService(options); services.push(value); return value; };
async function terminal(value: CodexSetupService, id: string) {
  await vi.waitFor(() => expect(['succeeded', 'failed', 'cancelled']).toContain(value.get(id)?.state), { timeout: 20_000 });
  return value.get(id);
}
function calls(): { method?: string; params?: { loginId?: string }; bin: string; home: string; pid: number }[] { return existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : []; }
function alive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }

beforeAll(() => {
  vi.stubEnv('HOME', home); vi.stubEnv('USERPROFILE', home); vi.stubEnv('XDG_CONFIG_HOME', join(home, '.config')); vi.stubEnv('CODEX_HOME', auth); vi.stubEnv('CODEX_BIN', fixture.bin);
});
afterEach(async () => {
  await Promise.all(services.splice(0).map(value => value.close()));
  rmSync(join(auth, 'fixture-account'), { force: true }); rmSync(log, { force: true });
  vi.stubEnv('FIXTURE_MODE', 'hold'); vi.stubEnv('CODEX_BIN', fixture.bin);
});
afterAll(() => { vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); });

describe('Codex account setup uses the task executable and home', { timeout: 40_000 }, () => {
  it('distinguishes installation, signed-out, signed-in, not-required and malformed account state', async () => {
    const value = service();
    expect(await value.setup()).toMatchObject({ installation: 'installed', authentication: 'signedOut', version: 'codex-cli 0.156.1', executable: fixture.bin });
    expect(resolveCodexBin()).toBe(fixture.bin);
    writeFileSync(join(auth, 'fixture-account'), 'fixture');
    expect(await value.setup()).toMatchObject({ authentication: 'signedIn' });
    vi.stubEnv('FIXTURE_MODE', 'custom');
    expect(await value.setup()).toMatchObject({ authentication: 'notRequired' });
    vi.stubEnv('FIXTURE_MODE', 'malformed');
    expect(await value.setup()).toMatchObject({ authentication: 'unknown' });
    expect(calls().every(call => call.home === auth && call.bin === fixture.script)).toBe(true);
    expect(calls().filter(call => call.method === 'account/read')).toHaveLength(4);
    expect(calls().every(call => !alive(call.pid))).toBe(true);
  });

  it('does not fall back when an explicit override is missing and refuses managed install', async () => {
    vi.stubEnv('CODEX_BIN', join(home, 'missing'));
    const value = service();
    expect(await value.setup()).toMatchObject({ installation: 'unknown', authentication: 'unknown' });
    expect(resolveCodexBin()).toBeNull();
    expect(() => value.start('install')).toThrow('CODEX_BIN');
  });

  it('returns device code only while authorizing, then rereads account before success', async () => {
    vi.stubEnv('FIXTURE_MODE', 'success');
    const value = service(); const { id } = value.start('login');
    expect((await terminal(value, id))?.state).toBe('succeeded');
    expect(value.get(id)).not.toHaveProperty('userCode');
    expect(value.get(id)).not.toHaveProperty('verificationUrl');
    expect(calls().filter(call => call.method === 'account/read')).toHaveLength(2);
    expect(calls().filter(call => call.method === 'account/login/start')).toHaveLength(1);
    expect(calls().every(call => !alive(call.pid))).toBe(true);
  });

  it.each(['failure', 'unconfirmed', 'unsupported', 'foreign', 'custom'])('never claims success for %s', async mode => {
    vi.stubEnv('FIXTURE_MODE', mode);
    const value = service(); const { id } = value.start('login');
    expect((await terminal(value, id))?.state).toBe('failed');
    expect(value.get(id)).not.toHaveProperty('verificationUrl');
  });

  it('cancels only its login id, awaits child exit, and repeats cancellation without side effects', async () => {
    vi.stubEnv('FIXTURE_MODE', 'hold');
    const value = service(); const { id } = value.start('login');
    await vi.waitFor(() => expect(value.get(id)).toMatchObject({ state: 'authorizing', userCode: 'TEST-CODE', verificationUrl: 'https://auth.openai.com/codex/device' }), { timeout: 10_000 });
    expect(() => value.start('login')).toThrow('正在进行');
    expect(await value.cancel('unknown')).toBeUndefined();
    expect(value.get(id)?.state).toBe('authorizing');
    const cancelled = await value.cancel(id);
    expect(cancelled?.state).toBe('cancelled');
    expect(await value.cancel(id)).toEqual(cancelled);
    expect(calls().filter(call => call.method === 'account/login/cancel').map(call => call.params?.loginId)).toEqual(['fixture-login']);
    expect(calls().every(call => !alive(call.pid))).toBe(true);
  });

  it('cancels a late login id before closing and never publishes its device code', async () => {
    vi.stubEnv('FIXTURE_MODE', 'late');
    const value = service(); const { id } = value.start('login');
    await vi.waitFor(() => expect(calls().some(call => call.method === 'account/login/start')).toBe(true), { timeout: 10_000 });
    expect((await value.cancel(id))?.state).toBe('cancelled');
    expect(value.get(id)).not.toHaveProperty('userCode');
    expect(calls().filter(call => call.method === 'account/login/cancel').map(call => call.params?.loginId)).toEqual(['fixture-login']);
    expect(calls().every(call => !alive(call.pid))).toBe(true);
  });

  it('shutdown cancels login, waits for child exit and rejects later starts', async () => {
    vi.stubEnv('FIXTURE_MODE', 'hold');
    const value = service(); const { id } = value.start('login');
    await vi.waitFor(() => expect(value.get(id)?.state).toBe('authorizing'), { timeout: 10_000 });
    await value.close();
    expect(value.get(id)?.state).toBe('cancelled');
    expect(() => value.start('login')).toThrow('退出');
    expect(calls().every(call => !alive(call.pid))).toBe(true);
  });

  it('retains bounded terminal snapshots and separates install failures from successes', async () => {
    vi.stubEnv('CODEX_BIN', '');
    let fail = false;
    const value = service({ retain: 2, install: async () => { if (fail) throw new Error('fixture install failure'); } });
    const first = value.start('install').id;
    expect((await terminal(value, first))?.state).toBe('succeeded');
    fail = true; const second = value.start('install').id;
    expect((await terminal(value, second))?.state).toBe('failed');
    const third = value.start('install').id; await terminal(value, third);
    expect(value.get(first)).toBeUndefined();
    expect(value.get(second)?.state).toBe('failed');
  });
});

it('cleanup uncertainty remains failed after cancellation and prevents successful Host close', async () => {
  vi.stubEnv('CODEX_BIN', '');
  const value = new CodexSetupService({ install: async signal => {
    await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
    throw new CodexProcessCleanupError('fixture cleanup unknown');
  } });
  const { id } = value.start('install');
  await Promise.resolve();
  await expect(value.cancel(id)).rejects.toThrow('fixture cleanup unknown');
  expect(value.get(id)?.state).toBe('failed');
  expect(() => value.start('install')).toThrow('清理未确认');
  await expect(value.close()).rejects.toThrow('清理未确认');
});

it('probe cleanup failure remains visible to later Host close', async () => {
  const close = OwnedCodexProcess.prototype.close;
  const failure = vi.spyOn(OwnedCodexProcess.prototype, 'close').mockImplementationOnce(async function (this: OwnedCodexProcess, graceMs) {
    await close.call(this, graceMs);
    throw new CodexProcessCleanupError('fixture probe cleanup unknown');
  });
  const value = new CodexSetupService();
  try {
    await expect(value.setup()).rejects.toThrow('fixture probe cleanup unknown');
    expect(() => value.setup()).toThrow('清理未确认');
    await expect(value.close()).rejects.toThrow('清理未确认');
  } finally { failure.mockRestore(); }
}, 20_000);
