import { describe, expect, it } from 'vitest';
import {
  getSessionTitleConfig,
  getSessionTitleEfforts,
  summarizeSessionTitleConfig,
  summarizeSessionTitles,
  type AppConfig,
} from '../src/config/schema';

function cfg(sessionTitles?: NonNullable<AppConfig['preferences']>['sessionTitles']): AppConfig {
  return {
    accounts: { app: { id: 'cli_app', secret: 's', tenant: 'feishu' } },
    preferences: { sessionTitles },
  };
}

describe('session title config', () => {
  it('defaults every backend to no model / first-sentence truncation', () => {
    expect(getSessionTitleConfig(cfg(), 'codex-appserver')).toEqual({ enabled: false });
    expect(summarizeSessionTitleConfig(cfg(), 'claude-agent')).toContain('截断首句');
    expect(summarizeSessionTitles(cfg())).toBe('- Codex：截断首句\n- Claude Code：截断首句');
  });

  it('keeps model + effort settings isolated per backend', () => {
    const config = cfg({
      byBackend: {
        'codex-appserver': { enabled: true, model: 'openrouter/acme-coder', effort: 'xhigh' },
        'claude-agent': { enabled: true, model: 'vendor/fast-title', effort: 'low' },
      },
    });
    expect(getSessionTitleConfig(config, 'codex-appserver')).toEqual({
      enabled: true,
      model: 'openrouter/acme-coder',
      effort: 'xhigh',
    });
    expect(getSessionTitleConfig(config, 'claude-agent')).toEqual({
      enabled: true,
      model: 'vendor/fast-title',
      effort: 'low',
    });
    expect(getSessionTitleConfig(config, 'some-new-backend')).toEqual({ enabled: false });
    expect(summarizeSessionTitles(config)).toBe(
      '- Codex：AI 精炼 · openrouter/acme-coder · xhigh\n' +
      '- Claude Code：AI 精炼 · vendor/fast-title · low',
    );
  });

  it('treats incomplete or invalid enabled configs as disabled', () => {
    const incomplete = cfg({
      byBackend: {
        missingModel: { enabled: true, effort: 'low' } as never,
        missingEffort: { enabled: true, model: 'third-party/model' } as never,
        blankModel: { enabled: true, model: '   ', effort: 'high' },
        invalidEffort: { enabled: true, model: 'third-party/model', effort: 'turbo' } as never,
      },
    });
    for (const backend of ['missingModel', 'missingEffort', 'blankModel', 'invalidEffort']) {
      expect(getSessionTitleConfig(incomplete, backend)).toEqual({ enabled: false });
    }
  });

  it('limits Effort by host protocol without limiting third-party model ids', () => {
    expect(getSessionTitleEfforts('codex-appserver')).toEqual([
      'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra',
    ]);
    expect(getSessionTitleEfforts('claude-agent')).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(getSessionTitleConfig(cfg({
      byBackend: {
        'codex-appserver': { enabled: true, model: 'any-vendor/model', effort: 'ultra' },
      },
    }), 'codex-appserver')).toEqual({ enabled: true, model: 'any-vendor/model', effort: 'ultra' });
  });
});
