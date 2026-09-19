import { describe, expect, it } from 'vitest';
import { buildModelCard, reasoningEffortLabel, type ModelCardState } from '../src/card/command-cards';
import type { ModelInfo } from '../src/agent/types';

// /model 卡按「当前模型能力」自适应（对齐 Codex 的诚实体验）：
//  - effort 下拉只在当前模型真有 supportedEfforts 时出现（修旧版「空 effort 回退假
//    low/medium/high」→ 没有 effort 档的模型显示点了没用的 effort 下拉）。
//  - 模型下拉只在有多个可见模型时出现。
//  - 都不可调（单模型 + 无 effort）→ 信息卡 + 明确「不支持在此切换」。
// 这些都是按 ModelInfo 能力派生的通用分支，用 codex 形态的 fixture 覆盖（codex 是
// 现在唯一后端，但同一张卡仍按能力自适应）。

const model = (over: Partial<ModelInfo> & Pick<ModelInfo, 'id' | 'displayName'>): ModelInfo => ({
  description: '',
  supportedEfforts: [],
  defaultEffort: 'medium',
  isDefault: false,
  hidden: false,
  ...over,
});

const state = (models: ModelInfo[], cur: string): ModelCardState => ({
  chatId: 'c',
  threadId: 't',
  requesterOpenId: 'u',
  models,
  model: cur,
  effort: 'medium',
  createdAt: 0,
});

// 多模型 + 真 effort（codex 的常态）。
const codex = [
  model({
    id: 'gpt-5.6-sol',
    displayName: 'GPT-5.6-Sol',
    supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    isDefault: true,
  }),
  model({ id: 'gpt-5-codex', displayName: 'GPT-5 Codex', supportedEfforts: ['low', 'medium', 'high'] }),
];
// 多模型但当前模型无 effort 档 → 有模型下拉、无 effort 下拉。
const multiNoEffort = [
  model({ id: 'm1', displayName: '模型一', isDefault: true }),
  model({ id: 'm2', displayName: '模型二' }),
];
// 单模型 + 无 effort → 既不能切模型也不能调 effort。
const singleNoEffort = [model({ id: 'only', displayName: '唯一模型', isDefault: true })];

const json = (s: ModelCardState): string => JSON.stringify(buildModelCard(s));

describe('buildModelCard · 按当前模型能力自适应', () => {
  it('多模型 + 真 effort（codex）→ 模型下拉 + effort 下拉都在', () => {
    const j = json(state(codex, 'gpt-5.6-sol'));
    expect(j).toContain('model.set'); // 模型下拉
    expect(j).toContain('model.effort'); // effort 下拉
    expect(j).toContain('effort：中');
    expect(j).toContain('effort：最高');
    expect(j).toContain('effort：超强');
    expect(j).not.toContain('undefined');
  });

  it('未知的新 effort 档回退显示原始值，不显示 undefined', () => {
    expect(reasoningEffortLabel('future-tier')).toBe('future-tier');
  });

  it('多模型，当前模型无 effort 档 → 有模型下拉，无 effort 下拉，有说明', () => {
    const j = json(state(multiNoEffort, 'm1'));
    expect(j).toContain('model.set'); // 仍可切模型
    expect(j).not.toContain('model.effort'); // 不再有假 effort 下拉
    expect(j).not.toContain('effort：'); // 不出现 effort 选项
    expect(j).toContain('不调节推理强度'); // 给出说明
  });

  it('单模型，无 effort → 无任何下拉，信息卡 + 不支持说明', () => {
    const j = json(state(singleNoEffort, 'only'));
    expect(j).not.toContain('model.set');
    expect(j).not.toContain('model.effort');
    expect(j).toContain('唯一模型'); // 当前模型以文字呈现
    expect(j).toContain('不支持在此切换'); // 明确说明
  });

  it('hidden 模型不计入「是否多模型」', () => {
    const oneVisible = [
      model({ id: 'a', displayName: 'A', isDefault: true }),
      model({ id: 'b', displayName: 'B', hidden: true }),
    ];
    const j = json(state(oneVisible, 'a'));
    expect(j).not.toContain('model.set'); // 只有 1 个可见 → 不给模型下拉
  });
});


describe('/model Fast', () => {
  it.each([true, false, undefined])('echoes stored Fast %s', fastMode => {
    const j = json({ ...state(codex, 'gpt-5.6-sol'), backend: 'codex-appserver', fastMode });
    expect(j).toContain('model.fast');
    expect(j).toContain(`"initial_option":"${fastMode === undefined ? 'default' : fastMode ? 'on' : 'off'}"`);
    expect(j).toContain('用量消耗');
  });
  it('hides Fast on other backends', () => {
    expect(json({ ...state(multiNoEffort, 'm1'), backend: 'claude-agent' })).not.toContain('model.fast');
  });
});
