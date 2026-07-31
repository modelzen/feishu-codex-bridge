import { describe, expect, it } from 'vitest';
import { buildUpdateCard } from '../src/card/dm-cards';

describe('desktop manual-update DM card', () => {
  it('explains an unpublished desktop channel without claiming an npm or latest-version failure', () => {
    const card = buildUpdateCard({
      phase: 'checked',
      mode: 'manual',
      state: 'unpublished',
      current: '0.1.0',
      compatVersion: '0.6.10',
      latest: null,
      hasUpdate: false,
      dev: false,
      message: '桌面更新通道尚未发布，当前为测试构建。',
    });
    const json = JSON.stringify(card);

    expect(json).toContain('桌面更新通道尚未发布，当前为测试构建');
    expect(json).toContain('桌面版本');
    expect(json).toContain('0.1.0');
    expect(json).toContain('兼容内核');
    expect(json).toContain('0.6.10');
    expect(json).not.toContain('npm');
    expect(json).not.toContain('dm.update.do');
    expect(json).not.toContain('已是最新');
  });

  it('opens an HTTPS DMG or release page directly and never offers in-app installation', () => {
    const card = buildUpdateCard({
      phase: 'checked',
      mode: 'manual',
      state: 'available',
      current: '0.1.0',
      compatVersion: '0.6.10',
      latest: '0.2.0',
      hasUpdate: true,
      dev: false,
      message: '发现 Vonvon Bridge 桌面新版 v0.2.0，请手动下载并安装签名 DMG。',
      releasePageUrl: 'https://download.vonvon.example/releases/0.2.0',
      dmgUrl: 'https://download.vonvon.example/Vonvon-Bridge-0.2.0.dmg',
    });
    const json = JSON.stringify(card);

    expect(json).toContain('下载签名 DMG');
    expect(json).toContain('open_url');
    expect(json).toContain('https://download.vonvon.example/Vonvon-Bridge-0.2.0.dmg');
    expect(json).not.toContain('dm.update.do');
    expect(json).not.toContain('npm');
    expect(json).not.toContain('自动重启');
  });
});
