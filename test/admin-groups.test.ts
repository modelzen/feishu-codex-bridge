import { createPendingGroups, pendingGroupsFile, readPendingGroups } from '../src/project/pending-groups';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LarkChannel } from '@larksuiteoapi/node-sdk';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { createGroupExecutor, parseBindGroupInput, type BindGroupInput } from '../src/admin/groups';
import { createAdminIpcCaller, createAdminIpcResponder } from '../src/admin/ipc';
import { addProject, listProjects, listProjectsIn } from '../src/project/registry';
import { joinExistingGroup } from '../src/project/lifecycle';
import { paths } from '../src/config/paths';

vi.mock('../src/config/paths', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = mkdtempSync(join(tmpdir(), 'groups-fixture-'));
  return { paths: { appDir: root, projectsFile: join(root, 'projects.json'), projectsRootDir: join(root, 'projects'), backendsDir: join(root, 'backends') } };
});
afterAll(async () => { await rm(paths.appDir, { recursive: true, force: true }); });

function channelFixture() {
  const message = vi.fn(async () => ({ code: 0, data: { message_id: 'message' } }));
  const membership = vi.fn(async () => ({ code: 0, data: { is_in_chat: true } }));
  const list = vi.fn(async () => ({ code: 0, data: { items: [{ chat_id: 'oc_a', name: 'Group A' }], has_more: true, page_token: 'page2' } }));
  const channel = { rawClient: { im: { v1: { message: { create: message }, chatMembers: { isInChat: membership }, chat: { list } } } } } as unknown as LarkChannel;
  return { channel, message, membership, list };
}
const input = (directory: string): BindGroupInput => ({ chatId: 'oc_a', projectName: 'First', directory, backend: 'codex-appserver', kind: 'multi' });

describe('desktop group commands in the owning bot', () => {
  it('commits once through IPC, sends one welcome, and retries identical bindings', async () => {
    const dir = await mkdtemp(join(paths.appDir, 'workspace-'));
    const fixture = channelFixture();
    const execute = createGroupExecutor(fixture.channel);
    let receive = (_raw: unknown): void => {};
    const respond = createAdminIpcResponder(async op => {
      if (op.kind !== 'bindGroup' && op.kind !== 'joinedGroups') throw new Error('wrong op');
      return execute(op);
    }, message => receive(message));
    const caller = createAdminIpcCaller(respond);
    receive = caller.onMessage;
    const results = await Promise.all(Array.from({ length: 8 }, () => caller.call({ kind: 'bindGroup', input: input(dir) })));
    expect(results.every(result => JSON.stringify(result) === JSON.stringify(results[0]))).toBe(true);
    expect(fixture.message).toHaveBeenCalledTimes(1);
    expect(await listProjects()).toHaveLength(1);
    const saved = JSON.parse(await readFile(paths.projectsFile, 'utf8'));
    expect(saved.projects[0]).toMatchObject({ cwd: await realpath(dir), chatId: 'oc_a', mode: 'qa', origin: 'joined' });
    expect(saved.projects[0]).not.toHaveProperty('addedBy');
    await expect(caller.call({ kind: 'bindGroup', input: { ...input(dir), kind: 'single' } })).rejects.toThrow('不可修改');
    await expect(caller.call({ kind: 'bindGroup', input: { ...input(dir), chatId: 'oc_other' } })).rejects.toThrow('项目名');
    const page = await caller.call({ kind: 'joinedGroups', cursor: 'cursor1' });
    expect(page).toEqual({ groups: [{ chatId: 'oc_a', name: 'Group A', bound: true }], nextCursor: 'page2' });
    expect(fixture.list).toHaveBeenCalledWith({ params: { page_size: 50, page_token: 'cursor1' } });
  });

  it('refuses invalid directories and non-members without welcome or persistence', async () => {
    const fixture = channelFixture();
    const execute = createGroupExecutor(fixture.channel);
    const file = join(paths.appDir, 'plain-file');
    await writeFile(file, 'x');
    await expect(execute({ kind: 'bindGroup', input: input(file) })).rejects.toThrow('不是目录');
    const pendingFile = pendingGroupsFile(paths.projectsFile);
    const queue = createPendingGroups({ file: pendingFile, eligible: async () => true, verify: async () => 'Unbound', onError: error => { throw error; } });
    await queue.add('oc_a', 'ou_admin');
    fixture.membership.mockResolvedValue({ code: 0, data: { is_in_chat: false } });
    await expect(execute({ kind: 'bindGroup', input: input(paths.appDir) })).rejects.toThrow('不在此群');
    expect(fixture.message).not.toHaveBeenCalled();
    expect(await readPendingGroups(pendingFile)).toHaveLength(1);
    await queue.remove('oc_a');
    fixture.membership.mockRejectedValue(new Error('upstream unavailable'));
    await expect(execute({ kind: 'bindGroup', input: input(paths.appDir) })).rejects.toMatchObject({ code: 'GROUP_UPSTREAM' });
  });

  it('keeps a committed binding when welcome fails and preserves actual DM operator', async () => {
    const fixture = channelFixture();
    fixture.message.mockRejectedValue(new Error('welcome unavailable'));
    const execute = createGroupExecutor(fixture.channel);
    const value = { ...input(paths.appDir), projectName: 'Second', chatId: 'oc_second' };
    await execute({ kind: 'bindGroup', input: value });
    await execute({ kind: 'bindGroup', input: value });
    expect(fixture.message).toHaveBeenCalledTimes(1);
    const queue = createPendingGroups({ file: pendingGroupsFile(paths.projectsFile), eligible: async () => true, verify: async () => 'DM', onError: error => { throw error; } });
    await queue.add('oc_dm', 'ou_actual_sender');
    await queue.refresh();
    const dm = await joinExistingGroup(fixture.channel, { name: 'DM', chatId: 'oc_dm', existingPath: paths.appDir, addedBy: 'ou_actual_sender' });
    expect(dm.addedBy).toBe('ou_actual_sender');
    expect(await readPendingGroups(pendingGroupsFile(paths.projectsFile))).toEqual([]);
    const retried = await execute({ kind: 'bindGroup', input: { ...input(paths.appDir), projectName: 'DM', chatId: 'oc_dm' } });
    expect(retried).toEqual(dm);
    expect(fixture.message).toHaveBeenCalledTimes(2);
  });

  it('registry rejects duplicate races while preserving unrelated existing projects', async () => {
    const values = await Promise.allSettled(['A', 'B'].map(name => addProject({ name, chatId: 'oc_race', cwd: paths.appDir, blank: false, createdAt: 1 })));
    expect(values.filter(value => value.status === 'fulfilled')).toHaveLength(1);
    expect((await listProjects()).filter(project => project.chatId === 'oc_race')).toHaveLength(1);
    expect((await listProjects()).find(project => project.chatId === 'oc_dm')?.addedBy).toBe('ou_actual_sender');
    const invalid = join(paths.appDir, 'invalid.json');
    await writeFile(invalid, '{}');
    await expect(listProjectsIn(invalid)).rejects.toThrow('格式无效');
  });

  it('parses the exact supported binding shape', () => {
    expect(parseBindGroupInput({ ...input(paths.appDir), projectName: ' Trim ' }).projectName).toBe('Trim');
    for (const patch of [{ backend: 'unknown' }, { directory: 'relative' }, { kind: 'new' }, { chatId: '../escape' }, { extra: true }]) expect(() => parseBindGroupInput({ ...input(paths.appDir), ...patch })).toThrow();
  });
});
