import { describe, expect, it, vi } from 'vitest';
import type { AgentBackend } from '../src/agent/types';
import {
  SessionTitleCoordinator,
  type SessionTitleStore,
} from '../src/bot/session-title-coordinator';
import type { SessionTitleJob } from '../src/bot/session-store';

function memoryStore(): SessionTitleStore & { jobs: Map<string, SessionTitleJob> } {
  const jobs = new Map<string, SessionTitleJob>();
  const clone = (job: SessionTitleJob): SessionTitleJob => structuredClone(job);
  return {
    jobs,
    async create(job) {
      if (jobs.has(job.key)) return false;
      jobs.set(job.key, clone(job));
      return true;
    },
    async get(key) {
      const job = jobs.get(key);
      return job ? clone(job) : undefined;
    },
    async list() {
      return [...jobs.values()].map(clone);
    },
    async update(key, predicate, updater) {
      const current = jobs.get(key);
      if (!current || !predicate(clone(current))) return false;
      const next = updater(clone(current));
      jobs.set(key, { ...clone(next), updatedAt: Date.now() });
      return true;
    },
  };
}

function titleBackend(overrides: Partial<AgentBackend> = {}): AgentBackend {
  return {
    id: 'codex-appserver',
    displayName: 'Codex',
    readSessionTitle: vi.fn(async () => undefined),
    setSessionTitle: vi.fn(async () => undefined),
    generateSessionTitle: vi.fn(async () => '生成标题'),
    ...overrides,
  } as unknown as AgentBackend;
}

function coordinator(store: SessionTitleStore, backend: AgentBackend): SessionTitleCoordinator {
  return new SessionTitleCoordinator({ store, backendFor: () => backend, retryMs: 1 });
}

