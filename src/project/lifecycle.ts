import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { LarkChannel } from '@larksuiteoapi/node-sdk';
import { paths } from '../config/paths';
import { log } from '../core/logger';
import { addProject, getProjectByChatId, getProjectByName, type Project } from './registry';
import type { PermissionMode } from '../agent/types';
import { isBackendEntryInstalled } from '../agent';
import { catalogById, isInstallable, projectCreatableBackends } from '../agent/catalog';
import {
  createProjectGroup,
  finalizeCreatedProjectGroup,
} from './group-provisioning';
import { onboardGroup } from './onboarding';

/**
 * 校验「创建时选定的后端」此刻仍可用（已下载 + 支持该权限档）。防御卡渲染与提交之间
 * 的卸载竞态——否则会把无效后端写进项目，直到建会话才 fail-closed 报错。复用
 * {@link projectCreatableBackends} 的同源过滤（codex external-cli 基线特判，恒可用）。
 * backend 未设（落回默认 codex）直接放行。
 */
export function assertBackendUsable(backend: string | undefined, mode: PermissionMode): void {
  if (!backend) return;
  const ok = projectCreatableBackends(mode, isBackendEntryInstalled).some((e) => e.id === backend);
  if (ok) return;
  // 选了一个「未下载」的后端（下拉里标注了「未下载」的项）：给可下载的明确指引去 Web 下载，
  // 等价于「置灰提示」（Feishu 下拉无法对单项真置灰，故选中后在此友好拦截）。
  const entry = catalogById(backend);
  if (entry && isInstallable(entry)) {
    throw new Error(`「${entry.displayName}」尚未下载——请到 Web 控制台「后端 Agent」页点「下载」装好后，再回卡片选用。`);
  }
  throw new Error(`所选后端「${backend}」当前不可用（未下载或不支持该权限档），请回卡片重新选择`);
}

export interface CreateProjectInput {
  name: string;
  /** DM sender open_id — invited to the new group + set as a member. */
  ownerOpenId: string;
  /** when set, bind this existing folder; otherwise create a blank project. */
  existingPath?: string;
  /** optional config.json override for the parent directory of blank projects. */
  projectsRootDir?: string;
  /** session model for the group (default 'multi'). */
  kind?: 'multi' | 'single';
  /** permission tier (default 'full' for self-created projects). */
  mode?: PermissionMode;
  /** agent backend chosen at creation (fixed afterwards — no switching). When
   *  omitted, runtime falls back to DEFAULT_BACKEND_ID (codex). */
  backend?: string;
  /** allow the sandboxed shell to reach the network (default false). */
  network?: boolean;
}

export interface JoinGroupInput {
  /** project name — editable in the bind card, defaults to the group's name. */
  name: string;
  /** the pre-existing group the bot was added to. */
  chatId: string;
  /** open_id of the admin who added the bot + submitted the bind. */
  addedBy: string;
  /** when set, bind this existing folder; otherwise create a blank project. */
  existingPath?: string;
  /** optional config.json override for the parent directory of blank projects. */
  projectsRootDir?: string;
  /** session model for the group (default 'multi'). */
  kind?: 'multi' | 'single';
  /** permission tier (default 'qa' — read-only — for joined external groups). */
  mode?: PermissionMode;
  /** agent backend chosen at bind time (fixed afterwards — no switching). */
  backend?: string;
  /** allow the sandboxed shell to reach the network (default false). */
  network?: boolean;
}

/**
 * Resolve the working directory for a project: an explicit `existingPath` (must
 * exist) binds a folder you already have; otherwise a blank project dir is
 * created under the configured projects root (falling back to
 * {@link paths.projectsRootDir}). Throws before any group is touched so a bad
 * path never leaves an orphan group.
 */
async function resolveCwd(
  name: string,
  existingPath?: string,
  configuredProjectsRootDir?: string,
): Promise<{ cwd: string; blank: boolean }> {
  if (existingPath) {
    const cwd = isAbsolute(existingPath) ? existingPath : resolve(existingPath);
    if (!existsSync(cwd)) throw new Error(`文件夹不存在：${cwd}`);
    return { cwd, blank: false };
  }
  const cwd = join(resolveProjectsRootDir(configuredProjectsRootDir), name);
  await mkdir(cwd, { recursive: true });
  return { cwd, blank: true };
}

/**
 * Resolve `preferences.projectsRootDir` without depending on the daemon's cwd.
 * An empty value preserves the historical default; a relative value is
 * rejected because a background service may start from different directories.
 */
