import { describe, it, expect } from 'vitest';
import { UI_PURE_JS, UI_HTML } from '../src/web/ui';

/**
 * Web 控制台前端「纯逻辑片段」单测（design web-tabs.md / web-onboarding-qr.md /
 * backend-catalog-ondemand.md）。
 *
 * ui.ts 是单文件内嵌 HTML 字符串、client JS 不用反引号/${}，无 jsdom 也无构建。
 * 这里把 {@link UI_PURE_JS}（DOM-free 纯函数集合）用 new Function 取出来直接断言
 * —— 与真实页面运行的是同一份字符串（UI_HTML 内联了它），零漂移。
 */

// UI_PURE_JS 是一段函数声明集合；包一层 return 暴露需要测的函数。
const pure = new Function(
  UI_PURE_JS +
    '\nreturn { parseRoute, qrEncode, qrSvg, depTriState, groupBackends, summarizeState, parseSseDataBlock, scanStatusText, scanErrorText };',
)() as {
  parseRoute: (h: string) => { tab: string; botId?: string };
  qrEncode: (t: string) => { size: number; modules: boolean[][] };
  qrSvg: (t: string, opts?: { size?: number }) => string;
  depTriState: (e: { depState?: string; installable?: boolean }) => { state: string; label: string; action: string | null };
  groupBackends: (entries: { agentFamily: string }[]) => { family: string; entries: unknown[] }[];
  summarizeState: (s: unknown) => { total: number; online: number; projects: number; active: number };
  parseSseDataBlock: (block: string) => unknown;
  scanStatusText: (status: string) => string;
  scanErrorText: (code: string, message?: string) => string | null;
};

describe('ui.ts UI_PURE_JS 内联进 UI_HTML（同一份字符串，零漂移）', () => {
  it('UI_HTML 内联了 UI_PURE_JS 全文', () => {
    expect(UI_HTML).toContain(UI_PURE_JS);
  });

  it('每 bot 完成提醒设置展示四档、长任务阈值与保存接口', () => {
    for (const label of ['仅手动', '长任务', '失败或超时', '每次结束']) {
      expect(UI_HTML).toContain(label);
    }
    expect(UI_HTML).toContain('/completion-reminder');
    expect(UI_HTML).toContain('1–1440');
    expect(UI_HTML).toContain('运行卡不显示提醒按钮');
  });

  it('添加机器人只保留扫码，不暴露手填表单或 POST /api/bots', () => {
    expect(UI_HTML).not.toContain('已有飞书应用？手动填 App ID/Secret');
    expect(UI_HTML).not.toContain("fetch('/api/bots', {");
  });
});

describe('parseRoute —— hash 路由（overview / bot）', () => {
  it('空 hash → 仪表盘（控制台落地页）', () => {
    expect(pure.parseRoute('')).toEqual({ tab: 'overview' });
  });
  it('#overview → 仪表盘', () => {
    expect(pure.parseRoute('#overview')).toEqual({ tab: 'overview' });
  });
  it('#home → 营销首页（保留函数，仅直链可达，不在导航暴露）', () => {
    expect(pure.parseRoute('#home')).toEqual({ tab: 'home' });
  });
  it('#bot/<appId> → 该 bot（解 encodeURIComponent）', () => {
    expect(pure.parseRoute('#bot/cli_abc123')).toEqual({ tab: 'bot', botId: 'cli_abc123' });
  });
  it('appId 含特殊字符走 decodeURIComponent', () => {
    expect(pure.parseRoute('#bot/' + encodeURIComponent('cli_a/b c'))).toEqual({ tab: 'bot', botId: 'cli_a/b c' });
  });
  it('未知 hash 兜底仪表盘', () => {
    expect(pure.parseRoute('#whatever')).toEqual({ tab: 'overview' });
  });
  it('系统分页 #backends/#doctor/#logs → 对应 tab', () => {
    expect(pure.parseRoute('#backends')).toEqual({ tab: 'backends' });
    expect(pure.parseRoute('#doctor')).toEqual({ tab: 'doctor' });
    expect(pure.parseRoute('#logs')).toEqual({ tab: 'logs' });
  });
});

