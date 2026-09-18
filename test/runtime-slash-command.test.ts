import { describe, expect, it } from 'vitest';
import {
  BRIDGE_RUNTIME_ADMIN_SLASH_COMMANDS,
  BRIDGE_RUNTIME_SLASH_COMMANDS,
  parseRuntimeGoalTrigger,
  parseRuntimeSlashCommand,
} from '../src/runtime/slash-command';

describe('public Runtime slash-command contract', () => {
  it('parses one exact leading command without normalizing its input', () => {
    expect(parseRuntimeSlashCommand('/HELP  details')).toEqual({
      name: 'help',
      rawInput: '  details',
      knownToBridge: true,
      administratorOnly: false,
    });
    expect(parseRuntimeSlashCommand('/settings')).toEqual({
      name: 'settings',
      rawInput: '',
      knownToBridge: true,
      administratorOnly: true,
    });
    expect(parseRuntimeSlashCommand('/plan')).toEqual({
      name: 'plan',
      rawInput: '',
      knownToBridge: false,
      administratorOnly: false,
    });
  });

  it('does not mistake paths, URLs, or slash-prefixed prose for commands', () => {
    expect(parseRuntimeSlashCommand('/src/file.ts')).toBeUndefined();
    expect(parseRuntimeSlashCommand('https://example.com/help')).toBeUndefined();
    expect(parseRuntimeSlashCommand('/help?')).toBeUndefined();
    expect(parseRuntimeSlashCommand('please /help')).toBeUndefined();
  });

  it('keeps the public Bridge command and administrator policy catalogs explicit', () => {
    expect(BRIDGE_RUNTIME_SLASH_COMMANDS).toEqual([
      'resume', 'model', 'settings', 'help', 'compact', 'context', 'clear', 'goal',
    ]);
    expect(BRIDGE_RUNTIME_ADMIN_SLASH_COMMANDS).toEqual(['resume', 'settings', 'clear']);
  });

  it('recognizes a standalone goal trigger without matching paths or URLs', () => {
    expect(parseRuntimeGoalTrigger('please /goal ship it')).toBe('please ship it');
    expect(parseRuntimeGoalTrigger('/goal')).toBeNull();
    expect(parseRuntimeGoalTrigger('src/goal/main.ts')).toBeNull();
  });
});
