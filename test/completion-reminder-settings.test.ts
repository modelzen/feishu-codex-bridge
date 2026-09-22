import { describe, expect, it } from 'vitest';
import {
  buildCompletionReminderCustomCard,
  buildSettingsCard,
  DM,
} from '../src/card/dm-cards';
import {
  COMPLETION_REMINDER_LONG_TASK_DEFAULT_MINUTES,
  COMPLETION_REMINDER_LONG_TASK_MAX_MINUTES,
  COMPLETION_REMINDER_LONG_TASK_MIN_MINUTES,
  getCompletionReminderConfig,
  shouldSendCompletionReminder,
  shouldShowCompletionReminderButton,
  type AppConfig,
  type CompletionReminderConfig,
} from '../src/config/schema';

function cfg(completionReminder?: CompletionReminderConfig): AppConfig {
  return {
    accounts: { app: { id: 'cli_app', secret: 'secret', tenant: 'feishu' } },
    preferences: { completionReminder },
  };
}

function records(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.flatMap(records);
  if (!value || typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  return [record, ...Object.values(record).flatMap(records)];
}

function actionId(element: Record<string, unknown>): string | undefined {
  const behaviors = element.behaviors;
  if (!Array.isArray(behaviors)) return undefined;
  for (const behavior of behaviors) {
    if (!behavior || typeof behavior !== 'object') continue;
    const value = (behavior as { value?: unknown }).value;
    if (value && typeof value === 'object' && typeof (value as { a?: unknown }).a === 'string') {
      return (value as { a: string }).a;
    }
  }
  return undefined;
}

function buttonsFor(card: unknown, action: string): Record<string, unknown>[] {
  return records(card).filter((element) => element.tag === 'button' && actionId(element) === action);
}

function buttonLabel(button: Record<string, unknown>): string | undefined {
  const text = button.text;
  return text && typeof text === 'object' ? String((text as { content?: unknown }).content ?? '') : undefined;
}

describe('ordinary task completion reminder config', () => {
  it('defaults to failures with a 3-minute long-task threshold', () => {
    expect(getCompletionReminderConfig(cfg())).toEqual({
      mode: 'failures',
      longTaskMinutes: COMPLETION_REMINDER_LONG_TASK_DEFAULT_MINUTES,
    });
    expect(shouldShowCompletionReminderButton(cfg())).toBe(false);
  });

  it('accepts all four modes and only exposes the per-run button in manual mode', () => {
    for (const mode of ['manual', 'long', 'failures', 'always'] as const) {
      expect(getCompletionReminderConfig(cfg({ mode })).mode).toBe(mode);
      expect(shouldShowCompletionReminderButton(cfg({ mode }))).toBe(mode === 'manual');
    }
    expect(getCompletionReminderConfig(cfg({ mode: 'unknown' as never })).mode).toBe('failures');
  });

  it('normalizes long-task minutes into the safe 1–1440 range', () => {
    expect(COMPLETION_REMINDER_LONG_TASK_MIN_MINUTES).toBe(1);
    expect(COMPLETION_REMINDER_LONG_TASK_MAX_MINUTES).toBe(1440);
    expect(getCompletionReminderConfig(cfg({ longTaskMinutes: 0 })).longTaskMinutes).toBe(3);
    expect(getCompletionReminderConfig(cfg({ longTaskMinutes: -10 })).longTaskMinutes).toBe(3);
    expect(getCompletionReminderConfig(cfg({ longTaskMinutes: Number.NaN })).longTaskMinutes).toBe(3);
    expect(getCompletionReminderConfig(cfg({ longTaskMinutes: 0.9 })).longTaskMinutes).toBe(1);
    expect(getCompletionReminderConfig(cfg({ longTaskMinutes: 8.9 })).longTaskMinutes).toBe(8);
    expect(getCompletionReminderConfig(cfg({ longTaskMinutes: 9999 })).longTaskMinutes).toBe(1440);
  });

  it('decides each mode without notifying user-stopped or cancelled work', () => {
    const doneAt = (minutes: number) => ({ outcome: 'done' as const, elapsedMs: minutes * 60_000 });

    expect(shouldSendCompletionReminder(cfg({ mode: 'manual' }), doneAt(1))).toBe(false);
    expect(
      shouldSendCompletionReminder(cfg({ mode: 'manual' }), { ...doneAt(1), manuallyRequested: true }),
    ).toBe(true);

    expect(shouldSendCompletionReminder(cfg({ mode: 'long', longTaskMinutes: 3 }), doneAt(2.99))).toBe(false);
    expect(shouldSendCompletionReminder(cfg({ mode: 'long', longTaskMinutes: 3 }), doneAt(3))).toBe(true);
    expect(
      shouldSendCompletionReminder(cfg({ mode: 'long', longTaskMinutes: 3 }), {
        outcome: 'error',
        elapsedMs: 10_000,
      }),
    ).toBe(false);

    expect(shouldSendCompletionReminder(cfg({ mode: 'failures' }), doneAt(10))).toBe(false);
    expect(
      shouldSendCompletionReminder(cfg({ mode: 'failures' }), { outcome: 'error', elapsedMs: 10_000 }),
    ).toBe(true);
    expect(
      shouldSendCompletionReminder(cfg({ mode: 'failures' }), { outcome: 'idle_timeout', elapsedMs: 10_000 }),
    ).toBe(true);

    expect(shouldSendCompletionReminder(cfg({ mode: 'always' }), doneAt(0))).toBe(true);
    expect(
      shouldSendCompletionReminder(cfg({ mode: 'always' }), { outcome: 'interrupted', elapsedMs: 10_000 }),
    ).toBe(false);
    expect(
      shouldSendCompletionReminder(cfg({ mode: 'always' }), { outcome: 'cancelled', elapsedMs: 10_000 }),
    ).toBe(false);
  });
});

describe('ordinary task completion reminder DM cards', () => {
  it('shows the four modes in 运行控制 and highlights failures by default', () => {
    const card = buildSettingsCard(cfg());
    const json = JSON.stringify(card);
    const modeButtons = buttonsFor(card, DM.setCompletionReminder);

    expect(json).toContain('⏱ 运行控制');
    expect(json).toContain('任务结束提醒');
    expect(modeButtons.map(buttonLabel)).toEqual(['仅手动', '长任务', '失败或超时', '每次结束']);
    expect(modeButtons.map((button) => button.type)).toEqual(['default', 'default', 'primary', 'default']);
    expect(buttonsFor(card, DM.completionReminderCustom)).toHaveLength(0);
  });

  it('shows the threshold editor entry only when long-task mode is selected', () => {
    const card = buildSettingsCard(cfg({ mode: 'long', longTaskMinutes: 12 }));
    const json = JSON.stringify(card);
    expect(json).toContain('当前 **12 分钟**');
    expect(buttonsFor(card, DM.completionReminderCustom)).toHaveLength(1);
  });

  it('builds a dedicated validated-minutes form and returns to global settings', () => {
    const card = buildCompletionReminderCustomCard(cfg({ mode: 'long', longTaskMinutes: 9 }));
    const json = JSON.stringify(card);
    expect(json).toContain('1–1440 分钟');
    expect(json).toContain('"name":"minutes"');
    expect(json).toContain('"default_value":"9"');
    expect(buttonsFor(card, DM.completionReminderCustomSubmit)).toHaveLength(1);
    expect(buttonsFor(card, DM.settings)).toHaveLength(1);
  });
});
