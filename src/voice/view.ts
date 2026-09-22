import { buildScopeGrantUrl } from '../config/scopes';
import type { AppConfig } from '../config/schema';
import { ASR_SCOPE } from './constants';
import { normalizeHealth } from './health';
import type { VoiceHealth, VoiceView } from './types';

export { ASR_SCOPE } from './constants';
export { normalizeHealth } from './health';

export const VOICE_TITLE = '语音转文字';
export const VOICE_DESCRIPTION = '给 agent 发语音时，先转为文字再发送给 agent。';
export const VOICE_NOTICE = '若机器人所属租户为飞书免费版，则不支持调用';
export const VOICE_DOC_URL = 'https://open.feishu.cn/document/server-docs/ai/speech_to_text-v1/file_recognize?lang=zh-CN';

function resultMessage(h: VoiceHealth): string {
  if (h.state === 'unchecked') return '尚未测试';
  if (h.state === 'testing') return h.message;
  if (h.state === 'ready') return '转写成功，可以使用。';
  if (h.state === 'permission_ready') return '权限已就绪，可点击测试。';
  if (h.state === 'missing_permission') return '缺少语音识别权限，请授权后测试。';
  if (h.issue === 'unsupported_plan') return '当前租户不支持此服务。';
  if (h.issue === 'rate_limit') return '请求受限，请稍后测试。';
  if (h.issue === 'quota') return '调用额度已用尽，请管理员检查用量。';
  if (h.issue === 'authentication') return '应用凭据无效，请检查机器人配置。';
  if (h.issue === 'network') return '网络连接失败，请稍后重试。';
  if (h.issue === 'rejected') return '调用被拒绝，请联系飞书支持核查。';
  return '转写未成功，请稍后重试。';
}
export function voiceView(cfg: AppConfig): VoiceView {
  const feishu = normalizeHealth(cfg.preferences?.voice?.feishu);
  return {
    enabled: cfg.preferences?.voice?.enabled === true,
    feishu,
    result: cfg.preferences?.voice?.enabled ? resultMessage(feishu) : '已关闭',
    grantUrl: buildScopeGrantUrl(cfg.accounts.app.id, cfg.accounts.app.tenant, [ASR_SCOPE]),
  };
}
