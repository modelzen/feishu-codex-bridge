import { Client, Domain } from '@larksuiteoapi/node-sdk';
import type { TenantBrand } from '../config/schema';

const PROJECT_MEMBER_PAGE_SIZE = 100;
const MAX_PROJECT_MEMBER_PAGES = 100;
const CONTACT_BATCH_SIZE = 50;

export interface RuntimeFeishuAdminIdentity {
  openId: string;
  name: string;
  avatarUrl?: string;
  nameResolved: boolean;
}

export interface RuntimeFeishuAdminCatalog {
  owner: RuntimeFeishuAdminIdentity;
  admins: RuntimeFeishuAdminIdentity[];
  source: 'feishu-collaborators';
  partial: boolean;
  message?: string;
}

export interface RuntimeFeishuAdminRobot {
  appId: string;
  tenant: TenantBrand;
  ownerOpenId: string;
  secretRef: string;
  name?: string;
}

interface CollaboratorItem {
  type?: 'owner' | 'administrator' | 'developer' | 'operator';
  user_id?: string;
}

interface ContactItem {
  open_id?: string;
  name?: string;
  avatar?: { avatar_72?: string };
}

export interface RuntimeFeishuAdminClient {
  application: { v6: { applicationCollaborators: { get(input: {
    path: { app_id: string };
    params: { user_id_type: 'open_id' };
  }): Promise<{ code?: number; msg?: string; data?: { collaborators?: readonly CollaboratorItem[] } }> } } };
  contact: { v3: { user: { batch(input: {
    params: { user_ids: string[]; user_id_type: 'open_id' };
  }): Promise<{ code?: number; msg?: string; data?: { items?: readonly ContactItem[] } }> } } };
  im?: { v1: { chatMembers: { get(input: {
    path: { chat_id: string };
    params: { member_id_type: 'open_id'; page_size: number; page_token?: string };
  }): Promise<{
    code?: number;
    msg?: string;
    data?: {
      items?: readonly { member_id?: string; name?: string }[];
      page_token?: string;
      has_more?: boolean;
    };
  }> } } };
}

export interface RuntimeFeishuAdminDirectoryOptions {
  resolveRobot: (robotId: string) => RuntimeFeishuAdminRobot | undefined | Promise<RuntimeFeishuAdminRobot | undefined>;
  resolveSecret: (secretRef: string) => Promise<string | undefined>;
  listProjectChatIds?: (robotId: string) => readonly string[] | Promise<readonly string[]>;
  listRobotIds?: () => readonly string[] | Promise<readonly string[]>;
  createClient?: (input: { appId: string; appSecret: string; tenant: TenantBrand }) => RuntimeFeishuAdminClient;
  avatarCache?: { get(key: string): Promise<string | undefined>; set(key: string, value: string): Promise<void> };
  avatarCacheKey?: (input: { tenant: TenantBrand; appId: string; openId: string }) => string;
  source?: string;
  missingRobotMessage?: string;
  missingSecretMessage?: (robot: RuntimeFeishuAdminRobot) => string;
}

/** Shared collaborator-role authority and identity enrichment for Runtime hosts. */
export class RuntimeFeishuAdminDirectory {
  readonly #cache = new Map<string, Promise<RuntimeFeishuAdminCatalog>>();
  readonly #createClient: NonNullable<RuntimeFeishuAdminDirectoryOptions['createClient']>;