describe('depTriState —— 后端依赖三态', () => {
  it('installed → 就绪（无动作）', () => {
    expect(pure.depTriState({ depState: 'installed', installable: false })).toEqual({ state: 'installed', label: '✅ 就绪', action: null });
  });
  it('not-installed + installable → 可下载', () => {
    const t = pure.depTriState({ depState: 'not-installed', installable: true });
    expect(t.state).toBe('downloadable');
    expect(t.action).toBe('download');
  });
  it('external-missing（不可一键装）→ 手动', () => {
    const t = pure.depTriState({ depState: 'external-missing', installable: false });
    expect(t.state).toBe('manual');
    expect(t.action).toBe('manual');
  });
});

describe('groupBackends —— catalog 按 agentFamily 分组', () => {
  // codex-only：catalog 只剩 codex-appserver，分组结果只有一个 codex family 组。
  const entries = [{ id: 'codex-appserver', agentFamily: 'codex' }];
  it('codex 单组，保首次出现顺序', () => {
    const groups = pure.groupBackends(entries);
    expect(groups.map((g) => g.family)).toEqual(['codex']);
    expect(groups[0]!.entries).toHaveLength(1);
  });
  it('同 family 多接入归一组（分组逻辑通用性）', () => {
    // 用合成的同 family 多条目验证「按 agentFamily 聚合 + 保首次出现顺序」的通用逻辑。
    const groups = pure.groupBackends([
      { agentFamily: 'codex' },
      { agentFamily: 'codex' },
    ]);
    expect(groups.map((g) => g.family)).toEqual(['codex']);
    expect(groups[0]!.entries).toHaveLength(2);
  });
  it('空入参 → 空分组', () => {
    expect(pure.groupBackends([])).toEqual([]);
  });
});

describe('summarizeState —— 全局聚合摘要', () => {
  it('在线/项目/活跃集聚合', () => {
    const s = pure.summarizeState({
      bots: [
        { running: true, active: true, projects: [{}, {}] },
        { running: false, active: true, projects: [{}] },
        { running: true, active: false, projects: [] },
      ],
    });
    expect(s).toEqual({ total: 3, online: 2, projects: 3, active: 2 });
  });
  it('无 bots 安全归零', () => {
    expect(pure.summarizeState(null)).toEqual({ total: 0, online: 0, projects: 0, active: 0 });
    expect(pure.summarizeState({ bots: [] })).toEqual({ total: 0, online: 0, projects: 0, active: 0 });
  });
});

describe('parseSseDataBlock —— 安装进度 SSE 块解析', () => {
  it('event+data 块取出 JSON', () => {
    expect(pure.parseSseDataBlock('data: {"type":"log","chunk":"npm install"}')).toEqual({ type: 'log', chunk: 'npm install' });
  });
  it('done / error 块', () => {
    expect(pure.parseSseDataBlock('data: {"type":"done"}')).toEqual({ type: 'done' });
    expect(pure.parseSseDataBlock('data: {"type":"error","code":"not_wired_yet"}')).toEqual({ type: 'error', code: 'not_wired_yet' });
  });
  it('心跳 / 无 data 行 → null', () => {
    expect(pure.parseSseDataBlock(': ka')).toBeNull();
    expect(pure.parseSseDataBlock('')).toBeNull();
  });
  it('坏 JSON → null（不抛）', () => {
    expect(pure.parseSseDataBlock('data: {not json}')).toBeNull();
  });
});

describe('扫码 SSE 事件处理 —— status / error 文案映射', () => {
  it('status：polling/默认 → 等待扫码', () => {
    expect(pure.scanStatusText('polling')).toContain('扫码');
    expect(pure.scanStatusText('whatever')).toContain('扫码');
  });
  it('status：slow_down → 已降速', () => {
    expect(pure.scanStatusText('slow_down')).toContain('降速');
  });
  it('status：domain_switched → 国际版', () => {
    expect(pure.scanStatusText('domain_switched')).toContain('国际版');
  });
  it('error：abort → null（静默不弹）', () => {
    expect(pure.scanErrorText('abort')).toBeNull();
  });
  it('error：expired_token → 过期文案', () => {
    expect(pure.scanErrorText('expired_token')).toContain('过期');
  });
  it('error：access_denied → 取消/拒绝文案', () => {
    expect(pure.scanErrorText('access_denied')).toContain('取消');
  });
  it('error：identity_missing → 明确未保存并要求重新扫码', () => {
    expect(pure.scanErrorText('identity_missing')).toContain('没有保存');
    expect(pure.scanErrorText('identity_missing')).toContain('重新扫码');
  });
  it('error：未知 code → 透传 message，无 message 兜底', () => {
    expect(pure.scanErrorText('persist_failed', '写盘失败')).toBe('写盘失败');
    expect(pure.scanErrorText('unknown')).toContain('请重试');
  });
});

