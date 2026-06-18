import { describe, expect, it } from 'vitest';
import {
  canEnableCliBridge,
  getCliBridgePreferences,
  resolveCliBridgeTarget,
  type AppConfig,
} from '../src/config/schema';
import { paths } from '../src/config/paths';

function cfg(preferences: AppConfig['preferences'] = {}): AppConfig {
  return {
    accounts: { app: { id: 'cli_app', secret: 'secret', tenant: 'feishu' } },
    preferences,
  };
}

describe('cli bridge config helpers', () => {
  it('uses safe defaults when cliBridge is omitted', () => {
    expect(getCliBridgePreferences(cfg())).toEqual({
      enabled: false,
      delivery: 'away_only',
      includeBridgeOwnedSessionsForDebugging: false,
      agents: { claude: true, codex: true },
      notifyScope: 'all',
      keepAwake: { enabled: true },
      approval: { enabled: true, timeoutSeconds: 86400 },
      taskCompletion: { enabled: true, replyEnabled: true, replyTimeoutSeconds: 600 },
      allowCache: { enabled: true, scope: 'session' },
      presence: { enabled: true, platform: 'auto', idleThresholdSeconds: 120 },
    });
  });

  it('parses notify scope and keep-awake, defaulting unknown scope to all', () => {
    const valid = getCliBridgePreferences(cfg({
      cliBridge: { notifyScope: 'bound_projects', keepAwake: { enabled: false } },
    }));
    expect(valid.notifyScope).toBe('bound_projects');
    expect(valid.keepAwake.enabled).toBe(false);

    const none = getCliBridgePreferences(cfg({ cliBridge: { notifyScope: 'none' } }));
    expect(none.notifyScope).toBe('none');

    const bogus = getCliBridgePreferences(cfg({ cliBridge: { notifyScope: 'sometimes' as never } }));
    expect(bogus.notifyScope).toBe('all');
    // keep-awake defaults on when omitted
    expect(bogus.keepAwake.enabled).toBe(true);
  });

  it('normalizes invalid values back to defaults', () => {
    const prefs = getCliBridgePreferences(cfg({
      cliBridge: {
        enabled: true,
        delivery: 'bad' as never,
        agents: { claude: false, codex: false },
        approval: { enabled: true, timeoutSeconds: -1 },
        taskCompletion: { enabled: true, replyEnabled: true, replyTimeoutSeconds: 0 },
        presence: { enabled: true, platform: 'windows' as never, idleThresholdSeconds: 1 },
      },
    }));
    expect(prefs.delivery).toBe('away_only');
    expect(prefs.agents).toEqual({ claude: false, codex: false });
    expect(prefs.approval.timeoutSeconds).toBe(86400);
    expect(prefs.taskCompletion.replyTimeoutSeconds).toBe(600);
    expect(prefs.presence.platform).toBe('auto');
    expect(prefs.presence.idleThresholdSeconds).toBe(10);
  });

  it('normalizes legacy always delivery to the default away-only route', () => {
    expect(getCliBridgePreferences(cfg({
      cliBridge: { enabled: true, delivery: 'always' },
    })).delivery).toBe('away_only');
  });

  it('resolves owner target and blocks enablement without owner', () => {
    expect(resolveCliBridgeTarget(cfg())).toBeUndefined();
    expect(canEnableCliBridge(cfg())).toEqual({ ok: false, reason: 'missing_owner' });
    const owned = cfg({ access: { ownerOpenId: 'ou_owner', admins: [] } });
    expect(resolveCliBridgeTarget(owned)).toEqual({ receiveIdType: 'open_id', receiveId: 'ou_owner' });
    expect(canEnableCliBridge(owned)).toEqual({ ok: true });
  });
});

describe('cli bridge paths', () => {
  it('keeps cli bridge runtime files under the current bot directory', () => {
    expect(paths.cliBridgeSocket.endsWith('/cli-bridge.sock')).toBe(true);
  });
});
