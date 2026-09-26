import { pendingGroupsFile, retirePendingGroup } from '../project/pending-groups';
import { paths } from '../config/paths';
import { DEFAULT_BACKEND_ID, effectiveDefaultBackend } from '../agent';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { LarkChannel } from '@larksuiteoapi/node-sdk';
import { bindModeFor, joinExistingGroup } from '../project/lifecycle';
import { getProjectByChatId, getProjectByName, listProjects, type Project } from '../project/registry';
import { AdminWriteError } from './ops';

export interface BindGroupInput {
  chatId: string;
  projectName: string;
  directory: string;
  backend: 'codex-appserver' | 'claude-agent';
  kind: 'multi' | 'single';
}
export type AdminGroupOp = { kind: 'joinedGroups'; cursor?: string } | { kind: 'bindGroup'; input: BindGroupInput };
export interface JoinedGroups {
  groups: { chatId: string; name: string; bound: boolean }[];
  nextCursor?: string;
}
export class GroupUpstreamError extends Error {
  readonly code = 'GROUP_UPSTREAM';
}
export class InvalidGroupInput extends Error { readonly code = 'INVALID_GROUP_INPUT'; }

export function parseBindGroupInput(raw: Record<string, unknown>): BindGroupInput {
  const { chatId, projectName, directory, backend, kind } = raw;
  if (Object.keys(raw).some(key => !['chatId', 'projectName', 'directory', 'backend', 'kind'].includes(key)) ||
      typeof chatId !== 'string' || !/^oc_[\w-]{1,200}$/.test(chatId) ||
      typeof projectName !== 'string' || !projectName.trim() || projectName.length > 200 || /[\x00-\x1f]/.test(projectName) ||
      typeof directory !== 'string' || !isAbsolute(directory) || directory.length > 4096 || /[\x00-\x1f]/.test(directory) ||
      (backend !== 'codex-appserver' && backend !== 'claude-agent') || (kind !== 'multi' && kind !== 'single')) {
    throw new InvalidGroupInput('群绑定参数无效');
  }
  return { chatId, projectName: projectName.trim(), directory, backend, kind };
}

export function parseJoinedGroups(raw: unknown): JoinedGroups {
  if (!raw || typeof raw !== 'object' || !('groups' in raw) || !Array.isArray(raw.groups)) throw new GroupUpstreamError('群列表响应无效');
  const groups = raw.groups.map(group => {
    if (!group || typeof group !== 'object' || typeof group.chatId !== 'string' || typeof group.name !== 'string' || typeof group.bound !== 'boolean') throw new GroupUpstreamError('群列表响应无效');
    return { chatId: group.chatId, name: group.name, bound: group.bound };
  });
  if ('nextCursor' in raw && raw.nextCursor !== undefined && typeof raw.nextCursor !== 'string') throw new GroupUpstreamError('群列表游标无效');
  return { groups, ...('nextCursor' in raw && typeof raw.nextCursor === 'string' ? { nextCursor: raw.nextCursor } : {}) };
}

function upstream(error: unknown): never {
  throw new GroupUpstreamError(error instanceof Error ? error.message : '飞书群接口调用失败');
}

export function createGroupExecutor(channel: LarkChannel): (op: AdminGroupOp) => Promise<JoinedGroups | Project> {
  let bindChain: Promise<unknown> = Promise.resolve();
  async function bind(input: BindGroupInput): Promise<Project> {
    let directory: string;
    try {
      directory = await realpath(input.directory);
      if (!(await stat(directory)).isDirectory()) throw new Error('not directory');
    } catch { throw new InvalidGroupInput('所选文件夹不存在或不是目录'); }
    const membership = await channel.rawClient.im.v1.chatMembers.isInChat({ path: { chat_id: input.chatId } }).catch(upstream);
    if (membership.code !== 0 || typeof membership.data?.is_in_chat !== 'boolean') throw new GroupUpstreamError(membership.msg ?? '无法确认机器人群成员身份');
    if (!membership.data.is_in_chat) throw new AdminWriteError('机器人不在此群中');
    async function same(project: Project): Promise<boolean> {
      const cwd = await realpath(project.cwd).catch(() => project.cwd);
      const backend = project.backend ?? await effectiveDefaultBackend().catch(() => DEFAULT_BACKEND_ID);
      return project.name === input.projectName && cwd === directory && backend === input.backend && (project.kind ?? 'multi') === input.kind;
    }
    const bound = await getProjectByChatId(input.chatId);
    if (bound) {
      if (await same(bound)) {
        await retirePendingGroup(pendingGroupsFile(paths.projectsFile), bound.chatId);
        return bound;
      }
      throw new AdminWriteError(`该群已绑定为项目「${bound.name}」，现有文件夹、后端和群类型不可修改`);
    }
    if (await getProjectByName(input.projectName)) throw new AdminWriteError('项目名已被使用');
    try {
      return await joinExistingGroup(channel, { name: input.projectName, chatId: input.chatId, existingPath: directory, backend: input.backend, kind: input.kind, mode: bindModeFor(input.backend) });
    } catch (error) {
      const raced = await getProjectByChatId(input.chatId);
      if (raced && await same(raced)) {
        await retirePendingGroup(pendingGroupsFile(paths.projectsFile), raced.chatId);
        return raced;
      }
      throw new AdminWriteError(error instanceof Error ? error.message : '群绑定失败');
    }
  }
  return async op => {
    if (op.kind === 'bindGroup') {
      const run = bindChain.then(() => bind(op.input));
      bindChain = run.catch(() => undefined);
      return run;
    }
    const response = await channel.rawClient.im.v1.chat.list({ params: { page_size: 50, ...(op.cursor ? { page_token: op.cursor } : {}) } }).catch(upstream);
    if (response.code !== 0 || !response.data || !Array.isArray(response.data.items)) throw new GroupUpstreamError(response.msg ?? '飞书群列表响应无效');
    const projects = await listProjects();
    const groups = response.data.items.map(item => {
      if (!item.chat_id || typeof item.name !== 'string') throw new GroupUpstreamError('飞书群列表缺少群标识或名称');
      return { chatId: item.chat_id, name: item.name, bound: projects.some(project => project.chatId === item.chat_id) };
    });
    if (response.data.has_more && !response.data.page_token) throw new GroupUpstreamError('飞书群列表缺少下一页游标');
    return { groups, ...(response.data.has_more ? { nextCursor: response.data.page_token } : {}) };
  };
}
