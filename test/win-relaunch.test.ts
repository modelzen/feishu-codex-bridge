import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  buildRelauncherPowershell,
  encodePowershellCommand,
  runWinRelaunch,
  type WinRelaunchDeps,
} from '../src/service/win-startup';

// The real relauncher drops its one-shot task on Windows even with injected
// lifecycle dependencies. Keep that last OS cleanup boundary mocked as well.
vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawnSync: vi.fn(() => ({ status: 0, stdout: '', stderr: '' })),
}));

// Windows update→restart fix. restartWinStartup can't kill from its own process
// (it's inside the target's taskkill /T tree — DM path IS the daemon, Web path is
// its child), so it hands "kill old → wait for it to die → startNow" to a
// tree-free relauncher (WMI/Task Scheduler parented outside the tree). These lock
// the load-bearing pieces that can't run on the mac dev box: the WMI command
// string, the -EncodedCommand delivery, env-independence, and the ordering. Fully
// dependency-injected — no real process is killed, nothing touches the real appDir.

const REQ = 'C:\\Users\\me\\.feishu-codex-bridge\\relaunch.json';

describe('buildRelauncherPowershell (WMI tree-free spawn)', () => {
  it('creates the process via WMI Win32_Process.Create (parented by WmiPrvSE, escapes taskkill /T)', () => {
    const ps = buildRelauncherPowershell(REQ, 'C:\\bin\\feishu.mjs', 'C:\\node.exe');
    expect(ps).toContain('Invoke-CimMethod');
    expect(ps).toContain('Win32_Process');
    expect(ps).toContain('Create');
  });

  it('re-enters the CLI as __win-relaunch with node+bin+request-path all quoted', () => {
    const ps = buildRelauncherPowershell(REQ, 'C:\\Program Files\\feishu\\bin.mjs', 'C:\\node.exe');
    // node + bin + the request path each double-quoted so a space can't split args;
    // passing the request path explicitly is what makes the relauncher env-independent.
    expect(ps).toContain('"C:\\node.exe" "C:\\Program Files\\feishu\\bin.mjs" __win-relaunch "' + REQ + '"');
  });

  it('escapes single quotes in paths (PowerShell literal → doubled) so paths cannot break out', () => {
    const ps = buildRelauncherPowershell(REQ, "C:\\it's\\bin.mjs", 'C:\\node.exe');
    expect(ps).toContain("it''s"); // the CommandLine is a single-quoted PS literal
    expect(ps).not.toContain("it's\\bin"); // never a lone quote that would end the literal early
  });

  it('falls back to a one-shot Scheduled Task if WMI fails at runtime (PS2.0 / WMI off)', () => {
    const ps = buildRelauncherPowershell(REQ, 'C:\\bin.mjs', 'C:\\node.exe');
    expect(ps).toContain('-ErrorAction Stop'); // make a WMI failure throw, not silently no-op
    expect(ps).toContain('catch');
    expect(ps).toContain('schtasks /create');
    expect(ps).toContain('schtasks /run');
  });

  it('encodes as base64 UTF-16LE for -EncodedCommand so quoting survives the spawn boundary', () => {
    // The real bug: node path with a space (e.g. C:\Program Files\nodejs) had its
    // quotes mangled by -Command through Node spawn, so WMI never launched.
    const script = buildRelauncherPowershell(REQ, 'C:\\Program Files\\app\\bin.mjs', 'C:\\Program Files\\nodejs\\node.exe');
    const enc = encodePowershellCommand(script);
    expect(enc).toMatch(/^[A-Za-z0-9+/=]+$/); // pure base64 — nothing for spawn to mangle
    // PowerShell -EncodedCommand decodes base64 as UTF-16LE → must round-trip exactly
    expect(Buffer.from(enc, 'base64').toString('utf16le')).toBe(script);
  });
});

interface StartOpts {
  appDir: string;
  envPath: string;
  userProfile: string;
  codexBin?: string | null;
}

