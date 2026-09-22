import * as nodeFs from 'node:fs';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { effectiveGuestMode, effectiveMode, turnTier } from '../src/project/registry';
import { sandboxParams, withAutoCompact } from '../src/agent/codex-appserver/backend';
import { buildGroupSettingsCard, buildPermissionCard, buildProjectSettingsCard } from '../src/card/dm-cards';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, realpathSync: vi.fn(actual.realpathSync) };
});

describe('effectiveMode', () => {
  it('defaults missing mode to full (legacy data unaffected)', () => {
    expect(effectiveMode({})).toBe('full');
    expect(effectiveMode({ mode: undefined })).toBe('full');
  });
  it('passes explicit tiers through', () => {
    expect(effectiveMode({ mode: 'qa' })).toBe('qa');
    expect(effectiveMode({ mode: 'write' })).toBe('write');
    expect(effectiveMode({ mode: 'full' })).toBe('full');
  });
});

describe('effectiveGuestMode', () => {
  it('unset guestMode falls back to the admin tier (no split)', () => {
    expect(effectiveGuestMode({ mode: 'full' })).toBe('full');
    expect(effectiveGuestMode({ mode: 'qa' })).toBe('qa');
    expect(effectiveGuestMode({})).toBe('full'); // legacy
  });
  it('explicit guestMode wins', () => {
    expect(effectiveGuestMode({ mode: 'full', guestMode: 'qa' })).toBe('qa');
  });
});

describe('turnTier (admin vs guest per-turn tier + thread split)', () => {
  it('no guestMode → no split; both roles get the admin tier', () => {
    expect(turnTier({ mode: 'full' }, true)).toEqual({ mode: 'full', role: 'admin', split: false });
    expect(turnTier({ mode: 'full' }, false)).toEqual({ mode: 'full', role: 'guest', split: false });
  });
  it('guestMode equal to mode → still no split', () => {
    expect(turnTier({ mode: 'qa', guestMode: 'qa' }, false).split).toBe(false);
  });
  it('distinct guestMode → split; admin keeps mode, guest gets guestMode', () => {
    expect(turnTier({ mode: 'full', guestMode: 'qa' }, true)).toEqual({ mode: 'full', role: 'admin', split: true });
    expect(turnTier({ mode: 'full', guestMode: 'qa' }, false)).toEqual({ mode: 'qa', role: 'guest', split: true });
  });
});

