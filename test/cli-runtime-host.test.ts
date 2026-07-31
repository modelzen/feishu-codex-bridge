import { describe, expect, it, vi } from 'vitest';
import { CliRuntimeHost, type PreparedCliBot } from '../src/cli/runtime-host';
import type { BotRuntimeEvent } from '../src/runtime';

function preparedBot(
  name: string,
  appId: string,
  ownerOpenId?: string,
  admins: string[] = ['ou_admin'],
): PreparedCliBot {
  return {
    entry: {
      name,
      appId,
      tenant: 'feishu',
      createdAt: 1,
      active: true,
    },
    config: {
      accounts: {
        app: {
          id: appId,
          secret: `secret-${appId}`,
          tenant: 'feishu',
        },
      },
      preferences: {
        access: {
          ...(ownerOpenId === undefined ? {} : { ownerOpenId }),
          admins,
        },
      },
    },
    initialSecret: `secret-${appId}`,
  };
}

describe('CliRuntimeHost', () => {
  it('uses the v0.6.10 admin fallback and isolates only configs with no usable owner', async () => {
    const events: BotRuntimeEvent[] = [];
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const host = new CliRuntimeHost({
      bots: [
        preparedBot('legacy', 'cli_legacy'),
        preparedBot('unowned', 'cli_unowned', undefined, []),
        preparedBot('healthy', 'cli_healthy', 'ou_owner'),
      ],
      onRuntimeEvent: (event) => events.push(event),
    });

    const specs = await host.loadBotSpecs();

    expect(specs).toHaveLength(2);
    expect(specs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        appId: 'cli_legacy',
        ownerOpenId: 'ou_admin',
      }),
      expect.objectContaining({
        appId: 'cli_healthy',
        ownerOpenId: 'ou_owner',
      }),
    ]));
    expect(events).toContainEqual(expect.objectContaining({
      type: 'status',
      appId: 'cli_unowned',
      status: {
        connection: 'disconnected',
        lastError: expect.stringContaining('缺少 ownerOpenId'),
      },
    }));
    expect(error).toHaveBeenCalledWith(expect.stringContaining('其余机器人继续启动'));
    error.mockRestore();
  });
});
