import { afterAll, expect, it, vi } from 'vitest';
import { rm } from 'node:fs/promises';
import type { AgentBackend, AgentEvent } from '../src/agent/types';
import type { AppConfig } from '../src/config/schema';
import { paths } from '../src/config/paths';
import { getSession } from '../src/bot/session-store';
import { createOrchestrator } from '../src/bot/handle-message';

vi.mock('../src/config/paths', async () => {
  const { mkdtempSync } = await import('node:fs'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const appDir = mkdtempSync(join(tmpdir(), 'comment-settings-runtime-'));
  return { paths: { appDir, sessionsFile: join(appDir, 'sessions.json'), projectsFile: join(appDir, 'projects.json'), commentInstructionsFile: join(appDir, 'instructions.md'), commentsRootDir: join(appDir, 'comments'), projectsRootDir: join(appDir, 'projects') } };
});
const fixture = vi.hoisted(() => ({ backends: new Map<string, unknown>(), replies: 0 }));
vi.mock('../src/agent', async original => ({ ...await original<object>(), createBackend: (id = 'codex-appserver') => fixture.backends.get(id) }));
vi.mock('../src/core/logger', () => ({ log: { info() {}, warn() {}, fail() {} }, withTrace: (_context: unknown, callback: () => unknown) => callback() }));
vi.mock('../src/bot/comments', async original => ({
  ...await original<object>(),
  resolveComment: async () => ({ target: { fileType: 'docx', fileToken: 'fixture-doc' }, ctx: { question: 'fixture question', isWhole: true, targetReplyId: undefined } }),
  postCommentReply: async () => { fixture.replies++; },
}));
function backend(id: string) {
  let next = 0;
  const threads: ReturnType<typeof thread>[] = [];
  function thread(sessionId: string) {
    return { sessionId, isAlive: () => true, close: vi.fn(async () => {}), runStreamed: vi.fn(() => ({ turnId: () => 'turn', events: (async function* (): AsyncGenerator<AgentEvent> { yield { type: 'done', turnId: 'turn' }; })() })) };
  }
  const result = {
    id, displayName: id,
    listModels: async () => ['one', 'two'].map(model => ({ id: model, displayName: model, description: '', supportedEfforts: ['low', 'high'], defaultEffort: 'low', isDefault: model === 'one', hidden: false })),
    startThread: vi.fn(async () => { const t = thread(`${id}-${++next}`); threads.push(t); return t; }),
    resumeThread: vi.fn(async (input: { sessionId: string }) => { const t = thread(input.sessionId); threads.push(t); return t; }),
  };
  fixture.backends.set(id, result as unknown as AgentBackend);
  return { ...result, threads };
}
afterAll(() => rm(paths.appDir, { recursive: true, force: true }));
it('the next comment applies model changes to the same native session and backend changes to a new session', async () => {
  const codex = backend('codex-appserver'); const claude = backend('claude-agent');
  const cfg: AppConfig = { accounts: { app: { id: 'cli_fixture', secret: 'fixture', tenant: 'feishu' } }, preferences: { access: { ownerOpenId: 'ou_owner' }, comments: { backend: 'codex-appserver', model: 'one', effort: 'low' } } };
  const orchestrator = createOrchestrator({} as never, cfg, paths.appDir);
  const event = (replyId: string) => ({ fileType: 'docx', fileToken: 'fixture-doc', commentId: 'comment', replyId, mentionedBot: true, operator: { openId: 'ou_owner' } });
  try {
    await orchestrator.onComment(event('one') as never);
    const original = await getSession('doc:fixture-doc:comment');
    expect(original).toMatchObject({ backend: 'codex-appserver', model: 'one', effort: 'low' });
    cfg.preferences!.comments = { backend: 'codex-appserver', model: 'two', effort: 'high' };
    await orchestrator.onComment(event('two') as never);
    expect(codex.threads[0]!.close).toHaveBeenCalledOnce();
    expect(codex.resumeThread).toHaveBeenCalledWith(expect.objectContaining({ sessionId: original!.sessionId, model: 'two', effort: 'high' }));
    expect(await getSession('doc:fixture-doc:comment')).toMatchObject({ sessionId: original!.sessionId, model: 'two', effort: 'high' });
    cfg.preferences!.comments = { backend: 'claude-agent', model: 'one', effort: 'low' };
    await orchestrator.onComment(event('three') as never);
    expect(claude.startThread).toHaveBeenCalledOnce();
    expect(await getSession('doc:fixture-doc:comment')).toMatchObject({ backend: 'claude-agent', model: 'one' });
    expect(fixture.replies).toBe(3);
  } finally { await orchestrator.shutdown(); }
});
