import { describe, expect, it } from 'vitest';
import type { ModelInfo } from '../src/agent/types';
import {
  buildSessionTitleSettingsCard,
  buildSettingsCard,
  DM,
  parseSessionTitleFormValue,
  SESSION_TITLE_CUSTOM_MODEL_OPTION,
} from '../src/card/dm-cards';
import type { AppConfig } from '../src/config/schema';

const BACKENDS = [
  { id: 'codex-appserver', label: 'Codex' },
  { id: 'claude-agent', label: 'Claude' },
];

const model = (over: Partial<ModelInfo> & Pick<ModelInfo, 'id' | 'displayName'>): ModelInfo => ({
  description: '',
  supportedEfforts: [],
  defaultEffort: 'medium',
  isDefault: false,
  hidden: false,
  ...over,
});

const liveModels = [
  model({ id: 'openrouter/acme-title-v3', displayName: 'Acme Title V3' }),
  model({ id: 'private/hidden', displayName: 'Hidden Provider Model', hidden: true }),
];

function cfg(sessionTitles?: NonNullable<AppConfig['preferences']>['sessionTitles']): AppConfig {
  return {
    accounts: { app: { id: 'cli_app', secret: 's', tenant: 'feishu' } },
    preferences: { sessionTitles },
  };
}

const json = (...args: Parameters<typeof buildSessionTitleSettingsCard>): string =>
  JSON.stringify(buildSessionTitleSettingsCard(...args));

describe('session-title settings cards', () => {
  it('adds a dedicated entry to the global DM settings card', () => {
    const rendered = JSON.stringify(buildSettingsCard(cfg()));
    expect(rendered).toContain(DM.sessionTitleSettings);
    expect(rendered).toContain('会话标题');
    expect(rendered).toContain('默认截断首句');
  });

  it('renders live third-party models without a provider whitelist and hides hidden models', () => {
    const rendered = json(cfg(), BACKENDS, 'codex-appserver', liveModels);
    expect(rendered).toContain('Acme Title V3');
    expect(rendered).toContain('openrouter/acme-title-v3');
    expect(rendered).not.toContain('Hidden Provider Model');
    expect(rendered).toContain(SESSION_TITLE_CUSTOM_MODEL_OPTION);
    expect(rendered).toContain('自定义模型 ID');
  });

  it('requires both model and Effort before AI can be enabled', () => {
    const rendered = json(cfg(), BACKENDS, 'codex-appserver', liveModels);
    expect(rendered).toContain('"name":"model"');
    expect(rendered).toContain('"name":"effort"');
    expect(rendered.match(/"required":true/g)?.length).toBeGreaterThanOrEqual(2);
    expect(rendered).toContain(DM.sessionTitleSubmit);
    expect(rendered).toContain('"value":"max"');
    expect(rendered).toContain('"value":"ultra"');

    expect(parseSessionTitleFormValue(undefined)).toEqual({
      ok: false,
      message: '请选择模型，或填写自定义模型 ID。',
    });
    expect(parseSessionTitleFormValue({ model: 'openrouter/acme-title-v3' })).toEqual({
      ok: false,
      message: '请选择 Effort。',
    });
    expect(
      parseSessionTitleFormValue({ model: 'openrouter/acme-title-v3', effort: 'high' }),
    ).toEqual({
      ok: true,
      config: { enabled: true, model: 'openrouter/acme-title-v3', effort: 'high' },
    });
  });

  it('shows Claude protocol Effort values, including max but not Codex-only none/minimal', () => {
    const rendered = json(cfg(), BACKENDS, 'claude-agent', liveModels);
    expect(rendered).toContain('"value":"max"');
    expect(rendered).not.toContain('"value":"none"');
    expect(rendered).not.toContain('"value":"minimal"');
    expect(rendered).not.toContain('"value":"ultra"');
  });

  it('accepts an arbitrary custom model id while still requiring Effort', () => {
    expect(
      parseSessionTitleFormValue({
        model: SESSION_TITLE_CUSTOM_MODEL_OPTION,
        customModel: 'my-company/title-model',
        effort: { value: 'xhigh' },
      }),
    ).toEqual({
      ok: true,
      config: { enabled: true, model: 'my-company/title-model', effort: 'xhigh' },
    });
  });

  it('shows and preselects each backend configuration independently', () => {
    const config = cfg({
      byBackend: {
        'codex-appserver': { enabled: true, model: 'openrouter/acme-title-v3', effort: 'high' },
        'claude-agent': { enabled: true, model: 'vendor/claude-title', effort: 'low' },
      },
    });
    const codex = json(config, BACKENDS, 'codex-appserver', liveModels);
    const claude = json(config, BACKENDS, 'claude-agent', [
      model({ id: 'vendor/claude-title', displayName: 'Vendor Claude Title' }),
    ]);
    expect(codex).toContain('AI 精炼：openrouter/acme-title-v3 · high');
    expect(codex).toContain('"initial_option":"openrouter/acme-title-v3"');
    expect(claude).toContain('AI 精炼：vendor/claude-title · low');
    expect(claude).toContain('"initial_option":"vendor/claude-title"');
  });

  it('falls back to custom-id mode when the configured third-party model is absent from live discovery', () => {
    const config = cfg({
      byBackend: {
        'codex-appserver': { enabled: true, model: 'offline-provider/title-model', effort: 'medium' },
      },
    });
    const rendered = json(config, BACKENDS, 'codex-appserver', []);
    expect(rendered).toContain(`"initial_option":"${SESSION_TITLE_CUSTOM_MODEL_OPTION}"`);
    expect(rendered).toContain('"default_value":"offline-provider/title-model"');
  });
});
