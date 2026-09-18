import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../src/config/schema';
import { buildAdminsCard } from '../src/card/dm-cards';

describe('buildAdminsCard', () => {
  it('renders owner and administrator collaborators without mutation actions', () => {
    const cfg = {
      appId: 'cli_test',
      appSecret: 'secret',
      preferences: { access: { ownerOpenId: 'ou_owner', admins: ['ou_admin'] } },
    } as unknown as AppConfig;
    const json = JSON.stringify(buildAdminsCard(cfg, new Map([
      ['ou_owner', 'Owner'],
      ['ou_admin', 'Alice'],
    ])));

    expect(json).toContain('Owner');
    expect(json).toContain('Alice');
    expect(json).toContain('协作者管理');
    expect(json).not.toContain('添加管理员');
    expect(json).not.toContain('🗑 移除');
    expect(json).not.toContain('dm.admin.rm');
  });
});
