import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { paths } from '../config/paths';

/** A project = a Feishu group bound to a fixed working directory. */
export interface Project {
  /** unique project name (also the group name) */
  name: string;
  /** the bound Feishu group chat_id (oc_xxx) */
  chatId: string;
  /** absolute working directory codex runs in for this project */
  cwd: string;
  /** true when bridge created the cwd as a blank project (under projectsRootDir) */
  blank: boolean;
  createdAt: number;
  /** last branch shown in the announcement (for lazy change detection) */
  branch?: string;
  /** group session model: 'multi' (default) = a topic per session (现状);
   * 'single' = the whole group is one session keyed by chatId. */
  kind?: 'multi' | 'single';
  /** respond to non-@ messages too. Read as `noMention ?? true` (default on).
   * multi: only inside a topic; single: whole group. Needs im:message.group_msg. */
  noMention?: boolean;
}

interface StoreFile {
  version: number;
  projects: Project[];
}

const FILE_VERSION = 1;

async function read(): Promise<Project[]> {
  try {
    const text = await readFile(paths.projectsFile, 'utf8');
    const parsed = JSON.parse(text) as Partial<StoreFile>;
    return Array.isArray(parsed.projects) ? parsed.projects : [];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

async function write(projects: Project[]): Promise<void> {
  await mkdir(dirname(paths.projectsFile), { recursive: true });
  const tmp = `${paths.projectsFile}.tmp-${process.pid}`;
  const body: StoreFile = { version: FILE_VERSION, projects };
  await writeFile(tmp, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
  await rename(tmp, paths.projectsFile);
}

export async function listProjects(): Promise<Project[]> {
  return read();
}

export async function getProjectByChatId(chatId: string): Promise<Project | undefined> {
  return (await read()).find((p) => p.chatId === chatId);
}

export async function getProjectByName(name: string): Promise<Project | undefined> {
  return (await read()).find((p) => p.name === name);
}

/** Add a project. Throws if the name already exists. */
export async function addProject(p: Project): Promise<void> {
  const projects = await read();
  if (projects.some((x) => x.name === p.name)) {
    throw new Error(`项目名「${p.name}」已存在`);
  }
  projects.push(p);
  await write(projects);
}

/** Patch fields of a project by name; no-op if it doesn't exist. */
export async function updateProject(
  name: string,
  patch: Partial<Omit<Project, 'name'>>,
): Promise<void> {
  const projects = await read();
  const p = projects.find((x) => x.name === name);
  if (!p) return;
  const target = p as unknown as Record<string, unknown>;
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) target[k] = v;
  }
  await write(projects);
}

/** Remove (unbind) a project by name. Returns the removed entry, if any. */
export async function removeProject(name: string): Promise<Project | undefined> {
  const projects = await read();
  const idx = projects.findIndex((p) => p.name === name);
  if (idx === -1) return undefined;
  const [removed] = projects.splice(idx, 1);
  await write(projects);
  return removed;
}