export function resolveProjectsRootDir(configured?: unknown): string {
  if (configured === undefined || configured === null) return paths.projectsRootDir;
  if (typeof configured !== 'string') {
    throw new Error('配置 preferences.projectsRootDir 必须是字符串');
  }
  const value = configured.trim();
  if (!value) return paths.projectsRootDir;
  let resolved: string;
  if (value === '~') resolved = homedir();
  else if (value.startsWith('~/') || value.startsWith('~\\')) {
    resolved = resolve(homedir(), value.slice(2));
  } else {
    if (!isAbsolute(value)) {
      throw new Error('配置 preferences.projectsRootDir 必须是绝对路径或以 ~ 开头');
    }
    resolved = resolve(value);
  }

  // Embedded desktop deliberately splits legacy compatibility assets from
  // writable assets. An imported CLI preference may still explicitly point at
  // the old default (`~/.feishu-codex-bridge/projects`); never let that stale
  // value turn the read-only fallback into a blank-project write target.
  if (
    paths.writableAssetsDir !== paths.legacyAssetsDir
    && isWithinDirectory(resolved, paths.legacyAssetsDir)
  ) {
    return paths.projectsRootDir;
  }
  return resolved;
}

function isWithinDirectory(candidate: string, directory: string): boolean {
  const relation = relative(resolve(directory), resolve(candidate));
  return relation === ''
    || (!isAbsolute(relation) && relation !== '..' && !relation.startsWith(`..${sep}`));
}

/**
 * Create a project: resolve/prepare the cwd, create a bound Feishu group
 * (bot stays owner, creator invited + promoted to admin), register it, and set
 * the group announcement.
 * Throws on duplicate name or missing existing path (before creating a group,
 * so no orphan groups).
 */
export async function createProject(channel: LarkChannel, input: CreateProjectInput): Promise<Project> {
  const name = input.name.trim();
  if (!name) throw new Error('项目名不能为空');
  if (await getProjectByName(name)) throw new Error(`项目名「${name}」已存在，换个名或用 /projects 看已有的`);
  assertBackendUsable(input.backend, input.mode ?? 'full'); // 创建默认「完全访问」档

  // 1. resolve cwd
  const { cwd, blank } = await resolveCwd(name, input.existingPath, input.projectsRootDir);

  // 2. create the bound group and promote the creator to group admin.
  const chatId = await createProjectGroup(channel, {
    name,
    ownerOpenId: input.ownerOpenId,
  });

  // 3. register
  const project: Project = {
    name,
    chatId,
    cwd,
    blank,
    createdAt: Date.now(),
    kind: input.kind ?? 'multi',
    origin: 'created',
    mode: input.mode ?? 'full',
    backend: input.backend || undefined,
    network: input.network ?? false,
  };
  await addProject(project);
  log.info('project', 'create', { name, chatId, cwd, blank, mode: project.mode, backend: project.backend });

  // 4. group announcement (top banner) + onboarding (welcome card / Pin / tab),
  //    both best-effort — a group is usable even if these fail.
  await finalizeCreatedProjectGroup(channel, project);
  return project;
}

/**
 * Bind a *pre-existing* group (the bot was just added to it by a human) as a
 * `joined` project. Unlike {@link createProject}: no group is created, no
 * announcement is written, no admin is promoted and ownership is never touched —
 * the bot stays a plain member. Onboarding only posts a (non-pinned) welcome
 * card. Throws on duplicate name (the name is editable in the bind card, so the
 * user can pick another) or if this chat is already bound — before resolving the
 * cwd, so nothing partial is left behind.
 */
export async function joinExistingGroup(channel: LarkChannel, input: JoinGroupInput): Promise<Project> {
  const name = input.name.trim();
  if (!name) throw new Error('项目名不能为空');
  if (await getProjectByName(name)) throw new Error(`项目名「${name}」已存在，换个名或用 /projects 看已有的`);
  const bound = await getProjectByChatId(input.chatId);
  if (bound) throw new Error(`该群已绑定为项目「${bound.name}」`);
  assertBackendUsable(input.backend, input.mode ?? 'qa'); // 外部群默认「只读」档

  const { cwd, blank } = await resolveCwd(name, input.existingPath, input.projectsRootDir);

  const project: Project = {
    name,
    chatId: input.chatId,
    cwd,
    blank,
    createdAt: Date.now(),
    kind: input.kind ?? 'multi',
    origin: 'joined',
    addedBy: input.addedBy,
    mode: input.mode ?? 'qa',
    backend: input.backend || undefined,
    network: input.network ?? false,
  };
  await addProject(project);
  log.info('project', 'join', { name, chatId: input.chatId, cwd, blank, kind: project.kind, mode: project.mode, backend: project.backend });

  // Onboarding only (no announcement / Pin / tab — see onboardGroup's joined
  // branch); best-effort, the binding holds even if the welcome card fails.
  await onboardGroup(channel, project).catch((err) => log.fail('project', err, { phase: 'onboard-join' }));
  return project;
}