/**
 * A fake old-daemon lifecycle for pidAlive: starts alive, dies after N poll
 * probes (Infinity = never dies → the elevated/Access-Denied abort path).
 */
function makeWorld(opts: { aliveInitially?: boolean; diesAfterProbes?: number }) {
  const aliveInitially = opts.aliveInitially ?? true;
  const diesAfter = opts.diesAfterProbes ?? 0;
  let probes = 0;
  const events: string[] = [];
  let started: StartOpts | undefined; // undefined = never called
  let cleared = false;

  const deps: WinRelaunchDeps = {
    claimRequest: () => ({ oldPid: 4242, envPath: 'C:\\node;C:\\npm', userProfile: 'C:\\Users\\me', nonce: 'n1' }),
    clearRequest: () => {
      cleared = true;
      events.push('clear');
    },
    pidAlive: () => {
      if (!aliveInitially) return false;
      return probes++ < diesAfter;
    },
    taskkill: () => {
      events.push('taskkill');
      return { status: 0, stderr: '' };
    },
    start: (o: StartOpts) => {
      started = o;
      events.push('start');
    },
    // deterministic + instant: no real timers, no real clock
    sleep: async () => undefined,
    now: () => 0, // deadline = graceMs; loop exits via alive() flipping false, not the clock
    graceMs: 10_000,
    pollMs: 1,
    ensureLogs: async () => undefined,
    logLine: (line: string) => events.push(`log:${line}`),
  };

  return {
    deps,
    events,
    getStarted: () => started,
    wasCleared: () => cleared,
  };
}

describe('runWinRelaunch (ordering: kill → wait for death → startNow)', () => {
  it('kills the old daemon, waits until it is dead, then starts new with the carried env, then clears', async () => {
    const w = makeWorld({ aliveInitially: true, diesAfterProbes: 3 });
    await runWinRelaunch(w.deps);

    // taskkill must precede start, and start must precede clear.
    const kIdx = w.events.indexOf('taskkill');
    const sIdx = w.events.indexOf('start');
    const cIdx = w.events.indexOf('clear');
    expect(kIdx).toBeGreaterThanOrEqual(0);
    expect(sIdx).toBeGreaterThan(kIdx);
    expect(cIdx).toBeGreaterThan(sIdx);
    // new daemon inherits the daemon-side PATH + USERPROFILE (relauncher's own env
    // may be foreign — this is what keeps appDir resolution correct on other machines).
    expect(w.getStarted()?.envPath).toBe('C:\\node;C:\\npm');
    expect(w.getStarted()?.userProfile).toBe('C:\\Users\\me');
  });

  it('derives appDir from the request path so it is independent of the relauncher env', async () => {
    let startOpts: StartOpts | undefined;
    await runWinRelaunch({
      // POSIX-style path so node:path.dirname works the same on the mac test box
      requestPath: '/home/me/.feishu-codex-bridge/relaunch.json',
      claimRequest: () => ({ oldPid: 42, envPath: 'P', userProfile: '/home/me', nonce: 'n' }),
      clearRequest: () => undefined,
      pidAlive: () => false, // old already gone → straight to start
      start: (o: StartOpts) => {
        startOpts = o;
      },
      sleep: async () => undefined,
      ensureLogs: async () => undefined,
      logLine: () => undefined,
    });
    expect(startOpts?.appDir).toBe('/home/me/.feishu-codex-bridge'); // dirname(requestPath)
    expect(startOpts?.userProfile).toBe('/home/me');
  });

  it('skips taskkill when the old daemon is already dead, but still starts the replacement', async () => {
    const w = makeWorld({ aliveInitially: false });
    await runWinRelaunch(w.deps);
    expect(w.events).not.toContain('taskkill');
    expect(w.events).toContain('start');
    expect(w.wasCleared()).toBe(true);
  });

  it('ABORTS (does NOT start a second instance) if the old daemon refuses to die', async () => {
    const w = makeWorld({ aliveInitially: true, diesAfterProbes: Infinity });
    // now() advances so the grace deadline is actually reached and the loop exits.
    let t = 0;
    w.deps.now = () => (t += 5_000);
    await runWinRelaunch(w.deps);

    expect(w.events).toContain('taskkill');
    expect(w.getStarted()).toBeUndefined(); // never started → no double instance
    expect(w.wasCleared()).toBe(true); // claim consumed → cleared in finally (no orphan claim file)
    expect(w.events.some((e) => e.startsWith('log:ABORT'))).toBe(true);
  });

  it('no-ops when there is no relaunch request to claim', async () => {
    const events: string[] = [];
    await runWinRelaunch({
      claimRequest: () => null,
      ensureLogs: async () => undefined,
      logLine: (l) => events.push(l),
      start: () => events.push('start'),
      taskkill: () => {
        events.push('taskkill');
        return { status: 0, stderr: '' };
      },
    });
    expect(events).not.toContain('start');
    expect(events).not.toContain('taskkill');
    expect(events.some((e) => e.includes('no relaunch request'))).toBe(true);
  });

  it('a concurrent second relauncher loses the atomic claim and no-ops (no double daemon)', async () => {
    // Shared request: the first claim wins (returns it), any later claim gets null
    // — models renameSync's atomic single-winner across two racing relaunchers.
    let claimed = false;
    const claimRequest = () => {
      if (claimed) return null;
      claimed = true;
      return { oldPid: 4242, envPath: 'C:\\node', userProfile: 'C:\\Users\\me', nonce: 'n1' };
    };
    const mkEvents = () => {
      const events: string[] = [];
      return {
        events,
        deps: {
          claimRequest,
          clearRequest: () => events.push('clear'),
          pidAlive: () => false, // old already gone → straight to start
          taskkill: () => ({ status: 0, stderr: '' }),
          start: () => events.push('start'),
          sleep: async () => undefined,
          ensureLogs: async () => undefined,
          logLine: (l: string) => events.push(`log:${l}`),
        } as WinRelaunchDeps,
      };
    };
    const winner = mkEvents();
    const loser = mkEvents();
    await runWinRelaunch(winner.deps);
    await runWinRelaunch(loser.deps);

    expect(winner.events).toContain('start'); // winner starts exactly one daemon
    expect(loser.events).not.toContain('start'); // loser must NOT start a second
    expect(loser.events.some((e) => e.includes('no relaunch request'))).toBe(true);
  });
});

