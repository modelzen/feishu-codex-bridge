import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ResolvedCliBridgePreferences } from '../config/schema';

const execFileAsync = promisify(execFile);

export interface CliPresenceRoute {
  routeToFeishu: boolean;
  reason: 'always' | 'local_active' | 'away' | 'presence_failed' | 'disabled';
}

export interface CliLocalActivity {
  localActive: boolean;
  reason: 'local_active' | 'away' | 'presence_failed' | 'disabled';
}

export async function resolveCliPresenceRoute(prefs: ResolvedCliBridgePreferences): Promise<CliPresenceRoute> {
  // delivery is normalized to 'away_only' for every real config (see
  // getCliBridgePreferences), so routing always goes through local-activity. The
  // 'always' route still exists in CliPresenceRoute for injected presence in tests.
  const activity = await resolveCliLocalActivity(prefs);
  if (activity.localActive) return { routeToFeishu: false, reason: 'local_active' };
  if (activity.reason === 'away') return { routeToFeishu: true, reason: 'away' };
  // On Windows, if idle detection couldn't run (no PowerShell / API error), fail
  // open and forward rather than silently swallow — the feature shouldn't go dead.
  // macOS/Linux keep their original no-forward on presence_failed / disabled.
  if (activity.reason === 'presence_failed' && process.platform === 'win32') {
    return { routeToFeishu: true, reason: 'presence_failed' };
  }
  return { routeToFeishu: false, reason: activity.reason };
}

// The ioreg fork+parse is the expensive part. Cache the raw idle reading for a
// short window so a burst of hooks from one session — and the route-check plus
// local-return check that both fire within milliseconds at the start of a reply
// wait — collapse to a single subprocess. The threshold comparison stays fresh,
// and idle time can only drift by ~TTL, far under the away threshold (≥10s).
const IDLE_READ_TTL_MS = 2000;
let idleCache: { seconds: number; at: number } | undefined;

async function readMacIdleSeconds(): Promise<number> {
  const now = Date.now();
  if (idleCache && now - idleCache.at < IDLE_READ_TTL_MS) return idleCache.seconds;
  const { stdout } = await execFileAsync('/usr/sbin/ioreg', ['-c', 'IOHIDSystem']);
  const match = stdout.match(/HIDIdleTime"\s*=\s*(\d+)/);
  const seconds = Math.floor((match ? Number(match[1]) : 0) / 1_000_000_000);
  idleCache = { seconds, at: now };
  return seconds;
}

// Windows analogue of HIDIdleTime: GetLastInputInfo (user32) returns ms since the
// last keyboard/mouse input. Called via PowerShell + inline C# — no native dep,
// mirroring the ioreg shell-out; -EncodedCommand sidesteps quoting/newline issues.
// NOTE: unverified on a real Windows host, and only meaningful when the daemon
// runs in the user's interactive session (a session-0 service sees no input). On
// any failure the caller fails open (forwards), so a broken read can't go silent.
async function readWindowsIdleSeconds(): Promise<number> {
  const now = Date.now();
  if (idleCache && now - idleCache.at < IDLE_READ_TTL_MS) return idleCache.seconds;
  const script = [
    "Add-Type @'",
    'using System;',
    'using System.Runtime.InteropServices;',
    'public class A2LIdle {',
    '  [StructLayout(LayoutKind.Sequential)] struct LII { public uint cbSize; public uint dwTime; }',
    '  [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LII p);',
    '  public static uint Ms() { LII l = new LII(); l.cbSize = (uint)Marshal.SizeOf(l); GetLastInputInfo(ref l); return ((uint)Environment.TickCount) - l.dwTime; }',
    '}',
    "'@",
    // Lock screen ⇒ LogonUI.exe is running ⇒ report a huge idle value so it counts
    // as away immediately, without waiting out the idle threshold (mirrors macOS,
    // where lock is instant-away). Also fires during login/UAC — harmless here.
    'if (Get-Process LogonUI -ErrorAction SilentlyContinue) { 0x7FFFFFFF } else { [A2LIdle]::Ms() }',
  ].join('\n');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded]);
  const ms = Number(stdout.trim());
  if (!Number.isFinite(ms)) throw new Error(`unparseable idle output: ${stdout.slice(0, 50)}`);
  const seconds = Math.floor(ms / 1000);
  idleCache = { seconds, at: now };
  return seconds;
}

export async function resolveCliLocalActivity(prefs: ResolvedCliBridgePreferences): Promise<CliLocalActivity> {
  if (!prefs.presence.enabled) return { localActive: false, reason: 'disabled' };
  // platform:'macos' forces the ioreg reader regardless of the host (the documented
  // "强制走 macOS"); 'auto' picks by process.platform. Forcing it off a Mac just makes
  // the ioreg exec throw → caught below as presence_failed (fail-closed on Unix).
  const readIdleSeconds =
    prefs.presence.platform === 'macos' ? readMacIdleSeconds
      : process.platform === 'darwin' ? readMacIdleSeconds
        : process.platform === 'win32' ? readWindowsIdleSeconds
          : undefined;
  if (!readIdleSeconds) return { localActive: false, reason: 'presence_failed' };
  try {
    const idleSeconds = await readIdleSeconds();
    return idleSeconds >= prefs.presence.idleThresholdSeconds
      ? { localActive: false, reason: 'away' }
      : { localActive: true, reason: 'local_active' };
  } catch {
    return { localActive: false, reason: 'presence_failed' };
  }
}
