import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

type Candidate = { chatId: string; operator: string; addedAt: number; generation: string } &
  ({ state: 'verifying' } | { state: 'ready'; name: string });
export interface PendingGroup { chatId: string; name: string; addedAt: number }
export const pendingGroupsFile = (projectsFile: string): string => join(dirname(projectsFile), 'pending-groups.json');
const writers = new Map<string, Promise<unknown>>();

export async function readPendingGroups(file: string): Promise<Candidate[]> {
  let raw: unknown;
  try { raw = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return []; throw error; }
  if (!raw || typeof raw !== 'object' || !('version' in raw) || raw.version !== 1 || !('groups' in raw) || !Array.isArray(raw.groups)) throw new Error('待绑定群记录无效');
  return raw.groups.map((value: unknown): Candidate => {
    if (!value || typeof value !== 'object' || !('chatId' in value) || typeof value.chatId !== 'string' ||
        !('operator' in value) || typeof value.operator !== 'string' || !('addedAt' in value) || typeof value.addedAt !== 'number' || !Number.isFinite(value.addedAt) ||
        !('generation' in value) || typeof value.generation !== 'string' || !('state' in value)) throw new Error('待绑定群记录无效');
    const base = { chatId: value.chatId, operator: value.operator, addedAt: value.addedAt, generation: value.generation };
    if (value.state === 'verifying') return { ...base, state: 'verifying' };
    if (value.state === 'ready' && 'name' in value && typeof value.name === 'string' && value.name.trim()) return { ...base, state: 'ready', name: value.name };
    throw new Error('待绑定群记录无效');
  });
}

function update(file: string, change: (groups: Candidate[]) => Candidate[]): Promise<void> {
  const next = (writers.get(file) ?? Promise.resolve()).then(async () => {
    const before = await readPendingGroups(file);
    const groups = change(before);
    if (groups === before) return;
    await mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify({ version: 1, groups }), { mode: 0o600 });
    await rename(tmp, file);
  });
  const settled = next.catch(() => undefined);
  writers.set(file, settled);
  void settled.then(() => { if (writers.get(file) === settled) writers.delete(file); });
  return next;
}

export function retirePendingGroup(file: string, chatId: string): Promise<void> {
  return update(file, groups => groups.some(group => group.chatId === chatId) ? groups.filter(group => group.chatId !== chatId) : groups);
}

export function createPendingGroups(options: {
  file: string;
  eligible: (group: { chatId: string; operator: string }) => Promise<boolean>;
  verify: (chatId: string) => Promise<string | null>;
  onError: (error: unknown) => void;
}) {
  let refreshing: Promise<void> | undefined;
  async function sweep(): Promise<void> {
    for (const candidate of await readPendingGroups(options.file)) {
      try {
        const eligible = await options.eligible(candidate);
        const verifiedName = eligible ? await options.verify(candidate.chatId) : null;
        const name = verifiedName !== null && await options.eligible(candidate) ? verifiedName : null;
        await update(options.file, groups => {
          const current = groups.find(group => group.chatId === candidate.chatId);
          if (current?.generation !== candidate.generation) return groups;
          if (name === null) return groups.filter(group => group !== current);
          return groups.map(group => group === current ? { ...group, state: 'ready', name } : group);
        });
      } catch (error) { options.onError(error); }
    }
  }
  return {
    add(chatId: string, operator: string): Promise<void> {
      return update(options.file, groups => groups.some(group => group.chatId === chatId) ? groups :
        [...groups, { chatId, operator, addedAt: Date.now(), generation: randomUUID(), state: 'verifying' }]);
    },
    remove: (chatId: string) => retirePendingGroup(options.file, chatId),
    refresh(): Promise<void> {
      if (!refreshing) refreshing = sweep().catch(options.onError).finally(() => { refreshing = undefined; });
      return refreshing;
    },
  };
}