describe('runWinRelaunch persisted CODEX_BIN request', () => {
  async function consume(codexBin: unknown, check: (start: ReturnType<typeof vi.fn>) => void): Promise<void> {
    const root = mkdtempSync(join(tmpdir(), 'win-relaunch-request-'));
    const requestPath = join(root, 'relaunch.json');
    const start = vi.fn();
    writeFileSync(requestPath, JSON.stringify({ oldPid: 42, envPath: 'P', userProfile: 'U', nonce: 'test', codexBin }));
    try {
      await runWinRelaunch({
        requestPath,
        start,
        pidAlive: () => false,
        sleep: async () => undefined,
        ensureLogs: async () => undefined,
        logLine: () => undefined,
      });
      expect(existsSync(requestPath)).toBe(false);
      expect(existsSync(`${requestPath}.claim.${process.pid}`)).toBe(false);
      check(start);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  it.each([join(tmpdir(), 'selected Codex', 'codex.exe'), null, undefined])('carries an absolute selection or explicit clear, and accepts old requests (%s)', async (codexBin) => {
    await consume(codexBin, (start) => {
      expect(start).toHaveBeenCalledTimes(1);
      expect(start).toHaveBeenCalledWith(expect.objectContaining({ codexBin }));
    });
  });

  it.each([123, false, {}, '', './codex.exe', '../foreign/codex.exe', join(tmpdir(), 'invalid\npath')])('rejects invalid override data before starting a replacement (%j)', async (codexBin) => {
    await consume(codexBin, (start) => expect(start).not.toHaveBeenCalled());
  });
});
