import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveDataRoot } from '../src/config/data-root';

const homes: string[] = [];

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), 'vonvon-data-root-'));
  homes.push(dir);
  return dir;
}

function root(dir: string, name: 'legacy' | 'canonical'): string {
  return join(dir, name === 'legacy' ? '.feishu-codex-bridge' : '.vonvon-bridge');
}

function assertUnchanged(dir: string, action: () => void): void {
  const before = readdirSync(dir);
  action();
  expect(readdirSync(dir)).toEqual(before);
}

afterEach(() => {
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('resolveDataRoot', () => {
  it('selects a fresh canonical path without creating it', () => {
    const dir = home();
    assertUnchanged(dir, () => {
      expect(resolveDataRoot(dir)).toEqual({ path: root(dir, 'canonical'), kind: 'fresh' });
    });
    expect(existsSync(root(dir, 'canonical'))).toBe(false);
  });

  it.each(['legacy', 'canonical'] as const)('keeps the sole %s directory and its contents', (name) => {
    const dir = home();
    const selected = root(dir, name);
    mkdirSync(selected);
    writeFileSync(join(selected, 'marker'), 'unchanged');

    assertUnchanged(dir, () => {
      expect(resolveDataRoot(dir)).toEqual({ path: selected, kind: name });
    });
    expect(readFileSync(join(selected, 'marker'), 'utf8')).toBe('unchanged');
    expect(existsSync(root(dir, name === 'legacy' ? 'canonical' : 'legacy'))).toBe(false);
  });

  it('prefers the canonical spelling when the legacy name links to the same directory', () => {
    const dir = home();
    mkdirSync(root(dir, 'canonical'));
    writeFileSync(join(root(dir, 'canonical'), 'marker'), 'unchanged');
    symlinkSync(root(dir, 'canonical'), root(dir, 'legacy'), process.platform === 'win32' ? 'junction' : 'dir');

    assertUnchanged(dir, () => {
      expect(resolveDataRoot(dir)).toEqual({ path: root(dir, 'canonical'), kind: 'canonical' });
    });
    expect(readFileSync(join(root(dir, 'legacy'), 'marker'), 'utf8')).toBe('unchanged');
  });

  it.skipIf(process.platform === 'win32')('accepts a relative legacy directory link', () => {
    const dir = home();
    mkdirSync(root(dir, 'canonical'));
    symlinkSync('.vonvon-bridge', root(dir, 'legacy'), 'dir');
    expect(resolveDataRoot(dir)).toEqual({ path: root(dir, 'canonical'), kind: 'canonical' });
  });

  it.each(['legacy', 'canonical'] as const)('keeps the %s spelling when it alone links to an external directory', (name) => {
    const dir = home();
    const external = join(dir, 'external');
    mkdirSync(external);
    writeFileSync(join(external, 'marker'), 'unchanged');
    symlinkSync(external, root(dir, name), process.platform === 'win32' ? 'junction' : 'dir');

    assertUnchanged(dir, () => {
      expect(resolveDataRoot(dir)).toEqual({ path: root(dir, name), kind: name });
    });
    expect(readFileSync(join(external, 'marker'), 'utf8')).toBe('unchanged');
  });

  it('refuses distinct stores without changing either', () => {
    const dir = home();
    for (const name of ['legacy', 'canonical'] as const) {
      mkdirSync(root(dir, name));
      writeFileSync(join(root(dir, name), 'marker'), name);
    }
    assertUnchanged(dir, () => {
      expect(() => resolveDataRoot(dir)).toThrow(/different stores/);
    });
    expect(readFileSync(join(root(dir, 'legacy'), 'marker'), 'utf8')).toBe('legacy');
    expect(readFileSync(join(root(dir, 'canonical'), 'marker'), 'utf8')).toBe('canonical');
  });

  it.each(['legacy', 'canonical'] as const)('rejects a file at the %s root', (name) => {
    const dir = home();
    writeFileSync(root(dir, name), 'unchanged');
    assertUnchanged(dir, () => {
      expect(() => resolveDataRoot(dir)).toThrow(/not a directory/);
    });
    expect(readFileSync(root(dir, name), 'utf8')).toBe('unchanged');
  });

  it.skipIf(process.platform === 'win32')('rejects a dangling directory link rather than treating it as absent', () => {
    const dir = home();
    symlinkSync('missing', root(dir, 'legacy'), 'dir');
    assertUnchanged(dir, () => {
      expect(() => resolveDataRoot(dir)).toThrow(/Invalid bridge data directory/);
    });
    expect(lstatSync(root(dir, 'legacy')).isSymbolicLink()).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('rejects a directory link loop', () => {
    const dir = home();
    symlinkSync('.feishu-codex-bridge', root(dir, 'legacy'), 'dir');
    expect(() => resolveDataRoot(dir)).toThrow(/Invalid bridge data directory/);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('reports an inaccessible linked root', () => {
    const dir = home();
    const privateDir = join(dir, 'private');
    mkdirSync(privateDir);
    mkdirSync(join(privateDir, 'data'));
    symlinkSync(join(privateDir, 'data'), root(dir, 'legacy'), 'dir');
    chmodSync(privateDir, 0o000);
    try {
      expect(() => resolveDataRoot(dir)).toThrow(/Invalid bridge data directory/);
    } finally {
      chmodSync(privateDir, 0o700);
    }
  });
});
