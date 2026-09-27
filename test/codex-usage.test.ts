import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UsageError } from '../src/agent/types';
import {
  chatgptBaseUrl,
  fetchUsageBundle,
  jwtExpMs,
  mapProfileResponse,
  mapUsageResponse,
  readCodexAuth,
  resolveCodexHome,
} from '../src/agent/codex-appserver/usage';

// ── fixtures：来自 wham 端点的真机捕获结构（数值脱敏）──────────────────

const USAGE_FIXTURE = {
  user_id: 'user-x',
  account_id: 'user-x',
  email: 'someone@example.com',
  plan_type: 'prolite',
  rate_limit: {
    allowed: true,
    limit_reached: false,
    primary_window: { used_percent: 1, limit_window_seconds: 18000, reset_after_seconds: 16923, reset_at: 1780849681 },
    secondary_window: { used_percent: 4, limit_window_seconds: 604800, reset_after_seconds: 305721, reset_at: 1781138479 },
  },
  additional_rate_limits: [
    {
      limit_name: 'GPT-5.3-Codex-Spark',
      metered_feature: 'codex_bengalfox',
      rate_limit: {
        allowed: true,
        limit_reached: false,
        primary_window: { used_percent: 0, limit_window_seconds: 18000, reset_after_seconds: 18000, reset_at: 1780850758 },
        secondary_window: { used_percent: 0, limit_window_seconds: 604800, reset_after_seconds: 604800, reset_at: 1781437558 },
      },
    },
  ],
  credits: { has_credits: false, unlimited: false, balance: '0' },
};

const PROFILE_FIXTURE = {
  profile: { username: 'someone', display_name: 'Clay Zhang', profile_picture_url: 'https://example.com/a.png' },
  stats: {
    lifetime_tokens: 4271434092,
    peak_daily_tokens: 258804367,
    current_streak_days: 20,
    longest_streak_days: 31,
    total_threads: 1432,
    longest_running_turn_sec: 4529,
    fast_mode_usage_percentage: 53.26,
    total_skills_used: 1102,
    unique_skills_used: 95,
    most_used_reasoning_effort: 'xhigh',
    most_used_reasoning_effort_percentage: 62.37,
    top_invocations: [
      { type: 'plugin', plugin_id: 'p1', plugin_name: 'superpowers', skill_id: null, skill_name: null, usage_count: 438 },
      { type: 'skill', plugin_id: null, plugin_name: null, skill_id: 's1', skill_name: 'design-taste-frontend', usage_count: 48 },
    ],
    daily_usage_buckets: [
      { start_date: '2026-03-25', tokens: 448568 },
      { start_date: '2026-06-06', tokens: 880000 },
    ],
    cumulative_daily_usage_buckets: [{ start_date: '2026-03-25', tokens: 448568 }],
  },
  metadata: { stats_as_of: '2026-06-07', generated_at: '2026-06-07T11:46:14Z', stats_error: null },
};

describe('mapUsageResponse', () => {
  it('maps the 5h/7d windows with semantics intact (used_percent / reset_at epoch s)', () => {
    const snap = mapUsageResponse(USAGE_FIXTURE, 123);
    expect(snap.planType).toBe('prolite');
    expect(snap.main.primary).toEqual({ usedPercent: 1, windowSeconds: 18000, resetAt: 1780849681 });
    expect(snap.main.secondary?.windowSeconds).toBe(604800);
    expect(snap.fetchedAt).toBe(123);
  });
  it('maps named additional rate limits', () => {
    const snap = mapUsageResponse(USAGE_FIXTURE, 0);
    expect(snap.extras).toHaveLength(1);
    expect(snap.extras[0]!.name).toBe('GPT-5.3-Codex-Spark');
    expect(snap.extras[0]!.primary?.usedPercent).toBe(0);
  });
  it('tolerates null windows and clamps out-of-range percentages', () => {
    const snap = mapUsageResponse(
      { rate_limit: { primary_window: { used_percent: 150, limit_window_seconds: 18000 }, secondary_window: null } },
      0,
    );
    expect(snap.main.primary?.usedPercent).toBe(100);
    expect(snap.main.secondary).toBeUndefined();
    expect(snap.extras).toEqual([]);
  });
});

describe('mapProfileResponse', () => {
  it('maps stats, buckets and metadata', () => {
    const p = mapProfileResponse(PROFILE_FIXTURE);
    expect(p.displayName).toBe('Clay Zhang');
    expect(p.lifetimeTokens).toBe(4271434092);
    expect(p.peakDailyTokens).toBe(258804367);
    expect(p.currentStreakDays).toBe(20);
    expect(p.longestStreakDays).toBe(31);
    expect(p.longestTurnSec).toBe(4529);
    expect(p.dailyBuckets).toEqual([
      { date: '2026-03-25', tokens: 448568 },
      { date: '2026-06-06', tokens: 880000 },
    ]);
    expect(p.statsAsOf).toBe('2026-06-07');
  });
  it('flattens top invocations to plugin/skill names with kind', () => {
    const p = mapProfileResponse(PROFILE_FIXTURE);
    expect(p.topInvocations).toEqual([
      { name: 'superpowers', count: 438, kind: 'plugin' },
      { name: 'design-taste-frontend', count: 48, kind: 'skill' },
    ]);
    expect(p.totalSkillsUsed).toBe(1102);
    expect(p.uniqueSkillsUsed).toBe(95);
  });
  it('treats every field as optional (official contract is all-Option)', () => {
    const p = mapProfileResponse({});
    expect(p.lifetimeTokens).toBeUndefined();
    expect(p.dailyBuckets).toEqual([]);
    expect(p.topInvocations).toEqual([]);
  });
});

