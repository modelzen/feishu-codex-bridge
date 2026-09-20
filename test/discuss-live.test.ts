import { expect, it } from 'vitest';
import { AppServerClient } from '../src/agent/codex-appserver/app-server-client';
import { resolveCodexBin } from '../src/agent/codex-appserver/locate';
import { AUX_CONFIG, createDiscussModel } from '../src/agent/codex-appserver/discuss-runner';
import { tmpdir } from 'node:os';

it.skipIf(process.env.DISCUSS_LIVE !== '1').each(['legacy', 'paginated'] as const)('%s fork inherits ended main context and auxiliary continuation retains it', async historyMode => {
  const client = new AppServerClient({ bin: resolveCodexBin()!, cwd: tmpdir(), clientName: 'discuss-integration-test' });
  const signal = AbortSignal.timeout(55000);
  let id: string | undefined;
  let judge;
  const schema = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false };
  try {
    await client.connect();
    const { thread } = await client.request<{ thread: { id: string; path: string } }>('thread/start', {
      cwd: tmpdir(), model: 'gpt-5.6-luna', approvalPolicy: 'never', sandbox: 'read-only', config: AUX_CONFIG, historyMode,
      baseInstructions: 'This is an isolated integration test. Return the requested JSON, use no tools.',
    }); id = thread.id;
    const { turn } = await client.request<{ turn: { id: string } }>('turn/start', { threadId: id, model: 'gpt-5.6-luna', effort: 'low', input: [{ type: 'text', text: 'Remember test marker orchid-742. Return {"answer":"stored"}.', text_elements: [] }], outputSchema: schema });
    for await (const n of client.stream()) { if (n.method === 'turn/completed' && n.params.turn.id === turn.id) { expect(n.params.turn.status).toBe('completed'); break; } }
    const { thread: meta } = await client.request<{ thread: { path: string } }>('thread/read', { threadId: id, includeTurns: false });
    const source = { path: meta.path, lastTurnId: turn.id };

    expect(source.lastTurnId).toBe(turn.id);
    judge = await createDiscussModel({ model: 'gpt-5.6-luna', effort: 'low', instructions: 'You are a read-only test observer. Use inherited context only as reference. Return requested JSON, never use tools.', sourceId: id, sourcePath: source.path, lastTurnId: source.lastTurnId }, signal);
    expect(JSON.parse(await judge.ask('What was the test marker in the inherited context? Return it as answer.', schema, signal)).answer).toContain('orchid-742');
    expect(JSON.parse(await judge.ask('Return the same marker again as answer.', schema, signal)).answer).toContain('orchid-742');
  } finally {
    await judge?.close();
    if (id) await client.request('thread/archive', { threadId: id }).catch(() => undefined);
    await client.close(100);
  }
}, 60000);


it.skipIf(process.env.DISCUSS_LIVE !== '1')('persistent Luna updates its summary with a correction in the next batch', async () => {
  const { LUNA_PROMPT, SUMMARY_SCHEMA } = await import('../src/bot/discuss');
  const signal = AbortSignal.timeout(55000);
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const storageRoot = await mkdtemp(join(tmpdir(), 'discuss-luna-resume-'));
  const options = { model: 'gpt-5.6-luna', effort: 'low' as const, instructions: LUNA_PROMPT, storageRoot };
  let luna = await createDiscussModel(options, signal);
  try {
    const first = await luna.ask(JSON.stringify({ messages: [{ messageId: 'first', text: '项目验收定于周五。' }] }), SUMMARY_SCHEMA, signal);
    const resumeId = luna.sessionId;
    await luna.close();
    luna = await createDiscussModel({ ...options, resumeId }, signal);
    expect(luna.sessionId).toBe(resumeId);
    const second = JSON.parse(await luna.ask(JSON.stringify({ previous: first, messages: [{ messageId: 'correction', text: '更正：验收改到下周一，取消周五安排。' }] }), SUMMARY_SCHEMA, signal));
    const rows = Object.values(second).flat() as { text: string; messageIds: string[] }[];
    expect(rows.some(row => row.messageIds.includes('correction') && row.text.includes('周一'))).toBe(true);
  } finally { await luna.close(); await rm(storageRoot, { recursive: true, force: true }); }
}, 60000);


it.skipIf(process.env.DISCUSS_CONFIRMATION_LIVE !== '1').each([
  { runId: null, answer: 'FOLLOW_UP' },
  { runId: 'running-turn', answer: 'STEER' },
])('routes a pending confirmation with runId=$runId', async ({ runId, answer }) => {
  const { JUDGE_PROMPT, JUDGE_SCHEMA } = await import('../src/bot/discuss');
  const signal = AbortSignal.timeout(110000);
  const judge = await createDiscussModel({ model: 'gpt-6-astra', effort: 'low', instructions: JUDGE_PROMPT }, signal);
  try {
    const result = JSON.parse(await judge.ask(JSON.stringify({
      hostId: 'confirmation-test', runId, busy: runId !== null,
      recent: [{ role: 'assistant', content: '已在过程消息中用 Markdown 引用图片，等待你确认是否可见。' }],
      messages: [{ messageId: 'confirmation', content: '很好没问题' }],
    }), JUDGE_SCHEMA, signal));
    expect(result.decisions).toEqual([expect.objectContaining({ messageId: 'confirmation', action: answer })]);
    const courtesy = JSON.parse(await judge.ask(JSON.stringify({
      hostId: 'courtesy-test', runId: null, busy: false,
      recent: [{ role: 'assistant', content: '任务已完成，验收已通过，没有待确认事项。' }],
      messages: [{ messageId: 'thanks', content: '谢谢' }],
    }), JUDGE_SCHEMA, signal));
    expect(courtesy.decisions).toEqual([expect.objectContaining({ messageId: 'thanks', action: 'IGNORE' })]);
  } finally { await judge.close(); }
}, 120000);
