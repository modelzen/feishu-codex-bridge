import '../test/fixtures/offline-service-probes.mjs';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectHost, inspectHost, migrateHostDataOffline, HostOwnershipError } from '../dist/host.js';

const root = mkdtempSync(join(tmpdir(), 'vonvon-host-smoke-'));
const cliPath = fileURLToPath(new URL('../bin/feishu-codex-bridge.mjs', import.meta.url));
const fixture = new URL('../test/fixtures/offline-service-probes.mjs', import.meta.url).href;
const nodePath = process.execPath;
process.env.NODE_OPTIONS = `--import=${fixture}`;
process.env.FEISHU_BRIDGE_NATIVE_SERVICE_TEST = '0';
const envFor = (home) => ({ ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, '.config') });
let host;
try {
  const home = join(root, 'new'); mkdirSync(home);
  host = await connectHost({ home, nodePath, cliPath });
  assert.equal(host.kind, 'connected', JSON.stringify(host));
  assert.equal(host.ownership, 'owned');
  assert.equal((await host.request('/api/state')).status, 200);
  const attached = await connectHost({ home, nodePath, cliPath });
  assert.equal(attached.kind, 'connected');
  assert.equal(attached.ownership, 'attached');
  await assert.rejects(attached.restart(), HostOwnershipError);
  await attached.close();
  assert.equal((await host.request('/api/state')).status, 200);
  const firstPid = host.pid;
  await host.restart();
  assert.notEqual(host.pid, firstPid);
  assert.equal((await host.request('/api/state')).status, 200);
  await host.close();
  assert.equal((await inspectHost(home)).kind, 'absent');
  host = undefined;

  const eof = spawn(nodePath, [cliPath, 'host', '--parent-control'], { env: envFor(home), stdio: ['pipe', 'ignore', 'pipe'] });
  let errors = ''; eof.stderr.on('data', (b) => errors += b);
  eof.stdin.end();
  const eofCode = await new Promise((resolve, reject) => { eof.once('error', reject); eof.once('exit', resolve); });
  assert.equal(eofCode, 0, errors);
  assert.equal((await inspectHost(home)).kind, 'absent');

  const raceHome = join(root, 'race'); mkdirSync(raceHome);
  const raced = await Promise.all([connectHost({ home: raceHome, nodePath, cliPath }), connectHost({ home: raceHome, nodePath, cliPath })]);
  assert.equal(raced.filter(item => item.kind === 'connected' && item.ownership === 'owned').length, 1);
  for (const item of raced) if (item.kind === 'connected') await item.close();
  assert.equal((await inspectHost(raceHome)).kind, 'absent');

  const poisonedHome = join(root, 'poisoned'); mkdirSync(join(poisonedHome, '.vonvon-bridge'), { recursive: true });
  const record = join(poisonedHome, '.vonvon-bridge', 'web-console.json');
  writeFileSync(record, '{');
  assert.equal((await connectHost({ home: poisonedHome, nodePath, cliPath })).kind, 'blocked');
  writeFileSync(record, JSON.stringify({ pid: process.pid, port: 1, token: 'fixture', startedAt: Date.now() }));
  assert.equal((await inspectHost(poisonedHome)).kind, 'blocked');

  const leasedHome = join(root, 'leased'); mkdirSync(join(leasedHome, '.feishu-codex-bridge'), { recursive: true });
  const dataUser = spawn(nodePath, [cliPath, 'secrets', 'get'], { env: envFor(leasedHome), stdio: ['pipe', 'ignore', 'ignore'] });
  try {
    const deadline = Date.now() + 5000;
    while (!existsSync(join(leasedHome, '.vonvon-bridge-access')) || readdirSync(join(leasedHome, '.vonvon-bridge-access')).length === 0) {
      if (Date.now() > deadline) throw new Error('Data lease publication timed out.');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal((await migrateHostDataOffline(leasedHome, { nodePath, cliPath })).kind, 'deferred');
    assert.equal(existsSync(join(leasedHome, '.vonvon-bridge-migration.json')), false);
    const exited = new Promise(resolve => dataUser.once('exit', resolve));
    dataUser.kill('SIGKILL'); await exited;
    assert.equal((await migrateHostDataOffline(leasedHome, { nodePath, cliPath })).kind, 'linked');
  } finally { if (dataUser.exitCode === null && dataUser.signalCode === null) dataUser.kill('SIGKILL'); }

  const legacyHome = join(root, 'old'); mkdirSync(legacyHome);
  const legacy = join(legacyHome, '.feishu-codex-bridge'); mkdirSync(legacy);
  writeFileSync(join(legacy, 'sessions.json'), '{"preserved":true}');
  const stored = spawnSync(nodePath, [cliPath, 'secrets', 'set', 'fixture-secret'], { env: envFor(legacyHome), encoding: 'utf8', input: 'synthetic-fixture-value' });
  assert.equal(stored.status, 0, stored.stderr);
  const encrypted = readFileSync(join(legacy, 'secrets.enc'));
  const salt = readFileSync(join(legacy, '.keystore.salt'));
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  const wrapper = join(legacy, 'secrets-getter');
  writeFileSync(wrapper, `#!/bin/sh\n# Auto-generated by feishu-codex-bridge. Do not edit.\nexec ${quote(nodePath)} ${quote(cliPath)} secrets get "$@"\n`, { mode: 0o700 });
  writeFileSync(join(legacy, 'config.json'), JSON.stringify({ secrets: { providers: { bridge: { source: 'exec', command: wrapper, args: [] }, custom: { source: 'exec', command: 'custom-provider', args: ['keep'] } } } }));
  const runtimeFor = (name) => {
    const directory = join(root, name); mkdirSync(directory);
    const runtime = { nodePath: join(directory, process.platform === 'win32' ? 'node.exe' : 'node'), cliPath: join(directory, 'cli.mjs') };
    copyFileSync(nodePath, runtime.nodePath);
    writeFileSync(runtime.cliPath, `import ${JSON.stringify(new URL('../dist/cli.js', import.meta.url).href)};`);
    return runtime;
  };
  const runtimeA = runtimeFor('runtime-A');
  const runtimeB = runtimeFor('runtime-B');
  const migrated = await migrateHostDataOffline(legacyHome, runtimeA);
  assert.equal(migrated.kind, 'linked', JSON.stringify(migrated));
  assert.equal(realpathSync(legacy), realpathSync(join(legacyHome, '.vonvon-bridge')));
  assert.equal(readFileSync(join(legacy, 'sessions.json'), 'utf8'), '{"preserved":true}');
  assert.deepEqual(readFileSync(join(legacy, 'secrets.enc')), encrypted);
  assert.deepEqual(readFileSync(join(legacy, '.keystore.salt')), salt);
  assert.equal((await migrateHostDataOffline(legacyHome, runtimeB)).kind, 'unchanged');
  const canonicalHome = join(root, 'canonical-update');
  const canonicalRoot = join(canonicalHome, '.vonvon-bridge'); mkdirSync(canonicalRoot, { recursive: true });
  const canonicalStored = spawnSync(runtimeA.nodePath, [runtimeA.cliPath, 'secrets', 'set', 'fixture-secret'], { env: envFor(canonicalHome), encoding: 'utf8', input: 'synthetic-fixture-value' });
  assert.equal(canonicalStored.status, 0, canonicalStored.stderr);
  const canonicalEncrypted = readFileSync(join(canonicalRoot, 'secrets.enc'));
  const canonicalSalt = readFileSync(join(canonicalRoot, '.keystore.salt'));
  const canonicalWrapper = join(canonicalRoot, 'secrets-getter');
  writeFileSync(canonicalWrapper, `#!/bin/sh\n# Auto-generated by feishu-codex-bridge. Do not edit.\nexec ${quote(runtimeA.nodePath)} ${quote(runtimeA.cliPath)} secrets get "$@"\n`, { mode: 0o700 });
  writeFileSync(join(canonicalRoot, 'config.json'), JSON.stringify({ secrets: { providers: { bridge: { source: 'exec', command: canonicalWrapper, args: [] } } } }));
  assert.equal((await migrateHostDataOffline(canonicalHome, runtimeA)).kind, 'unchanged');
  assert.equal((await migrateHostDataOffline(canonicalHome, runtimeB)).kind, 'unchanged');
  rmSync(join(root, 'runtime-A'), { recursive: true });
  const canonicalProvider = JSON.parse(readFileSync(join(canonicalRoot, 'config.json'), 'utf8')).secrets.providers.bridge;
  const canonicalSecret = spawnSync(canonicalProvider.command, canonicalProvider.args, { env: envFor(canonicalHome), encoding: 'utf8', input: JSON.stringify({ protocolVersion: 1, provider: 'bridge', ids: ['fixture-secret'] }) });
  assert.equal(canonicalSecret.status, 0, canonicalSecret.stderr);
  assert.equal(JSON.parse(canonicalSecret.stdout).values['fixture-secret'], 'synthetic-fixture-value');
  assert.deepEqual(readFileSync(join(canonicalRoot, 'secrets.enc')), canonicalEncrypted);
  assert.deepEqual(readFileSync(join(canonicalRoot, '.keystore.salt')), canonicalSalt);
  assert.deepEqual(readFileSync(join(legacy, 'secrets.enc')), encrypted);
  assert.deepEqual(readFileSync(join(legacy, '.keystore.salt')), salt);
  const providers = JSON.parse(readFileSync(join(legacy, 'config.json'), 'utf8')).secrets.providers;
  assert.deepEqual(providers.custom, { source: 'exec', command: 'custom-provider', args: ['keep'] });
  const secret = spawnSync(providers.bridge.command, providers.bridge.args, { env: envFor(legacyHome), encoding: 'utf8', input: JSON.stringify({ protocolVersion: 1, provider: 'bridge', ids: ['fixture-secret'] }) });
  assert.equal(secret.status, 0, secret.stderr);
  assert.equal(JSON.parse(secret.stdout).values['fixture-secret'], 'synthetic-fixture-value');
  assert.equal((await migrateHostDataOffline(legacyHome, { nodePath, cliPath })).kind, 'unchanged');

  const failedHome = join(root, 'failed-close'); mkdirSync(failedHome);
  const failedEntry = join(root, 'failed-close.mjs');
  writeFileSync(failedEntry, `
    import {createServer} from 'node:http';
    import {appendFileSync,mkdirSync,writeFileSync} from 'node:fs';
    import {join} from 'node:path';
    const root=join(process.env.HOME,'.vonvon-bridge'); mkdirSync(root,{recursive:true});
    appendFileSync(join(process.env.HOME,'launches'),'launch\\n');
    const server=createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({version:'fixture',generatedAt:Date.now(),bots:[]}));});
    server.listen(0,'127.0.0.1',()=>writeFileSync(join(root,'web-console.json'),JSON.stringify({pid:process.pid,port:server.address().port,token:'fixture',startedAt:Date.now()})));
    process.stdin.resume(); process.stdin.on('end',()=>process.exit(1));
  `);
  const failed = await connectHost({ home: failedHome, nodePath, cliPath: failedEntry });
  assert.equal(failed.kind, 'connected');
  try {
    const pid = failed.pid;
    await assert.rejects(failed.close(), /code 1/);
    await assert.rejects(failed.close(), /code 1/);
    await assert.rejects(failed.restart(), /code 1/);
    assert.equal(failed.pid, pid);
    assert.equal(readFileSync(join(failedHome, 'launches'), 'utf8'), 'launch\n');
    assert.equal(JSON.parse(readFileSync(join(failedHome, '.vonvon-bridge', 'web-console.json'), 'utf8')).pid, pid);
  } finally {
    try { process.kill(failed.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }

  const pending = join(root, 'pending'); mkdirSync(pending);
  writeFileSync(join(pending, '.vonvon-bridge-migration.json'), '{}');
  for (const args of [['--help'], ['--version'], ['data', 'status'], ['status'], ['stop']]) {
    const result = spawnSync(nodePath, [cliPath, ...args], { env: envFor(pending), encoding: 'utf8' });
    assert.equal(result.status, 0, `${args}: ${result.stderr}`);
  }
  const imported = spawnSync(nodePath, ['--input-type=module', '-e', `await import(${JSON.stringify(new URL('../dist/host.js', import.meta.url).href)})`], { env: envFor(pending), encoding: 'utf8' });
  assert.equal(imported.status, 0, imported.stderr);
  const blocked = spawnSync(nodePath, [cliPath, 'bot', 'list'], { env: envFor(pending), encoding: 'utf8' });
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /recovery|migration/);
  assert.equal(existsSync(join(pending, '.vonvon-bridge')), false);
  console.log('Host smoke passed: owned HTTP, attach-close, restart, early EOF, startup race, poisoned discovery, lifetime lease crash recovery, encrypted getter migration, runtime A-to-B update after removing A, persistent failed close/restart, and pending-journal CLI routing. Service/process queries used fixtures; no OS registrations changed.');
} finally {
  if (host?.kind === 'connected') await host.close();
  rmSync(root, { recursive: true, force: true });
}
