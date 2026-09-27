import { describe, expect, it, vi } from 'vitest';
import { createAgentAvatarProvider } from '../src/admin/avatar';

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
const url = 'https://s1-imfile.feishucdn.com/avatar.png';
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });

function provider(imageUrl = url) {
  const requests: string[] = [];
  const fetchImpl: typeof fetch = vi.fn(async input => {
    const href = String(input);
    requests.push(href);
    if (href.includes('tenant_access_token')) return json({ code: 0, tenant_access_token: 'private' });
    if (href.includes('bot/v3/info')) return json({ code: 0, bot: { avatar_url: imageUrl } });
    return new Response(png, { headers: { 'Content-Type': 'image/png' } });
  });
  const avatars = createAgentAvatarProvider({
    credentials: async () => ({ appId: 'cli_test', appSecret: 'private', tenant: 'feishu' }),
    fetchImpl,
  });
  return { avatars, requests, fetchImpl };
}

describe('admin Agent avatar', () => {
  it('refreshes asynchronously and returns a bounded raster without exposing credentials', async () => {
    const { avatars, requests, fetchImpl } = provider();
    expect(avatars.get('cli_test')).toBeUndefined();
    const first = avatars.refresh('cli_test');
    await avatars.refresh('cli_test');
    await first;
    expect(requests).toHaveLength(3);
    expect(avatars.get('cli_test')).toBe(`data:image/png;base64,${png.toString('base64')}`);
    await avatars.refresh('cli_test');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    avatars.retain(new Set());
    expect(avatars.get('cli_test')).toBeUndefined();
  });

  it('rejects untrusted image origins before downloading image bytes', async () => {
    const { avatars, requests } = provider('https://example.com/portrait.png');
    await avatars.refresh('cli_test');
    expect(requests).toHaveLength(2);
    expect(avatars.get('cli_test')).toBeUndefined();
  });


  it.each([
    ['redirect', () => new Response(null, {status: 302, headers: {Location: 'https://example.com/other.png'}})],
    ['oversize stream', () => new Response(Buffer.alloc(256 * 1024 + 1), {headers: {'Content-Type': 'image/png'}})],
    ['SVG', () => new Response('<svg></svg>', {headers: {'Content-Type': 'image/svg+xml'}})],
    ['false raster type', () => new Response('<svg></svg>', {headers: {'Content-Type': 'image/png'}})],
  ] as const)('does not publish %s as an Agent portrait', async (_name, imageResponse) => {
    const fetchImpl: typeof fetch = vi.fn(async input => {
      const href = String(input);
      if (href.includes('tenant_access_token')) return json({code: 0, tenant_access_token: 'private'});
      if (href.includes('bot/v3/info')) return json({code: 0, bot: {avatar_url: url}});
      return imageResponse();
    });
    const avatars = createAgentAvatarProvider({
      credentials: async () => ({appId: 'cli_test', appSecret: 'private', tenant: 'feishu'}), fetchImpl,
    });
    await avatars.refresh('cli_test');
    expect(avatars.get('cli_test')).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('keeps the last good avatar when a later fetch fails', async () => {
    let now = 0;
    let fail = false;
    const fetchImpl: typeof fetch = vi.fn(async input => {
      const href = String(input);
      if (fail) throw new Error('offline');
      if (href.includes('tenant_access_token')) return json({ code: 0, tenant_access_token: 'private' });
      if (href.includes('bot/v3/info')) return json({ code: 0, bot: { avatar_url: url } });
      return new Response(png, { headers: { 'Content-Type': 'image/png' } });
    });
    const avatars = createAgentAvatarProvider({
      credentials: async () => ({ appId: 'cli_test', appSecret: 'private', tenant: 'feishu' }),
      fetchImpl, now: () => now,
    });
    await avatars.refresh('cli_test');
    now = 11 * 60_000;
    fail = true;
    await avatars.refresh('cli_test');
    expect(avatars.get('cli_test')).toMatch(/^data:image\/png;base64,/);
  });
});
