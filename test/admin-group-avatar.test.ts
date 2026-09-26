import { describe, expect, it, vi } from 'vitest';
import { createGroupAvatarProvider } from '../src/admin/avatar';

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const json = (value: unknown) => new Response(JSON.stringify(value));
const url = 'https://s1-imfile.feishucdn.com/group.png';
function fixture(options: { source?: string; image?: () => Response; block?: Promise<void> } = {}) {
  let now = 0;
  const credentials = vi.fn(async (botId: string) => ({appId: botId, appSecret: 'secret', tenant: 'feishu' as const}));
  const fetchImpl: typeof fetch = vi.fn(async input => {
    const href = String(input);
    if (href.includes('tenant_access_token')) {
      await options.block;
      return json({code: 0, tenant_access_token: 'private'});
    }
    if (href.includes('/im/v1/chats/')) return json({code: 0, data: {avatar: options.source ?? url}});
    return options.image?.() ?? new Response(png, {headers: {'Content-Type': 'image/png'}});
  });
  return {provider: createGroupAvatarProvider({credentials, fetchImpl, now: () => now}), fetchImpl, credentials, advance: () => { now += 11 * 60_000; }};
}

describe('group avatar metadata', () => {
  it('uses the chat API, isolates credentials by bot and shares in-flight work until TTL expiry', async () => {
    const {provider, fetchImpl, credentials, advance} = fixture();
    const first = provider.refresh('cli_a', 'oc_shared');
    expect(provider.refresh('cli_a', 'oc_shared')).toBe(first);
    await first;
    expect(provider.get('cli_a', 'oc_shared')).toBe(`data:image/png;base64,${png.toString('base64')}`);
    expect(provider.get('cli_b', 'oc_shared')).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledWith('https://open.feishu.cn/open-apis/im/v1/chats/oc_shared', expect.objectContaining({headers: {Authorization: 'Bearer private'}, redirect: 'error'}));
    await provider.refresh('cli_a', 'oc_shared');
    expect(credentials).toHaveBeenCalledTimes(1);
    await provider.refresh('cli_b', 'oc_shared');
    expect(credentials).toHaveBeenLastCalledWith('cli_b');
    advance();
    await provider.refresh('cli_a', 'oc_shared');
    expect(credentials).toHaveBeenCalledTimes(3);
    provider.retainChats('cli_a', new Set());
    expect(provider.get('cli_a', 'oc_shared')).toBeUndefined();
    expect(provider.get('cli_b', 'oc_shared')).toBeDefined();
    provider.retainBots(new Set());
    expect(provider.get('cli_b', 'oc_shared')).toBeUndefined();
  });

  it('limits active chains to two without queuing and does not resurrect pruned in-flight entries', async () => {
    let release = () => {};
    const block = new Promise<void>(resolve => { release = resolve; });
    const {provider, credentials} = fixture({block});
    const pending = [provider.refresh('a', 'one'), provider.refresh('b', 'two')];
    await Promise.all(Array.from({length: 500}, (_, i) => provider.refresh('c', String(i))));
    expect(credentials).toHaveBeenCalledTimes(2);
    provider.retainChats('a', new Set());
    provider.retainBots(new Set(['a', 'c']));
    release();
    await Promise.all(pending);
    expect(provider.get('a', 'one')).toBeUndefined();
    expect(provider.get('b', 'two')).toBeUndefined();
    await provider.refresh('c', 'later');
    expect(provider.get('c', 'later')).toBeDefined();
  });

  it('loads group 65 by evicting a settled entry while keeping the 64-entry bound', async () => {
    const {provider, credentials} = fixture();
    for (let i = 0; i < 65; i++) await provider.refresh('a', String(i));
    expect(credentials).toHaveBeenCalledTimes(65);
    expect(provider.get('a', '64')).toBeDefined();
    expect(provider.get('a', '0')).toBeUndefined();
    expect(Array.from({length: 65}, (_, i) => provider.get('a', String(i))).filter(Boolean)).toHaveLength(64);
    await provider.refresh('a', '0');
    expect(provider.get('a', '0')).toBeDefined();
    expect(provider.get('a', '1')).toBeUndefined();
  });

  it('preserves a pending entry when evicting at capacity', async () => {
    const {provider, credentials, advance} = fixture();
    for (let i = 0; i < 64; i++) await provider.refresh('a', String(i));
    advance();
    let release = () => {};
    const blocked = new Promise<void>(resolve => { release = resolve; });
    credentials.mockImplementationOnce(async botId => {
      await blocked;
      return {appId: botId, appSecret: 'secret', tenant: 'feishu'};
    });
    const pending = provider.refresh('a', '0');
    await provider.refresh('a', '64');
    expect(provider.refresh('a', '0')).toBe(pending);
    expect(provider.get('a', '1')).toBeUndefined();
    expect(provider.get('a', '64')).toBeDefined();
    release();
    await pending;
    expect(provider.get('a', '0')).toBeDefined();
    expect(Array.from({length: 65}, (_, i) => provider.get('a', String(i))).filter(Boolean)).toHaveLength(64);
  });

  it.each([
    {source: 'https://example.com/avatar.png'},
    {source: 'https://feishucdn.com.evil.example/avatar.png'},
    {image: () => new Response(null, {status: 302, headers: {Location: url}})},
    {image: () => new Response(Buffer.alloc(256 * 1024 + 1), {headers: {'Content-Type': 'image/png'}})},
    {image: () => new Response('<svg/>', {headers: {'Content-Type': 'image/png'}})},
  ])('rejects unsafe image input %#', async options => {
    const {provider} = fixture(options);
    await provider.refresh('a', 'one');
    expect(provider.get('a', 'one')).toBeUndefined();
  });
});
