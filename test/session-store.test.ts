import { rmSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearSessionTitleJobKey,
  createSessionTitleJob,
  getSession,
  getSessionTitleJob,
  listSessions,
  listSessionTitleJobs,
  patchSession,
  sessionTitleJobKey,
  updateSessionTitleJob,
  upsertSession,
  type SessionRecord,
  type SessionTitleJob,
} from '../src/bot/session-store';
import { paths } from '../src/config/paths';

// 把 sessions.json 指到临时目录，绝不碰真实 ~/.feishu-codex-bridge。
vi.mock('../src/config/paths', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'session-store-test-'));
  return { paths: { sessionsFile: join(dir, 'sessions.json') } };
});

afterAll(() => {
  rmSync(dirname(paths.sessionsFile), { recursive: true, force: true });
});

beforeEach(async () => {
  await rm(paths.sessionsFile, { force: true });
});

function rec(threadId: string, sessionId: string): SessionRecord {
  return {
    threadId,
    chatId: 'oc_chat',
    cwd: '/tmp/proj',
    sessionId,
    backend: 'codex-appserver',
    summary: `s-${threadId}`,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

function titleJob(sessionId = 'cx-title'): SessionTitleJob {
  const now = Date.now();
  return {
    key: sessionTitleJobKey('codex-appserver', sessionId),
    backend: 'codex-appserver',
    sessionId,
    cwd: '/tmp/proj',
    phase: 'pending',
    source: '帮我看下这个报错',
    policy: { strategy: 'model', model: 'gpt-5.5', effort: 'low' },
    attempts: 0,
    createdAt: now,
    updatedAt: now,
  };
}

describe('session-store', () => {
  it('upsert + getSession roundtrip; upsert replaces by threadId', async () => {
    await upsertSession(rec('t1', 'cx1'));
    await upsertSession(rec('t1', 'cx1b'));
    expect((await getSession('t1'))?.sessionId).toBe('cx1b');
    expect(await listSessions()).toHaveLength(1);
  });

  // F3 核心：并发 upsert 不同 threadId，无锁版会基于同一旧快照后写覆盖前写丢绑定。
  it('20 concurrent upserts of distinct threadIds all survive', async () => {
    await Promise.all(Array.from({ length: 20 }, (_, i) => upsertSession(rec(`t${i}`, `cx${i}`))));
    const all = await listSessions();
    expect(all).toHaveLength(20);
    for (let i = 0; i < 20; i++) {
      expect(all.find((s) => s.threadId === `t${i}`)?.sessionId).toBe(`cx${i}`);
    }
    // 落盘文件本身完好（tmp 交错会产生半截 JSON）
    const onDisk = JSON.parse(await readFile(paths.sessionsFile, 'utf8'));
    expect(onDisk.sessions).toHaveLength(20);
  });

  it('concurrent functional patches see the latest on-disk value (no lost update)', async () => {
    await upsertSession(rec('t1', 'cx1'));
    await Promise.all(
      Array.from({ length: 20 }, () => patchSession('t1', (s) => ({ lastSeenAt: (s.lastSeenAt ?? 0) + 1 }))),
    );
    expect((await getSession('t1'))?.lastSeenAt).toBe(20);
  });

  // M-8：旧 v1 文件读入迁移 —— 会话 id 旧字段名 → sessionId；缺 backend 回填
  // 默认 codex 后端。重启后既不丢绑定，也能按 backend 正确路由 resume。
  it('migrates a legacy v1 file on read (session-id field rename + backend backfill)', async () => {
    await mkdir(dirname(paths.sessionsFile), { recursive: true });
    const legacy = {
      version: 1,
      sessions: [
        {
          threadId: 'old-topic',
          chatId: 'oc_chat',
          cwd: '/tmp/proj',
          ['codexThread' + 'Id']: 'cx-legacy', // 旧字段名（拼接缘由见 session-store 注释）
          summary: 's',
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    };
    await writeFile(paths.sessionsFile, JSON.stringify(legacy), 'utf8');
    const got = await getSession('old-topic');
    expect(got?.sessionId).toBe('cx-legacy');
    expect(got?.backend).toBe('codex-appserver');
    // 写回（patch 任意字段）后落盘的是新字段名 + 回填的 backend + 新文件版本
    await patchSession('old-topic', { model: 'gpt-5.5' });
    const onDisk = JSON.parse(await readFile(paths.sessionsFile, 'utf8'));
    expect(onDisk.version).toBe(3);
    expect(onDisk.sessions[0].sessionId).toBe('cx-legacy');
    expect(onDisk.sessions[0].backend).toBe('codex-appserver');
    expect(onDisk.titleJobs).toEqual([]);
  });

  it('keeps an explicit stored backend as-is (no backfill clobber)', async () => {
    // session-store 只存字符串、不校验后端是否注册；这里用一个非默认值验证
    // 已存在的 backend 字段不会被 backfill 覆盖（migrate 只在缺字段时回填默认）。
    await upsertSession({ ...rec('t-other', 'sess-uuid'), backend: 'some-other-backend' });
    expect((await getSession('t-other'))?.backend).toBe('some-other-backend');
  });

  it('patchSession skips undefined fields and is a no-op for an unknown threadId', async () => {
    await upsertSession(rec('t1', 'cx1'));
    await patchSession('t1', { model: 'gpt-5.5', effort: undefined });
    const got = await getSession('t1');
    expect(got?.model).toBe('gpt-5.5');
    expect(got?.effort).toBeUndefined();
    await patchSession('nope', { model: 'x' }); // must not throw or create a record
    expect(await listSessions()).toHaveLength(1);
  });

  it('reads a v2 store with an empty title ledger and never backfills old sessions', async () => {
    await mkdir(dirname(paths.sessionsFile), { recursive: true });
    await writeFile(
      paths.sessionsFile,
      JSON.stringify({
        version: 2,
        sessions: [rec('old-v2-topic', 'old-v2-session')],
        // A hand-edited/partial-upgrade v2 file still must not smuggle in work.
        titleJobs: [titleJob('must-not-run')],
      }),
      'utf8',
    );

    expect(await listSessionTitleJobs()).toEqual([]);
    expect((await getSession('old-v2-topic'))?.sessionId).toBe('old-v2-session');

    // Any later write upgrades the envelope but does not invent work for an old
    // backend session the bridge cannot safely prove it owns.
    await patchSession('old-v2-topic', { summary: 'updated' });
    const onDisk = JSON.parse(await readFile(paths.sessionsFile, 'utf8'));
    expect(onDisk.version).toBe(3);
    expect(onDisk.titleJobs).toEqual([]);
  });

  it('create is idempotent and ordinary session writes preserve title jobs', async () => {
    const job = titleJob();
    expect(await createSessionTitleJob(job)).toBe(true);
    expect(await createSessionTitleJob({ ...job, source: '不应覆盖' })).toBe(false);

    await upsertSession(rec('t-title', 'cx-title'));
    await patchSession('t-title', { model: 'gpt-5.5' });

    expect((await getSessionTitleJob(job.key))?.source).toBe('帮我看下这个报错');
    const onDisk = JSON.parse(await readFile(paths.sessionsFile, 'utf8'));
    expect(onDisk.sessions).toHaveLength(1);
    expect(onDisk.titleJobs).toHaveLength(1);
  });

  it('allows exactly one concurrent pending -> generating claim', async () => {
    const job = titleJob('cx-race');
    await createSessionTitleJob(job);

    const claims = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        updateSessionTitleJob(
          job.key,
          (current) => current.phase === 'pending',
          (current) => ({
            ...current,
            phase: 'generating' as const,
            claimId: `claim-${i}`,
            leaseUntil: Date.now() + 60_000,
            attempts: current.attempts + 1,
          }),
        ),
      ),
    );

    expect(claims.filter(Boolean)).toHaveLength(1);
    const stored = await getSessionTitleJob(job.key);
    expect(stored?.phase).toBe('generating');
    expect(stored?.attempts).toBe(1);
    expect(stored?.claimId).toMatch(/^claim-\d+$/);
  });

  it('conditional mutate is a no-op for a stale claim id', async () => {
    const job = { ...titleJob('cx-stale'), phase: 'generating' as const, claimId: 'winner' };
    await createSessionTitleJob(job);
    const result = await updateSessionTitleJob(
      job.key,
      (current) => current.claimId === 'loser',
      (current) => ({ ...current, phase: 'prepared', candidate: '报错排查' }),
    );
    expect(result).toBe(false);
    expect((await getSessionTitleJob(job.key))?.phase).toBe('generating');
  });

  it('full replacement can clear source/candidate/policy atomically', async () => {
    const job: SessionTitleJob = {
      ...titleJob('cx-clear-fields'),
      phase: 'applying',
      candidate: '登录报错排查',
      claimId: 'claim-1',
      leaseUntil: Date.now() + 1000,
    };
    await createSessionTitleJob(job);
    const updated = await updateSessionTitleJob(
      job.key,
      (current) => current.phase === 'applying' && current.claimId === 'claim-1',
      (current) => ({
        key: current.key,
        backend: current.backend,
        sessionId: current.sessionId,
        cwd: current.cwd,
        phase: 'done',
        finalTitle: current.candidate,
        attempts: current.attempts,
        outcome: 'written',
        createdAt: current.createdAt,
        updatedAt: current.updatedAt,
      }),
    );
    expect(updated).toBe(true);
    const stored = await getSessionTitleJob(job.key);
    expect(stored).not.toHaveProperty('source');
    expect(stored).not.toHaveProperty('candidate');
    expect(stored).not.toHaveProperty('policy');
    expect(stored).not.toHaveProperty('claimId');
    expect(stored?.phase).toBe('done');
  });

  it('clears a consumed binding marker only when the key still matches', async () => {
    const marker = sessionTitleJobKey('codex-appserver', 'cx-marker');
    await upsertSession({ ...rec('t-marker', 'cx-marker'), titleJobKey: marker });

    await clearSessionTitleJobKey('t-marker', 'codex-appserver:stale');
    expect((await getSession('t-marker'))?.titleJobKey).toBe(marker);

    await clearSessionTitleJobKey('t-marker', marker);
    expect(await getSession('t-marker')).not.toHaveProperty('titleJobKey');
  });
});
