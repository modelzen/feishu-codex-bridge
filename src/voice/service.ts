import type { AppPreferencesWriter } from '../admin/ops';
import type { AppConfig } from '../config/schema';
import { opusToPcm } from './audio';
import { DEFAULT_RETRY_DELAY_MS, MAX_VOICE_BYTES, MAX_VOICE_DURATION_MS } from './constants';
import { normalizeHealth } from './health';
import { probePcm } from './probe';
import { createFeishuVoiceClient, type FeishuVoiceClient } from './providers';
import { VoiceFailure, type VoiceAction, type VoiceConfig, type VoiceHealth, type VoiceService } from './types';

export function validateVoiceAction(input: unknown): VoiceAction {
  if (!input || typeof input !== 'object') throw new Error('缺少语音设置操作');
  const { action } = input as Record<string, unknown>;
  switch (action) {
    case 'enable':
    case 'test':
    case 'disable':
    case 'refreshPermission':
      return { action };
    default:
      throw new Error('无效的语音设置操作');
  }
}

export interface VoiceDependencies {
  feishu?: FeishuVoiceClient;
  decode?: typeof opusToPcm;
}

function asVoiceFailure(err: unknown): VoiceFailure {
  return err instanceof VoiceFailure
    ? err
    : new VoiceFailure('识别服务异常，请重新检测', 'temporary_error');
}

function canTranscribe(health: VoiceHealth): boolean {
  if (health.state === 'unchecked' || health.state === 'ready' || health.state === 'permission_ready') return true;
  return health.state === 'temporary_error' && Date.now() >= (health.retryAt ?? 0);
}

export function createVoiceService(
  cfg: AppConfig,
  write: AppPreferencesWriter,
  deps: VoiceDependencies = {},
): VoiceService {
  const feishu = deps.feishu ?? createFeishuVoiceClient(cfg);
  const decode = deps.decode ?? opusToPcm;
  let generation = 0;
  let testJob: Promise<void> | undefined;
  let previousHealth: VoiceHealth | undefined;
  let actionChain: Promise<unknown> = Promise.resolve();
  const config = (): VoiceConfig => cfg.preferences?.voice ?? { enabled: false };

  async function patch(update: Partial<VoiceConfig>, epoch = generation): Promise<void> {
    await write((preferences) => {
      // Only retain supported settings; historical alternate-provider references are ignored.
      if (epoch !== generation) return;
      preferences.voice = {
        enabled: preferences.voice?.enabled ?? false,
        feishu: preferences.voice?.feishu,
        ...update,
      };
    });
  }

  async function recordHealth(value: VoiceHealth, epoch: number): Promise<void> {
    await patch({ feishu: { ...value, checkedAt: Date.now() } }, epoch);
  }

  async function recordFailure(err: unknown, epoch: number): Promise<string> {
    const failure = asVoiceFailure(err);
    // A corrupt/long/silent individual clip must not disable an otherwise healthy service.
    if (failure.kind !== 'audio') {
      const { retryAfterMs, ...diagnostics } = failure.diagnostics;
      await recordHealth({
        state: failure.kind,
        message: failure.message,
        ...diagnostics,
        ...(failure.kind === 'temporary_error'
          ? { retryAt: Date.now() + (retryAfterMs ?? DEFAULT_RETRY_DELAY_MS) }
          : {}),
      }, epoch);
    }
    return failure.message;
  }

  async function testProvider(epoch: number, permissionOnly: boolean, previous: VoiceHealth): Promise<void> {
    try {
      await feishu.checkPermission();
      if (epoch !== generation) return;
      if (permissionOnly) {
        // A permission check does not prove entitlement or reset a failed ASR diagnosis/cooldown.
        const keep = previous.state === 'ready' || previous.state === 'temporary_error' || previous.state === 'unavailable';
        if (keep) await patch({ feishu: previous }, epoch);
        else await recordHealth({ state: 'permission_ready', message: '权限已就绪' }, epoch);
        return;
      }
      const pcm = await probePcm();
      if (epoch !== generation) return;
      const text = await feishu.recognize(pcm);
      if (!text.trim()) throw new VoiceFailure('测试音频未识别出文字，请重新检测', 'temporary_error');
      await recordHealth({ state: 'ready', message: '实际识别测试通过' }, epoch);
    } catch (err) {
      const failure = asVoiceFailure(err);
      await recordFailure(
        failure.kind === 'audio'
          ? new VoiceFailure(failure.message, 'temporary_error', failure.diagnostics)
          : failure,
        epoch,
      );
    }
  }

  async function actionImpl(raw: VoiceAction): Promise<void> {
    const { action } = validateVoiceAction(raw);
    const requiresEnabled = action === 'test' || action === 'refreshPermission';
    if (requiresEnabled && !config().enabled) throw new Error('请先开启语音转文字，再测试');
    if (requiresEnabled && testJob) return;
    if (testJob && action !== 'disable') throw new Error('检测正在进行，请稍后再试');
    if (action === 'disable') {
      generation++;
      // Preserve diagnostics/cooldown: toggling the switch must not bypass rate limiting.
      const feishu = config().feishu?.state === 'testing'
        ? previousHealth ?? normalizeHealth(undefined)
        : normalizeHealth(config().feishu);
      await patch({ enabled: false, feishu });
      return;
    }
    const current = normalizeHealth(config().feishu);
    if (action === 'test' && current.retryAt && current.retryAt > Date.now()) {
      throw new Error('飞书暂时受限，请等待冷却结束后再检测');
    }
    generation++;
    const epoch = generation;
    previousHealth = current;
    await patch({
      ...(action === 'enable' ? { enabled: true } : {}),
      feishu: {
        state: 'testing',
        message: action === 'test' ? '正在测试转写…' : '正在检查权限…',
        checkedAt: Date.now(),
      },
    });
    // Return immediately across supervisor IPC; UI polls persisted safe diagnostics.
    testJob = testProvider(epoch, action !== 'test', current)
      .catch(() => undefined)
      .finally(() => {
        testJob = undefined;
        previousHealth = undefined;
      });
  }

  return {
    action(action) {
      const run = actionChain.then(() => actionImpl(action));
      actionChain = run.catch(() => undefined);
      return run;
    },
    async settled() {
      await actionChain;
      await testJob;
    },
    async transcribe(audio, durationMs) {
      if (!config().enabled) return { reason: '语音转文字未启用' };
      if (audio.length > MAX_VOICE_BYTES) return { reason: '语音超过 20 MB 处理上限' };
      if (durationMs && durationMs > MAX_VOICE_DURATION_MS) return { reason: '语音超过飞书 60 秒限制' };
      const current = normalizeHealth(config().feishu);
      if (!canTranscribe(current)) return { reason: current.message };
      const epoch = generation;
      try {
        if (current.state !== 'ready' && current.state !== 'permission_ready') await feishu.checkPermission();
        if (epoch !== generation || !config().enabled) return { reason: '语音设置已变更，请重发' };
        const pcm = await decode(audio);
        if (epoch !== generation || !config().enabled) return { reason: '语音设置已变更，请重发' };
        const text = await feishu.recognize(pcm);
        await recordHealth({ state: 'ready', message: '最近一次识别成功' }, epoch);
        if (epoch !== generation || !config().enabled) return { reason: '语音设置已变更，请重发' };
        return { text, provider: 'feishu' };
      } catch (err) {
        return { reason: await recordFailure(err, epoch) };
      }
    },
  };
}
