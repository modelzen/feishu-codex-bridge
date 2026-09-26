type Credentials = {
  appId: string;
  tenant: 'feishu' | 'lark';
  appSecret: string;
};

type CacheEntry = {
  avatarDataUrl?: string;
  expiresAt: number;
  pending?: Promise<void>;
};

const bases = { feishu: 'https://open.feishu.cn', lark: 'https://open.larksuite.com' } as const;
const allowedImageHosts = ['feishucdn.com', 'larksuitecdn.com', 'lark-cdn.com'];
const maxImageBytes = 256 * 1024;

function imageUrl(value: string): URL | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return undefined;
    if (!allowedImageHosts.some(host => url.hostname === host || url.hostname.endsWith(`.${host}`))) return undefined;
    return url;
  } catch { return undefined; }
}

function tokenFrom(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || !('code' in value) || value.code !== 0 ||
      !('tenant_access_token' in value) || typeof value.tenant_access_token !== 'string') return undefined;
  return value.tenant_access_token || undefined;
}

function avatarUrlFrom(value: unknown): URL | undefined {
  if (typeof value !== 'object' || value === null || !('code' in value) || value.code !== 0 ||
      !('bot' in value) || typeof value.bot !== 'object' || value.bot === null ||
      !('avatar_url' in value.bot) || typeof value.bot.avatar_url !== 'string') return undefined;
  return imageUrl(value.bot.avatar_url);
}

async function rasterDataUrl(response: Response): Promise<string | undefined> {
  if (!response.ok) return undefined;
  const media = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
  const mime = media === 'image/png' || media === 'image/jpeg' || media === 'image/webp' ? media : undefined;
  if (!mime || Number(response.headers.get('content-length') ?? 0) > maxImageBytes) return undefined;
  const reader = response.body?.getReader();
  if (!reader) return undefined;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maxImageBytes) { await reader.cancel(); return undefined; }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  if (!size) return undefined;
  const bytes = Buffer.concat(chunks);
  const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  const webp = bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  if (!((mime === 'image/png' && png) || (mime === 'image/jpeg' && jpeg) || (mime === 'image/webp' && webp))) return undefined;
  return `data:${mime};base64,${bytes.toString('base64')}`;
}

export function createAgentAvatarProvider(options: {
  credentials: (botId: string) => Promise<Credentials>;
  fetchImpl?: typeof fetch;
  now?: () => number;
}) {
  const request = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const cache = new Map<string, CacheEntry>();

  async function fetchAvatar(botId: string): Promise<string | undefined> {
    const credential = await options.credentials(botId);
    const base = bases[credential.tenant];
    const signal = AbortSignal.timeout(4_000);
    const tokenResponse = await request(`${base}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: credential.appId, app_secret: credential.appSecret }), signal, redirect: 'error',
    });
    if (!tokenResponse.ok) return undefined;
    const token = tokenFrom(await tokenResponse.json());
    if (!token) return undefined;
    const infoResponse = await request(`${base}/open-apis/bot/v3/info`, {
      headers: { Authorization: `Bearer ${token}` }, signal, redirect: 'error',
    });
    if (!infoResponse.ok) return undefined;
    const source = avatarUrlFrom(await infoResponse.json());
    if (!source) return undefined;
    const image = await request(source, { redirect: 'manual', signal });
    return rasterDataUrl(image);
  }

  return {
    get(botId: string): string | undefined { return cache.get(botId)?.avatarDataUrl; },
    refresh(botId: string): Promise<void> {
      const entry = cache.get(botId);
      if (entry?.pending) return entry.pending;
      if (entry && entry.expiresAt > now()) return Promise.resolve();
      const pending = fetchAvatar(botId).then(avatarDataUrl => {
        const current = cache.get(botId);
        if (!current || current.pending !== pending) return;
        cache.set(botId, { avatarDataUrl: avatarDataUrl ?? current.avatarDataUrl, expiresAt: now() + 10 * 60_000 });
      }).catch(() => {
        const current = cache.get(botId);
        if (current?.pending === pending) cache.set(botId, { avatarDataUrl: current.avatarDataUrl, expiresAt: now() + 60_000 });
      });
      cache.set(botId, { avatarDataUrl: entry?.avatarDataUrl, expiresAt: entry?.expiresAt ?? 0, pending });
      return pending;
    },
    retain(botIds: ReadonlySet<string>): void {
      for (const botId of cache.keys()) if (!botIds.has(botId)) cache.delete(botId);
    },
  };
}
