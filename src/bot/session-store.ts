import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { paths } from '../config/paths';
import type { ReasoningEffort } from '../agent/types';

/**
 * A persisted session = one Feishu topic (thread) bound to a codex thread.
 * Survives bridge restarts so @bot inside an existing topic resumes the right
 * codex thread (instead of silently starting a fresh one) and the ⚙️ per-session
 * model/effort overrides stick.
 */
export interface SessionRecord {
  /** Feishu topic thread_id (the key) */
  threadId: string;
  chatId: string;
  cwd: string;
  /** codex thread id — pass to backend.resumeThread */
  codexThreadId: string;
  model?: string;
  effort?: ReasoningEffort;
  /** first user message excerpt, for context */
  summary: string;
  createdAt: number;
  updatedAt: number;
}

interface StoreFile {
  version: number;
  sessions: SessionRecord[];
}

const FILE_VERSION = 1;

async function read(): Promise<SessionRecord[]> {
  try {
    const text = await readFile(paths.sessionsFile, 'utf8');
    const parsed = JSON.parse(text) as Partial<StoreFile>;
    return Array.isArray(parsed.sessions) ? parsed.sessions : [];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

async function write(sessions: SessionRecord[]): Promise<void> {
  await mkdir(dirname(paths.sessionsFile), { recursive: true });
  const tmp = `${paths.sessionsFile}.tmp-${process.pid}`;
  const body: StoreFile = { version: FILE_VERSION, sessions };
  await writeFile(tmp, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
  await rename(tmp, paths.sessionsFile);
}

export async function listSessions(): Promise<SessionRecord[]> {
  return read();
}

export async function getSession(threadId: string): Promise<SessionRecord | undefined> {
  return (await read()).find((s) => s.threadId === threadId);
}

/** Insert or replace a session by threadId. */
export async function upsertSession(rec: SessionRecord): Promise<void> {
  const sessions = await read();
  const idx = sessions.findIndex((s) => s.threadId === rec.threadId);
  if (idx === -1) sessions.push(rec);
  else sessions[idx] = rec;
  await write(sessions);
}

/** Patch fields of an existing session; no-op if it doesn't exist. */
export async function patchSession(
  threadId: string,
  patch: Partial<Omit<SessionRecord, 'threadId'>>,
): Promise<void> {
  const sessions = await read();
  const rec = sessions.find((s) => s.threadId === threadId);
  if (!rec) return;
  const target = rec as unknown as Record<string, unknown>;
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) target[k] = v;
  }
  rec.updatedAt = Date.now();
  await write(sessions);
}
