import { expect, it } from 'vitest';
import { VoiceIntake } from '../src/bot/voice-intake';

it('cancels a chat scope without disturbing another chat or a replacement lane', async () => {
  const intake = new VoiceIntake();
  let finish!: () => void;
  const blocked = new Promise<void>(resolve => { finish = resolve; });
  const delivered: string[] = [];
  const failed = (error: unknown) => { throw error; };
  intake.submit('old-topic', () => blocked, async () => { delivered.push('old'); }, failed, 'chat');
  intake.submit('other-topic', async () => undefined, async () => { delivered.push('other'); }, failed, 'other-chat');
  await Promise.resolve();
  expect(intake.cancelScope('chat')).toBe(1);
  intake.submit('old-topic', async () => undefined, async () => { delivered.push('new'); }, failed, 'chat');
  finish();
  // Flush the preparation and delivery promises, including old generation cleanup.
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(delivered.sort()).toEqual(['new', 'other']);
  expect(intake.hasPending('old-topic')).toBe(false);
  intake.close();
});