describe('SessionTitleCoordinator', () => {
  it('strips the sender block before direct-title handling and writes only once', async () => {
    const store = memoryStore();
    const backend = titleBackend();
    const subject = coordinator(store, backend);
    const key = await subject.register({
      backend: backend.id,
      sessionId: 's-short',
      cwd: '/repo',
      source: '[本条消息的发信人：某用户（open_id：ou_123）]\n\n帮我看下这个报错',
      policy: { strategy: 'model', model: 'third-party-cheap', effort: 'low' },
    });

    await subject.activate(key);
    await Promise.all(Array.from({ length: 20 }, () => subject.apply(key)));
    await subject.activate(key);
    await subject.apply(key);

    expect(backend.generateSessionTitle).not.toHaveBeenCalled();
    expect(backend.setSessionTitle).toHaveBeenCalledTimes(1);
    expect(backend.setSessionTitle).toHaveBeenCalledWith('/repo', 's-short', '帮我看下这个报错');
    expect(store.jobs.get(key)).toMatchObject({ phase: 'done', outcome: 'written', finalTitle: '帮我看下这个报错' });
    expect(store.jobs.get(key)).not.toHaveProperty('source');
  });

  it('uses the exact configured third-party model and effort for a long prompt', async () => {
    const store = memoryStore();
    const backend = titleBackend({
      generateSessionTitle: vi.fn(async () => '标题：`登录回调超时排查。`'),
    });
    const subject = coordinator(store, backend);
    const key = await subject.register({
      backend: backend.id,
      sessionId: 's-model',
      cwd: '/repo',
      source: '[本条消息的发信人：张三（open_id：ou_x）]\n\n请帮我排查登录回调长期超时的问题，重点检查网关日志和最近发布的认证改动，然后给出修复方案。',
      policy: { strategy: 'model', model: 'vendor/custom-title-v7', effort: 'xhigh' },
    });

    await subject.activate(key);
    await subject.apply(key);

    expect(backend.generateSessionTitle).toHaveBeenCalledTimes(1);
    const options = vi.mocked(backend.generateSessionTitle! as NonNullable<AgentBackend['generateSessionTitle']>).mock.calls[0]![0];
    expect(options.model).toBe('vendor/custom-title-v7');
    expect(options.effort).toBe('xhigh');
    expect(options.prompt).not.toContain('本条消息的发信人');
    expect(options.prompt).not.toContain('张三');
    expect(backend.setSessionTitle).toHaveBeenCalledWith('/repo', 's-model', '登录回调超时排查');
  });

  it('falls back to the cleaned first sentence when the configured model fails', async () => {
    const store = memoryStore();
    const backend = titleBackend({
      generateSessionTitle: vi.fn(async () => {
        throw new Error('unknown third-party model');
      }),
    });
    const subject = coordinator(store, backend);
    const key = await subject.register({
      backend: backend.id,
      sessionId: 's-fallback',
      cwd: '/repo',
      source: '请帮我排查登录回调长期超时的问题。后面还有很多背景信息，不能拿来替换指定模型。',
      policy: { strategy: 'model', model: 'vendor/missing', effort: 'medium' },
    });

    await subject.activate(key);
    await subject.apply(key);

    expect(backend.generateSessionTitle).toHaveBeenCalledTimes(1);
    expect(backend.setSessionTitle).toHaveBeenCalledWith('/repo', 's-fallback', '请帮我排查登录回调长期超时的问题');
  });

  it('uses no model by default and recovery ignores a session until its first turn is activated', async () => {
    const store = memoryStore();
    const backend = titleBackend();
    const subject = coordinator(store, backend);
    const key = await subject.register({
      backend: backend.id,
      sessionId: 's-default-off',
      cwd: '/repo',
      source: `[本条消息的发信人：某用户（open_id：ou_off）]\n\n请帮我分析这个很长的构建失败问题。${'后面是大量背景，不应该进入标题。'.repeat(4)}`,
      policy: { strategy: 'truncate' },
    });

    await subject.recover();
    expect(store.jobs.get(key)?.phase).toBe('waiting_turn');
    expect(backend.setSessionTitle).not.toHaveBeenCalled();

    await subject.activate(key);
    await subject.recover();
    expect(backend.generateSessionTitle).not.toHaveBeenCalled();
    expect(backend.setSessionTitle).toHaveBeenCalledWith('/repo', 's-default-off', '请帮我分析这个很长的构建失败问题');
  });

  it('never overwrites an existing native title or spends a title-model call', async () => {
    const store = memoryStore();
    const backend = titleBackend({ readSessionTitle: vi.fn(async () => '用户自己起的标题') });
    const subject = coordinator(store, backend);
    const key = await subject.register({
      backend: backend.id,
      sessionId: 's-existing',
      cwd: '/repo',
      source: '这是一个足够长的问题，需要生成标题，但原生会话已经被用户命名了，所以绝对不能覆盖。',
      policy: { strategy: 'model', model: 'vendor/model', effort: 'high' },
    });

    await subject.activate(key);
    await subject.apply(key);

    expect(backend.generateSessionTitle).not.toHaveBeenCalled();
    expect(backend.setSessionTitle).not.toHaveBeenCalled();
    expect(store.jobs.get(key)).toMatchObject({ phase: 'skipped', outcome: 'preexisting', finalTitle: '用户自己起的标题' });
  });

  it('restart recovery reuses a persisted candidate without paying for the model again', async () => {
    const store = memoryStore();
    const backend = titleBackend({ generateSessionTitle: vi.fn(async () => '持久候选标题') });
    const firstProcess = coordinator(store, backend);
    const key = await firstProcess.register({
      backend: backend.id,
      sessionId: 's-recovery',
      cwd: '/repo',
      source: '这是一个足够长的首条问题，用于验证标题候选已经落盘以后，重启恢复不会再次调用模型生成标题。',
      policy: { strategy: 'model', model: 'vendor/title', effort: 'low' },
    });
    await firstProcess.activate(key);
    await firstProcess.prepare(key);
    expect(store.jobs.get(key)).toMatchObject({ phase: 'prepared', candidate: '持久候选标题' });
    expect(backend.generateSessionTitle).toHaveBeenCalledTimes(1);

    const restarted = coordinator(store, backend);
    await restarted.recover();
    expect(backend.generateSessionTitle).toHaveBeenCalledTimes(1);
    expect(backend.setSessionTitle).toHaveBeenCalledTimes(1);
    expect(store.jobs.get(key)).toMatchObject({ phase: 'done', outcome: 'written' });
  });

  it('does not write twice when the first native write succeeded but its call reported an error', async () => {
    const store = memoryStore();
    let nativeTitle: string | undefined;
    const set = vi.fn(async (_cwd: string, _sessionId: string, title: string) => {
      nativeTitle = title;
      throw new Error('connection dropped after commit');
    });
    const backend = titleBackend({
      readSessionTitle: vi.fn(async () => nativeTitle),
      setSessionTitle: set,
    });
    const subject = coordinator(store, backend);
    const key = await subject.register({
      backend: backend.id,
      sessionId: 's-uncertain',
      cwd: '/repo',
      source: '帮我检查支付回调为什么失败',
      policy: { strategy: 'truncate' },
    });

    await subject.activate(key);
    await subject.apply(key);
    await subject.apply(key);

    expect(set).toHaveBeenCalledTimes(1);
    expect(store.jobs.get(key)).toMatchObject({ phase: 'done', outcome: 'written', finalTitle: nativeTitle });
  });

  it('only attaches post-clear source to a pre-registered waiting job', async () => {
    const store = memoryStore();
    const backend = titleBackend();
    const subject = coordinator(store, backend);
    expect(await subject.attachSource('codex-appserver:manual-resume-id', '不要给手动恢复的会话改名')).toBe(false);
    expect(store.jobs.size).toBe(0);

    const key = await subject.register({
      backend: backend.id,
      sessionId: 's-cleared',
      cwd: '/repo',
      policy: { strategy: 'truncate' },
    });
    expect(store.jobs.get(key)?.phase).toBe('waiting_source');
    expect(await subject.attachSource(key, '这条消息排队时被取消，不应成为标题')).toBe(true);
    expect(await subject.attachSource(key, '[本条消息的发信人：某用户（open_id：ou_y）]\n继续排查构建失败')).toBe(true);
    expect(store.jobs.get(key)?.phase).toBe('waiting_turn');
    await subject.activate(key);
    await subject.apply(key);
    expect(backend.setSessionTitle).toHaveBeenCalledWith('/repo', 's-cleared', '继续排查构建失败');
  });
});
