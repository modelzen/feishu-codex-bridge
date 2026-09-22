import { describe, expect, it, vi } from 'vitest';
import { UI_HTML } from '../src/web/ui';

// Exercise the shipped inline controller against a tiny DOM, no copied controller logic.
class Element {
  children: Element[] = [];
  style: Record<string, string> = {};
  attributes: Record<string, string> = {};
  isConnected = true;
  disabled = false;
  value = '';
  type = '';
  onclick?: () => void;
  onchange?: () => void;
  oninput?: () => void;
  constructor(public tag: string, public className = '', private text = '') {}
  appendChild(e: Element) { this.children.push(e); return e; }
  setAttribute(k: string, v: string) { this.attributes[k] = v; }
  get textContent(): string { return this.text + this.children.map(c => c.textContent).join(''); }
  set textContent(v: string) { this.text = v; this.children = []; }
  all(): Element[] { return [this, ...this.children.flatMap(c => c.all())]; }
}
function setup(feishuState = 'missing_permission') {
  const status = { enabled: true, feishu: { state: feishuState, message: '缺少权限' }, result: '缺少语音识别权限，请授权后测试。', grantUrl: 'https://open.feishu.cn/app/cli_a/auth' };
  const requests: Array<{ path: string; init: RequestInit | undefined }> = [];
  const fetch = vi.fn(async (path: string, init?: RequestInit) => { requests.push({ path, init }); return { ok: true, json: async () => init ? { ok: true } : status }; });
  const renderRoute = vi.fn(); const toast = vi.fn(); const loadState = vi.fn();
  const start = UI_HTML.indexOf('  var voiceBusy = {}');
  const end = UI_HTML.indexOf('  function renderBotOverview(', start);
  const render = new Function('el', 'fetch', 'renderRoute', 'toast', 'loadState', UI_HTML.slice(start, end) + '\nreturn renderVoiceCard;')(
    (tag: string, cls?: string, text?: string) => new Element(tag, cls, text), fetch, renderRoute, toast, loadState,
  ) as (root: Element, b: object) => void;
  const bot = { appId: 'cli_a', running: true };
  function page() { const root = new Element('root'); render(root, bot); return root; }
  return { page, requests, status, renderRoute, toast, loadState, bot };
}
function button(root: Element, label: string) { const found = root.all().find(e => e.tag === 'button' && e.textContent === label); expect(found).toBeTruthy(); return found!; }

describe('voice setup UI', () => {
  it('shows a single switch, concise notices, permission link and an independent test button', async () => {
    const t = setup(); const root = t.page();
    await vi.waitFor(() => expect(root.textContent).toContain('去授权'));
    const switches = root.all().filter(e => e.attributes.role === 'switch');
    expect(switches).toHaveLength(1);
    expect(switches[0]!.attributes['aria-checked']).toBe('true');
    expect(root.textContent).toContain('给 agent 发语音时，先转为文字再发送给 agent。');
    expect(root.textContent).toContain('若机器人所属租户为飞书免费版，则不支持调用');
    expect(root.textContent.indexOf('若机器人所属租户')).toBeLessThan(root.textContent.indexOf('已开启'));
    expect(root.all().filter(e => e.tag === 'button').at(-1)?.textContent).toBe('测试');
    expect(root.textContent).not.toContain('使用权益');
    expect(root.all().find(e => e.tag === 'a' && e.textContent === '飞书 ASR 文档')).toHaveProperty('href', 'https://open.feishu.cn/document/server-docs/ai/speech_to_text-v1/file_recognize?lang=zh-CN');
    expect(root.all().find(e => e.tag === 'a' && e.textContent === '去授权')).toHaveProperty('href', t.status.grantUrl);
    expect(root.all().filter(e => e.tag === 'select' || e.tag === 'details')).toHaveLength(0);
    button(root, '测试').onclick!();
    await vi.waitFor(() => expect(t.loadState).toHaveBeenCalled());
    expect(JSON.parse(String(t.requests.find(r => r.init)?.init?.body))).toEqual({ action: 'test' });
  });
  it('refreshes permission separately and removes authorization actions when permission is granted', async () => {
    const t = setup(); const root = t.page();
    await vi.waitFor(() => expect(root.textContent).toContain('重新检测'));
    button(root, '重新检测').onclick!();
    await vi.waitFor(() => expect(t.loadState).toHaveBeenCalled());
    expect(JSON.parse(String(t.requests.find(r => r.init)?.init?.body))).toEqual({ action: 'refreshPermission' });
    t.status.feishu.state = 'permission_ready'; t.status.result = '权限已就绪，可点击测试。';
    const refreshed = t.page();
    await vi.waitFor(() => expect(refreshed.textContent).toContain('权限已就绪'));
    expect(refreshed.textContent).not.toContain('去授权');
    expect(refreshed.textContent).not.toContain('重新检测');
    expect(button(refreshed, '测试').disabled).toBe(false);
  });
  it.each([true, false])('persists switch changes from enabled=%s', async enabled => {
    const t = setup(); t.status.enabled = enabled; const root = t.page();
    await vi.waitFor(() => expect(root.all().some(e => e.attributes.role === 'switch')).toBe(true));
    root.all().find(e => e.attributes.role === 'switch')!.onclick!();
    await vi.waitFor(() => expect(t.loadState).toHaveBeenCalled());
    expect(JSON.parse(String(t.requests.find(r => r.init)?.init?.body))).toEqual({ action: enabled ? 'disable' : 'enable' });
    if (!enabled) {
      expect(root.textContent).not.toContain('去授权');
      expect(root.all().some(e => e.tag === 'button' && e.textContent === '测试')).toBe(false);
    }
  });
  it('shows a short result and disables testing during rate-limit cooldown', async () => {
    const t = setup('temporary_error'); t.status.result = '请求受限，请稍后测试。';
    Object.assign(t.status.feishu, { code: '99991400', retryAt: Date.now() + 60_000 });
    const root = t.page();
    await vi.waitFor(() => expect(root.textContent).toContain('99991400'));
    expect(button(root, '测试').disabled).toBe(true);
    expect(root.textContent).not.toContain('去授权');
    expect(root.textContent).toContain('请求受限');
  });
  it('does not permit changes while the bot is stopped', async () => {
    const t = setup(); t.bot.running = false; const root = t.page();
    await vi.waitFor(() => expect(root.textContent).toContain('测试'));
    expect(button(root, '测试').disabled).toBe(true);
    expect(root.all().find(e => e.attributes.role === 'switch')!.disabled).toBe(true);
  });
});