describe('sandboxParams', () => {
  // Force a platform for one assertion, then restore — keeps these deterministic
  // regardless of the host the tests run on.
  function withPlatform<T>(value: NodeJS.Platform, fn: () => T): T {
    const orig = process.platform;
    Object.defineProperty(process, 'platform', { value, configurable: true });
    try {
      return fn();
    } finally {
      Object.defineProperty(process, 'platform', { value: orig, configurable: true });
    }
  }

  it('full (and undefined) → danger-full-access, no permissions config (any platform)', () => {
    for (const plat of ['darwin', 'win32', 'linux'] as const) {
      withPlatform(plat, () => {
        expect(sandboxParams('full', false)).toEqual({ sandbox: 'danger-full-access' });
        expect(sandboxParams(undefined, true)).toEqual({ sandbox: 'danger-full-access' });
      });
    }
  });

  // qa/write read-confinement is enforceable on macOS (Seatbelt) and native
  // Windows (restricted token) — assert the profile shape on both.
  for (const plat of ['darwin', 'win32'] as const) {
    it(`${plat}: qa → read-only confined to workspace, network off`, () => {
      withPlatform(plat, () => {
        const p = sandboxParams('qa', false) as any;
        expect(p.sandbox).toBeUndefined();
        expect(p.config.default_permissions).toBe('feishu');
        const fs = p.config.permissions.feishu.filesystem;
        expect(fs[':minimal']).toBe('read');
        expect(fs[':workspace_roots']['.']).toBe('read');
        expect(p.config.permissions.feishu.network.enabled).toBe(false);
      });
    });
    it(`${plat}: write → workspace write + network honored`, () => {
      withPlatform(plat, () => {
        const p = sandboxParams('write', true) as any;
        expect(p.config.permissions.feishu.filesystem[':workspace_roots']['.']).toBe('write');
        expect(p.config.permissions.feishu.network.enabled).toBe(true);
      });
    });
  }

  it('macOS custom launchers get exact-file reads without exposing sibling files', () => {
    const root = mkdtempSync(join(tmpdir(), 'bridge-runtime-test-'));
    try {
      const launcher = join(root, 'bin', 'codex');
      const runtime = join(root, 'runtime', 'codex');
      mkdirSync(dirname(launcher));
      mkdirSync(dirname(runtime));
      writeFileSync(runtime, 'test runtime');
      symlinkSync(runtime, launcher);
      withPlatform('darwin', () => {
        const p = sandboxParams('qa', false, launcher) as any;
        const fs = p.config.permissions.feishu.filesystem;
        expect(fs[launcher]).toBe('read');
        expect(fs[dirname(launcher)]).toBeUndefined();
        expect(fs[dirname(nodeFs.realpathSync(runtime))]).toBeUndefined();
        // macOS realpath resolves /var to /private/var.
        expect(Object.values(fs).filter((v) => v === 'read')).toHaveLength(3);
        expect(fs[':workspace_roots']['.']).toBe('read');
        expect(fs[':root']).toBeUndefined();
        expect(p.config.permissions.feishu.network.enabled).toBe(false);
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('macOS only expands verified Homebrew installation directories', () => {
    const cases = [
      ['/opt/homebrew/bin/codex', '/opt/homebrew/Caskroom/codex/0.154.0/bin/codex', '/opt/homebrew/bin', true],
      ['/usr/local/bin/codex', '/usr/local/Cellar/codex/0.154.0/bin/codex', '/usr/local/bin', true],
      ['/mock-home/codex', '/opt/homebrew/Caskroom/codex/0.154.0/bin/codex', '/mock-home', false],
      ['/opt/homebrew/bin/codex', '/mock-home/codex', '/opt/homebrew/bin', false],
      ['/opt/homebrew/bin/codex', '/opt/homebrew/Caskroom/other/0.154.0/bin/codex', '/opt/homebrew/bin', false],
      ['/opt/homebrew/bin/codex', '/opt/homebrew/Caskroom/codex/0.154.0/bin/codex', '/mock-home', false],
    ] as const;
    for (const [launcher, runtime, canonicalParent, directoryAllowed] of cases) {
      const spy = vi.spyOn(nodeFs, 'realpathSync').mockImplementation(((path: string) =>
        path === launcher ? runtime : canonicalParent) as typeof nodeFs.realpathSync);
      try {
        withPlatform('darwin', () => {
          for (const mode of ['qa', 'write'] as const) {
            const fs = (sandboxParams(mode, false, launcher) as any).config.permissions.feishu.filesystem;
            expect(fs[launcher]).toBe('read');
            expect(fs[runtime]).toBe('read');
            expect(fs[dirname(launcher)]).toBe(directoryAllowed ? 'read' : undefined);
            expect(fs[dirname(runtime)]).toBe(directoryAllowed ? 'read' : undefined);
            expect(fs['/mock-home']).toBeUndefined();
          }
        });
      } finally {
        spy.mockRestore();
      }
    }
  });

  it('macOS reports a clear fail-closed diagnostic if the discovered executable disappears', () => {
    const missing = Object.assign(new Error('fixture removed during upgrade'), { code: 'ENOENT' });
    for (const failAt of ['launcher', 'parent']) {
      const spy = vi.spyOn(nodeFs, 'realpathSync').mockImplementation(((path: string) => {
        if (failAt === 'launcher' || path === '/mock-home') throw missing;
        return '/mock-runtime/codex';
      }) as typeof nodeFs.realpathSync);
      try {
        withPlatform('darwin', () => {
          for (const mode of ['qa', 'write'] as const) {
            let failure: unknown;
            try { sandboxParams(mode, false, '/mock-home/codex'); } catch (error) { failure = error; }
            expect(failure).toBeInstanceOf(Error);
            expect((failure as Error).message).toContain('已拒绝启动项目权限会话');
            expect((failure as Error).message).toContain('CODEX_BIN');
            expect((failure as Error).cause).toBe(missing);
          }
          expect(sandboxParams('full', false, '/mock-home/codex')).toEqual({ sandbox: 'danger-full-access' });
        });
      } finally { spy.mockRestore(); }
    }
  });

  it('fail-closed on Linux/WSL: qa/write throw (reads not confined there), full still works', () => {
    withPlatform('linux', () => {
      expect(() => sandboxParams('qa', false)).toThrow();
      expect(() => sandboxParams('write', false)).toThrow();
      expect(sandboxParams('full', false)).toEqual({ sandbox: 'danger-full-access' });
    });
  });
});

describe('group settings card', () => {
  it('renders the auto-compact toggle, defaulting to on', () => {
    const json = JSON.stringify(buildGroupSettingsCard({ name: 'P', kind: 'multi', origin: 'created' }));
    expect(json).toContain('gs.autoCompact');
    expect(json).toContain('自动压缩');
  });
  it('reflects an explicit off setting', () => {
    const json = JSON.stringify(
      buildGroupSettingsCard({ name: 'P', kind: 'multi', origin: 'created', autoCompact: false }),
    );
    // the 'off' option button is primary-selected when autoCompact is false
    expect(json).toContain('gs.autoCompact');
  });
});

describe('withAutoCompact', () => {
  it('leaves params untouched when auto-compact is on (true/undefined)', () => {
    const full = { sandbox: 'danger-full-access' };
    expect(withAutoCompact(full, undefined)).toEqual(full);
    expect(withAutoCompact(full, true)).toEqual(full);
  });

  it('injects a disable limit into a fresh config (full mode keeps sandbox)', () => {
    const out = withAutoCompact({ sandbox: 'danger-full-access' }, false) as any;
    expect(out.sandbox).toBe('danger-full-access');
    expect(out.config.model_auto_compact_token_limit).toBeGreaterThan(100_000_000);
  });

  it('merges the disable limit into an existing config without clobbering permissions', () => {
    const qa = { config: { default_permissions: 'feishu', permissions: { feishu: {} } } };
    const out = withAutoCompact(qa, false) as any;
    expect(out.config.default_permissions).toBe('feishu');
    expect(out.config.permissions.feishu).toBeDefined();
    expect(out.config.model_auto_compact_token_limit).toBeGreaterThan(100_000_000);
  });
});

describe('permission cards', () => {
  // The project settings card opens the 🔐 权限 form sub-card (buildPermissionCard);
  // the tier choice is a dropdown (select_static in a form), not live buttons.
  it('project settings card shows the 🔐 权限 entry + a tier summary', () => {
    const json = JSON.stringify(
      buildProjectSettingsCard({ name: 'P', cwd: '/x', kind: 'multi', origin: 'created', mode: 'full', guestMode: 'qa', network: false }),
    );
    expect(json).toContain('dm.proj.perm'); // 🔐 权限 button → opens the form
    expect(json).toContain('"n":"P"');
    expect(json).toContain('管理员'); // split summary mentions both roles
    expect(json).toContain('其他人');
  });

  it('project settings card carries the auto-compact toggle (project-scoped)', () => {
    const json = JSON.stringify(
      buildProjectSettingsCard({ name: 'P', cwd: '/x', kind: 'multi', origin: 'created', mode: 'full', guestMode: 'qa', network: false }),
    );
    expect(json).toContain('dm.proj.autoCompact');
    expect(json).toContain('自动压缩');
  });

  it('permission form has admin + guest tier dropdowns, network, submit, and pre-selects current tiers', () => {
    const json = JSON.stringify(buildPermissionCard({ name: 'P', mode: 'full', guestMode: 'qa', network: false }));
    // two tier selects (select_static inside a form), by name
    expect(json).toContain('"name":"mode"');
    expect(json).toContain('"name":"guestMode"');
    expect(json).toContain('"name":"network"');
    expect(json).toContain('select_static');
    expect(json).toContain('"tag":"form"');
    // tiers listed + submit carries the project name
    expect(json).toContain('项目内只读');
    expect(json).toContain('完全访问');
    expect(json).toContain('dm.proj.perm.submit');
    expect(json).toContain('"n":"P"');
    // current tiers pre-selected (initial_option)
    expect(json).toContain('"initial_option":"full"'); // admin
    expect(json).toContain('"initial_option":"qa"'); // guest
  });

  it('unset guestMode pre-selects the admin tier for the guest dropdown (no split)', () => {
    const json = JSON.stringify(buildPermissionCard({ name: 'P', mode: 'qa', network: true }));
    expect(json).toContain('"initial_option":"on"'); // network
    // both dropdowns default to qa (guest falls back to admin tier)
    expect((json.match(/"initial_option":"qa"/g) ?? []).length).toBe(2);
  });
});
