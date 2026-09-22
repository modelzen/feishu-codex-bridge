import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildPlist } from '../src/service/launchd';
import { buildUnit, SYSTEMD_UNIT_NAME } from '../src/service/systemd';
import { buildLauncherCmd, buildLauncherVbs } from '../src/service/win-startup';

// These tests cover serialization and configuration semantics. Native execution
// and executable-selection evidence live in service-smoke.test.ts.

const nativeCodexPath = join(tmpdir(), 'codex tools', 'codex');
const systemdString = (value: string): string => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%');

describe('systemd unit (buildUnit)', () => {
  const unit = buildUnit();

  it('is a well-formed user service with crash-restart + login autostart', () => {
    expect(unit).toContain('[Service]');
    expect(unit).toContain('Type=simple');
    expect(unit).toContain('Restart=always');
    expect(unit).toContain('RestartSec=5');
    expect(unit).toContain('[Install]');
    expect(unit).toContain('WantedBy=default.target');
  });

  it('runs the bridge `run` subcommand and appends to the shared log files', () => {
    expect(unit).toMatch(/ExecStart=".+" ".+" run/);
    expect(unit).toContain('StandardOutput=append:');
    expect(unit).toContain('StandardError=append:');
    expect(unit).toContain('Environment="PATH=');
  });

  it('unit name is a .service', () => {
    expect(SYSTEMD_UNIT_NAME).toMatch(/\.service$/);
  });

  it('preserves an explicit CODEX_BIN override for the background service', () => {
    withCodexBin(nativeCodexPath, () => {
      expect(buildUnit()).toContain(`Environment="CODEX_BIN=${systemdString(nativeCodexPath)}"`);
    });
  });

  it('escapes a literal percent specifier instead of allowing systemd to expand it', () => {
    withCodexBin(join(tmpdir(), 'codex%n!', 'codex'), () => {
      expect(buildUnit()).toContain('codex%%n!');
    });
  });

  it('normalizes a relative CODEX_BIN before persisting it', () => {
    withCodexBin(join('relative tools', 'codex'), () => {
      expect(buildUnit()).toContain(`Environment="CODEX_BIN=${systemdString(resolve('relative tools', 'codex'))}"`);
    });
  });

  it('omits an unset override and serializes an explicit clear', () => {
    withCodexBin(undefined, () => expect(buildUnit()).not.toContain('CODEX_BIN='));
    withCodexBin('', () => expect(buildUnit()).toContain('Environment="CODEX_BIN="'));
    withCodexBin(nativeCodexPath, () => {
      expect(buildUnit({ codexBin: null })).toContain('Environment="CODEX_BIN="');
      expect(buildUnit({ codexBin: null })).not.toContain(systemdString(nativeCodexPath));
    });
  });
});

describe('launchd plist (buildPlist)', () => {
  it('preserves an explicit CODEX_BIN override for the background service', () => {
    const path = join(tmpdir(), 'Codex & Friends', 'codex');
    withCodexBin(path, () => {
      const plist = buildPlist();
      expect(plist).toContain('<key>CODEX_BIN</key>');
      expect(plist).toContain(path.replace(/&/g, '&amp;'));
    });
  });

  it('omits an unset override and serializes an explicit clear', () => {
    withCodexBin(undefined, () => expect(buildPlist()).not.toContain('<key>CODEX_BIN</key>'));
    withCodexBin('', () => expect(buildPlist()).toMatch(/<key>CODEX_BIN<\/key>\s*<string><\/string>/));
    withCodexBin(nativeCodexPath, () => {
      expect(buildPlist({ codexBin: null })).toMatch(/<key>CODEX_BIN<\/key>\s*<string><\/string>/);
      expect(buildPlist({ codexBin: null })).not.toContain(nativeCodexPath);
    });
  });
});

describe('Windows hidden launcher (.cmd)', () => {
  const cmd = buildLauncherCmd();

  it('is a CRLF batch script that sets PATH + service flag and runs the bridge', () => {
    expect(cmd.startsWith('@echo off')).toBe(true);
    expect(cmd).toContain('\r\n'); // cmd.exe needs CRLF
    expect(cmd).toContain('set "PATH=');
    expect(cmd).toContain('set "FEISHU_CODEX_BRIDGE_SERVICE=1"');
    expect(cmd).toMatch(/".+" ".+" run /);
  });

  it('appends stdout and stderr to the log files', () => {
    expect(cmd).toContain('>> "');
    expect(cmd).toContain('2>> "');
  });

  it('preserves an explicit CODEX_BIN override for the background service', () => {
    withCodexBin(nativeCodexPath, () => {
      expect(buildLauncherCmd()).toContain(`set "CODEX_BIN=${nativeCodexPath}"`);
    });
  });

  it('protects literal percent/bang characters and uses UTF-8 for Unicode paths', () => {
    withCodexBin(join(tmpdir(), 'codex 中文 %USERNAME% !', 'codex.exe'), () => {
      const launcher = buildLauncherCmd();
      expect(launcher).toContain('setlocal DisableDelayedExpansion');
      expect(launcher).toContain('65001');
      expect(launcher).toContain('codex 中文 %%USERNAME%% !');
    });
  });

  it('omits an unset override and serializes an explicit clear', () => {
    withCodexBin(undefined, () => expect(buildLauncherCmd()).not.toContain('set "CODEX_BIN='));
    withCodexBin('', () => expect(buildLauncherCmd()).toContain('set "CODEX_BIN="'));
    withCodexBin(nativeCodexPath, () => {
      expect(buildLauncherCmd({ codexBin: null })).toContain('set "CODEX_BIN="');
      expect(buildLauncherCmd({ codexBin: null })).not.toContain(nativeCodexPath);
    });
  });
});

describe('Windows hidden launcher (.vbs)', () => {
  const vbs = buildLauncherVbs();

  it('runs the .cmd hidden (window style 0) and does not wait', () => {
    expect(vbs).toContain('WScript.Shell');
    expect(vbs).toMatch(/sh\.Run "cmd \/c "".+\.cmd""", 0, False/);
  });
});

function withCodexBin(value: string | undefined, fn: () => void): void {
  const prev = process.env.CODEX_BIN;
  if (value === undefined) delete process.env.CODEX_BIN;
  else process.env.CODEX_BIN = value;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = prev;
  }
}
