import type { LarkChannel } from '@larksuiteoapi/node-sdk';
import { describe, expect, it, vi } from 'vitest';
import {
  createProjectGroup,
  deleteCreatedProjectGroup,
} from '../src/project/group-provisioning';

describe('project group provisioning', () => {
  it('creates the project group, invites the owner, and promotes them to manager', async () => {
    const create = vi.fn(async () => ({ data: { chat_id: 'oc_created' } }));
    const addManagers = vi.fn(async () => ({}));
    const channel = {
      rawClient: {
        im: {
          v1: {
            chat: { create },
            chatManagers: { addManagers },
          },
        },
      },
    } as unknown as LarkChannel;

    await expect(createProjectGroup(channel, {
      name: 'Vonvon Bridge',
      ownerOpenId: 'ou_owner',
    })).resolves.toBe('oc_created');
    expect(create).toHaveBeenCalledWith({
      params: { user_id_type: 'open_id' },
      data: { name: 'Vonvon Bridge', user_id_list: ['ou_owner'] },
    });
    expect(addManagers).toHaveBeenCalledWith({
      path: { chat_id: 'oc_created' },
      params: { member_id_type: 'open_id' },
      data: { manager_ids: ['ou_owner'] },
    });
  });

  it('disbands an automatically-created group during rollback', async () => {
    const remove = vi.fn(async () => ({}));
    const channel = {
      rawClient: {
        im: {
          v1: {
            chat: { delete: remove },
          },
        },
      },
    } as unknown as LarkChannel;

    await deleteCreatedProjectGroup(channel, 'oc_created');
    expect(remove).toHaveBeenCalledWith({ path: { chat_id: 'oc_created' } });
  });
});
