import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  acquireHostRuntimeLease,
  RuntimeAlreadyOwnedError,
  type HostRuntimeLease,
} from '../src/core/runtime-lock';

describe('host Runtime ownership shared with a desktop app', () => {
  const cleanup: Array<() => void> = [];

  afterEach(() => {
    for (const release of cleanup.splice(0).reverse()) release();
  });

  it('allows either desktop or CLI to own the Runtime, but never both', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fcb-runtime-lease-'));
    const lockFile = join(dir, 'owner.json');
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));

    const desktop = acquireHostRuntimeLease({
      lockFile,
      owner: { kind: 'desktop', product: 'bridge-desktop' },
    });
    cleanup.push(desktop.release);

    let conflict: unknown;
    try {
      acquireHostRuntimeLease({
        lockFile,
        owner: { kind: 'cli', product: 'feishu-codex-bridge' },
      });
    } catch (error) {
      conflict = error;
    }

    expect(conflict).toBeInstanceOf(RuntimeAlreadyOwnedError);
    expect((conflict as RuntimeAlreadyOwnedError).owner).toMatchObject({
      kind: 'desktop',
      product: 'bridge-desktop',
      pid: process.pid,
    });

    desktop.release();
    const cli: HostRuntimeLease = acquireHostRuntimeLease({
      lockFile,
      owner: { kind: 'cli', product: 'feishu-codex-bridge' },
    });
    cleanup.push(cli.release);
  });

  it('reclaims a lease left by a process that has exited', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fcb-runtime-stale-'));
    const lockFile = join(dir, 'owner.json');
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));

    const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    const deadPid = child.pid!;
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));
    writeFileSync(
      lockFile,
      `${JSON.stringify({
        schemaVersion: 1,
        kind: 'desktop',
        product: 'bridge-desktop',
        pid: deadPid,
        processStartedAt: Date.now() - 1_000,
        acquiredAt: Date.now() - 500,
        leaseId: 'stale-lease',
      })}\n`,
    );

    const cli = acquireHostRuntimeLease({
      lockFile,
      owner: { kind: 'cli', product: 'feishu-codex-bridge' },
    });
    cleanup.push(cli.release);
  });

  it('does not mistake a reused live PID for the original lease owner', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fcb-runtime-pid-reuse-'));
    const lockFile = join(dir, 'owner.json');
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 8000)'], { stdio: 'ignore' });
    try {
      writeFileSync(
        lockFile,
        `${JSON.stringify({
          schemaVersion: 1,
          kind: 'desktop',
          product: 'bridge-desktop',
          pid: child.pid!,
          processStartedAt: Date.now() - 3 * 86_400_000,
          acquiredAt: Date.now() - 3 * 86_400_000,
          leaseId: 'reused-pid-lease',
        })}\n`,
      );

      const cli = acquireHostRuntimeLease({
        lockFile,
        owner: { kind: 'cli', product: 'feishu-codex-bridge' },
      });
      cleanup.push(cli.release);
    } finally {
      child.kill('SIGKILL');
      await new Promise<void>((resolve) => child.once('exit', () => resolve()));
    }
  });

  it('can retry release after a transient ownership-file read failure', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fcb-runtime-release-retry-'));
    const lockFile = join(dir, 'owner.json');
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));

    const lease = acquireHostRuntimeLease({
      lockFile,
      owner: { kind: 'desktop', product: 'bridge-desktop' },
    });
    writeFileSync(lockFile, '{invalid-json\n');

    expect(() => lease.release()).toThrow();
    writeFileSync(lockFile, `${JSON.stringify(lease.owner)}\n`);
    expect(() => lease.release()).not.toThrow();
    expect(existsSync(lockFile)).toBe(false);
  });
});
