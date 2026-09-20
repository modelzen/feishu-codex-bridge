import { expect, it } from 'vitest';
import { createBriefingModel } from '../src/agent/codex-appserver/briefing-runner';
import { BRIEFING_SCHEMA } from '../src/bot/context-briefing';
import { createLarkChannel } from '@larksuiteoapi/node-sdk';
import { loadConfig } from '../src/config/store';
import { resolveAppSecret } from '../src/config/secret-resolver';
import type { AppConfig } from '../src/config/schema';
import { ChatHistory } from '../src/bot/briefing-history';

// Explicit opt-in: exercises the real authenticated runtime without sending any
// Feishu messages or granting the auxiliary model task-execution tools.
it.skipIf(process.env.BRIEFING_LIVE !== '1')('Luna returns a question-conditioned, cited briefing in its isolated runtime', async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  const start = Date.now();
  let runner;
  try {
    runner = await createBriefingModel('gpt-5.6-luna', controller.signal);
    const response = await runner.ask(JSON.stringify({ question: { messageId: 'q', text: '目前究竟验收了吗？' }, remainingLookups: 0,
      messages: [
        { messageId: 'a', senderName: '张三', senderId: 'u1', text: '昨天建议周五验收，尚未确定。' },
        { messageId: 'b', senderName: '李四', senderId: 'u2', text: '今天报告修好了，但是还没验收。' },
        { messageId: 'c', senderName: '张三', senderId: 'u1', text: '验收延期到下周一。' },
      ] }), BRIEFING_SCHEMA, controller.signal);
    const parsed = JSON.parse(response);
    expect(parsed.recentEvents.length + parsed.relevantBackground.length).toBeGreaterThan(0);
    expect(parsed.usefulMessages.some((m: { messageId: string }) => m.messageId === 'b' || m.messageId === 'c')).toBe(true);
    expect(parsed.lookup).toBeNull();
    console.log(JSON.stringify({ model: 'gpt-5.6-luna', elapsedMs: Date.now() - start, citedIds: parsed.usefulMessages.map((m: { messageId: string }) => m.messageId) }));
  } finally { clearTimeout(timer); await runner?.close(); }
}, 40_000);

it.skipIf(!process.env.BRIEFING_HISTORY_CONFIG || !process.env.BRIEFING_HISTORY_CHAT)(
  'reads real current-group history without sending messages', async () => {
    const cfg = await loadConfig(process.env.BRIEFING_HISTORY_CONFIG) as AppConfig;
    const channel = createLarkChannel({ appId: cfg.accounts.app.id, appSecret: await resolveAppSecret(cfg) });
    const history = new ChatHistory(channel, process.env.BRIEFING_HISTORY_ARCHIVE);
    const cutoff = Date.now();
    const days = Number(process.env.BRIEFING_HISTORY_DAYS || 1);
    const result = await history.recent({ chatId: process.env.BRIEFING_HISTORY_CHAT!, start: cutoff - days * 86400000, cutoff }, AbortSignal.timeout(20_000));
    expect(result.gaps).not.toContain('群历史读取失败');
    expect(result.messages.every(m => m.chatId === process.env.BRIEFING_HISTORY_CHAT)).toBe(true);
    console.log(JSON.stringify({ source: 'live group history', count: result.messages.length,
      named: result.messages.filter(m => m.senderName && m.senderId).length, gaps: result.gaps }));
  }, 30_000);