// ── QR 编码器：结构正确性（finder/timing/dark module）+ SVG 良构 ────────────────
//   无 jsdom/jsqr 依赖 → 用 QR 规范的硬结构特征做强校验（三个 finder 7x7 定位图案）。
function hasFinderAt(m: boolean[][], r0: number, c0: number): boolean {
  // 7x7 定位图案：外环全黑、第二环全白、3x3 中心全黑。
  for (let r = 0; r < 7; r++) {
    for (let c = 0; c < 7; c++) {
      const ring = r === 0 || r === 6 || c === 0 || c === 6;
      const inner = r >= 2 && r <= 4 && c >= 2 && c <= 4;
      const expect2 = ring || inner;
      if (m[r0 + r]![c0 + c] !== expect2) return false;
    }
  }
  return true;
}

describe('qrEncode —— 微型 QR 编码器结构正确', () => {
  it('短链接选小版本，模块矩阵方阵', () => {
    const qr = pure.qrEncode('https://open.feishu.cn/app');
    expect(qr.size).toBeGreaterThanOrEqual(21);
    expect(qr.modules).toHaveLength(qr.size);
    qr.modules.forEach((row) => expect(row).toHaveLength(qr.size));
  });
  it('三个角的 finder 定位图案正确（左上/右上/左下）', () => {
    const qr = pure.qrEncode('https://accounts.feishu.cn/open-apis/authen/v1/index?app_id=cli_xxx');
    const n = qr.size;
    expect(hasFinderAt(qr.modules, 0, 0)).toBe(true);
    expect(hasFinderAt(qr.modules, 0, n - 7)).toBe(true);
    expect(hasFinderAt(qr.modules, n - 7, 0)).toBe(true);
  });
  it('timing 图案（第 6 行/列交替）正确', () => {
    const qr = pure.qrEncode('hello world');
    const n = qr.size;
    for (let i = 8; i < n - 8; i++) {
      expect(qr.modules[6]![i]).toBe(i % 2 === 0);
      expect(qr.modules[i]![6]).toBe(i % 2 === 0);
    }
  });
  it('暗模块（size-8, 8）恒为黑', () => {
    const qr = pure.qrEncode('x');
    expect(qr.modules[qr.size - 8]![8]).toBe(true);
  });
  it('长数据自动升版（更大尺寸）', () => {
    const small = pure.qrEncode('hi');
    const big = pure.qrEncode('a'.repeat(300));
    expect(big.size).toBeGreaterThan(small.size);
  });
  it('UTF-8 中文不抛', () => {
    expect(() => pure.qrEncode('中文测试 https://feishu.cn/x')).not.toThrow();
  });
});

describe('qrSvg —— 给定 url 出有效 SVG', () => {
  it('良构 SVG：含 svg/rect 白底/path 黑格 + viewBox + 默认 220px', () => {
    const svg = pure.qrSvg('https://open.feishu.cn/app');
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg.endsWith('</svg>')).toBe(true);
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(svg).toContain('viewBox="0 0 ');
    expect(svg).toContain('<rect');
    expect(svg).toContain('fill="#ffffff"');
    expect(svg).toContain('<path d="M'); // 至少一个黑格
    expect(svg).toContain('width="220"');
    // 标签配平（无未闭合）
    expect((svg.match(/</g) || []).length).toBe((svg.match(/>/g) || []).length);
  });
  it('viewBox 尺寸 = 模块数 + 8（quiet zone 两侧各 4）', () => {
    const qr = pure.qrEncode('https://open.feishu.cn/app');
    const svg = pure.qrSvg('https://open.feishu.cn/app');
    const total = qr.size + 8;
    expect(svg).toContain('viewBox="0 0 ' + total + ' ' + total + '"');
  });
  it('opts.size 自定义像素', () => {
    expect(pure.qrSvg('x', { size: 180 })).toContain('width="180"');
  });
});
