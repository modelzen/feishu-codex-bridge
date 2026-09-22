import { describe, expect, it } from 'vitest';
import {
  buildCommentPromptCard,
  buildCommentSettingsCard,
  resolveCommentModelFormValue,
} from '../src/card/dm-cards';
import type { AppConfig } from '../src/config/schema';
import type { ModelInfo } from '../src/agent/types';

// 云文档评论设置卡。Agent 按钮只切换预览，Agent+模型+推理强度由表单一次提交；
// 无显式「默认/后端默认」选项；回复规则在子卡内编辑；带飞书 CLI 配合提示。

const model = (over: Partial<ModelInfo> & Pick<ModelInfo, 'id' | 'displayName'>): ModelInfo => ({
  description: '',
  supportedEfforts: [],
  defaultEffort: 'medium',
  isDefault: false,
  hidden: false,
  ...over,
});

const codexModels = [
  model({ id: 'gpt-5.5', displayName: 'GPT-5.5', supportedEfforts: ['low', 'medium', 'high'], isDefault: true }),
  model({ id: 'gpt-5-codex', displayName: 'GPT-5 Codex', supportedEfforts: ['low', 'medium', 'high'] }),
  model({ id: 'secret', displayName: 'Secret', hidden: true }),
];
const claudeModels = [
  model({ id: 'opus', displayName: 'Opus', isDefault: true }),
  model({ id: 'sonnet', displayName: 'Sonnet' }),
]; // 2 models, no effort tiers

const TWO_BACKENDS = [
  { id: 'codex-appserver', label: 'Codex' },
  { id: 'claude-agent', label: 'Claude' },
];

function cfg(comments?: NonNullable<AppConfig['preferences']>['comments']): AppConfig {
  return { accounts: { app: { id: 'cli_app', secret: 's', tenant: 'feishu' } }, preferences: { comments } };
}

const json = (...args: Parameters<typeof buildCommentSettingsCard>): string =>
  JSON.stringify(buildCommentSettingsCard(...args));

describe('buildCommentSettingsCard', () => {
  it('shows backend buttons (cascade) + a model/effort form + prompt-editor + lark-cli hint', () => {
    const j = json(cfg(), TWO_BACKENDS, codexModels);
    expect(j).toContain('dm.comment.setBackend'); // backend buttons (>1)
    expect(j).toContain('Codex');
    expect(j).toContain('Claude');
    expect(j).toContain('"tag":"form"'); // selection is transient; submit commits the full config
    expect(j).toContain('dm.comment.submit'); // single submit for model+effort
    expect(j).toContain('评论使用的 Agent');
    expect(j).toContain('回复模型');
    expect(j).toContain('保存评论配置');
    expect(j).toContain('GPT-5.5');
    expect(j).toContain('dm.comment.editPrompt'); // prompt editor button
    expect(j).toContain('编辑回复规则');
    expect(j).toContain('lark-cli'); // 飞书CLI 配合提示
    expect(j).toContain('bytedance.larkoffice.com/wiki/'); // 飞书CLI 文档链接
    expect(j).toContain('dm.settings'); // back to settings
  });

  it('has NO explicit 默认 / 后端默认 options (the dropdown just preselects the effective value)', () => {
    const j = json(cfg(), TWO_BACKENDS, codexModels);
    expect(j).not.toContain('后端默认');
    expect(j).not.toContain('dm.comment.setModel'); // old per-button handlers gone
    expect(j).not.toContain('dm.comment.setEffort');
  });

  it('does not expose AGENTS.md / CLAUDE.md in the UI (implementation detail)', () => {
    const j = json(cfg(), TWO_BACKENDS, codexModels);
    expect(j).not.toContain('AGENTS.md');
    expect(j).not.toContain('CLAUDE.md');
  });

  it('hides hidden models from the model dropdown', () => {
    expect(json(cfg(), TWO_BACKENDS, codexModels)).not.toContain('Secret');
  });

  it('does not offer a save action when live model discovery is empty', () => {
    const j = json(cfg(), TWO_BACKENDS, []);
    expect(j).toContain('暂时没有取到这个 Agent 的模型列表');
    expect(j).not.toContain('dm.comment.submit');
  });

  it('omits the effort select when the backend has no reasoning tiers (claude-style)', () => {
    const j = json(cfg(), TWO_BACKENDS, claudeModels);
    expect(j).toContain('dm.comment.submit'); // still a form (model select)
    expect(j).toContain('Sonnet'); // model dropdown present
    expect(j).not.toContain('"name":"effort"'); // but no effort select control
  });

  it('omits backend buttons when only one backend is installed', () => {
    const j = json(cfg(), [{ id: 'codex-appserver', label: 'Codex' }], codexModels);
    expect(j).not.toContain('dm.comment.setBackend');
  });

  it('preselects the configured model/effort', () => {
    const j = json(cfg({ backend: 'codex-appserver', model: 'gpt-5-codex', effort: 'high' }), TWO_BACKENDS, codexModels);
    expect(j).toContain('"initial_option":"gpt-5-codex"');
    expect(j).toContain('"initial_option":"high"');
  });

  it('previews another Agent without carrying the saved backend model into it', () => {
    const j = json(
      cfg({ backend: 'codex-appserver', model: 'gpt-5-codex', effort: 'high' }),
      TWO_BACKENDS,
      claudeModels,
      undefined,
      'claude-agent',
    );
    expect(j).toContain('这里只预览可选配置');
    expect(j).toContain('待保存配置');
    expect(j).toContain('"a":"dm.comment.submit","b":"claude-agent"');
    expect(j).toContain('"initial_option":"opus"');
    expect(j).not.toContain('gpt-5-codex');
  });

  it('normalizes a backend-wide effort choice to the selected model capability', () => {
    const mixed = [
      model({
        id: 'fast',
        displayName: 'Fast',
        supportedEfforts: ['low'],
        defaultEffort: 'low',
        isDefault: true,
      }),
      model({
        id: 'deep',
        displayName: 'Deep',
        supportedEfforts: ['high'],
        defaultEffort: 'high',
      }),
    ];
    expect(resolveCommentModelFormValue(mixed, 'fast', 'high')).toMatchObject({
      ok: true,
      effort: 'low',
      adjusted: true,
    });
    expect(resolveCommentModelFormValue(mixed, 'deep', 'high')).toMatchObject({
      ok: true,
      effort: 'high',
      adjusted: false,
    });
    expect(resolveCommentModelFormValue(mixed, 'missing', 'low')).toEqual({
      ok: false,
      message: '所选模型当前不可用，未保存。请重新选择。',
    });
  });
});