describe('jwtExpMs', () => {
  const fake = (payload: object): string =>
    `${Buffer.from('{"alg":"RS256"}').toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`;
  it('decodes exp (seconds) into milliseconds', () => {
    expect(jwtExpMs(fake({ exp: 1781101723 }))).toBe(1781101723000);
  });
  it('returns undefined for garbage', () => {
    expect(jwtExpMs('not-a-jwt')).toBeUndefined();
    expect(jwtExpMs(fake({}))).toBeUndefined();
  });
});

// ── CODEX_HOME 文件读取（临时目录隔离）─────────────────────────────────

describe('auth.json / config.toml readers', () => {
  let home: string | undefined;
  const prevHome = process.env.CODEX_HOME;
  afterEach(() => {
    if (home) rmSync(home, { recursive: true, force: true });
    home = undefined;
    if (prevHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevHome;
  });
  const setup = (files: Record<string, string>): void => {
    home = mkdtempSync(join(tmpdir(), 'codex-usage-test-'));
    process.env.CODEX_HOME = home;
    for (const [name, content] of Object.entries(files)) writeFileSync(join(home, name), content);
  };

  it('resolveCodexHome honors $CODEX_HOME', () => {
    setup({});
    expect(resolveCodexHome()).toBe(home);
  });

  it('reads chatgpt access token + account id', async () => {
    setup({
      'auth.json': JSON.stringify({
        auth_mode: 'chatgpt',
        last_refresh: '2026-06-07T12:07:02Z',
        tokens: { access_token: 'tok', account_id: 'acc-1', refresh_token: 'rt' },
      }),
    });
    const auth = await readCodexAuth();
    expect(auth.accessToken).toBe('tok');
    expect(auth.accountId).toBe('acc-1');
  });

  it('classifies a missing auth.json as no-auth', async () => {
    setup({});
    await expect(readCodexAuth()).rejects.toMatchObject({ kind: 'no-auth' });
  });

  it('classifies a token-less auth.json as api-key-mode', async () => {
    setup({ 'auth.json': JSON.stringify({ OPENAI_API_KEY: 'sk-xxx', auth_mode: 'apikey' }) });
    await expect(readCodexAuth()).rejects.toMatchObject({ kind: 'api-key-mode' });
  });

  it('retries then fails on persistently truncated JSON (non-atomic writer)', async () => {
    setup({ 'auth.json': '{"tokens": {"access_to' });
    await expect(readCodexAuth()).rejects.toMatchObject({ kind: 'no-auth' });
  });

  it('chatgptBaseUrl defaults without config.toml and respects the top-level key', async () => {
    setup({});
    expect(await chatgptBaseUrl()).toBe('https://chatgpt.com/backend-api');
    setup({ 'config.toml': 'model = "gpt-5"\nchatgpt_base_url = "https://corp.example.com/backend-api/"\n' });
    expect(await chatgptBaseUrl()).toBe('https://corp.example.com/backend-api'); // 尾斜杠剥掉
  });

  it('ignores chatgpt_base_url inside a [section] (top-level only)', async () => {
    setup({ 'config.toml': '[mcp_servers.x]\nchatgpt_base_url = "https://evil.example.com"\n' });
    expect(await chatgptBaseUrl()).toBe('https://chatgpt.com/backend-api');
  });
});

describe('UsageError', () => {
  it('carries a kind for card-side branching', () => {
    const e = new UsageError('need-relogin', 'x');
    expect(e.kind).toBe('need-relogin');
    expect(e).toBeInstanceOf(Error);
  });
});

describe('fetchUsageBundle', () => {
  const previousHome = process.env.CODEX_HOME;
  let home: string | undefined;

  afterEach(() => {
    vi.unstubAllGlobals();
    if (home) rmSync(home, { recursive: true, force: true });
    home = undefined;
    if (previousHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousHome;
  });

  it('waits for the other account request to settle before reporting a failure', async () => {
    home = mkdtempSync(join(tmpdir(), 'codex-usage-bundle-test-'));
    process.env.CODEX_HOME = home;
    writeFileSync(join(home, 'auth.json'), JSON.stringify({ tokens: { access_token: 'test-token' } }));

    let finishUsage: (response: Response) => void = () => {};
    const usageResponse = new Promise<Response>((resolve) => { finishUsage = resolve; });
    let markUsageStarted: () => void = () => {};
    const usageStarted = new Promise<void>((resolve) => { markUsageStarted = resolve; });
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.endsWith('/wham/profiles/me')) return Promise.resolve(new Response(null, { status: 503 }));
      if (url.endsWith('/wham/usage')) {
        markUsageStarted();
        return usageResponse;
      }
      throw new Error(`Unexpected request: ${url}`);
    }));

    let settled = false;
    const result = fetchUsageBundle(true).then(
      () => { settled = true; return undefined; },
      (error: unknown) => { settled = true; return error; },
    );
    await usageStarted;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);

    finishUsage(Response.json(USAGE_FIXTURE));
    expect(await result).toMatchObject({ kind: 'transient', message: 'HTTP 503 (/wham/profiles/me)' });
  });
});
