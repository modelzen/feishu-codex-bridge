import { describe, expect, it } from 'vitest';
import { pickDefault } from '../src/bot/handle-message';
import { buildModelDefaultCard, modelDefaultSummary } from '../src/card/dm-cards';
import type { ModelInfo } from '../src/agent/types';

// 项目级「新话题默认模型 / 推理强度」。两条不变量：
//  ① pickDefault：项目默认（prefer）只在对**实时**模型列表仍有效时生效；陈旧 / 跨后端 /
//     不支持的 effort 一律被忽略并回落后端 isDefault —— 默认值自愈，永不把坏 id 喂给 CLI。
//  ② buildModelDefaultCard：按后端能力自适应（多模型才给模型下拉、有 effort 档才给强度下拉），
//     ctx 决定提交 / 返回的 action（dm = 项目设置卡；group = 群 /settings 卡）。

const model = (over: Partial<ModelInfo> & Pick<ModelInfo, 'id' | 'displayName'>): ModelInfo => ({
  description: '',
  supportedEfforts: [],
  defaultEffort: 'medium',
  isDefault: false,
  hidden: false,
  ...over,
});

// codex 形态：多模型 + 真 effort 档。
const codex = [
  model({ id: 'gpt-5.5', displayName: 'GPT-5.5', supportedEfforts: ['low', 'medium', 'high'], isDefault: true }),
  model({ id: 'gpt-5-codex', displayName: 'GPT-5 Codex', supportedEfforts: ['low', 'medium', 'high'], defaultEffort: 'high' }),
  model({
    id: 'gpt-5.6-sol',
    displayName: 'GPT-5.6-Sol',
    supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  }),
];
// claude 形态：多模型但都不调 effort（supportedEfforts 空），各自 defaultEffort 不同。
const claude = [
  model({ id: 'opus', displayName: 'Opus', defaultEffort: 'high', isDefault: true }),
  model({ id: 'sonnet', displayName: 'Sonnet', defaultEffort: 'medium' }),
];

describe('pickDefault · 项目默认对实时列表自愈校验', () => {
  it('无 prefer → 后端 isDefault 模型 + 其 defaultEffort', () => {
    expect(pickDefault(codex)).toEqual({ model: 'gpt-5.5', effort: 'medium' });
  });

  it('有效 prefer（模型在列表、effort 受支持）→ 原样生效', () => {
    expect(pickDefault(codex, { model: 'gpt-5-codex', effort: 'high' })).toEqual({
      model: 'gpt-5-codex',
      effort: 'high',
    });
  });

  it('prefer 模型有效但 effort 不被该模型支持 → 收窄到该模型 defaultEffort', () => {
    // gpt-5-codex 支持 low/medium/high，prefer 一个不支持的 'xhigh' → 回落它的 defaultEffort 'high'
    expect(pickDefault(codex, { model: 'gpt-5-codex', effort: 'xhigh' })).toEqual({
      model: 'gpt-5-codex',
      effort: 'high',
    });
  });

  it('prefer 模型不在列表（下架 / 跨后端坏 id）→ 忽略 prefer，回落后端 isDefault', () => {
    // 把 codex id 喂给 claude 列表：模型不在 → 完全忽略（含 effort），回落 opus + 其 defaultEffort
    expect(pickDefault(claude, { model: 'gpt-5.5', effort: 'high' })).toEqual({ model: 'opus', effort: 'high' });
  });

  it('prefer 模型被 hidden → 视为不可用，回落 isDefault', () => {
    const withHidden = [
      model({ id: 'a', displayName: 'A', supportedEfforts: ['low', 'high'], defaultEffort: 'low', isDefault: true }),
      model({ id: 'b', displayName: 'B', supportedEfforts: ['low', 'high'], hidden: true }),
    ];
    // 'b' hidden → ignored; fall back to 'a' and use 'a's OWN defaultEffort (not prefer's 'high').
    expect(pickDefault(withHidden, { model: 'b', effort: 'high' })).toEqual({ model: 'a', effort: 'low' });
  });

  it('claude（无 effort 档）→ prefer.effort 被忽略，用所选模型的 defaultEffort', () => {
    expect(pickDefault(claude, { model: 'sonnet', effort: 'high' })).toEqual({ model: 'sonnet', effort: 'medium' });
  });

  it('空列表 → 兜底常量，不抛错', () => {
    expect(pickDefault([])).toEqual({ model: 'gpt-5.5', effort: 'medium' });
  });
});

