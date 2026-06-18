import { describe, expect, it } from 'vitest';
import { createKeepAwakeController, type KeepAwakeProcess } from '../src/cli-bridge/keep-awake';

/** A fake caffeinate process that records whether it was killed. */
function fakeProc(): KeepAwakeProcess & { killed: boolean } {
  return {
    killed: false,
    kill() {
      this.killed = true;
      return true;
    },
  };
}

describe('keep-awake controller', () => {
  it('spawns on the first acquire and kills on the last release (ref-counted)', () => {
    const spawned: Array<KeepAwakeProcess & { killed: boolean }> = [];
    const ctl = createKeepAwakeController({
      spawnProcess: () => {
        const p = fakeProc();
        spawned.push(p);
        return p;
      },
    });

    ctl.acquire();
    expect(ctl.isActive()).toBe(true);
    expect(spawned).toHaveLength(1);

    // a second concurrent reason must NOT spawn a second process
    ctl.acquire();
    expect(spawned).toHaveLength(1);
    expect(ctl.isActive()).toBe(true);

    // releasing one reason keeps it alive — still one outstanding
    ctl.release();
    expect(ctl.isActive()).toBe(true);
    expect(spawned[0]?.killed).toBe(false);

    // releasing the last reason kills caffeinate
    ctl.release();
    expect(ctl.isActive()).toBe(false);
    expect(spawned[0]?.killed).toBe(true);
  });

  it('re-spawns a fresh process after a full release', () => {
    const spawned: Array<KeepAwakeProcess & { killed: boolean }> = [];
    const ctl = createKeepAwakeController({
      spawnProcess: () => {
        const p = fakeProc();
        spawned.push(p);
        return p;
      },
    });
    ctl.acquire();
    ctl.release();
    ctl.acquire();
    expect(spawned).toHaveLength(2);
    expect(spawned[1]?.killed).toBe(false);
  });

  it('does not spawn while disabled', () => {
    let enabled = false;
    const spawned: KeepAwakeProcess[] = [];
    const ctl = createKeepAwakeController({
      enabled: () => enabled,
      spawnProcess: () => {
        const p = fakeProc();
        spawned.push(p);
        return p;
      },
    });
    ctl.acquire();
    expect(ctl.isActive()).toBe(false);
    expect(spawned).toHaveLength(0);

    // flipping enabled on starts it on the next acquire even though count was already >0
    enabled = true;
    ctl.acquire();
    expect(ctl.isActive()).toBe(true);
    expect(spawned).toHaveLength(1);
  });

  it('shutdown force-kills and resets the count', () => {
    const p = fakeProc();
    const ctl = createKeepAwakeController({ spawnProcess: () => p });
    ctl.acquire();
    ctl.acquire();
    ctl.shutdown();
    expect(ctl.isActive()).toBe(false);
    expect(p.killed).toBe(true);
    // a stray release after shutdown is a no-op (count already 0)
    ctl.release();
    expect(ctl.isActive()).toBe(false);
  });

  it('tolerates a spawnProcess that returns undefined (non-macOS no-op)', () => {
    const ctl = createKeepAwakeController({ spawnProcess: () => undefined });
    ctl.acquire();
    expect(ctl.isActive()).toBe(false);
    ctl.release();
    ctl.shutdown();
    expect(ctl.isActive()).toBe(false);
  });
});
