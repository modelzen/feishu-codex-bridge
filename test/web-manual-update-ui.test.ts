import { describe, expect, it } from 'vitest';
import { UI_HTML } from '../src/web/ui';

describe('desktop manual-update Web UI', () => {
  it('renders manual release handoff links and contains no in-app npm update request', () => {
    expect(UI_HTML).toContain("u.mode === 'manual'");
    expect(UI_HTML).toContain('u.dmgUrl || u.releasePageUrl');
    expect(UI_HTML).toContain('手动下载');
    expect(UI_HTML).not.toContain("fetch('/api/update',");
    expect(UI_HTML).not.toContain('npm i -g 安装最新版');
    expect(UI_HTML).not.toContain('更新并重启 · v');
  });
});
