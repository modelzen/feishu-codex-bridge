import { describe, expect, it, vi } from 'vitest';
import { configureEmbeddedRuntimeHost } from '../src/core/runtime-context';
import { DesktopReleaseProvider } from '../src/service/desktop-release';
import { checkUpdate, installLatest } from '../src/service/update';

describe('DesktopReleaseProvider', () => {
  it('reports an unpublished test build without touching the network when no manifest is configured', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const provider = new DesktopReleaseProvider({
      currentVersion: '0.1.0',
      fetchImpl,
    });

    await expect(provider.check()).resolves.toEqual({
      mode: 'manual',
      state: 'unpublished',
      current: '0.1.0',
      compatVersion: '0.6.10',
      latest: null,
      hasUpdate: false,
      dev: false,
      message: '桌面更新通道尚未发布，当前为测试构建。',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns a manual download handoff for a newer strictly valid HTTPS manifest', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      schemaVersion: 1,
      channel: 'stable',
      version: '0.2.0',
      releasePageUrl: 'https://download.vonvon.example/releases/0.2.0',
      dmgUrl: 'https://download.vonvon.example/releases/Vonvon-Bridge-0.2.0.dmg',
      critical: true,
      minimumMacOS: '14.0',
      sha256: 'a'.repeat(64),
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const provider = new DesktopReleaseProvider({
      currentVersion: '0.1.0',
      manifestUrl: 'https://download.vonvon.example/releases/stable.json',
      fetchImpl,
    });

    await expect(provider.check()).resolves.toEqual({
      mode: 'manual',
      state: 'available',
      current: '0.1.0',
      compatVersion: '0.6.10',
      latest: '0.2.0',
      hasUpdate: true,
      dev: false,
      message: '发现 Vonvon Bridge 桌面新版 v0.2.0，请手动下载并安装签名 DMG。',
      channel: 'stable',
      releasePageUrl: 'https://download.vonvon.example/releases/0.2.0',
      dmgUrl: 'https://download.vonvon.example/releases/Vonvon-Bridge-0.2.0.dmg',
      critical: true,
      minimumMacOS: '14.0',
      sha256: 'a'.repeat(64),
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://download.vonvon.example/releases/stable.json',
      expect.objectContaining({
        credentials: 'omit',
        redirect: 'error',
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it('treats equal and older channel versions as current using semantic-version precedence', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      schemaVersion: 1,
      channel: 'beta',
      version: '1.0.0-beta.10',
      releasePageUrl: 'https://download.vonvon.example/releases/1.0.0-beta.10',
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const provider = new DesktopReleaseProvider({
      currentVersion: '1.0.0',
      manifestUrl: 'https://download.vonvon.example/releases/beta.json',
      fetchImpl,
    });

    await expect(provider.check()).resolves.toMatchObject({
      mode: 'manual',
      state: 'current',
      current: '1.0.0',
      latest: '1.0.0-beta.10',
      hasUpdate: false,
      message: '当前桌面版本 v1.0.0 不低于发布通道版本 v1.0.0-beta.10。',
    });
  });

  it('compares arbitrary-size SemVer numeric identifiers without precision loss', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      schemaVersion: 1,
      channel: 'stable',
      version: '9007199254740993.0.0',
      releasePageUrl: 'https://download.vonvon.example/releases/large-version',
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const provider = new DesktopReleaseProvider({
      currentVersion: '9007199254740992.0.0',
      manifestUrl: 'https://download.vonvon.example/releases/stable.json',
      fetchImpl,
    });

    await expect(provider.check()).resolves.toMatchObject({
      state: 'available',
      latest: '9007199254740993.0.0',
      hasUpdate: true,
    });
  });

  it.each([
    {
      name: 'unknown manifest fields',
      manifest: {
        schemaVersion: 1,
        channel: 'stable',
        version: '0.2.0',
        releasePageUrl: 'https://download.vonvon.example/releases/0.2.0',
        installCommand: 'npm i -g something',
      },
    },
    {
      name: 'non-HTTPS handoff URL',
      manifest: {
        schemaVersion: 1,
        channel: 'stable',
        version: '0.2.0',
        dmgUrl: 'http://download.vonvon.example/Vonvon-Bridge.dmg',
      },
    },
  ])('rejects $name instead of exposing an unsafe handoff', async ({ manifest }) => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(
      JSON.stringify(manifest),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    const provider = new DesktopReleaseProvider({
      currentVersion: '0.1.0',
      manifestUrl: 'https://download.vonvon.example/releases/stable.json',
      fetchImpl,
    });

    await expect(provider.check()).resolves.toEqual({
      mode: 'manual',
      state: 'unavailable',
      current: '0.1.0',
      compatVersion: '0.6.10',
      latest: null,
      hasUpdate: false,
      dev: false,
      message: '暂时无法检查桌面更新，请稍后重试。当前桌面版本 v0.1.0。',
    });
  });

  it('rejects a JSON-looking body served with an invalid media type', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      schemaVersion: 1,
      channel: 'stable',
      version: '0.2.0',
      releasePageUrl: 'https://download.vonvon.example/releases/0.2.0',
    }), {
      status: 200,
      headers: { 'content-type': 'application/jsonp' },
    }));
    const provider = new DesktopReleaseProvider({
      currentVersion: '0.1.0',
      manifestUrl: 'https://download.vonvon.example/releases/stable.json',
      fetchImpl,
    });

    await expect(provider.check()).resolves.toMatchObject({
      state: 'unavailable',
      hasUpdate: false,
    });
  });

  it('rejects a non-HTTPS manifest configuration before making a request', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const provider = new DesktopReleaseProvider({
      currentVersion: '0.1.0',
      manifestUrl: 'http://download.vonvon.example/releases/stable.json',
      fetchImpl,
    });

    await expect(provider.check()).resolves.toMatchObject({
      state: 'unavailable',
      hasUpdate: false,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('cancels a manifest body as soon as it crosses the response-size limit', async () => {
    let cancelled = false;
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new TextEncoder().encode('x'.repeat(10)));
        if (pulls === 3) controller.close();
      },
      cancel() {
        cancelled = true;
      },
    }, { highWaterMark: 0 });
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(body, {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const provider = new DesktopReleaseProvider({
      currentVersion: '0.1.0',
      manifestUrl: 'https://download.vonvon.example/releases/stable.json',
      fetchImpl,
      maxResponseBytes: 15,
    });

    await expect(provider.check()).resolves.toMatchObject({
      state: 'unavailable',
      hasUpdate: false,
    });
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThan(3);
  });

  it('bounds manifest requests with an abort timeout and returns a non-fatal unavailable state', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), {
        once: true,
      });
    }));
    const provider = new DesktopReleaseProvider({
      currentVersion: '0.1.0',
      manifestUrl: 'https://download.vonvon.example/releases/stable.json',
      fetchImpl,
      timeoutMs: 5,
    });

    await expect(provider.check()).resolves.toMatchObject({
      mode: 'manual',
      state: 'unavailable',
      current: '0.1.0',
      hasUpdate: false,
    });
  });

  it('routes the embedded compatibility update check through the desktop release provider', async () => {
    const provider = new DesktopReleaseProvider({ currentVersion: '0.1.0' });
    const release = configureEmbeddedRuntimeHost({
      requestRestart() {},
      checkUpdate: () => provider.check(),
    });
    try {
      await expect(checkUpdate()).resolves.toMatchObject({
        mode: 'manual',
        state: 'unpublished',
        current: '0.1.0',
        compatVersion: '0.6.10',
      });
    } finally {
      release();
    }
  });

  it('refuses the legacy global npm installer while running inside the desktop host', async () => {
    const release = configureEmbeddedRuntimeHost({
      requestRestart() {},
      checkUpdate: () => new DesktopReleaseProvider({ currentVersion: '0.1.0' }).check(),
    });
    try {
      await expect(installLatest()).resolves.toEqual({
        ok: false,
        message: 'Vonvon Bridge 桌面版由桌面应用管理更新，不会改写旧版全局 CLI。',
      });
    } finally {
      release();
    }
  });
});