  constructor(private readonly options: RuntimeFeishuAdminDirectoryOptions) {
    this.#createClient = options.createClient ?? ((input) => new Client({
      appId: input.appId,
      appSecret: input.appSecret,
      domain: input.tenant === 'lark' ? Domain.Lark : Domain.Feishu,
      source: options.source ?? 'feishu-codex-bridge-runtime',
    }) as unknown as RuntimeFeishuAdminClient);
  }

  list(robotId: string, refresh = false): Promise<RuntimeFeishuAdminCatalog> {
    if (refresh) this.#cache.delete(robotId);
    const cached = this.#cache.get(robotId);
    if (cached) return cached;
    const pending = this.#load(robotId).catch((cause) => {
      if (this.#cache.get(robotId) === pending) this.#cache.delete(robotId);
      throw cause;
    });
    this.#cache.set(robotId, pending);
    return pending;
  }

  async preload(): Promise<void> {
    const ids = await this.options.listRobotIds?.() ?? [];
    await Promise.all(ids.map(async (id) => await this.list(id).catch(() => undefined)));
  }

  async #load(robotId: string): Promise<RuntimeFeishuAdminCatalog> {
    const robot = await this.options.resolveRobot(robotId);
    if (!robot) throw new Error(this.options.missingRobotMessage ?? '机器人不存在。');
    const secret = await this.options.resolveSecret(robot.secretRef);
    if (!secret) throw new Error(this.options.missingSecretMessage?.(robot) ?? '机器人凭据缺失，请重新授权。');
    const client = this.#createClient({ appId: robot.appId, appSecret: secret, tenant: robot.tenant });
    const response = await client.application.v6.applicationCollaborators.get({
      path: { app_id: robot.appId },
      params: { user_id_type: 'open_id' },
    });
    if (response.code !== undefined && response.code !== 0) {
      throw new Error(response.msg || '飞书拒绝读取应用协作者。');
    }
    const collaborators = response.data?.collaborators ?? [];
    const platformOwner = collaborators.find((item) => item.type === 'owner' && validOpenId(item.user_id))?.user_id;
    const ownerOpenId = platformOwner ?? robot.ownerOpenId;
    const adminOpenIds = collaborators
      .filter((item) => item.type === 'administrator' && validOpenId(item.user_id))
      .map((item) => item.user_id!)
      .filter((openId, index, values) => openId !== ownerOpenId && values.indexOf(openId) === index);
    const ids = [ownerOpenId, ...adminOpenIds];
    const chatIds = [...new Set(await this.options.listProjectChatIds?.(robotId) ?? [])];
    const projectMembers = await readProjectMembers(client, chatIds);
    const contacts = await readContacts(client, ids);
    const avatarUrls = new Map<string, string>();
    await Promise.all(ids.map(async (openId) => {
      const refreshed = contacts.contacts.get(openId)?.avatarUrl;
      const key = this.options.avatarCacheKey?.({ tenant: robot.tenant, appId: robot.appId, openId })
        ?? `${robot.tenant}:${robot.appId}:${openId}`;
      if (refreshed) await this.options.avatarCache?.set(key, refreshed).catch(() => undefined);
      const retained = await this.options.avatarCache?.get(key).catch(() => undefined);
      const avatarUrl = refreshed ?? retained;
      if (safeHttpsUrl(avatarUrl)) avatarUrls.set(openId, avatarUrl);
    }));
    let partial = platformOwner === undefined || projectMembers.partial || contacts.partial;
    const identity = (openId: string): RuntimeFeishuAdminIdentity => {
      const name = contacts.contacts.get(openId)?.name || projectMembers.members.get(openId);
      if (!name) partial = true;
      return {
        openId,
        name: name ?? '未能读取飞书名称',
        ...(avatarUrls.has(openId) ? { avatarUrl: avatarUrls.get(openId)! } : {}),
        nameResolved: Boolean(name),
      };
    };
    const owner = identity(ownerOpenId);
    const admins = adminOpenIds.map(identity).sort(compareIdentity);
    const missingAvatars = [owner, ...admins].filter((item) => !item.avatarUrl).length;
    if (this.options.avatarCache && missingAvatars > 0) partial = true;
    const messages: string[] = [];
    if (!platformOwner) messages.push('飞书接口未返回所有者，当前显示注册时记录的所有者。');
    if (projectMembers.partial) messages.push('部分项目群成员未能读取，姓名补全可能不完整。');
    if (contacts.partial) messages.push('部分联系人资料未能读取。');
    if ([owner, ...admins].some((item) => !item.nameResolved)) messages.push('部分管理员的飞书名称不可见，但不影响管理员权限。');
    if (this.options.avatarCache && missingAvatars > 0) messages.push('部分管理员头像未返回。');
    if (partial) messages.push('管理员资格仍以飞书开放平台角色为准。');
    return {
      owner,
      admins,
      source: 'feishu-collaborators',
      partial,
      ...(messages.length > 0 ? { message: messages.join(' ') } : {}),
    };
  }
}

async function readProjectMembers(client: RuntimeFeishuAdminClient, chatIds: readonly string[]): Promise<{
  members: Map<string, string>;
  partial: boolean;
}> {
  const members = new Map<string, string>();
  if (!client.im || chatIds.length === 0) return { members, partial: false };
  let partial = false;
  for (const chatId of chatIds) {
    let pageToken: string | undefined;
    try {
      for (let page = 0; page < MAX_PROJECT_MEMBER_PAGES; page += 1) {
        const response = await client.im.v1.chatMembers.get({
          path: { chat_id: chatId },
          params: {
            member_id_type: 'open_id',
            page_size: PROJECT_MEMBER_PAGE_SIZE,
            ...(pageToken ? { page_token: pageToken } : {}),
          },
        });
        if (response.code !== undefined && response.code !== 0) throw new Error(response.msg ?? 'member read failed');
        for (const item of response.data?.items ?? []) {
          if (validOpenId(item.member_id) && item.name?.trim() && !members.has(item.member_id)) {
            members.set(item.member_id, item.name.trim());
          }
        }
        if (!response.data?.has_more) break;
        const next = response.data.page_token?.trim();
        if (!next || next === pageToken) { partial = true; break; }
        pageToken = next;
      }
    } catch {
      partial = true;
    }
  }
  return { members, partial };
}

async function readContacts(client: RuntimeFeishuAdminClient, ids: readonly string[]): Promise<{
  contacts: Map<string, { name?: string; avatarUrl?: string }>;
  partial: boolean;
}> {
  const contacts = new Map<string, { name?: string; avatarUrl?: string }>();
  let partial = false;
  for (let offset = 0; offset < ids.length; offset += CONTACT_BATCH_SIZE) {
    try {
      const response = await client.contact.v3.user.batch({
        params: { user_ids: ids.slice(offset, offset + CONTACT_BATCH_SIZE), user_id_type: 'open_id' },
      });
      if (response.code !== undefined && response.code !== 0) { partial = true; continue; }
      for (const item of response.data?.items ?? []) {
        if (!validOpenId(item.open_id)) continue;
        const name = item.name?.trim();
        const avatarUrl = safeHttpsUrl(item.avatar?.avatar_72) ? item.avatar?.avatar_72 : undefined;
        contacts.set(item.open_id, {
          ...(name ? { name } : {}),
          ...(avatarUrl ? { avatarUrl } : {}),
        });
      }
    } catch {
      partial = true;
    }
  }
  return { contacts, partial };
}

function validOpenId(value: string | undefined): value is string {
  return value?.startsWith('ou_') === true;
}

function safeHttpsUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4_096) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch {
    return false;
  }
}

function compareIdentity(left: RuntimeFeishuAdminIdentity, right: RuntimeFeishuAdminIdentity): number {
  return left.name.localeCompare(right.name, 'zh-CN') || left.openId.localeCompare(right.openId);
}
