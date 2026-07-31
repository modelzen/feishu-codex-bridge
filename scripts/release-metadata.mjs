import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));

function git(args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

let previousTag;
try {
  previousTag = git(['describe', '--tags', '--abbrev=0', 'HEAD^']);
} catch {
  previousTag = undefined;
}

const range = previousTag ? `${previousTag}..HEAD` : 'HEAD';
const commits = git(['log', '--format=%H%x09%s', range])
  .split('\n')
  .filter(Boolean)
  .map((line) => {
    const [sha, ...subject] = line.split('\t');
    return { sha, subject: subject.join('\t') };
  });

process.stdout.write(`${JSON.stringify({
  package: packageJson.name,
  version: packageJson.version,
  tag: `v${packageJson.version}`,
  previousTag,
  runtimeExport: packageJson.exports['./runtime'].import,
  commits,
})}\n`);