const json = (...args: Parameters<typeof buildModelDefaultCard>): string => JSON.stringify(buildModelDefaultCard(...args));

describe('buildModelDefaultCard · 按后端能力自适应 + ctx 路由', () => {
  it('codex（多模型 + effort）→ 模型下拉 + 强度下拉，dm 提交/返回 action', () => {
    const j = json({ name: 'p' }, codex, 'dm');
    expect(j).toContain('model'); // 模型 selectMenu name
    expect(j).toContain('强度：'); // effort 选项
    expect(j).toContain('强度：最高');
    expect(j).toContain('强度：超强');
    expect(j).not.toContain('undefined');
    expect(j).toContain('dm.proj.modelDefault.submit'); // dm 提交
    expect(j).toContain('dm.projectSettings'); // dm 返回
    expect(j).not.toContain('gs.modelDefault'); // 不串到群入口
  });

  it('claude（无 effort 档）→ 有模型下拉、无强度下拉 + 说明', () => {
    const j = json({ name: 'p', backend: 'claude-agent' }, claude, 'dm');
    expect(j).toContain('Opus');
    expect(j).not.toContain('强度：'); // 不出现假 effort 档
    expect(j).toContain('不调节推理强度');
  });

  it('单模型 + 无 effort → 信息卡，无表单提交', () => {
    const single = [model({ id: 'only', displayName: '唯一模型', isDefault: true })];
    const j = json({ name: 'p', backend: 'claude-agent' }, single, 'dm');
    expect(j).toContain('唯一模型');
    expect(j).toContain('无需设置默认');
    expect(j).not.toContain('dm.proj.modelDefault.submit');
  });

  it('ctx=group → 群入口的提交/返回 action', () => {
    const j = json({ name: 'p' }, codex, 'group');
    expect(j).toContain('gs.modelDefault.submit'); // 群提交
    expect(j).toContain('gs.settings'); // 群返回
    expect(j).not.toContain('dm.proj.modelDefault.submit');
  });

  it('已设的有效默认 → 作为下拉初值回显', () => {
    const j = json({ name: 'p', defaultModel: 'gpt-5-codex', defaultEffort: 'high' }, codex, 'dm');
    expect(j).toContain('gpt-5-codex');
  });
});

describe('modelDefaultSummary', () => {
  it('未设 → 后端默认', () => {
    expect(modelDefaultSummary({})).toContain('后端默认');
  });

  it('已设模型 + 强度 → 显示 id 与中文强度档', () => {
    const s = modelDefaultSummary({ defaultModel: 'gpt-5.5', defaultEffort: 'high' });
    expect(s).toContain('gpt-5.5');
    expect(s).toContain('高'); // EFFORT_LABEL.high
  });
});


describe('Fast defaults', () => {
  it.each(['dm', 'group'] as const)('renders and echoes Fast in %s settings', ctx => {
    const j = json({ name: 'p', defaultFastMode: true }, codex, ctx);
    expect(j).toContain('"name":"fastMode"');
    expect(j).toContain('"initial_option":"on"');
    expect(j).toContain('用量消耗');
    expect(json({ name: 'p', defaultFastMode: false }, codex, ctx)).toContain('"initial_option":"off"');
  });
  it('offers Fast even for a single Codex model without effort', () => {
    const j = json({ name: 'p' }, [model({ id: 'only', displayName: 'Only' })], 'dm');
    expect(j).toContain('"name":"fastMode"');
    expect(j).toContain('dm.proj.modelDefault.submit');
  });
  it('does not offer Codex Fast for Claude', () => {
    expect(json({ name: 'p', backend: 'claude-agent' }, claude, 'dm')).not.toContain('"name":"fastMode"');
  });
  it('summarizes explicit on and off while keeping unconfigured defaults neutral', () => {
    expect(modelDefaultSummary({ defaultFastMode: true })).toContain('Fast 开启');
    expect(modelDefaultSummary({ defaultFastMode: false })).toContain('Fast 关闭');
    expect(modelDefaultSummary({})).not.toContain('Fast');
  });
});


it('keeps a separate Fast-only form and always offers inherited settings', () => {
  const j = json({ name: 'p', defaultFastMode: true }, [], 'dm');
  expect(j).toContain('"name":"fast_default"');
  expect(j).not.toContain('"name":"model_default"');
  expect(j).toContain('沿用 Codex 设置');
  expect(j).toContain('"value":"default"');
  expect(modelDefaultSummary({ defaultFastMode: null })).not.toContain('Fast 关闭');
});
