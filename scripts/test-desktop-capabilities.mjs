import '../test/fixtures/offline-service-probes.mjs';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectHost, inspectHost } from '../dist/host.js';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'vonvon-capabilities-smoke-')));
const home = join(root, 'home');
const data = join(home, '.vonvon-bridge');
mkdirSync(data, { recursive: true });
mkdirSync(join(home, '.codex'));
const marker = join(data, 'existing-user-data');
writeFileSync(marker, 'preserve-me');
const npm = join(root, 'npm-cli.cjs');
const trace = join(root, 'npm.json');
const accountTrace = join(root, 'account.jsonl');
const descendants = join(root, 'descendants.jsonl');
const accountDescendant = `
process.on('SIGTERM',()=>{});
require('node:fs').appendFileSync(${JSON.stringify(descendants)}, JSON.stringify({pid:process.pid})+'\\n');
process.send({ready:true});
setInterval(()=>{},100);
`;
const accountFixture = `
const fs=require('node:fs');
if(process.argv.includes('--version')){console.log('codex-cli 0.156.1');process.exit(0);}
const record=value=>fs.appendFileSync(${JSON.stringify(accountTrace)},JSON.stringify({...value,pid:process.pid,home:process.env.CODEX_HOME})+'\\n');
const descendant=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(accountDescendant)}],{stdio:['ignore',process.stdout,process.stderr,'ipc']});
const descendantReady=new Promise(resolve=>descendant.once('message',resolve));
record({event:'start'});
const reply=(id,result)=>process.stdout.write(JSON.stringify({id,result})+'\\n');
require('node:readline').createInterface({input:process.stdin}).on('line',async line=>{
 await descendantReady;
 const m=JSON.parse(line);if(!m.id)return;record({method:m.method,params:m.params});
 if(m.method==='account/read')return reply(m.id,{account:null,requiresOpenaiAuth:true});
 if(m.method==='account/login/start')return reply(m.id,{type:'chatgptDeviceCode',loginId:'smoke-login',userCode:'SMOKE-CODE',verificationUrl:'https://auth.openai.com/codex/device'});
 reply(m.id,{});
 if(m.method==='account/login/cancel')process.exit(0);
});`;
writeFileSync(npm, `
const fs=require('node:fs'),path=require('node:path');
const prefix=process.argv[process.argv.indexOf('--prefix')+1];
fs.writeFileSync(${JSON.stringify(trace)},JSON.stringify({pid:process.pid,prefix}));
if(process.env.NPM_PROBE_MODE==='hold'){
 const source="process.on('SIGTERM',()=>{});const fs=require('node:fs');fs.writeFileSync("+JSON.stringify(${JSON.stringify(trace)})+",JSON.stringify({pid:process.pid,leaderPid:"+process.pid+",prefix:"+JSON.stringify(prefix)+"}));setInterval(()=>fs.writeFileSync("+JSON.stringify(path.join(prefix,'writing'))+",'fixture'),10);";
 require('node:child_process').spawn(process.execPath,['-e',source],{stdio:'ignore'});
 setInterval(()=>{},100);
}
else {
const bins=path.join(prefix,'node_modules/.bin');fs.mkdirSync(bins,{recursive:true});
fs.writeFileSync(path.join(bins,'codex.cjs'),${JSON.stringify(accountFixture)});
if(process.platform==='win32')fs.writeFileSync(path.join(bins,'codex.cmd'),'@echo off\\r\\n"'+process.execPath+'" "%~dp0codex.cjs" %*\\r\\n');
else fs.writeFileSync(path.join(bins,'codex'),'#!/bin/sh\\nexec "'+process.execPath+'" "$(dirname "$0")/codex.cjs" "$@"\\n',{mode:0o755});
}`);
const savedEnv = { ...process.env };
process.env.NODE_OPTIONS = `--import=${new URL('../test/fixtures/offline-service-probes.mjs', import.meta.url).href}`;
process.env.VONVON_NPM_CLI = npm;
process.env.CODEX_HOME = join(home, '.codex');
process.env.FEISHU_BRIDGE_NATIVE_SERVICE_TEST = '0';
delete process.env.CODEX_BIN;
delete process.env.OPENAI_API_KEY;
delete process.env.CODEX_API_KEY;
const options = { home, nodePath: process.execPath, cliPath: fileURLToPath(new URL('../bin/feishu-codex-bridge.mjs', import.meta.url)) };
let host;
let phase = 'connect Host';
let failure;
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const waitFor = async read => {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) { const value = await read(); if(value) return value; await new Promise(resolve => setTimeout(resolve, 25)); }
  throw new Error('Fixture operation timed out');
};
const json = async (path, init) => {
  const response = await host.request(path, init);
  assert.ok(response.ok, `${response.status} ${await response.clone().text()}`);
  return response.json();
};
const start = async type => json(`/api/tools/codex/${type}`, { method: 'POST' });
const job = async id => json(`/api/tools/codex/jobs/${id}`);
try {
  host = await connectHost(options); assert.equal(host.kind, 'connected', JSON.stringify(host)); assert.equal(host.ownership, 'owned');
  phase = 'install Codex and inspect account';
  const installed = await start('install');
  const completed = await waitFor(async () => { const value = await job(installed.id); return value.state !== 'running' && value; });
  assert.equal(completed.state, 'succeeded', JSON.stringify(completed));
  assert.equal((await json('/api/tools/codex/setup')).authentication, 'signedOut');
  phase = 'cancel login';
  const login = await start('login');
  await waitFor(async () => (await job(login.id)).state === 'authorizing');
  assert.equal((await json(`/api/tools/codex/jobs/${login.id}`, { method: 'DELETE' })).state, 'cancelled');
  assert.equal((await json(`/api/tools/codex/jobs/${login.id}`, { method: 'DELETE' })).state, 'cancelled');
  const quittingLogin = await start('login');
  await waitFor(async () => (await job(quittingLogin.id)).state === 'authorizing');
  phase = 'close Host during login';
  await host.close(); host = undefined;
  const accountCalls = readFileSync(accountTrace, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(accountCalls.filter(call => call.method === 'account/login/cancel').length, 2);
  assert.ok(accountCalls.every(call => call.home === join(home, '.codex') && !alive(call.pid)));
  const pointer = readFileSync(join(data, 'codex-cli/current.json'), 'utf8');
  process.env.NPM_PROBE_MODE = 'hold'; rmSync(trace);
  phase = 'install with active npm descendant';
  host = await connectHost(options); assert.equal(host.kind, 'connected', JSON.stringify(host));
  await start('install');
  await waitFor(() => existsSync(trace) && JSON.parse(readFileSync(trace, 'utf8')).leaderPid);
  const npmChild = JSON.parse(readFileSync(trace, 'utf8'));
  assert.ok(!npmChild.prefix.startsWith(data));
  phase = 'close Host during install';
  await host.close(); host = undefined;
  assert.equal(alive(npmChild.pid), false);
  assert.equal(alive(npmChild.leaderPid), false);
  assert.equal(existsSync(dirname(npmChild.prefix)), false);
  assert.equal(readFileSync(join(data, 'codex-cli/current.json'), 'utf8'), pointer);
  assert.equal(readFileSync(marker, 'utf8'), 'preserve-me');
  assert.equal((await inspectHost(home)).kind, 'absent');
  const spawnedDescendants = readFileSync(descendants, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.ok(spawnedDescendants.length >= 2);
  assert.ok(spawnedDescendants.every(child => !alive(child.pid)), 'all inherited-pipe app-server descendants exited before Host close');
  console.log('PASS actual Host install, account probe, exact login cancellation, login quit, npm descendant quit, inherited-pipe descendants, retained install and existing data.');
} catch (error) {
  failure = error;
  console.error(`Desktop capabilities failed during ${phase}:`, error);
  const logs = join(data, 'logs');
  if (existsSync(logs)) {
    for (const file of readdirSync(logs).filter(file => file.endsWith('.log')).sort().slice(-2)) {
      console.error(`Isolated fixture log ${file}:\n${readFileSync(join(logs, file), 'utf8').slice(-8192)}`);
    }
  }
  throw error;
} finally {
  try {
    if (host?.kind === 'connected') await host.close();
    rmSync(root, { recursive: true, force: true });
  } catch (cleanupError) {
    throw failure ? new AggregateError([failure, cleanupError], 'Desktop capabilities and cleanup both failed.') : cleanupError;
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
  }
}
