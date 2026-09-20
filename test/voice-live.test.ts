import { it, expect } from 'vitest';
import { Client } from '@larksuiteoapi/node-sdk';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadBots } from '../src/config/bots';
import { botDir } from '../src/config/paths';
import { loadConfig } from '../src/config/store';
import { isComplete } from '../src/config/schema';
import { resolveAppSecret } from '../src/config/secret-resolver';
import { decodeVoice, recognizeVoicePcm } from '../src/bot/voice';

// Explicit opt-in: uses the saved bot's ASR permission, never sends a chat message.
it.skipIf(process.env.FEISHU_VOICE_LIVE !== '1')('transcribes a synthetic Chinese utterance using the saved Feishu bot', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'feishu-voice-check-'));
  try {
    const registry = await loadBots();
    if (!registry.current) throw new Error('No current bot');
    const cfg = await loadConfig(join(botDir(registry.current), 'config.json'));
    if (!isComplete(cfg)) throw new Error('Bot config incomplete');
    const client = new Client({ appId: cfg.accounts.app.id, appSecret: await resolveAppSecret(cfg), logger: { debug() {}, info() {}, warn() {}, error() {}, trace() {} } });
    const path = join(dir, 'sample.aiff');
    execFileSync('say', ['-v', 'Tingting', '-o', path, '请检查今天的生产报表'], { timeout: 15000 });
    const signal = AbortSignal.timeout(45000);
    const pcm = await decodeVoice(await readFile(path), signal);
    const text = await recognizeVoicePcm({ rawClient: client } as any, pcm, signal);
    console.log(JSON.stringify({ appId: cfg.accounts.app.id, transcript: text }));
    expect(text).toContain('语音消息：');
    expect(text).toContain('报表');
  } catch (err) {
    // Never let Vitest pretty-print an SDK error's authenticated request.
    const detail = (err as any)?.response?.data;
    throw new Error(detail ? JSON.stringify({ code: detail.code, msg: detail.msg, error: detail.error }) : err instanceof Error ? err.message : 'Live ASR failed');
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 60000);
