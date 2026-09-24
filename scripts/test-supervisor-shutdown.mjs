import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
let stopChild;

const directory = mkdtempSync(join(tmpdir(), 'vonvon-supervisor-test-'));
const stubs = new Map([
  ['../platform/spawn', `import {spawn} from 'node:child_process'; export function spawnProcess(_bin,_args,opts){return spawn(process.execPath,[process.env.VONVON_PROBE_CHILD],opts);}`],
  ['../service/win-startup', `export const SERVICE_ENV_FLAG='FEISHU_CODEX_BRIDGE_SERVICE'; export function recordServicePid(){}`],
  ['../core/logger', `export const log={info(){},warn(){},fail(){}};`],
  ['../admin/ipc', `export function createAdminIpcCaller(){return {onMessage(){},rejectAll(){},async call(){return {};}};}`],
  ['../admin/ops', `export class AdminWriteError extends Error{}`],
  ['../admin/service', `export function createAdminService(options){return options;}`],
  ['../agent', `export async function installBackendDep(){} export async function uninstallBackendDep(){}`],
  ['../cli/commands/daemon-control', `export function spawnDaemonControl(){}`],
  ['../web/mount', `export async function mountWebConsole(){return {port:1,async close(){}};}`],
]);

async function runScenario(scenario) {
  const hang = scenario === 'ignored' || scenario === 'unresponsive';
  const fails = scenario !== 'delayed';
  const fixture = join(directory, scenario);
  const child = spawn(process.execPath, [join(directory, 'entry.mjs')], {
    env: { ...process.env, HOME: directory, USERPROFILE: directory, VONVON_PROBE_DIR: directory,
      VONVON_PROBE_CHILD: join(directory, 'child.mjs'), VONVON_PROBE_PREFIX: fixture, VONVON_PROBE_HANG: hang ? '1' : '0', VONVON_PROBE_SCENARIO: scenario },
    detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '';
  let errors = '';
  child.stderr.on('data', (buffer) => errors += buffer);
  const exited = new Promise((resolve, reject) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
    child.once('error', reject);
  });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 20000);
  try {
    await new Promise((resolve, reject) => {
      const readyTimeout = setTimeout(() => reject(new Error('Fixture readiness timed out.')), 5000);
      child.stdout.on('data', (buffer) => {
        output += buffer;
        if ([...output.matchAll(/fixture-ready \d+/g)].length === 2) {
          clearTimeout(readyTimeout);
          resolve();
        }
      });
    });
    const started = Date.now();
    let failure;
    try { await stopChild(child, undefined, process.platform !== 'win32'); } catch (error) { failure = error; }
    const result = await exited;
    const elapsed = Date.now() - started;
    const completed = readdirSync(directory).filter((file) => file.startsWith(scenario + '-')).length;
    console.log(JSON.stringify({ scenario, result, elapsed, failure: failure?.message }));
    if (scenario === 'unresponsive') assert.ok(failure);
    else assert.equal(result.code, fails ? 1 : 0, errors);
    assert.equal(Boolean(failure), fails);
    assert.equal(completed, hang ? 0 : 2);
    assert.ok(elapsed >= (hang ? 7900 : 900));
    for (const match of output.matchAll(/fixture-ready (\d+)/g)) {
      assert.throws(() => process.kill(Number(match[1]), 0), (error) => error.code === 'ESRCH');
    }
    console.log(JSON.stringify({ productionSupervisor: true, scenario, exitCode: result.code, elapsedMs: elapsed, completedBeforeExit: completed }));
  } finally {
    clearTimeout(timeout);
    for (const match of output.matchAll(/fixture-ready (\d+)/g)) {
      try { process.kill(Number(match[1]), 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
  }
}

try {
  await build({ entryPoints: [resolve('src/host/lifecycle.ts')], outfile: join(directory, 'lifecycle.mjs'), bundle: true, format: 'esm', platform: 'node' });
  ({ stopChild } = await import(pathToFileURL(join(directory, 'lifecycle.mjs')).href));
  await build({
    entryPoints: [resolve('src/bot/supervisor.ts')], outfile: join(directory, 'supervisor.mjs'),
    bundle: true, format: 'esm', platform: 'node',
    plugins: [{ name: 'isolated-external-effects', setup(builder) {
      builder.onResolve({ filter: /.*/ }, (args) => stubs.has(args.path) ? { path: args.path, namespace: 'fixture' } : undefined);
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, (args) => ({ contents: stubs.get(args.path), loader: 'js' }));
    } }],
  });
  writeFileSync(join(directory, 'child.mjs'), `
    import {writeFileSync} from 'node:fs';
    setInterval(()=>{},1000);
    let stopping=false;
    function stop() {
      if(stopping || process.env.VONVON_PROBE_HANG==='1') return;
      stopping=true;
      setTimeout(()=>{
        writeFileSync(process.env.VONVON_PROBE_PREFIX+'-'+process.pid,'closed');
        process.exit(process.env.VONVON_PROBE_SCENARIO==='exit-one' ? 1 : 0);
      },1000);
    }
    process.on('SIGTERM',stop);
    process.on('message',message=>{if(message.type==='bridge:shutdown')stop();});
    console.log('fixture-ready '+process.pid);
  `);
  writeFileSync(join(directory, 'entry.mjs'), `
    import {runSupervisor} from './supervisor.mjs';
    import {observeShutdown} from './lifecycle.mjs';
    try {
      await runSupervisor([{appId:'fixture-one',name:'one',tenant:'feishu'},{appId:'fixture-two',name:'two',tenant:'feishu'}], {control: process.env.VONVON_PROBE_SCENARIO==='unresponsive' ? {waitForRequest:()=>new Promise(()=>{}),dispose(){}} : observeShutdown(true)});
    } catch(error) { console.error(error); process.exitCode=1; }
    process.disconnect?.();
  `);
  await runScenario('delayed');
  await runScenario('exit-one');
  await runScenario('ignored');
  await runScenario('unresponsive');
} finally { rmSync(directory, { recursive: true, force: true }); }
