import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));

if (packageJson.license !== 'AGPL-3.0-only') {
  throw new Error('package.json must declare AGPL-3.0-only.');
}

const runtimeExport = packageJson.exports?.['./runtime'];
if (
  runtimeExport?.types !== './dist/runtime.d.ts'
  || runtimeExport?.import !== './dist/runtime.js'
) {
  throw new Error('The ./runtime package export is missing or invalid.');
}

const packResult = JSON.parse(execFileSync(
  'npm',
  ['pack', '--json', '--dry-run', '--ignore-scripts'],
  { cwd: root, encoding: 'utf8' },
));
const packedFiles = new Set(packResult[0]?.files?.map((entry) => entry.path));
for (const required of [
  'LICENSE',
  'COMMERCIAL-LICENSE.md',
  'dist/index.js',
  'dist/index.d.ts',
  'dist/runtime.js',
  'dist/runtime.d.ts',
  'bin/feishu-codex-bridge.mjs',
]) {
  if (!packedFiles.has(required)) {
    throw new Error(`Published package is missing ${required}.`);
  }
}

const runtime = await import(pathToFileURL(resolve(root, runtimeExport.import)).href);
for (const name of [
  'startBot',
  'acquireHostRuntimeLease',
  'buildEmbeddedBridgeHookCommand',
]) {
  if (typeof runtime[name] !== 'function') {
    throw new Error(`Runtime export ${name} is missing.`);
  }
}

console.log('Package contract verified.');
