import { expect, it, vi } from 'vitest';
import type { AppConfig } from '../src/config/schema';

vi.mock('../src/cli-bridge/route', () => ({
  readCliBridgeRoute: () => ({kind: 'agent', botId: 'cli_first'}),
}));
import { shouldStartCliBridge } from '../src/cli-bridge/service';

it('keeps an enabled recipient ready when another Agent currently receives global Hooks', () => {
  const recipient: AppConfig = {
    accounts: {app: {id: 'cli_second', secret: 'test-secret', tenant: 'feishu'}},
    preferences: {access: {ownerOpenId: 'ou_owner'}, cliBridge: {enabled: true}},
  };
  expect(shouldStartCliBridge(recipient)).toBe(true);
  expect(shouldStartCliBridge({...recipient, preferences: {...recipient.preferences, cliBridge: {enabled: false}}})).toBe(false);
});
