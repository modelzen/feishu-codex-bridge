import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { rename } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { installManagedCodex, managedCodexBin, runSetupChild } from '../src/agent/codex-appserver/managed-install';
import { resolveCodexBin } from '../src/agent/codex-appserver/locate';
import { paths } from '../src/config/paths';
import { CodexProcessCleanupError, OwnedCodexProcess } from '../src/agent/codex-appserver/owned-process';

vi.mock('../src/config/paths', async () => {
  const { mkdtempSync, mkdirSync } = await import('node:fs'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const home = mkdtempSync(join(tmpdir(), 'managed-install-home-')); const appDir = join(home, '.vonvon-bridge'); mkdirSync(appDir);
  return { paths: { appDir, codexCliDir: join(appDir, 'codex-cli'), codexCliBinDir: join(appDir, 'codex-cli/node_modules/.bin') } };
});
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rename: vi.fn(actual.rename) };
});
const home = dirname(paths.appDir);
const npm = join(home, 'npm-cli.cjs');
const trace = join(home, 'npm-trace.json');
const codexSource = `console.log('codex-cli 0.156.1');`;
const npmSource = `
const fs=require('node:fs'),path=require('node:path');
const prefix=process.argv[process.argv.indexOf('--prefix')+1];
const cache=process.argv[process.argv.indexOf('--cache')+1];
const record={pid:process.pid,prefix,cache,args:process.argv.slice(2),cwd:process.cwd(),lock:JSON.parse(fs.readFileSync(path.join(prefix,'package-lock.json'),'utf8'))};
fs.writeFileSync(${JSON.stringify(trace)},JSON.stringify(record));
const bins=path.join(prefix,'node_modules/.bin'); fs.mkdirSync(bins,{recursive:true});
const script=path.join(bins,'codex.cjs'); fs.writeFileSync(script,process.env.FIXTURE_NPM_MODE==='wrong-version' ? "console.log('codex-cli 9.9.9')" : ${JSON.stringify(codexSource)});
if(process.platform==='win32') fs.writeFileSync(path.join(bins,'codex.cmd'),'@echo off\\r\\n"'+process.execPath+'" "%~dp0codex.cjs" %*\\r\\n');
else fs.writeFileSync(path.join(bins,'codex'),'#!/bin/sh\\nexec "'+process.execPath+'" "$(dirname \"$0\")/codex.cjs" "$@"\\n',{mode:0o755});
if(process.env.FIXTURE_NPM_MODE==='fail') process.exit(3);
if(process.env.FIXTURE_NPM_MODE==='hold') setInterval(()=>fs.writeFileSync(path.join(prefix,'still-writing'),'yes'),20);
`;
beforeAll(() => {
  writeFileSync(npm, npmSource);
  vi.stubEnv('HOME', home); vi.stubEnv('USERPROFILE', home); vi.stubEnv('XDG_CONFIG_HOME', join(home, '.config')); vi.stubEnv('CODEX_HOME', join(home, '.codex'));
  vi.stubEnv('CODEX_BIN', ''); vi.stubEnv('VONVON_NPM_CLI', npm);
});
afterEach(() => { vi.stubEnv('FIXTURE_NPM_MODE', ''); vi.mocked(rename).mockClear(); });
afterAll(() => { vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); });
const traceValue = (): { prefix: string; cache: string; args: string[]; pid: number; lock: { packages: Record<string, { integrity?: string }> } } => JSON.parse(readFileSync(trace, 'utf8'));
const install = () => installManagedCodex(new AbortController().signal);
const stages = () => readdirSync(home).filter(name => name.startsWith('.vonvon-codex-stage-'));

describe('managed Codex installation', { timeout: 20_000 }, () => {
  it('stages locked npm work outside live data and commits a verified private executable', async () => {
    await install();
    const record = traceValue();
    expect(record.prefix.startsWith(paths.appDir)).toBe(false);
    expect(record.cache.startsWith(paths.appDir)).toBe(false);
    expect(record.args).toContain('--ignore-scripts');
    expect(record.args).toContain('ci');
    expect(record.lock.packages['node_modules/@openai/codex']?.integrity).toMatch(/^sha512-/);
    expect(stages()).toEqual([]);
    expect(managedCodexBin()).toMatch(/releases/);
    expect(resolveCodexBin()).toBe(managedCodexBin());
    expect(await runSetupChild(managedCodexBin()!, ['--version'], { cwd: home, signal: new AbortController().signal })).toBe('codex-cli 0.156.1');
  });

  it.each(['fail', 'wrong-version'])('preserves prior install on %s and cleans only reaped staging', async mode => {
    const previous = managedCodexBin();
    vi.stubEnv('FIXTURE_NPM_MODE', mode);
    await expect(install()).rejects.toThrow();
    expect(managedCodexBin()).toBe(previous);
    expect(previous && existsSync(previous)).toBe(true);
    expect(stages()).toEqual([]);
  });

  it('preserves the current pointer on cross-device commit failure', async () => {
    const previous = managedCodexBin();
    vi.mocked(rename).mockRejectedValueOnce(Object.assign(new Error('cross-device'), { code: 'EXDEV' }));
    await expect(install()).rejects.toThrow('cross-device');
    expect(managedCodexBin()).toBe(previous);
    expect(stages()).toEqual([]);
  });

  it('cancels npm, awaits its exit, then removes staging without changing the selected install', async () => {
    const previous = managedCodexBin();
    vi.stubEnv('FIXTURE_NPM_MODE', 'hold');
    rmSync(trace, { force: true });
    const abort = new AbortController();
    const running = installManagedCodex(abort.signal);
    const outcome = running.catch(error => error);
    await vi.waitFor(() => expect(existsSync(trace)).toBe(true));
    const record = traceValue();
    abort.abort();
    await outcome;
    expect(() => process.kill(record.pid, 0)).toThrow();
    expect(existsSync(record.prefix)).toBe(false);
    expect(managedCodexBin()).toBe(previous);
    expect(stages()).toEqual([]);
  });

  it('retains staging when process-tree cleanup cannot be verified', async () => {
    const close = OwnedCodexProcess.prototype.close;
    const failure = vi.spyOn(OwnedCodexProcess.prototype, 'close').mockImplementationOnce(async function (this: OwnedCodexProcess, graceMs) {
      await close.call(this, graceMs);
      throw new CodexProcessCleanupError('fixture cleanup unknown');
    });
    try {
      await expect(install()).rejects.toThrow('fixture cleanup unknown');
      expect(stages()).toHaveLength(1);
      expect(existsSync(join(home, stages()[0]!, 'install'))).toBe(true);
    } finally {
      failure.mockRestore();
      for (const stage of stages()) rmSync(join(home, stage), { recursive: true, force: true });
    }
  });

  it('preserves CODEX_BIN and refuses missing packaged npm instead of using PATH npm', async () => {
    vi.stubEnv('CODEX_BIN', process.execPath);
    await expect(install()).rejects.toThrow('CODEX_BIN');
    expect(resolveCodexBin()).toBe(process.execPath);
    vi.stubEnv('CODEX_BIN', ''); vi.stubEnv('VONVON_NPM_CLI', '');
    await expect(install()).rejects.toThrow('可信 npm');
    vi.stubEnv('VONVON_NPM_CLI', npm);
  });
});
