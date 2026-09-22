import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeNodeExecutable } from './node-executable';

export const OLD_CODEX_VERSION = 'fake-codex old-on-path';
export const NEW_CODEX_VERSION = 'fake-codex selected-by-override';
export const CODEX_PATH_SCENARIOS = ['ordinary path', 'special characters'] as const;
export type CodexPathScenario = typeof CODEX_PATH_SCENARIOS[number];

export interface CodexSelectionFixture {
  oldBin: string;
  newBin: string;
  path: string;
  environment: NodeJS.ProcessEnv;
}

async function fakeCodex(directory: string, version: string): Promise<string> {
  await mkdir(directory, { recursive: true });
  if (process.platform !== 'win32') {
    return writeNodeExecutable(directory, 'codex', `console.log(${JSON.stringify(version)});`).bin;
  }

  // A real .exe keeps %/!/Unicode out of an extra cmd.exe parser. Otherwise a
  // fixture's own batch quoting could fail even in the foreground and obscure
  // the service's CODEX_BIN persistence failure. .NET Framework is supplied by
  // the Windows runner; neither Feishu nor Codex nor network access is needed.
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  if (!systemRoot) throw new Error('SystemRoot is required to compile the fake Codex executable');
  const compiler = ['Framework64', 'Framework']
    .map((framework) => join(systemRoot, 'Microsoft.NET', framework, 'v4.0.30319', 'csc.exe'))
    .find(existsSync);
  if (!compiler) throw new Error('The native fixture requires the Windows .NET Framework C# compiler');
  const source = join(directory, 'codex.cs');
  const bin = join(directory, 'codex.exe');
  await writeFile(source, `class FakeCodex { static void Main() { System.Console.WriteLine(${JSON.stringify(version)}); } }`, 'utf8');
  const result = spawnSync(compiler, ['/nologo', '/target:exe', `/out:${bin}`, source], {
    encoding: 'utf8',
    timeout: 15_000,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Fake Codex compilation failed: ${result.error?.message ?? result.status}\n${result.stdout}\n${result.stderr}`);
  }
  return bin;
}

/** Use the production locator in a standalone worker, with an old executable
 * discoverable on PATH and a different new executable available via CODEX_BIN.
 * The same fixture runs against the unfixed code and the eventual fix. */
export async function prepareCodexSelection(
  root: string,
  workerPath: string,
  keepAlive: boolean,
  scenario: CodexPathScenario,
): Promise<CodexSelectionFixture> {
  const oldDir = join(root, 'old tools');
  const newFolder = scenario === 'ordinary path'
    ? 'new tools'
    : process.platform === 'win32'
      ? 'new 中文 %FEISHU_SMOKE_LITERAL% ! tools'
      : 'new 中文 %n ! tools';
  const oldBin = await fakeCodex(oldDir, OLD_CODEX_VERSION);
  const newBin = await fakeCodex(join(root, newFolder), NEW_CODEX_VERSION);
  const bundleDir = join(root, 'locator');
  const { build } = await import('tsup');
  await build({
    entry: { locate: fileURLToPath(new URL('../../src/agent/codex-appserver/locate.ts', import.meta.url)) },
    outDir: bundleDir,
    format: ['cjs'],
    outExtension: () => ({ js: '.cjs' }),
    target: 'node20',
    platform: 'node',
    bundle: true,
    noExternal: [/.*/],
    splitting: false,
    dts: false,
    config: false,
    silent: true,
  });
  const bundlePath = join(bundleDir, 'locate.cjs');
  await writeFile(workerPath, `
import { appendFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const { resolveCodexBin, codexVersion } = createRequire(import.meta.url)(${JSON.stringify(bundlePath)});
const selected = resolveCodexBin({ force: true });
// Never execute a real installed Codex if some unexpected host configuration
// leaks in. Only these two private fixture executables may answer --version.
const allowed = ${JSON.stringify([oldBin, newBin])};
const event = {
  pid: process.pid,
  argv: process.argv.slice(2),
  path: process.env.PATH,
  serviceFlag: process.env.FEISHU_CODEX_BRIDGE_SERVICE ?? null,
  codexBin: process.env.CODEX_BIN ?? null,
  selected,
  version: allowed.includes(selected) ? codexVersion(selected, { force: true }) : 'UNEXPECTED EXECUTABLE WAS NOT RUN',
};
if (process.argv[2] === 'foreground') {
  console.log(JSON.stringify(event));
} else {
  console.log('smoke stdout ' + JSON.stringify(event));
  console.error('smoke stderr');
  appendFileSync(${JSON.stringify(join(root, 'events.jsonl'))}, JSON.stringify(event) + '\\n');
  ${keepAlive ? 'setInterval(() => {}, 1000);' : ''}
}
`, 'utf8');

  const home = join(root, 'empty home');
  await mkdir(home);
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  const path = process.platform === 'win32'
    ? [oldDir, dirname(process.execPath), join(systemRoot!, 'System32')].join(delimiter)
    : [oldDir, '/usr/bin', '/bin'].join(delimiter);
  return {
    oldBin,
    newBin,
    path,
    environment: {
      HOME: home,
      USERPROFILE: home,
      ...(systemRoot ? { SystemRoot: systemRoot } : {}),
      TEMP: root,
      TMP: root,
      PATHEXT: '.COM;.EXE;.BAT;.CMD',
      PATH: path,
      // Deliberately exists: an unescaped literal %FEISHU_SMOKE_LITERAL% in
      // the saved Windows CODEX_BIN must not expand to this value.
      FEISHU_SMOKE_LITERAL: 'incorrectly-expanded',
    },
  };
}
