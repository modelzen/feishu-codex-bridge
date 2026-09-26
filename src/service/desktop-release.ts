import { isNewer } from './update';

const API = 'https://api.github.com/repos/modelzen/vonvon-bridge/releases/latest';
const POSITIVE_TTL_MS = 15 * 60_000;
const NEGATIVE_TTL_MS = 3 * 60_000;
const REQUEST_TIMEOUT_MS = 2_000;

export interface DesktopInstaller {
  platform: 'macOS' | 'Windows';
  url: string;
}

export interface DesktopRelease {
  version: string;
  installers: [DesktopInstaller, ...DesktopInstaller[]];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Only advertise real, published native installers from the official release. */
export function parseDesktopRelease(value: unknown): DesktopRelease | null {
  if (!isRecord(value) || value.draft !== false || value.prerelease !== false || !Array.isArray(value.assets)) return null;
  if (typeof value.published_at !== 'string' || !Number.isFinite(Date.parse(value.published_at))) return null;
  const tag = value.tag_name;
  if (typeof tag !== 'string') return null;
  const version = tag.replace(/^v/, '');
  if (!/^\d+\.\d+\.\d+$/.test(version) || isNewer('0.7.0', version)) return null;

  const installers: DesktopInstaller[] = [];
  for (const item of value.assets) {
    if (!isRecord(item) || typeof item.name !== 'string' || typeof item.browser_download_url !== 'string') continue;
    if (item.state !== 'uploaded' || typeof item.size !== 'number' || item.size <= 0) continue;
    const name = item.name.toLowerCase();
    const url = item.browser_download_url;
    let parts: string[];
    try {
      const parsedUrl = new URL(url);
      if (parsedUrl.origin !== 'https://github.com' || parsedUrl.search || parsedUrl.hash) continue;
      parts = parsedUrl.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    } catch { continue; }
    if (parts.length !== 6 || parts.slice(0, 4).join('/') !== 'modelzen/vonvon-bridge/releases/download' || parts[4] !== tag || parts[5] !== item.name) continue;
    let platform: DesktopInstaller['platform'] | undefined;
    if (name === `vonvon-bridge-${version}-mac-arm64.pkg`) platform = 'macOS';
    if (name === `vonvon-bridge-${version}-win-x64.exe`) platform = 'Windows';
    if (platform && !installers.some((installer) => installer.platform === platform)) installers.push({ platform, url });
  }
  const first = installers[0];
  if (!first) return null;
  return { version, installers: [first, ...installers.slice(1)] };
}

/** Failed discovery is cached too, so Feishu messages cannot trigger a request storm. */
export function createDesktopReleaseLookup(
  fetcher: typeof fetch = fetch,
  now: () => number = Date.now,
  timeoutMs = REQUEST_TIMEOUT_MS,
): () => Promise<DesktopRelease | null> {
  let cached: { until: number; value: DesktopRelease | null } | undefined;
  let pending: Promise<DesktopRelease | null> | undefined;
  return async () => {
    if (cached && now() < cached.until) return cached.value;
    if (pending) return pending;
    pending = (async () => {
      let value: DesktopRelease | null = null;
      try {
        const response = await fetcher(API, {
          headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'vonvon-bridge-cli' },
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (response.ok) value = parseDesktopRelease(await response.json());
      } catch {
        // GitHub may be unavailable; CLI and message handling must still work.
      }
      cached = { until: now() + (value ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS), value };
      return value;
    })().finally(() => { pending = undefined; });
    return pending;
  };
}

export const getDesktopRelease = createDesktopReleaseLookup();

export function desktopInstallerForHost(release: DesktopRelease): DesktopInstaller | undefined {
  const platform = process.platform === 'darwin' && process.arch === 'arm64' ? 'macOS'
    : process.platform === 'win32' && process.arch === 'x64' ? 'Windows' : undefined;
  return release.installers.find((installer) => installer.platform === platform);
}

export function desktopReleaseNoticeForHost(release: DesktopRelease): string | null {
  const installer = desktopInstallerForHost(release);
  if (!installer) return null;
  return `Vonvon Bridge 桌面版 v${release.version} 已提供。安装后可接续已有 Agent、飞书群和配置，无需重新配置；CLI 仍可单独使用。\n${installer.platform} 安装包：${installer.url}`;
}
