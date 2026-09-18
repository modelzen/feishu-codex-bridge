import { describe, expect, it } from 'vitest';
import {
  buildRuntimeTaskCard,
  parseRuntimeTaskCardAction,
  RUNTIME_TASK_CARD_ACTIONS,
} from '../src/runtime/task-card';

function buttons(node: unknown, acc: Record<string, any>[] = []): Record<string, any>[] {
  if (Array.isArray(node)) node.forEach((item) => buttons(item, acc));
  else if (node && typeof node === 'object') {
    const value = node as Record<string, any>;
    if (value.tag === 'button') acc.push(value);
    for (const item of Object.values(value)) buttons(item, acc);
  }
  return acc;
}

describe('public Runtime task card', () => {
  it('fills the available chat width throughout the task lifecycle', () => {
    for (const status of ['queued', 'running', 'completed'] as const) {
      const card = buildRuntimeTaskCard({
        taskId: `task-width-${status}`,
        status,
        answer: status === 'completed' ? '| 类别 | 说明 |\n| --- | --- |\n| 专项工作 | 证据链复核 |' : '',
        activities: [],
        showActivities: true,
      });

      expect((card.config as { width_mode?: string }).width_mode).toBe('fill');
    }
  });

  it('owns the headerless terminal layout shared by Runtime hosts', () => {
    const card = buildRuntimeTaskCard({
      taskId: 'task-1',
      status: 'completed',
      answer: '最终回答',
      activities: [{ id: 'tool-1', title: 'read', detail: 'README.md', state: 'completed' }],
      showActivities: true,
      model: 'deepseek-v3',
      modelDisplay: 'always',
    }) as { header?: unknown; body: { elements: Record<string, any>[] } };

    expect(card.header).toBeUndefined();
    const process = card.body.elements.find((element) => element.tag === 'collapsible_panel');
    expect(process?.expanded).toBe(false);
    expect(process?.header?.title?.content).toBe('✅ **本轮过程** · 🧰 1 个工具（点击展开）');
    expect(JSON.stringify(card)).toContain('最终回答');
  });

  it('uses one shared action payload and parser for run controls', () => {
    const card = buildRuntimeTaskCard({
      taskId: 'task-2',
      status: 'running',
      answer: '',
      activities: [],
      showActivities: true,
      completionReminder: 'available',
    });
    const values = buttons(card).map((button) => button.behaviors[0].value);

    expect(values.map((value) => value.a)).toEqual([
      RUNTIME_TASK_CARD_ACTIONS.cancel,
      RUNTIME_TASK_CARD_ACTIONS.remind,
    ]);
    expect(parseRuntimeTaskCardAction(values[0])).toEqual({
      action: RUNTIME_TASK_CARD_ACTIONS.cancel,
      taskId: 'task-2',
    });
    expect(parseRuntimeTaskCardAction({ a: 'not-owned', m: 'task-2' })).toBeUndefined();
  });

  it('renders an unknown queue position without inventing a first-place claim', () => {
    const json = JSON.stringify(buildRuntimeTaskCard({
      taskId: 'task-3',
      status: 'queued',
      answer: '',
      activities: [],
      showActivities: true,
    }));

    expect(json).toContain('排队中');
    expect(json).not.toContain('第 **1** 位');
  });
});
