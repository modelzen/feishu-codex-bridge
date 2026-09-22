import type { CardActionEvent, LarkChannel } from '@larksuiteoapi/node-sdk';
import { buildVoiceSettingsCard, DM } from '../card/dm-cards';
import type { CardDispatcher } from '../card/dispatcher';
import { sendManagedCard, updateManagedCard } from '../card/managed';
import { isAdmin, type AppConfig } from '../config/schema';
import { log } from '../core/logger';
import type { VoiceAction, VoiceService } from '../voice/types';

const CARD_SETTLE_DELAY_MS = 500;

/** Button callbacks acknowledge immediately; permission checks and ASR run in the background. */
export function registerVoiceConsole(
  dispatcher: CardDispatcher,
  channel: LarkChannel,
  cfg: AppConfig,
  voice: Pick<VoiceService, 'action' | 'settled'>,
) {
  const jobs = new Map<string, symbol>();
  async function show(evt: CardActionEvent, notice?: string): Promise<CardActionEvent> {
    const card = buildVoiceSettingsCard(cfg, notice);
    const updated = await updateManagedCard(channel, evt.messageId, card).catch(() => false);
    if (updated) return evt;
    const sent = await sendManagedCard(channel, evt.chatId, card);
    return { ...evt, messageId: sent.messageId };
  }

  function clearJob(job: symbol): void {
    for (const [id, value] of jobs) {
      if (value === job) jobs.delete(id);
    }
  }

  function leave(messageId: string): void {
    const job = jobs.get(messageId);
    if (job) clearJob(job);
  }

  function run(evt: CardActionEvent, action?: VoiceAction['action']): void {
    if (!isAdmin(cfg, evt.operator?.openId ?? '')) return;
    const key = evt.messageId;
    leave(key);
    const job = Symbol();
    jobs.set(key, job);
    const current = () => jobs.get(key) === job;
    // Queue mutation before the card-settle delay; don't hold the SDK callback open.
    const saved = action
      ? voice.action({ action }).then(
        () => undefined,
        (err: unknown) => err instanceof Error ? err.message : '设置失败，请重试。',
      )
      : Promise.resolve(undefined);
    void (async () => {
      await new Promise((resolve) => setTimeout(resolve, CARD_SETTLE_DELAY_MS));
      const error = await saved;
      if (!current()) return;
      const pending = cfg.preferences?.voice?.feishu?.state === 'testing';
      const target = await show(evt, error);
      if (!current()) return;
      jobs.set(target.messageId, job);
      if (!pending) return;
      await voice.settled();
      if (current()) await show(target);
    })()
      .catch((err) => log.fail('console', err, { phase: 'voice-settings' }))
      .finally(() => clearJob(job));
  }

  dispatcher.on(DM.voiceSettings, ({ evt }) => run(evt));
  dispatcher.on(DM.setVoice, ({ evt, value }) => {
    if (value.v === 'on' || value.v === 'off') run(evt, value.v === 'on' ? 'enable' : 'disable');
  });
  dispatcher.on(DM.testVoice, ({ evt }) => run(evt, 'test'));
  dispatcher.on(DM.refreshVoicePermission, ({ evt }) => run(evt, 'refreshPermission'));
  return { leave };
}
