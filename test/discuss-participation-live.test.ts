import { expect, it } from 'vitest';
import { createDiscussModel } from '../src/agent/codex-appserver/discuss-runner';
import { JUDGE_PROMPT, JUDGE_SCHEMA } from '../src/bot/discuss';

// Opt-in behavioral checks against the real judge, not string matching the prompt.
const cases = [
  { name: 'unanswered question without mention', runId: null, recent: '群成员正在排查 TypeScript 构建错误，还没有人提供解决方法。', content: 'TS2307 Cannot find module lodash，这个错误怎么解决？', action: 'FOLLOW_UP' },
  { name: 'evidence-backed correction', runId: null, recent: '已核验的验收记录：本批次总数 1000 件，不良 100 件。', content: '那就按良率 99% 填入本次验收结论。', action: 'FOLLOW_UP' },
  { name: 'already answered', runId: null, recent: '甲问会议几点。乙回答今天下午三点，会议通知也写三点。机器人没有待办或待确认事项。', content: '明白了，下午三点见。', action: 'IGNORE' },
  { name: 'ordinary human exchange', runId: null, recent: '甲和乙正在商量午饭，机器人没有任务。', content: '那我们去楼下吃面吧。', action: 'IGNORE' },
  { name: 'pending acceptance beats silence', runId: null, recent: 'assistant：图片已修好，请确认现在能否看见。', content: '很好没问题', action: 'FOLLOW_UP' },
  { name: 'stop active task beats silence', runId: 'running-turn', recent: 'assistant 正在生成用户要求的报告，当前任务尚未结束。', content: '先停一下，别继续生成报告了。', action: 'STEER' },
] as const;

it.skipIf(process.env.DISCUSS_PARTICIPATION_LIVE !== '1').each(cases)('$name', async scenario => {
  const signal = AbortSignal.timeout(110000);
  const judge = await createDiscussModel({ model: 'gpt-6-astra', effort: 'low', instructions: JUDGE_PROMPT }, signal);
  try {
    const input = {
      hostId: 'participation-test', runId: scenario.runId, busy: scenario.runId !== null,
      recent: [{ messageId: 'context', role: 'user', content: scenario.recent }],
      messages: [{ messageId: 'candidate', content: scenario.content }],
    };
    const raw = await judge.ask(JSON.stringify(input), JUDGE_SCHEMA, signal);
    const result = JSON.parse(raw);
    expect(result.hostId).toBe(input.hostId);
    expect(result.runId).toBe(input.runId);
    expect(result.decisions).toEqual([expect.objectContaining({ messageId: 'candidate', action: scenario.action })]);
    expect(result.lookup).toBeNull();
  } finally { await judge.close(); }
}, 120000);
