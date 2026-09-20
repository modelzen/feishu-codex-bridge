#!/usr/bin/env node

import { constants as fsConstants, readFileSync } from 'node:fs';
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import spawn from 'cross-spawn';
import ts from 'typescript';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const backendDir = resolve(process.argv[2] ?? '');

if (!process.argv[2]) {
  process.stderr.write('usage: node scripts/check-dsh-profile.mjs <backend-install-dir>\n');
  process.exit(2);
}

function fail(message) {
  throw new Error(message);
}

function sourceFile(path) {
  const text = readFileSync(path, 'utf8');
  return ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function variableInitializer(file, name) {
  let found;
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) {
      found = node.initializer;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  if (!found) fail(`missing ${name} in ${file.fileName}`);
  while (ts.isAsExpression(found) || ts.isSatisfiesExpression(found)) found = found.expression;
  return found;
}

function stringConstant(file, name) {
  const value = variableInitializer(file, name);
  if (!ts.isStringLiteral(value) && !ts.isNoSubstitutionTemplateLiteral(value)) {
    fail(`${name} is not a static string`);
  }
  return value.text;
}

function packageConstants() {
  const file = sourceFile(join(repoRoot, 'src/agent/dsh/constants.ts'));
  const version = stringConstant(file, 'DSH_VERSION');
  const mainPackage = stringConstant(file, 'DSH_MAIN_PACKAGE');
  const binName = stringConstant(file, 'DSH_BIN_NAME');
  const packagesNode = variableInitializer(file, 'DSH_PACKAGES');
  if (!ts.isArrayLiteralExpression(packagesNode)) fail('DSH_PACKAGES is not a static array');
  const packages = packagesNode.elements.map((element) => {
    if (ts.isStringLiteral(element)) return element.text;
    if (ts.isIdentifier(element) && element.text === 'DSH_MAIN_PACKAGE') return mainPackage;
    return fail(`DSH_PACKAGES contains a non-static entry: ${element.getText(file)}`);
  });
  return { version, mainPackage, binName, packages };
}

function productionProfile() {
  const file = sourceFile(join(repoRoot, 'src/agent/dsh/profile.ts'));
  const profile = variableInitializer(file, 'PROFILE');
  if (!ts.isNoSubstitutionTemplateLiteral(profile)) fail('PROFILE is not a static template');
  return profile.text;
}

async function verifyPackages(nodeModules, expected) {
  for (const pkg of expected.packages) {
    const manifest = join(nodeModules, ...pkg.split('/'), 'package.json');
    const parsed = JSON.parse(await readFile(manifest, 'utf8'));
    if (parsed.name !== pkg) fail(`${pkg}: package name mismatch in ${manifest}`);
    if (parsed.version !== expected.version) {
      fail(`${pkg}: expected ${expected.version}, found ${String(parsed.version)}`);
    }
  }
}

async function findBin(nodeModules, name) {
  const candidates = process.platform === 'win32'
    ? [join(nodeModules, '.bin', `${name}.cmd`), join(nodeModules, '.bin', name)]
    : [join(nodeModules, '.bin', name)];
  for (const candidate of candidates) {
    try {
      await lstat(candidate);
      if (process.platform !== 'win32') await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Try the next npm shim form.
    }
  }
  fail(`missing executable ${name} under ${join(nodeModules, '.bin')}`);
}

function rpcClient(child) {
  let stdout = '';
  let stderr = '';
  let closed;
  const pending = new Map();
  const exited = new Promise((resolveExit) => {
    child.once('close', (code, signal) => {
      closed = new Error(`runtime exited before reply (code=${code}, signal=${signal ?? 'none'})`);
      for (const request of pending.values()) request.reject(closed);
      pending.clear();
      resolveExit({ code, signal });
    });
  });

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    let newline;
    while ((newline = stdout.indexOf('\n')) >= 0) {
      const line = stdout.slice(0, newline).trim();
      stdout = stdout.slice(newline + 1);
      if (!line) continue;
      let frame;
      try {
        frame = JSON.parse(line);
      } catch {
        closed = new Error('runtime wrote non-JSON data to stdout');
        for (const request of pending.values()) request.reject(closed);
        pending.clear();
        continue;
      }
      if (typeof frame.id !== 'number') continue;
      const request = pending.get(frame.id);
      if (!request) continue;
      pending.delete(frame.id);
      clearTimeout(request.timer);
      if (frame.error) request.reject(new Error(`RPC ${frame.error.code}: ${frame.error.message}`));
      else request.resolve(frame.result);
    }
  });
  child.stderr.on('data', (chunk) => {
    stderr = `${stderr}${String(chunk)}`.slice(-16_384);
  });

  const request = (id, method, params, timeoutMs = 30_000) => {
    if (closed) return Promise.reject(closed);
    return new Promise((resolveRequest, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} timed out${stderr.trim() ? ' (runtime wrote stderr)' : ''}`));
      }, timeoutMs);
      pending.set(id, { resolve: resolveRequest, reject, timer });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })}\n`);
    });
  };

  return { request, exited };
}

function baseSmokeEnv() {
  const out = {};
  for (const key of [
    'PATH',
    'SystemRoot',
    'WINDIR',
    'ComSpec',
    'PATHEXT',
    'TEMP',
    'TMP',
    'TMPDIR',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
  ]) {
    if (typeof process.env[key] === 'string') out[key] = process.env[key];
  }
  return out;
}

