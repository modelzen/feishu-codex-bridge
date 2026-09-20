import { expect, it } from 'vitest';
import { participationPolicy } from '../src/project/registry';
import { buildGroupSettingsCard, buildProjectSettingsCard } from '../src/card/dm-cards';
it('migrates legacy policy with Discuss precedence and preserves joined defaults', () => {
  expect(participationPolicy({ discuss: true, noMention: true })).toBe('model');
  expect(participationPolicy({ noMention: true })).toBe('all');
  expect(participationPolicy({ noMention: false })).toBe('mention');
  expect(participationPolicy({ kind: 'single', origin: 'joined' })).toBe('mention');
  expect(participationPolicy({})).toBe('all');
  expect(participationPolicy({ participation: 'mention', discuss: true, noMention: true })).toBe('mention');
});
it('shows a single three-choice participation control on both setting cards', () => {
  const p = { name: 'test', cwd: '/tmp/test', kind: 'single' as const, participation: 'model' as const };
  for (const card of [buildGroupSettingsCard(p), buildProjectSettingsCard(p)]) {
    const text = JSON.stringify(card);
    for (const label of ['AI 参与策略', '回复全部消息', '模型自行决定回复', '只回复被 @ 的消息']) expect(text).toContain(label);
    expect(text).not.toContain('Discuss · 群聊参与判断');
    expect(text).not.toContain('免@（不用 @ 也回复）');
  }
});