describe('buildCommentPromptCard', () => {
  it('prefills the input with the current prompt and offers save + reset', () => {
    const j = JSON.stringify(buildCommentPromptCard('我的自定义提示词 {fileType}'));
    expect(j).toContain('我的自定义提示词'); // prefilled value
    expect(j).toContain('comment_prompt'); // the form
    expect(j).toContain('dm.comment.promptSubmit'); // save action
    expect(j).toContain('dm.comment.resetPrompt'); // reset-to-default action
    expect(j).toContain('保存回复规则');
    expect(j).toContain('重置为默认'); // reset button label
    expect(j).toContain('编辑回复规则');
    expect(j).toContain('dm.comment.settings'); // back to settings
  });

  it('explains every variable and lists the supported doc types (grouped)', () => {
    const j = JSON.stringify(buildCommentPromptCard('x'));
    expect(j).toContain('{fileType}');
    expect(j).toContain('{fileToken}');
    expect(j).toContain('{docUrl}');
    // the {fileType} value list, grouped by family
    expect(j).toContain('飞书云文档'); // doc/docx
    expect(j).toContain('飞书表格'); // sheet
    expect(j).toContain('多维表格'); // bitable
    expect(j).not.toContain('云盘文件'); // file dropped — no longer supported
  });

  it('is a roomy multiline editor (width fill, card fills the chat) capped at Feishu max 1000', () => {
    const card = buildCommentPromptCard('x');
    const j = JSON.stringify(card);
    expect(j).toContain('"input_type":"multiline_text"'); // textarea, not single-line
    expect(j).toContain('"width":"fill"'); // input spans the card width (was Feishu's narrow default)
    expect(j).toContain('"max_length":1000'); // hard cap, stays in the valid 1–1000 range
    expect((card.config as { width_mode?: string }).width_mode).toBe('fill'); // card fills the chat window
  });

  it('shows the per-turn message the bot auto-receives (variables, not real values)', () => {
    const j = JSON.stringify(buildCommentPromptCard('x'));
    expect(j).toContain('每轮评论 @我'); // the explanation header
    expect(j).toContain('file_token：{fileToken}'); // shown with placeholders
    expect(j).toContain('用户的问题'); // the question line
    expect(j).toContain('用户选中的原文'); // the quote line
  });

  it('surfaces the master-file path as an edit-in-file escape hatch when given', () => {
    const j = JSON.stringify(buildCommentPromptCard('x', undefined, '/home/u/.feishu-codex-bridge/bots/cli_x/comment-instructions.md'));
    expect(j).toContain('/home/u/.feishu-codex-bridge/bots/cli_x/comment-instructions.md');
  });

  it('can render a notice (e.g. validation error)', () => {
    const j = JSON.stringify(buildCommentPromptCard('x', '⚠️ 提示词不能为空，未保存。'));
    expect(j).toContain('不能为空');
  });
});
