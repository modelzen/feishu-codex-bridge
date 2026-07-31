import { describe, expect, it } from 'vitest';
import { delimiter, dirname } from 'node:path';
import { appServerChildEnvironment } from '../src/agent/codex-appserver/app-server-client';
import { mergeProcessEnv } from '../src/platform/spawn';

describe('mergeProcessEnv', () => {
  it('overrides an existing key by value', () => {
    const out = mergeProcessEnv({ FOO: 'a', BAR: 'b' }, { FOO: 'z' });
    expect(out).toEqual({ FOO: 'z', BAR: 'b' });
  });

  it('dedupes case-insensitively so Windows PATH/Path never doubles up', () => {
    // On Windows env keys are case-insensitive: `Path` and `PATH` are one var.
    const out = mergeProcessEnv({ Path: 'C:\\old' }, { PATH: 'C:\\new' });
    const keys = Object.keys(out).filter((k) => k.toLowerCase() === 'path');
    expect(keys).toHaveLength(1);
    expect(out[keys[0]!]).toBe('C:\\new');
  });

  it('drops overrides whose value is undefined (does not inject empty keys)', () => {
    const out = mergeProcessEnv({ FOO: 'a' }, { BAR: undefined });
    expect(out).toEqual({ FOO: 'a' });
    expect('BAR' in out).toBe(false);
  });

  it('keeps base entries untouched when no overrides are given', () => {
    const base = { FOO: 'a', BAR: 'b' };
    expect(mergeProcessEnv(base)).toEqual(base);
  });
});

describe('appServerChildEnvironment', () => {
  it('puts the managed CLI directory first so its sibling Node resolves the npm shebang', () => {
    const executable = '/app/Vonvon Bridge.app/Contents/Resources/managed/node_modules/.bin/codex';
    const environment = appServerChildEnvironment(
      executable,
      { PATH: ['/usr/bin', '/bin'].join(delimiter), HOME: '/tmp/home' },
      { FEISHU_TEST: '1' },
    );

    expect(environment.PATH?.split(delimiter)[0]).toBe(dirname(executable));
    expect(environment.PATH?.split(delimiter)).toEqual([
      dirname(executable),
      '/usr/bin',
      '/bin',
    ]);
    expect(environment.HOME).toBe('/tmp/home');
    expect(environment.FEISHU_TEST).toBe('1');
    expect(environment.FEISHU_CODEX_BRIDGE).toBe('1');
  });
});
