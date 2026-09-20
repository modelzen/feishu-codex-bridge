import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawnProcess = vi.hoisted(() => vi.fn());

vi.mock('../src/platform/spawn', () => ({ spawnProcess }));

import { installBackendDep } from '../src/agent/installer';
import { paths } from '../src/config/paths';

describe('multi-package backend install rollback', () => {
  const originalBackendsDir = paths.backendsDir;
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'fcb-bundle-install-'));
    paths.backendsDir = root;
    spawnProcess.mockImplementation(() => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: PassThrough;
        stderr: PassThrough;
        kill: ReturnType<typeof vi.fn>;
      };
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = vi.fn();
      queueMicrotask(() => child.emit('close', 1));
      return child;
    });
  });

  afterEach(() => {
    paths.backendsDir = originalBackendsDir;
    spawnProcess.mockReset();
    rmSync(root, { recursive: true, force: true });
  });

  it('removes every declared package and npm bookkeeping after a failed install', async () => {
    const packages = ['@example/runtime', '@example/protocol'];
    for (const pkg of packages) {
      const dir = join(root, 'node_modules', ...pkg.split('/'));
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: pkg, version: '1.2.3' }));
    }
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        name: 'fixture',
        private: true,
        dependencies: {
          '@example/runtime': '1.2.3',
          '@example/protocol': '1.2.3',
        },
      }),
    );
    writeFileSync(join(root, 'package-lock.json'), '{}');

    const result = await installBackendDep([
      '@example/runtime@1.2.3',
      '@example/protocol@1.2.3',
    ]);

    expect(result).toMatchObject({ ok: false, code: 1, aborted: false });
    expect(spawnProcess).toHaveBeenCalledOnce();
    expect(spawnProcess.mock.calls[0]?.[1]?.slice(0, 3)).toEqual([
      'install',
      '@example/runtime@1.2.3',
      '@example/protocol@1.2.3',
    ]);
    for (const pkg of packages) {
      expect(existsSync(join(root, 'node_modules', ...pkg.split('/')))).toBe(false);
    }
    const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    expect(packageJson.dependencies).toEqual({});
    expect(existsSync(join(root, 'package-lock.json'))).toBe(false);
  });
});