async function withTimeout(promise, timeoutMs, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function linuxListenerCount(pid) {
  const sockets = new Set();
  for (const fd of await readdir(`/proc/${pid}/fd`)) {
    try {
      const target = await readlink(`/proc/${pid}/fd/${fd}`);
      const match = /^socket:\[(\d+)]$/.exec(target);
      if (match) sockets.add(match[1]);
    } catch {
      // Descriptors may close while inspected.
    }
  }
  let count = 0;
  for (const table of ['/proc/net/tcp', '/proc/net/tcp6']) {
    const lines = (await readFile(table, 'utf8')).trim().split('\n').slice(1);
    for (const line of lines) {
      const fields = line.trim().split(/\s+/);
      if (fields[3] === '0A' && sockets.has(fields[9])) count++;
    }
  }
  return count;
}

async function listenerCount(pid) {
  if (process.platform === 'linux') return linuxListenerCount(pid);
  if (process.platform === 'darwin') {
    const result = spawnSync('/usr/sbin/lsof', ['-nP', '-a', '-p', String(pid), '-iTCP', '-sTCP:LISTEN'], {
      encoding: 'utf8',
    });
    if (result.error) throw result.error;
    if (result.status !== 0 && result.status !== 1) fail(`lsof failed with status ${result.status}`);
    return result.stdout.trim() ? Math.max(0, result.stdout.trim().split('\n').length - 1) : 0;
  }
  if (process.platform === 'win32') {
    const script = `(Get-NetTCPConnection -OwningProcess ${pid} -State Listen -ErrorAction SilentlyContinue | Measure-Object).Count`;
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
    });
    if (result.status !== 0) fail('PowerShell listener check failed');
    return Number(result.stdout.trim() || '0');
  }
  fail(`listener check is not implemented on ${process.platform}`);
}

async function stopProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolveExit) => child.once('close', resolveExit));
  try {
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGTERM');
    else child.kill('SIGTERM');
  } catch {
    // Already gone.
  }
  try {
    await withTimeout(exited, 1_000, 'runtime did not stop after SIGTERM');
  } catch {
    try {
      if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
      else child.kill('SIGKILL');
    } catch {
      // Already gone.
    }
  }
}

let tempRoot;
let child;
try {
  const expected = packageConstants();
  const nodeModules = join(backendDir, 'node_modules');
  await verifyPackages(nodeModules, expected);
  process.stdout.write(`[ok] ${expected.packages.length} packages at ${expected.version}\n`);

  const bin = await findBin(nodeModules, expected.binName);
  process.stdout.write(`[ok] executable ${bin}\n`);

  tempRoot = await mkdtemp(join(tmpdir(), 'fcb-dsh-profile-'));
  await symlink(nodeModules, join(tempRoot, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const profileFile = join(tempRoot, 'dsh-sdk', 'cordis.yml');
  const workspace = join(tempRoot, 'workspace');
  const sessions = join(tempRoot, 'sessions');
  const home = join(tempRoot, 'home');
  const dshHome = join(tempRoot, 'dsh-home');
  await mkdir(dirname(profileFile), { recursive: true });
  await mkdir(workspace, { recursive: true });
  await mkdir(sessions, { recursive: true });
  await mkdir(home, { recursive: true });
  await mkdir(dshHome, { recursive: true });
  await writeFile(profileFile, productionProfile(), 'utf8');

  child = spawn(bin, [profileFile], {
    cwd: workspace,
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...baseSmokeEnv(),
      HOME: home,
      DSH_HOME: dshHome,
      DSH_CORDIS_CONFIG: profileFile,
      DSH_CWD: workspace,
      DSH_SESSION_ROOT: sessions,
      DSH_PERMISSION_MODE: 'danger-full-access',
      DSH_TOOLS_MODE: 'native',
      DSH_TELEMETRY_DISABLED: '1',
      FEISHU_CODEX_BRIDGE_DSH_EFFORT: 'high',
      DSH_SYSTEM_PROMPT: 'Keyless Bridge profile smoke test.',
    },
  });
  const rpc = rpcClient(child);
  const initialized = await rpc.request(1, 'initialize', {
    cwd: workspace,
    provider: 'deepseek',
    model: 'deepseek-v4-flash',
  });
  if (initialized?.serverInfo?.name !== 'deepseek-harness-sdk-runtime') {
    fail('initialize returned an unexpected server identity');
  }
  process.stdout.write(`[ok] initialize ${initialized.serverInfo.name}@${initialized.serverInfo.version}\n`);

  await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  const listeners = await listenerCount(child.pid);
  if (listeners !== 0) fail(`runtime opened ${listeners} TCP listener(s)`);
  process.stdout.write('[ok] no TCP listeners\n');

  await rpc.request(2, 'shutdown');
  const exit = await withTimeout(rpc.exited, 5_000, 'runtime did not exit after shutdown');
  if (exit.code !== 0) fail(`runtime shutdown exit code was ${exit.code}`);
  process.stdout.write('[ok] shutdown cleanly\n');
} catch (error) {
  process.stderr.write(`[fail] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  if (child) await stopProcess(child);
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
}
