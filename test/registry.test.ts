import { describe, expect, it } from 'vitest';
import { defaultNoMention, isProjectEnabled } from '../src/project/registry';

describe('isProjectEnabled', () => {
  it('keeps upstream records enabled unless top-level enabled is explicitly false', () => {
    expect(isProjectEnabled({})).toBe(true);
    expect(isProjectEnabled({ enabled: true })).toBe(true);
    expect(isProjectEnabled({ enabled: false })).toBe(false);
  });
});

describe('defaultNoMention', () => {
  // 免@ defaults on everywhere EXCEPT a joined single-session group.
  it('created groups default 免@ on (both kinds)', () => {
    expect(defaultNoMention({ origin: 'created', kind: 'multi' })).toBe(true);
    expect(defaultNoMention({ origin: 'created', kind: 'single' })).toBe(true);
  });

  it('joined multi-topic group defaults 免@ on', () => {
    expect(defaultNoMention({ origin: 'joined', kind: 'multi' })).toBe(true);
  });

  it('joined single-session group is the only combo defaulting 免@ off', () => {
    expect(defaultNoMention({ origin: 'joined', kind: 'single' })).toBe(false);
  });

  it('treats missing origin as created and missing kind as multi', () => {
    // old data without origin/kind → created+multi → on
    expect(defaultNoMention({})).toBe(true);
    expect(defaultNoMention({ kind: 'single' })).toBe(true); // created (implied) single → on
    expect(defaultNoMention({ origin: 'joined' })).toBe(true); // joined multi (implied) → on
  });
});
