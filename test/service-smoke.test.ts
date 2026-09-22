import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type ServiceDefinitionOptions } from '../src/service/common';
import { buildPlist } from '../src/service/launchd';
import { buildUnit } from '../src/service/systemd';
import { buildLauncherCmd, SERVICE_ENV_FLAG } from '../src/service/win-startup';

// Deliberately opt-in: ordinary `npm test` must not register even a temporary
// service. These tests never call the bridge's install/start/restart functions.
const enabled = process.env.FEISHU_BRIDGE_NATIVE_SERVICE_TEST === '1';
const timeoutMs = 15_000;

interface WorkerEvent {
  pid: number;
  argv: string[];
  path: string;
  serviceFlag: string | null;
}

interface Fixture {
  root: string;
  name: string;
  options: Required<ServiceDefinitionOptions>;
  events: () => Promise<WorkerEvent[]>;
}

function command(executable: string, args: string[], env?: NodeJS.ProcessEnv): string {
  const result = spawnSync(executable, args, { encoding: 'utf8', timeout: timeoutMs, env });
  if (result.error || result.status !== 0) {
    throw new Error(`${executable} ${args.join(' ')} failed: ${result.error?.message ?? result.status}\n${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  }
  return result.stdout;
}

async function until<T>(description: string, check: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  do {
    const result = await check();
    if (result !== undefined) return result;
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for ${description}`);
}

async function cleanup(actions: Array<() => void | Promise<void>>): Promise<void> {
  const failures: unknown[] = [];
  for (const action of actions) {
    try {
      await action();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) throw new AggregateError(failures, 'Native service cleanup failed');
}

async function withFixture(keepAlive: boolean, body: (fixture: Fixture) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'feishu-bridge-smoke-'));
  const folder = join(root, 'worker folder & spaces');
  await mkdir(folder);
  const eventPath = join(root, 'events.jsonl');
  const options = {
    cliBinPath: join(folder, 'fake-cli.mjs'),
    stdoutPath: join(folder, 'stdout.log'),
    stderrPath: join(folder, 'stderr.log'),
    // An intentionally unique PATH that neither the test runner nor the OS
    // service manager has: only the generated definition can restore it.
    envPath: join(folder, 'tools'),
  };
  await writeFile(options.cliBinPath, `
import { appendFileSync } from 'node:fs';
console.log('smoke stdout');
console.error('smoke stderr');
appendFileSync(${JSON.stringify(eventPath)}, JSON.stringify({
  pid: process.pid,
  argv: process.argv.slice(2),
  path: process.env.PATH,
  serviceFlag: process.env.${SERVICE_ENV_FLAG} ?? null,
}) + '\\n');
${keepAlive ? 'setInterval(() => {}, 1000);' : ''}
`, 'utf8');
  const fixture: Fixture = {
    root,
    name: `feishu-bridge-smoke-${randomUUID()}`,
    options,
    events: async () => {
      const text = await readFile(eventPath, 'utf8').catch(() => '');
      // Only consume complete lines while another process is writing.
      return text.split('\n').slice(0, -1).filter(Boolean).map((line) => JSON.parse(line) as WorkerEvent);
    },
  };
  try {
    await body(fixture);
  } catch (error) {
    for (const file of [options.stdoutPath, options.stderrPath]) {
      console.error(`${file}:\n${await readFile(file, 'utf8').catch(() => '(not created)')}`);
    }
    throw error;
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

function expectWorker(event: WorkerEvent, fixture: Fixture, serviceFlag: string | null): void {
  expect(event.pid).toBeGreaterThan(0);
  expect(event.argv).toEqual(['run']);
  expect(event.path).toBe(fixture.options.envPath);
  expect(event.serviceFlag).toBe(serviceFlag);
}

async function waitForWorker(fixture: Fixture, previousPid?: number): Promise<WorkerEvent> {
  return until('worker readback', async () => {
    const events = await fixture.events();
    return events.find((event) => event.pid !== previousPid);
  });
}

async function expectLogs(fixture: Fixture): Promise<void> {
  expect(await readFile(fixture.options.stdoutPath, 'utf8')).toContain('smoke stdout');
  expect(await readFile(fixture.options.stderrPath, 'utf8')).toContain('smoke stderr');
}

async function waitForExit(fixture: Fixture): Promise<void> {
  const pids = (await fixture.events()).map((event) => event.pid);
  await until('isolated service processes to exit', async () => {
    const alive = pids.some((pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        return false;
      }
    });
    return alive ? undefined : true;
  });
}

describe.skipIf(!enabled)('native service smoke tests (explicit opt-in)', () => {
  it.runIf(process.platform === 'win32')('executes the generated cmd launcher twice from a fresh environment', async () => {
    await withFixture(false, async (fixture) => {
      const launcher = join(fixture.root, 'launcher with spaces.cmd');
      await writeFile(launcher, buildLauncherCmd(fixture.options), 'utf8');
      const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
      if (!systemRoot) throw new Error('SystemRoot is required for the native Windows test');
      const cmdExe = join(systemRoot, 'System32', 'cmd.exe');
      // No inherited PATH, service flag, account tokens, or bridge configuration.
      const cleanEnv = {
        SystemRoot: systemRoot,
        TEMP: fixture.root,
        TMP: fixture.root,
        PATH: join(fixture.root, 'empty-parent-path'),
      };
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        const result = spawnSync(cmdExe, ['/d', '/s', '/c', `""${launcher}""`], {
          env: cleanEnv,
          encoding: 'utf8',
          windowsVerbatimArguments: true,
          timeout: timeoutMs,
        });
        if (result.error || result.status !== 0) {
          throw new Error(`cmd.exe failed: ${result.error?.message ?? result.status}\n${result.stdout}\n${result.stderr}`);
        }
        const events = await fixture.events();
        expect(events).toHaveLength(attempt);
        expectWorker(events[attempt - 1]!, fixture, '1');
      }
      // A second invocation must append both streams, rather than truncate logs.
      expect((await readFile(fixture.options.stdoutPath, 'utf8')).match(/smoke stdout/g)).toHaveLength(2);
      expect((await readFile(fixture.options.stderrPath, 'utf8')).match(/smoke stderr/g)).toHaveLength(2);
    });
  }, 60_000);

  it.runIf(process.platform === 'linux')('validates, starts and restarts an isolated systemd user unit', async () => {
    await withFixture(true, async (fixture) => {
      const unitName = `${fixture.name}.service`;
      const unitPath = join(fixture.root, unitName);
      await writeFile(unitPath, buildUnit(fixture.options), 'utf8');
      command('systemd-analyze', ['--user', 'verify', unitPath]);
      // Missing user bus is a CI configuration failure, never a silent skip.
      command('systemctl', ['--user', 'show-environment']);
      try {
        command('systemctl', ['--user', 'link', '--runtime', unitPath]);
        command('systemctl', ['--user', 'daemon-reload']);
        command('systemctl', ['--user', 'start', unitName]);
        const first = await waitForWorker(fixture);
        expectWorker(first, fixture, null);
        command('systemctl', ['--user', 'restart', unitName]);
        const second = await waitForWorker(fixture, first.pid);
        expectWorker(second, fixture, null);
        expect(second.pid).not.toBe(first.pid);
        expect(command('systemctl', ['--user', 'is-active', unitName]).trim()).toBe('active');
        await expectLogs(fixture);
      } finally {
        // Attempt all cleanup even after partial registration/timeouts. Both
        // stop and disable --now stop this unique job; --runtime removes only
        // its temporary link, never a persistent user service definition.
        await cleanup([
          () => { command('systemctl', ['--user', 'stop', unitName]); },
          () => { command('systemctl', ['--user', 'disable', '--runtime', '--now', unitName]); },
          () => { command('systemctl', ['--user', 'daemon-reload']); },
          () => waitForExit(fixture),
        ]);
      }
    });
  }, 120_000);

  it.runIf(process.platform === 'darwin')('parses generated launchd arguments and environment with native plutil', async () => {
    await withFixture(false, async (fixture) => {
      const plistPath = join(fixture.root, `${fixture.name}.plist`);
      await writeFile(plistPath, buildPlist({ ...fixture.options, label: fixture.name }), 'utf8');
      command('/usr/bin/plutil', ['-lint', plistPath]);
      const plist = JSON.parse(command('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plistPath]));
      expect(plist.Label).toBe(fixture.name);
      expect(plist.ProgramArguments).toEqual([process.execPath, fixture.options.cliBinPath, 'run']);
      expect(plist.EnvironmentVariables.PATH).toBe(fixture.options.envPath);
      expect(plist.StandardOutPath).toBe(fixture.options.stdoutPath);
      expect(plist.StandardErrorPath).toBe(fixture.options.stderrPath);
    });
  });

  it.runIf(process.platform === 'darwin')('starts and restarts an isolated launchd job', async () => {
    await withFixture(true, async (fixture) => {
      const plistPath = join(fixture.root, `${fixture.name}.plist`);
      await writeFile(plistPath, buildPlist({ ...fixture.options, label: fixture.name }), 'utf8');
      const domain = `gui/${userInfo().uid}`;
      const target = `${domain}/${fixture.name}`;
      command('/bin/launchctl', ['print', domain]);
      try {
        command('/bin/launchctl', ['bootstrap', domain, plistPath]);
        const first = await waitForWorker(fixture);
        expectWorker(first, fixture, null);
        command('/bin/launchctl', ['kickstart', '-k', target]);
        const second = await waitForWorker(fixture, first.pid);
        expectWorker(second, fixture, null);
        expect(second.pid).not.toBe(first.pid);
        await expectLogs(fixture);
      } finally {
        // Even a timed-out bootstrap may have registered the job server-side.
        await cleanup([
          () => { command('/bin/launchctl', ['bootout', target]); },
          () => waitForExit(fixture),
        ]);
      }
    });
  }, 120_000);
});
