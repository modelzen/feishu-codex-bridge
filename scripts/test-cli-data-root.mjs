import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const packageLock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
const projectDir = fileURLToPath(new URL('..', import.meta.url));
const indexUrl = pathToFileURL(resolve(projectDir, 'dist/index.js')).href;
const scratch = mkdtempSync(join(tmpdir(), 'vonvon-built-cli-'));

function run(args, home) {
  const result = spawnSync(process.execPath, args, {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: home,
      FEISHU_BRIDGE_NATIVE_SERVICE_TEST: '0',
    },
  });
  if (result.error) throw result.error;
  return result;
}

function assertSuccessful(result, label) {
  assert.equal(result.status, 0, `${label}: ${result.stderr}`);
  return result.stdout;
}

function probePaths(home) {
  const code = `
    const { paths } = await import(process.argv[1]);
    process.stdout.write(JSON.stringify({
      appDir: paths.appDir,
      botsFile: paths.botsFile,
      secretsFile: paths.secretsFile,
      configFile: paths.configFile,
      webConsoleFile: paths.webConsoleFile,
    }));
  `;
  return JSON.parse(assertSuccessful(run(['--input-type=module', '-e', code, indexUrl], home), 'public paths import'));
}

function checkHome(label, setup, expectedName) {
  const home = join(scratch, label);
  mkdirSync(home);
  setup(home);
  const before = readdirSync(home);
  for (const command of ['vonvon-bridge', 'feishu-codex-bridge']) {
    assert.equal(packageJson.bin[command], 'bin/feishu-codex-bridge.mjs');
    assert.equal(packageLock.packages[''].bin[command], packageJson.bin[command]);
    const mappedBin = resolve(projectDir, packageJson.bin[command]);
    const help = assertSuccessful(run([mappedBin, '--help'], home), `${command} --help`);
    assert.match(help, /Usage: vonvon-bridge/);
    assert.equal(assertSuccessful(run([mappedBin, '--version'], home), `${command} --version`).trim(), packageJson.version);
    assert.deepEqual(readdirSync(home), before, `${command} help/version changed the data home`);
  }
  const selected = join(home, expectedName);
  assert.deepEqual(probePaths(home), {
    appDir: selected,
    botsFile: join(selected, 'bots.json'),
    secretsFile: join(selected, 'secrets.enc'),
    configFile: join(selected, 'config.json'),
    webConsoleFile: join(selected, 'web-console.json'),
  });
  assert.deepEqual(readdirSync(home), before, 'library import changed the data home');
}

try {
  checkHome('fresh', () => {}, '.vonvon-bridge');
  checkHome('legacy', (home) => {
    mkdirSync(join(home, '.feishu-codex-bridge'));
    writeFileSync(join(home, '.feishu-codex-bridge', 'marker'), 'keep');
  }, '.feishu-codex-bridge');
  checkHome('canonical', (home) => {
    mkdirSync(join(home, '.vonvon-bridge'));
  }, '.vonvon-bridge');
  checkHome('linked-upgrade', (home) => {
    mkdirSync(join(home, '.vonvon-bridge'));
    symlinkSync(join(home, '.vonvon-bridge'), join(home, '.feishu-codex-bridge'), process.platform === 'win32' ? 'junction' : 'dir');
  }, '.vonvon-bridge');
  assert.equal(readFileSync(join(scratch, 'legacy', '.feishu-codex-bridge', 'marker'), 'utf8'), 'keep');
  process.stdout.write('Built CLI aliases and data-root selection passed in isolated homes.\n');
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
