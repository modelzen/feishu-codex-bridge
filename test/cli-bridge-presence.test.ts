import { describe, expect, it } from 'vitest';
import { parseScreenLocked } from '../src/cli-bridge/presence';

// Sample of the IOConsoleUsers dict ioreg prints; the screen-lock flag appears
// (= Yes) only while locked, and is absent / No otherwise.
const lockedDict = `
+-o Root  <class IORegistryEntry, id 0x100000100>
    | {
    |   "IOConsoleUsers" = ({"kCGSSessionUserNameKey"="clay","CGSSessionScreenIsLocked"=Yes})
    | }
`;
const unlockedDict = `
+-o Root  <class IORegistryEntry, id 0x100000100>
    | {
    |   "IOConsoleUsers" = ({"kCGSSessionUserNameKey"="clay"})
    | }
`;
const unlockedExplicitNo = `"CGSSessionScreenIsLocked" = No`;

describe('parseScreenLocked', () => {
  it('detects a locked screen', () => {
    expect(parseScreenLocked(lockedDict)).toBe(true);
    expect(parseScreenLocked('"CGSSessionScreenIsLocked" = Yes')).toBe(true);
    expect(parseScreenLocked('CGSSessionScreenIsLocked=Yes')).toBe(true);
  });

  it('treats absent or explicit-No as unlocked', () => {
    expect(parseScreenLocked(unlockedDict)).toBe(false);
    expect(parseScreenLocked(unlockedExplicitNo)).toBe(false);
    expect(parseScreenLocked('')).toBe(false);
  });
});
