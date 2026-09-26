import { describe, expect, it, vi } from 'vitest';
import { createDesktopReleaseLookup, parseDesktopRelease } from '../src/service/desktop-release';
import { buildDmMenuCard, buildUpdateCard } from '../src/card/dm-cards';

const tag = 'v0.7.0';
const macName = 'Vonvon-Bridge-0.7.0-mac-arm64.pkg';
const winName = 'Vonvon-Bridge-0.7.0-win-x64.exe';
const asset = (name: string) => ({
  name, state: 'uploaded', size: 1024,
  browser_download_url: `https://github.com/modelzen/vonvon-bridge/releases/download/${tag}/${name}`,
});
const release = (assets: unknown[] = [asset(macName), asset(winName)]) => ({
  tag_name: tag, draft: false, prerelease: false, published_at: '2026-09-26T00:00:00Z', assets,
});

describe('published desktop release guidance', () => {
  it('only accepts uploaded native installers from the same official release', () => {
    expect(parseDesktopRelease(release())).toMatchObject({ version: '0.7.0', installers: [{ platform: 'macOS' }, { platform: 'Windows' }] });
    expect(parseDesktopRelease({ ...release(), draft: true })).toBeNull();
    expect(parseDesktopRelease({ ...release(), prerelease: true })).toBeNull();
    expect(parseDesktopRelease({ ...release(), published_at: null })).toBeNull();
    expect(parseDesktopRelease(release([{ ...asset(macName), size: 0 }]))).toBeNull();
    expect(parseDesktopRelease(release([{ ...asset(macName), browser_download_url: `https://github.com/modelzen/vonvon-bridge/releases/download/v0.8.0/${macName}` }]))).toBeNull();
    expect(parseDesktopRelease(release([{ ...asset(macName), browser_download_url: `https://github.com/modelzen/vonvon-bridge/releases/download/${tag}/${winName}` }]))).toBeNull();
    expect(parseDesktopRelease(release([{ ...asset(macName), browser_download_url: `https://example.com/modelzen/vonvon-bridge/releases/download/${tag}/${macName}` }]))).toBeNull();
    expect(parseDesktopRelease(release([asset('vonvon-bridge-0.7.0-mac-arm64.tar.gz')]))).toBeNull();
    expect(parseDesktopRelease(release([asset('Vonvon-Bridge-0.7.0-win-arm64.exe')]))).toBeNull();
  });

  it('caches both published and unavailable results and shares concurrent requests', async () => {
    let time = 0;
    const fetcher = vi.fn(async () => new Response(JSON.stringify(release()), { status: 200 }));
    const lookup = createDesktopReleaseLookup(fetcher, () => time);
    const [first, second] = await Promise.all([lookup(), lookup()]);
    expect(first).toEqual(second);
    expect(fetcher).toHaveBeenCalledTimes(1);
    time = 14 * 60_000;
    await lookup();
    expect(fetcher).toHaveBeenCalledTimes(1);
    time = 16 * 60_000;
    expect(await lookup()).toEqual(first);
    expect(fetcher).toHaveBeenCalledTimes(2);

    const failedFetch = vi.fn(async () => { throw new Error('offline'); });
    const offline = createDesktopReleaseLookup(failedFetch, () => time);
    expect(await offline()).toBeNull();
    await offline();
    expect(failedFetch).toHaveBeenCalledTimes(1);
    time += 3 * 60_000;
    await offline();
    expect(failedFetch).toHaveBeenCalledTimes(2);

    const aborting = vi.fn((_input: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }));
    const timed = createDesktopReleaseLookup(aborting, () => time, 5);
    expect(await timed()).toBeNull();
    expect(aborting).toHaveBeenCalledTimes(1);
  });

  it('puts installer links near the top of the DM menu and update result only when published', () => {
    const available = parseDesktopRelease(release());
    expect(available).not.toBeNull();
    const menu = JSON.stringify(buildDmMenuCard({ desktopRelease: available }));
    expect(menu).toContain('Vonvon Bridge 桌面版');
    expect(menu).toContain(macName);
    expect(menu).toContain(winName);
    expect(menu.indexOf('桌面版')).toBeLessThan(menu.indexOf('私聊用于'));
    expect(JSON.stringify(buildDmMenuCard())).not.toContain('安装桌面版');
    const update = JSON.stringify(buildUpdateCard({ phase: 'checked', current: '0.7.0', latest: '0.7.0', hasUpdate: false, desktopRelease: available }));
    expect(update).toContain('安装桌面版');
    const bundled = JSON.stringify(buildUpdateCard({ phase: 'checked', current: '0.7.0', latest: '0.7.1', hasUpdate: true, distribution: 'bundled', desktopRelease: available }));
    expect(bundled).toContain('请在桌面应用中更新');
    expect(bundled).not.toContain('立即更新');
  });
});
