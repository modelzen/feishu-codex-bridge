import type { ModelInfo, ReasoningEffort } from '../types';

const GRADED_EFFORTS: ReasoningEffort[] = ['none', 'low', 'high', 'max'];
const TOGGLE_EFFORTS: ReasoningEffort[] = ['none', 'high'];

export const DSH_MODELS: readonly ModelInfo[] = [
  {
    id: 'moonshotai-cn/kimi-k3',
    displayName: 'Kimi K3',
    description: 'Moonshot AI China · 1M context · graded reasoning',
    supportedEfforts: [...GRADED_EFFORTS],
    defaultEffort: 'high',
    isDefault: true,
    hidden: false,
  },
  {
    id: 'moonshotai-cn/kimi-k2.7-code',
    displayName: 'Kimi K2.7 Code',
    description: 'Moonshot AI China · coding model · reasoning on/off',
    supportedEfforts: [...TOGGLE_EFFORTS],
    defaultEffort: 'high',
    isDefault: false,
    hidden: false,
  },
  {
    id: 'zai-coding-cn/glm-5.2',
    displayName: 'GLM-5.2',
    description: 'Z.AI Coding China · 1M context · graded reasoning',
    supportedEfforts: [...GRADED_EFFORTS],
    defaultEffort: 'high',
    isDefault: false,
    hidden: false,
  },
  {
    id: 'zai-coding-cn/glm-5.1',
    displayName: 'GLM-5.1',
    description: 'Z.AI Coding China · graded reasoning',
    supportedEfforts: [...GRADED_EFFORTS],
    defaultEffort: 'high',
    isDefault: false,
    hidden: false,
  },
  {
    id: 'minimax/MiniMax-M3',
    displayName: 'MiniMax M3',
    description: 'MiniMax · 1M context · reasoning on/off',
    supportedEfforts: [...TOGGLE_EFFORTS],
    defaultEffort: 'high',
    isDefault: false,
    hidden: false,
  },
  {
    id: 'minimax/MiniMax-M2.7',
    displayName: 'MiniMax M2.7',
    description: 'MiniMax · coding model · reasoning on/off',
    supportedEfforts: [...TOGGLE_EFFORTS],
    defaultEffort: 'high',
    isDefault: false,
    hidden: false,
  },
  {
    id: 'deepseek/deepseek-v4-flash',
    displayName: 'DeepSeek V4 Flash',
    description: 'DeepSeek · fast coding model · graded reasoning',
    supportedEfforts: [...GRADED_EFFORTS],
    defaultEffort: 'high',
    isDefault: false,
    hidden: false,
  },
  {
    id: 'deepseek/deepseek-v4-pro',
    displayName: 'DeepSeek V4 Pro',
    description: 'DeepSeek · flagship coding model · graded reasoning',
    supportedEfforts: [...GRADED_EFFORTS],
    defaultEffort: 'high',
    isDefault: false,
    hidden: false,
  },
];

export interface DshRoute {
  provider: string;
  model: string;
}

export function dshRoute(id: string): DshRoute {
  const separator = id.indexOf('/');
  if (separator <= 0 || separator === id.length - 1) {
    throw new Error(`无效 DSH 模型路由「${id}」（应为 provider/model）`);
  }
  return { provider: id.slice(0, separator), model: id.slice(separator + 1) };
}

export function toDshEffort(effort: ReasoningEffort): 'off' | 'low' | 'high' | 'max' {
  if (effort === 'none') return 'off';
  if (effort === 'low' || effort === 'high' || effort === 'max') return effort;
  throw new Error(`DSH 不支持推理强度「${effort}」`);
}

export function resolveDshModel(
  modelId?: string,
  effort?: ReasoningEffort,
): { info: ModelInfo; route: DshRoute; effort: ReasoningEffort; dshEffort: 'off' | 'low' | 'high' | 'max' } {
  const info = modelId
    ? DSH_MODELS.find((model) => model.id === modelId)
    : DSH_MODELS.find((model) => model.isDefault);
  if (!info) throw new Error(`未知 DSH 模型「${modelId ?? ''}」`);
  const selectedEffort = effort ?? info.defaultEffort;
  if (!info.supportedEfforts.includes(selectedEffort)) {
    throw new Error(
      `DSH 模型「${info.displayName}」不支持推理强度「${selectedEffort}」（可用：${info.supportedEfforts.join('、')}）`,
    );
  }
  return {
    info,
    route: dshRoute(info.id),
    effort: selectedEffort,
    dshEffort: toDshEffort(selectedEffort),
  };
}
