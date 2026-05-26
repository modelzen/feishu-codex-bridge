import { describe, expect, it } from 'vitest';
import {
  getMaxConcurrentRuns,
  getMessageReplyMode,
  getPendingPolicy,
  getRunIdleTimeoutMs,
  isAdmin,
  isChatAllowed,
  isUserAllowed,
  type AppConfig,
} from '../src/config/schema';

function cfg(preferences: AppConfig['preferences'] = {}): AppConfig {
  return {
    accounts: {
      app: {
        id: 'cli_xxx',
        secret: 'secret',
        tenant: 'feishu',
      },
    },
    preferences,
  };
}

describe('config schema helpers', () => {
  it('resolves run idle timeout defaults, disabled value, and clamp bounds', () => {
    expect(getRunIdleTimeoutMs(cfg())).toBe(120_000);
    expect(getRunIdleTimeoutMs(cfg({ runIdleTimeoutSeconds: 0 }))).toBeUndefined();
    expect(getRunIdleTimeoutMs(cfg({ runIdleTimeoutSeconds: 1 }))).toBe(10_000);
    expect(getRunIdleTimeoutMs(cfg({ runIdleTimeoutSeconds: 2000 }))).toBe(1_800_000);
    expect(getRunIdleTimeoutMs(cfg({ runIdleTimeoutSeconds: 12.9 }))).toBe(12_000);
    expect(getRunIdleTimeoutMs(cfg({ runIdleTimeoutSeconds: -1 }))).toBe(120_000);
  });

  it('resolves pending policy with steer as the default', () => {
    expect(getPendingPolicy(cfg())).toBe('steer');
    expect(getPendingPolicy(cfg({ pendingPolicy: 'queue' }))).toBe('queue');
    expect(getPendingPolicy(cfg({ pendingPolicy: 'steer' }))).toBe('steer');
  });

  it('clamps max concurrent runs to the supported range', () => {
    expect(getMaxConcurrentRuns(cfg())).toBe(10);
    expect(getMaxConcurrentRuns(cfg({ maxConcurrentRuns: 0 }))).toBe(10);
    expect(getMaxConcurrentRuns(cfg({ maxConcurrentRuns: 5.9 }))).toBe(5);
    expect(getMaxConcurrentRuns(cfg({ maxConcurrentRuns: 99 }))).toBe(50);
  });

  it('allows admins, users, and chats when allowlists are empty or omitted', () => {
    expect(isAdmin(cfg(), 'ou_1')).toBe(true);
    expect(isUserAllowed(cfg({ access: { allowedUsers: [] } }), 'ou_1')).toBe(true);
    expect(isChatAllowed(cfg({ access: { allowedChats: [] } }), 'oc_1')).toBe(true);
  });

  it('matches admins, users, and chats against configured allowlists', () => {
    const restricted = cfg({
      access: {
        admins: ['admin-1'],
        allowedUsers: ['user-1'],
        allowedChats: ['chat-1'],
      },
    });

    expect(isAdmin(restricted, 'admin-1')).toBe(true);
    expect(isAdmin(restricted, 'admin-2')).toBe(false);
    expect(isUserAllowed(restricted, 'user-1')).toBe(true);
    expect(isUserAllowed(restricted, 'user-2')).toBe(false);
    expect(isChatAllowed(restricted, 'chat-1')).toBe(true);
    expect(isChatAllowed(restricted, 'chat-2')).toBe(false);
  });

  it('resolves message reply mode with card as the default', () => {
    expect(getMessageReplyMode(cfg())).toBe('card');
    expect(getMessageReplyMode(cfg({ messageReply: 'markdown' }))).toBe('markdown');
    expect(getMessageReplyMode(cfg({ messageReply: 'text' }))).toBe('text');
    expect(getMessageReplyMode(cfg({ messageReply: 'card' }))).toBe('card');
    expect(getMessageReplyMode(cfg({ messageReply: 'bad' as never }))).toBe('card');
  });
});
