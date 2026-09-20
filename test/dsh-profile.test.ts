import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DSH_BIN_NAME,
  DSH_INSTALL_SPECS,
  DSH_VERSION,
} from '../src/agent/dsh/constants';
import { DSH_MODELS, dshRoute, toDshEffort } from '../src/agent/dsh/models';
import { dshProfileText, ensureDshProfile } from '../src/agent/dsh/profile';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('DSH pinned runtime metadata', () => {
  it('pins every directly referenced package to one reviewed prerelease', () => {
    expect(DSH_VERSION).toBe('0.1.1-rc.2');
    expect(DSH_BIN_NAME).toBe('dsh-jsonrpc-agent');
    expect(DSH_INSTALL_SPECS.length).toBeGreaterThanOrEqual(19);
    expect(new Set(DSH_INSTALL_SPECS).size).toBe(DSH_INSTALL_SPECS.length);
    for (const spec of DSH_INSTALL_SPECS) expect(spec).toMatch(/@0\.1\.1-rc\.2$/);
  });
});

describe('DSH reviewed model catalog', () => {
  it('declares eight unique provider/model routes and one default', () => {
    expect(DSH_MODELS).toHaveLength(8);
    expect(new Set(DSH_MODELS.map((model) => model.id)).size).toBe(8);
    expect(DSH_MODELS.filter((model) => model.isDefault).map((model) => model.id)).toEqual([
      'moonshotai-cn/kimi-k3',
    ]);
    expect(dshRoute('deepseek/deepseek-v4-pro')).toEqual({
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
    });
    expect(() => dshRoute('missing-separator')).toThrow(/DSH 模型路由/);
  });

  it('keeps effort choices model-specific and maps Bridge none to pi-ai off', () => {
    expect(DSH_MODELS.find((model) => model.id === 'minimax/MiniMax-M3')?.supportedEfforts).toEqual([
      'none',
      'high',
    ]);
    expect(DSH_MODELS.find((model) => model.id === 'moonshotai-cn/kimi-k3')?.supportedEfforts).toEqual([
      'none',
      'low',
      'high',
      'max',
    ]);
    expect(toDshEffort('none')).toBe('off');
    expect(toDshEffort('max')).toBe('max');
  });
});

describe('generated DSH Cordis profile', () => {
  it('contains only pinned native JSON-RPC components and no credential values', () => {
    const profile = dshProfileText();
    expect(profile).toContain("name: '@deepseek-ai/dsh-sdk-jsonrpc-server'");
    expect(profile).toContain("name: '@deepseek-ai/dsh-llm-pi-ai'");
    expect(profile).toContain("name: '@deepseek-ai/dsh-credentials-local'");
    expect(profile).toContain('mode: danger-full-access');
    expect(profile).toContain('policy: never');
    expect(profile).toContain('mode: native');
    expect(profile).toContain('workspaceContext: false');
    expect(profile).toContain('toolJobs: false');
    expect(profile).toContain('goals: false');
    expect(profile).toContain('MOONSHOT_API_KEY');
    expect(profile).toContain('ZAI_CODING_CN_API_KEY');
    expect(profile).toContain('MINIMAX_API_KEY');
    expect(profile).toContain('DEEPSEEK_API_KEY');
    expect(profile).not.toMatch(/run_code|code-mode|DSH_TOOLS_MODE:\s*code/i);
    expect(profile).not.toMatch(/apiKey:\s*['"]?[A-Za-z0-9_-]{16,}/);

    const installed = new Set(DSH_INSTALL_SPECS.map((spec) => spec.replace(/@0\.1\.1-rc\.2$/, '')));
    const referenced = [...profile.matchAll(/^\s*name:\s*'([^']+)'/gm)].map((match) => match[1]);
    expect(referenced.length).toBeGreaterThan(10);
    for (const pkg of referenced) expect(installed.has(pkg!)).toBe(true);
  });

  it('writes the deterministic profile and leaves matching content unchanged', async () => {
    const root = mkdtempSync(join(tmpdir(), 'fcb-dsh-profile-'));
    tempDirs.push(root);
    const file = join(root, 'runtime', 'cordis.yml');
    await ensureDshProfile(file);
    const first = readFileSync(file, 'utf8');
    await ensureDshProfile(file);
    expect(readFileSync(file, 'utf8')).toBe(first);
    expect(first).toBe(dshProfileText());
  });
});
