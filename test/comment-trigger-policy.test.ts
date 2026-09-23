import { afterEach, expect, it, vi } from 'vitest';
import type { CommentEvent } from '@larksuiteoapi/node-sdk';
import type { AppConfig } from '../src/config/schema';
import { canTriggerComment, getCommentTriggerPolicy, isAdmin } from '../src/config/schema';
import { buildCommentSettingsCard, DM } from '../src/card/dm-cards';
vi.mock('../src/config/store', () => ({ saveConfig: vi.fn(async () => undefined) }));
vi.mock('../src/agent', async importOriginal => ({ ...await importOriginal<typeof import('../src/agent')>(), createBackend: () => ({ id: 'codex-appserver', listModels: async () => [] }) }));
vi.mock('../src/bot/comments', async importOriginal => ({ ...await importOriginal<typeof import('../src/bot/comments')>(), resolveComment: vi.fn(async () => undefined) }));
import { createOrchestrator } from '../src/bot/handle-message';
import { resolveComment } from '../src/bot/comments';
import { saveConfig } from '../src/config/store';
const workers: ReturnType<typeof createOrchestrator>[] = [];
afterEach(async () => { await Promise.all(workers.splice(0).map(w => w.shutdown())); vi.clearAllMocks(); });
function config(): AppConfig {
  return { accounts: { app: { id: 'test', secret: 'test', tenant: 'feishu' } }, preferences: { access: { ownerOpenId: 'owner', admins: ['admin'] }, comments: { model: 'retained-model' } } };
}
function setup(cfg: AppConfig) {
  const w = createOrchestrator({ updateCard: vi.fn(async () => undefined) } as never, cfg, '/tmp'); workers.push(w); return w;
}
const event = (id: string, who = 'external', mentionedBot = true) => ({ fileToken: 'doc', fileType: 'docx', commentId: id, operator: { openId: who }, mentionedBot, timestamp: 0 }) as CommentEvent;
it('defaults and invalid config restrict triggers to admins; any mention never grants admin privileges', () => {
  const cfg = config();
  expect(getCommentTriggerPolicy(cfg)).toBe('admin_mention');
  for (const id of ['owner', 'admin']) expect(canTriggerComment(cfg, id, true)).toBe(true);
  expect(canTriggerComment(cfg, 'external', true)).toBe(false);
  cfg.preferences!.comments!.triggerPolicy = 'bad' as never;
  expect(canTriggerComment(cfg, 'external', true)).toBe(false);
  cfg.preferences!.comments!.triggerPolicy = 'any_mention';
  expect(canTriggerComment(cfg, 'external', true)).toBe(true);
  expect(isAdmin(cfg, 'external')).toBe(false);
  expect(canTriggerComment(cfg, '', true)).toBe(false);
  expect(canTriggerComment(cfg, 'external', false)).toBe(false);
});
it('routes external mentions only while enabled, still rejects missing identities, missing mentions and unsupported documents', async () => {
  const cfg = config(), w = setup(cfg);
  await w.onComment(event('blocked'));
  expect(resolveComment).not.toHaveBeenCalled();
  cfg.preferences!.comments!.triggerPolicy = 'any_mention';
  await w.onComment(event('allowed'));
  expect(resolveComment).toHaveBeenCalledTimes(1);
  await w.onComment(event('unmentioned', 'external', false));
  await w.onComment(event('anonymous', ''));
  await w.onComment({ ...event('missing'), operator: undefined } as never);
  await w.onComment({ ...event('unsupported'), fileType: 'unknown' } as never);
  expect(resolveComment).toHaveBeenCalledTimes(1);
  cfg.preferences!.comments!.triggerPolicy = 'admin_mention';
  await w.onComment(event('revoked'));
  expect(resolveComment).toHaveBeenCalledTimes(1);
  await w.onComment(event('owner', 'owner'));
  expect(resolveComment).toHaveBeenCalledTimes(2);
});
it('only an admin may change the policy and saves preserve other comment preferences', async () => {
  const cfg = config(), w = setup(cfg);
  const click = (who: string, value: string) => w.dispatcher.handle({ chatId: who, messageId: 'card', operator: { openId: who }, action: { tag: 'button', value: { a: DM.commentTriggerPolicy, v: value } } } as never);
  await click('external', 'any_mention'); await click('owner', 'invalid');
  expect(saveConfig).not.toHaveBeenCalled();
  await click('owner', 'any_mention');
  await vi.waitFor(() => expect(cfg.preferences!.comments!.triggerPolicy).toBe('any_mention'));
  expect(saveConfig).toHaveBeenCalled();
  expect(cfg.preferences!.comments!.model).toBe('retained-model');
  await click('owner', 'admin_mention');
  await vi.waitFor(() => expect(cfg.preferences!.comments!.triggerPolicy).toBe('admin_mention'));
});
it('offers both global policies even if no models are available', () => {
  const card = JSON.stringify(buildCommentSettingsCard(config(), [], []));
  expect(card).toContain('文档评论触发策略（全局）');
  expect(card).toContain('admin_mention'); expect(card).toContain('any_mention');
  expect(card).toContain('文档修改能力');
});

it('leaves the current trigger policy unchanged when persistence fails', async () => {
  const cfg = config(), w = setup(cfg);
  vi.mocked(saveConfig).mockRejectedValueOnce(new Error('disk full'));
  await w.dispatcher.handle({ chatId: 'owner', messageId: 'card', operator: { openId: 'owner' }, action: { tag: 'button', value: { a: DM.commentTriggerPolicy, v: 'any_mention' } } } as never);
  await vi.waitFor(() => expect(saveConfig).toHaveBeenCalled());
  expect(getCommentTriggerPolicy(cfg)).toBe('admin_mention');
});
