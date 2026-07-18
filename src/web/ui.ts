/**
 * Web 控制台前端 —— 单文件内嵌 HTML（零依赖、零构建）。
 *
 * 为什么是 .ts 模板字符串而不是独立 ui.html：tsup 打包 / tsc / vitest 三方都
 * 无需任何额外配置（.html 文件要么得加 esbuild loader + d.ts，要么得改 vitest
 * 配置），这是"实现最干净的一种"。约定：内嵌的 client JS **不用反引号、不用
 * ${}**（全部字符串拼接）；外层模板字符串（本文件 TS 层）可用 ${} 把若干「纯
 * 逻辑」JS 片段拼进来 —— 这些片段（{@link UI_PURE_JS}）是 DOM-free 纯函数，
 * 既内联进页面、又被单测 new Function 取出来直接断言（无需 jsdom）。
 *
 * 架构（design web-tabs.md）：hash 路由的多 Tab——📊 总览（全局：daemon / 多
 * bot 聚合 / 宿主机体检 / 🧠 后端管理卡 / ➕ 添加 / 全局日志）+ 每 bot 一个 Tab
 * （该 bot 概览 / setup 诊断 / 项目列表 + 设置抽屉 / 停用·删除）。单 #tabContent
 * 按路由清空重渲；SSE 日志全程只连一次不随 Tab 断。
 *
 * UI 风格贴飞书 DM 卡片：卡片块 + 圆角 + 标签 + 蓝主按钮（#3370ff），中文文案与
 * src/card/dm-cards.ts 同款 emoji 标签（🧠 后端 / 🔐 权限 / 🩺 诊断 / ✋ 免@ /
 * 🗜️ 自动压缩 / 🧵 话题 / 👥 多话题群 / 💬 单会话群）。
 */

/**
 * 纯逻辑片段（DOM-free，单测直接 new Function 取出断言）：
 *   parseRoute       hash → { tab:'overview' } | { tab:'bot', botId }
 *   qrEncode/qrSvg   零依赖微型 QR 编码器（byte 模式·ECC M·自动选版选 mask）→ SVG
 *   depTriState      后端依赖三态 → { state, label, action }（下载 / 手动 / 就绪）
 *   groupBackends    catalog 条目按 agentFamily 分组（Codex / Claude）
 *   summarizeState   /api/state 快照 → 全局聚合摘要（在线 N/M · 项目数 · 活跃集）
 * 约束：纯字符串拼接、不用反引号 / ${}（这段会被原样塞进 <script>）。
 */
export const UI_PURE_JS = `
  // ── hash 路由：''/#overview → 仪表盘；#bot/<appId> → 某机器人；#backends/#doctor/#logs
  //    → 系统分页（后端管理 / 宿主机体检 / 实时日志）。侧栏导航与这些一一对应。──────────
  function parseRoute(hash) {
    var h = (hash || '').replace(/^#/, '');
    if (h.indexOf('bot/') === 0) return { tab: 'bot', botId: decodeURIComponent(h.slice(4)) };
    if (h === 'overview' || h === 'backends' || h === 'doctor' || h === 'logs' || h === 'home') return { tab: h };
    return { tab: 'overview' }; // 空 hash / 未知 → 仪表盘（控制台落地页；营销首页仅 #home 直链可达）
  }

  // ── 后端依赖三态（catalog entry → 渲染语义）─────────────────────────────────
  //   installed       已装 → { state:'installed', label:'✅ 就绪' }
  //   not-installed   npm-ondemand 未装 → { state:'downloadable', action:'download' }
  //   external-missing 外部 CLI/适配器缺失 → { state:'manual', action:'manual' }
  function depTriState(entry) {
    if (entry.depState === 'installed') return { state: 'installed', label: '✅ 就绪', action: null };
    if (entry.installable) return { state: 'downloadable', label: '⬇️ 可下载', action: 'download' };
    return { state: 'manual', label: '⚠️ 未安装', action: 'manual' };
  }

  // ── catalog 条目按 agentFamily 分组（picker / 后端管理卡都用）────────────────
  // 返回 [{ family:'codex', entries:[…] }, { family:'claude', entries:[…] }, …]，
  // 顺序按首次出现，codex 永远在前（catalog 第一条即 codex）。
  function groupBackends(entries) {
    var order = [], byFamily = {};
    (entries || []).forEach(function (e) {
      if (!byFamily[e.agentFamily]) { byFamily[e.agentFamily] = []; order.push(e.agentFamily); }
      byFamily[e.agentFamily].push(e);
    });
    return order.map(function (f) { return { family: f, entries: byFamily[f] }; });
  }

  // ── /api/state 快照 → 全局聚合摘要 ──────────────────────────────────────────
  function summarizeState(state) {
    var bots = (state && state.bots) || [];
    var online = 0, projects = 0, active = 0;
    bots.forEach(function (b) {
      if (b.running) online++;
      if (b.active) active++;
      projects += (b.projects && b.projects.length) || 0;
    });
    return { total: bots.length, online: online, projects: projects, active: active };
  }

  // ── 扫码 SSE 事件 → 文案映射（事件处理核心，DOM-free 纯逻辑）─────────────────
  // status 事件：polling / slow_down / domain_switched → 顶部细字提示。
  function scanStatusText(status) {
    if (status === 'slow_down') return '📱 等待扫码…（已降速）';
    if (status === 'domain_switched') return '📱 已识别国际版租户，等待扫码…';
    return '📱 用飞书扫码并确认创建…';
  }
  // error 事件：读 SDK reject 的 code（非 instanceof）→ 文案。abort=null（静默不弹）。
  function scanErrorText(code, message) {
    if (code === 'abort') return null;
    if (code === 'expired_token') return '二维码已过期，请重新生成。';
    if (code === 'access_denied') return '你在飞书里取消或拒绝了创建。';
    if (code === 'identity_missing') return '未获取到你的飞书身份，机器人没有保存。请重新扫码并确认授权。';
    return message || '创建失败，请重试。';
  }

  // ── SSE 块解析：从 fetch 流式安装的一个「event: …\\ndata: {json}」块取出 JSON。──
  // 返回 parse 后的对象或 null（无 data 行 / JSON 坏）。用于后端安装进度流。
  function parseSseDataBlock(block) {
    var dataLine = null;
    (block || '').split('\\n').forEach(function (l) { if (l.indexOf('data:') === 0) dataLine = l.slice(5).trim(); });
    if (!dataLine) return null;
    try { return JSON.parse(dataLine); } catch (e) { return null; }
  }

  // ── 微型 QR 编码器（Model 2 · byte 模式 · ECC M · 自动选版 + 选 mask）────────
  // 端口自 Nayuki QR Code generator（MIT）核心。返回 { size, modules:[[bool]] }。
  function qrEncode(text) {
    var bytes = qrUtf8Bytes(text);
    var version = 0, dataCapBits = 0;
    for (var v = 1; v <= 40; v++) {
      var cap = qrNumDataCodewords(v) * 8;
      var ccBits = v < 10 ? 8 : 16;
      var used = 4 + ccBits + bytes.length * 8;
      if (used <= cap) { version = v; dataCapBits = cap; break; }
    }
    if (!version) throw new Error('数据过长，无法编码为二维码');
    var bb = [];
    qrAppendBits(bb, 0x4, 4);
    qrAppendBits(bb, bytes.length, version < 10 ? 8 : 16);
    for (var i = 0; i < bytes.length; i++) qrAppendBits(bb, bytes[i], 8);
    qrAppendBits(bb, 0, Math.min(4, dataCapBits - bb.length));
    qrAppendBits(bb, 0, (8 - bb.length % 8) % 8);
    for (var pad = 0xEC; bb.length < dataCapBits; pad ^= 0xEC ^ 0x11) qrAppendBits(bb, pad, 8);
    var dataCodewords = [];
    for (var k = 0; k < bb.length; k += 8) {
      var byte = 0;
      for (var b = 0; b < 8; b++) byte = (byte << 1) | bb[k + b];
      dataCodewords.push(byte);
    }
    var allCodewords = qrAddEcc(dataCodewords, version);
    var size = version * 4 + 17;
    var modules = [], isFn = [];
    for (var r = 0; r < size; r++) { modules.push(new Array(size).fill(false)); isFn.push(new Array(size).fill(false)); }
    qrDrawFunctionPatterns(modules, isFn, size, version);
    qrDrawCodewords(modules, isFn, size, allCodewords);
    var bestMask = 0, minPenalty = Infinity;
    for (var msk = 0; msk < 8; msk++) {
      qrApplyMask(modules, isFn, size, msk);
      qrDrawFormatBits(modules, isFn, size, msk);
      var pen = qrPenalty(modules, size);
      if (pen < minPenalty) { minPenalty = pen; bestMask = msk; }
      qrApplyMask(modules, isFn, size, msk);
    }
    qrApplyMask(modules, isFn, size, bestMask);
    qrDrawFormatBits(modules, isFn, size, bestMask);
    return { size: size, modules: modules };
  }
  function qrUtf8Bytes(s) {
    var out = [];
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) { out.push(0xC0 | (c >> 6), 0x80 | (c & 0x3F)); }
      else if (c >= 0xD800 && c <= 0xDBFF) {
        var c2 = s.charCodeAt(++i);
        var cp = 0x10000 + ((c & 0x3FF) << 10) + (c2 & 0x3FF);
        out.push(0xF0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3F), 0x80 | ((cp >> 6) & 0x3F), 0x80 | (cp & 0x3F));
      } else { out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 0x3F), 0x80 | (c & 0x3F)); }
    }
    return out;
  }
  function qrAppendBits(bb, val, len) { for (var i = len - 1; i >= 0; i--) bb.push((val >>> i) & 1); }
  var QR_ECC_CW = [-1,10,16,26,18,24,16,18,22,22,26,30,22,22,24,24,28,28,26,26,26,26,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28];
  var QR_ECC_BLOCKS = [-1,1,1,1,2,2,4,4,4,5,5,5,8,9,9,10,10,11,13,14,16,17,17,18,20,21,23,25,26,28,29,31,33,35,37,38,40,43,45,47,49];
  function qrNumRawDataModules(ver) {
    var result = (16 * ver + 128) * ver + 64;
    if (ver >= 2) { var n = Math.floor(ver / 7) + 2; result -= (25 * n - 10) * n - 55; if (ver >= 7) result -= 36; }
    return result;
  }
  function qrNumDataCodewords(ver) {
    return Math.floor(qrNumRawDataModules(ver) / 8) - QR_ECC_CW[ver] * QR_ECC_BLOCKS[ver];
  }
  function qrGfMul(x, y) {
    var z = 0;
    for (var i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11D); z ^= ((y >>> i) & 1) * x; }
    return z & 0xFF;
  }
  function qrReedSolomonDivisor(degree) {
    var result = [];
    for (var i = 0; i < degree - 1; i++) result.push(0);
    result.push(1);
    var root = 1;
    for (var j = 0; j < degree; j++) {
      for (var m = 0; m < result.length; m++) {
        result[m] = qrGfMul(result[m], root);
        if (m + 1 < result.length) result[m] ^= result[m + 1];
      }
      root = qrGfMul(root, 0x02);
    }
    return result;
  }
  function qrReedSolomonRemainder(data, divisor) {
    var result = divisor.map(function () { return 0; });
    data.forEach(function (b) {
      var factor = b ^ result.shift();
      result.push(0);
      divisor.forEach(function (coef, i) { result[i] ^= qrGfMul(coef, factor); });
    });
    return result;
  }
  function qrAddEcc(data, ver) {
    var numBlocks = QR_ECC_BLOCKS[ver], blockEccLen = QR_ECC_CW[ver];
    var rawCodewords = Math.floor(qrNumRawDataModules(ver) / 8);
    var numShort = numBlocks - rawCodewords % numBlocks;
    var shortLen = Math.floor(rawCodewords / numBlocks);
    var blocks = [], rsDiv = qrReedSolomonDivisor(blockEccLen), k = 0;
    for (var i = 0; i < numBlocks; i++) {
      var datLen = shortLen - blockEccLen + (i < numShort ? 0 : 1);
      var dat = data.slice(k, k + datLen); k += datLen;
      var ecBytes = qrReedSolomonRemainder(dat, rsDiv);
      if (i < numShort) dat.push(0);
      blocks.push(dat.concat(ecBytes));
    }
    var result = [];
    for (var idx = 0; idx < blocks[0].length; idx++) {
      for (var b = 0; b < blocks.length; b++) {
        if (idx !== shortLen - blockEccLen || b >= numShort) result.push(blocks[b][idx]);
      }
    }
    return result;
  }
  function qrSetFn(m, isFn, r, c, val) { m[r][c] = val; isFn[r][c] = true; }
  function qrGetBit(x, i) { return ((x >>> i) & 1) !== 0; }
  function qrDrawFunctionPatterns(m, isFn, size, ver) {
    for (var i = 0; i < size; i++) { qrSetFn(m, isFn, 6, i, i % 2 === 0); qrSetFn(m, isFn, i, 6, i % 2 === 0); }
    qrFinder(m, isFn, size, 3, 3); qrFinder(m, isFn, size, size - 4, 3); qrFinder(m, isFn, size, 3, size - 4);
    var pos = qrAlignPositions(ver), n = pos.length;
    for (var a = 0; a < n; a++) for (var b = 0; b < n; b++) {
      if ((a === 0 && b === 0) || (a === 0 && b === n - 1) || (a === n - 1 && b === 0)) continue;
      qrAlignment(m, isFn, pos[a], pos[b]);
    }
    qrDrawFormatBits(m, isFn, size, 0);
    qrDrawVersion(m, isFn, size, ver);
  }
  function qrFinder(m, isFn, size, cx, cy) {
    for (var dy = -4; dy <= 4; dy++) for (var dx = -4; dx <= 4; dx++) {
      var dist = Math.max(Math.abs(dx), Math.abs(dy)), xx = cx + dx, yy = cy + dy;
      if (xx >= 0 && xx < size && yy >= 0 && yy < size) qrSetFn(m, isFn, yy, xx, dist !== 2 && dist !== 4);
    }
  }
  function qrAlignment(m, isFn, cx, cy) {
    for (var dy = -2; dy <= 2; dy++) for (var dx = -2; dx <= 2; dx++) qrSetFn(m, isFn, cy + dy, cx + dx, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }
  function qrAlignPositions(ver) {
    if (ver === 1) return [];
    var n = Math.floor(ver / 7) + 2;
    var step = Math.floor((ver * 8 + n * 3 + 5) / (n * 4 - 4)) * 2;
    var result = [6];
    for (var pos = ver * 4 + 10; result.length < n; pos -= step) result.splice(1, 0, pos);
    return result;
  }
  function qrDrawFormatBits(m, isFn, size, mask) {
    var data = (0 << 3) | mask; // ECC M = 0b00
    var rem = data;
    for (var i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    var bits = (data << 10 | rem) ^ 0x5412;
    for (var i2 = 0; i2 <= 5; i2++) qrSetFn(m, isFn, i2, 8, qrGetBit(bits, i2));
    qrSetFn(m, isFn, 7, 8, qrGetBit(bits, 6));
    qrSetFn(m, isFn, 8, 8, qrGetBit(bits, 7));
    qrSetFn(m, isFn, 8, 7, qrGetBit(bits, 8));
    for (var i3 = 9; i3 < 15; i3++) qrSetFn(m, isFn, 8, 14 - i3, qrGetBit(bits, i3));
    for (var i4 = 0; i4 < 8; i4++) qrSetFn(m, isFn, 8, size - 1 - i4, qrGetBit(bits, i4));
    for (var i5 = 8; i5 < 15; i5++) qrSetFn(m, isFn, size - 15 + i5, 8, qrGetBit(bits, i5));
    qrSetFn(m, isFn, size - 8, 8, true);
  }
  function qrDrawVersion(m, isFn, size, ver) {
    if (ver < 7) return;
    var rem = ver;
    for (var i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
    var bits = ver << 12 | rem;
    for (var i2 = 0; i2 < 18; i2++) {
      var bit = qrGetBit(bits, i2), a = size - 11 + i2 % 3, b = Math.floor(i2 / 3);
      qrSetFn(m, isFn, b, a, bit); qrSetFn(m, isFn, a, b, bit);
    }
  }
  function qrDrawCodewords(m, isFn, size, codewords) {
    var i = 0;
    for (var right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (var vert = 0; vert < size; vert++) {
        for (var j = 0; j < 2; j++) {
          var col = right - j, upward = ((right + 1) & 2) === 0, row = upward ? size - 1 - vert : vert;
          if (!isFn[row][col] && i < codewords.length * 8) {
            m[row][col] = qrGetBit(codewords[i >>> 3], 7 - (i & 7)); i++;
          }
        }
      }
    }
  }
  function qrApplyMask(m, isFn, size, mask) {
    for (var r = 0; r < size; r++) for (var c = 0; c < size; c++) {
      if (isFn[r][c]) continue;
      var invert = false;
      if (mask === 0) invert = (r + c) % 2 === 0;
      else if (mask === 1) invert = r % 2 === 0;
      else if (mask === 2) invert = c % 3 === 0;
      else if (mask === 3) invert = (r + c) % 3 === 0;
      else if (mask === 4) invert = (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
      else if (mask === 5) invert = (r * c) % 2 + (r * c) % 3 === 0;
      else if (mask === 6) invert = ((r * c) % 2 + (r * c) % 3) % 2 === 0;
      else if (mask === 7) invert = ((r + c) % 2 + (r * c) % 3) % 2 === 0;
      if (invert) m[r][c] = !m[r][c];
    }
  }
  function qrPenalty(m, size) {
    var penalty = 0, r, c;
    for (r = 0; r < size; r++) { var rc = m[r][0], rl = 1; for (c = 1; c < size; c++) { if (m[r][c] === rc) { rl++; if (rl === 5) penalty += 3; else if (rl > 5) penalty++; } else { rc = m[r][c]; rl = 1; } } }
    for (c = 0; c < size; c++) { var cc = m[0][c], cl = 1; for (r = 1; r < size; r++) { if (m[r][c] === cc) { cl++; if (cl === 5) penalty += 3; else if (cl > 5) penalty++; } else { cc = m[r][c]; cl = 1; } } }
    for (r = 0; r < size - 1; r++) for (c = 0; c < size - 1; c++) { var col = m[r][c]; if (col === m[r][c + 1] && col === m[r + 1][c] && col === m[r + 1][c + 1]) penalty += 3; }
    return penalty;
  }

  // ── QR → SVG 字符串（quiet zone 4 模块，路径合并所有黑格）────────────────────
  function qrSvg(text, opts) {
    var px = (opts && opts.size) || 220;
    var qr = qrEncode(text);
    var n = qr.size, border = 4, total = n + border * 2;
    var path = '';
    for (var r = 0; r < n; r++) for (var c = 0; c < n; c++) {
      if (qr.modules[r][c]) path += 'M' + (c + border) + ',' + (r + border) + 'h1v1h-1z';
    }
    return '<svg xmlns="http://www.w3.org/2000/svg" width="' + px + '" height="' + px +
      '" viewBox="0 0 ' + total + ' ' + total + '" shape-rendering="crispEdges" role="img" aria-label="登录二维码">' +
      '<rect width="' + total + '" height="' + total + '" fill="#ffffff"/>' +
      '<path d="' + path + '" fill="#000000"/></svg>';
  }
`;

export const UI_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="/vendor/logo.png">
<title>Feishu Bridge 管理台</title>
<style>
  :root {
    /* Linear/Cursor 风：近黑底 + 极细描边 + 靛蓝点睛 + 绿点在线 + 克制小圆角。 */
    --accent: #6e79f2;          /* 靛蓝：主按钮 / 选中 / 强调 */
    --accent-2: #9a8cf2;        /* 亮紫：渐变端 */
    --accent-hover: #7f89f5;
    --accent-press: #5a66e6;
    --accent-dim: rgba(110,121,242,.16);
    --blue: #6e79f2;            /* 兼容旧 class（.progress/.spin/.tag.blue 等取它） */
    --blue-tint: rgba(110,121,242,.16);
    --bg: #0d0d10;             /* 主背景：近黑 */
    --bg-2: #09090b;           /* 侧栏 */
    --card: #141417;           /* 面板/卡片实底 */
    --card-solid: #141417;
    --panel: #141417;
    --panel-2: #17171b;        /* 抬升面（图标底、行内块） */
    --hover: #1b1b20;          /* 行/项 hover */
    --border: rgba(255,255,255,.07);
    --border-2: rgba(255,255,255,.12);
    --text: #e7e7ea;
    --text-2: #9a9aa3;
    --text-3: #67676f;
    --green: #3ecf6a; --green-tint: rgba(62,207,106,.14);
    --orange: #e3a93c; --orange-tint: rgba(227,169,60,.14);
    --red: #f2566b; --red-tint: rgba(242,86,107,.13);
    --radius: 12px;
    --radius-sm: 9px;
    --mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, "JetBrains Mono", "Roboto Mono", monospace;
    --shadow-sm: 0 1px 2px rgba(0,0,0,.3), 0 8px 24px rgba(0,0,0,.28);
    --shadow-md: 0 16px 44px rgba(0,0,0,.45);
    --shadow-lg: 0 30px 80px rgba(0,0,0,.6);
    --glow: 0 0 0 1px rgba(110,121,242,.45), 0 10px 36px rgba(110,121,242,.16);
    --pill: 8px;               /* Linear 按钮是小圆角，不再是全药丸 */
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; color: var(--text); background: var(--bg);
    font: 13.5px/1.55 -apple-system, BlinkMacSystemFont, "Inter", "SF Pro Text", "Segoe UI",
      "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
    -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility;
  }
  ::selection { background: rgba(110,121,242,.32); color: #fff; }
  a { color: var(--accent); }
  /* ── 应用骨架：深色玻璃侧栏（gsap.com 风：近黑 + 绿色激活态）+ 右侧主区 ──────────── */
  .app { display: flex; min-height: 100vh; }
  .sidebar {
    width: 236px; flex: none; background: var(--bg-2); color: var(--text-2);
    position: fixed; top: 0; left: 0; bottom: 0; z-index: 30;
    display: flex; flex-direction: column; padding: 10px 8px;
    border-right: 1px solid var(--border);
  }
  .side-brand { display: flex; align-items: center; gap: 9px; padding: 4px 8px 12px; }
  .side-logo {
    width: 26px; height: 26px; border-radius: 7px; flex: none; overflow: hidden;
    background: #fff; box-shadow: inset 0 0 0 1px var(--border);
    display: flex; align-items: center; justify-content: center;
  }
  .side-logo img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .side-brand-txt { display: flex; flex-direction: column; line-height: 1.2; }
  .side-brand-txt b { color: var(--text); font-size: 13.5px; font-weight: 600; letter-spacing: -.1px; }
  .side-brand-txt span { font-size: 11px; color: var(--text-3); }
  .side-nav { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 1px; }
  .nav-sec { font-size: 11px; letter-spacing: .2px; color: var(--text-3); margin: 14px 10px 4px; font-weight: 600; }
  .nav-item {
    display: flex; align-items: center; gap: 10px; padding: 6.5px 10px; border-radius: 7px;
    color: var(--text-2); cursor: pointer; font-size: 13px; font-weight: 500; border: 0; background: transparent;
    width: 100%; text-align: left; transition: background .12s, color .12s;
  }
  .nav-item .ic { width: 16px; height: 16px; flex: none; display: inline-flex; align-items: center; justify-content: center; color: var(--text-3); }
  .nav-item .ic svg { width: 16px; height: 16px; }
  .nav-item .lbl { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .nav-item:hover { background: var(--hover); color: var(--text); }
  .nav-item:hover .ic { color: var(--text-2); }
  .nav-item.on { background: var(--hover); color: var(--text); font-weight: 550; }
  .nav-item.on .ic { color: var(--text); }
  .nav-item.add { color: var(--accent); }
  .nav-item.add .ic { color: var(--accent); }
  .nav-dot { width: 7px; height: 7px; border-radius: 50%; flex: none; }
  .nav-dot.on { background: var(--green); box-shadow: 0 0 0 3px var(--green-tint); }
  .nav-dot.off { background: #e0922f; box-shadow: 0 0 0 3px rgba(224,146,47,.15); }
  .nav-badge { margin-left: auto; font-size: 11px; background: var(--panel); border: 1px solid var(--border); color: var(--text-3); border-radius: 20px; padding: 0 6px; }
  .side-foot { padding: 8px 10px 2px; border-top: 1px solid var(--border); margin-top: 6px; font-size: 11.5px; color: var(--text-3); display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
  .main { margin-left: 236px; flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .topbar {
    height: 48px; flex: none; background: var(--bg);
    border-bottom: 1px solid var(--border); position: sticky; top: 0; z-index: 20;
    display: flex; align-items: center; gap: 12px; padding: 0 22px;
  }
  .hamburger { display: none; border: 0; background: transparent; font-size: 18px; cursor: pointer; color: var(--text-2); }
  .crumb { font-size: 14px; font-weight: 600; color: var(--text); display: flex; align-items: baseline; gap: 9px; letter-spacing: -.1px; }
  .crumb .sub { font-size: 11.5px; font-weight: 400; color: var(--text-3); letter-spacing: 0; }
  .topbar-actions { margin-left: auto; display: flex; gap: 8px; align-items: center; }
  .gsum { display: flex; gap: 6px; flex-wrap: wrap; }
  .gtag {
    background: var(--panel); color: var(--text-2); border: 1px solid var(--border);
    border-radius: 6px; padding: 3px 10px; font-size: 11.5px; white-space: nowrap;
  }
  .content { padding: 26px 28px 64px; width: 100%; }
  .page-head { margin: 2px 0 22px; }
  .page-head h1 { font-size: 28px; margin: 0 0 6px; font-weight: 700; letter-spacing: -.6px; }
  .page-head p { margin: 0; color: var(--text-2); font-size: 14px; }
  /* ── 仪表盘 KPI 磁贴（深色描边 + hover 绿色辉光抬升）──────────────────────────── */
  .kpis { display: grid; grid-template-columns: repeat(4, minmax(0,1fr)); gap: 16px; margin-bottom: 22px; }
  @media (max-width: 980px) { .kpis { grid-template-columns: repeat(2, minmax(0,1fr)); } }
  .kpi { background: var(--card); border: 1px solid var(--border); border-radius: var(--radius); padding: 20px 22px; box-shadow: var(--shadow-sm); transition: box-shadow .22s, transform .22s, border-color .22s; }
  .kpi:hover { transform: translateY(-2px); border-color: var(--border-2); }
  .kpi .k-top { display: flex; align-items: center; gap: 9px; color: var(--text-3); font-size: 12px; }
  .kpi .k-ic { width: 30px; height: 30px; border-radius: 8px; display: flex; align-items: center; justify-content: center; color: var(--accent); background: var(--accent-dim); box-shadow: inset 0 0 0 1px rgba(110,121,242,.28); }
  .kpi .k-ic svg { width: 17px; height: 17px; }
  .kpi .k-val { font-size: 32px; font-weight: 700; letter-spacing: -1.2px; margin: 10px 0 2px; color: var(--text); }
  .kpi .k-sub { font-size: 12.5px; color: var(--text-3); }
  .grid-2 { display: grid; grid-template-columns: minmax(0, 1.5fr) minmax(0, 1fr); gap: 18px; }
  @media (max-width: 980px) { .grid-2 { grid-template-columns: 1fr; } }
  .cols { display: grid; grid-template-columns: minmax(0, 7fr) minmax(0, 5fr); gap: 18px; margin-top: 0; }
  @media (max-width: 980px) { .cols { grid-template-columns: 1fr; } }
  .card {
    background: var(--card); border: 1px solid var(--border); border-radius: var(--radius);
    padding: 20px 24px; margin-bottom: 18px; box-shadow: var(--shadow-sm);
    transition: border-color .2s, box-shadow .2s;
  }
  .card:hover { border-color: var(--border-2); }
  .card h2 { font-size: 15px; margin: 0 0 14px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-weight: 700; letter-spacing: -.2px; color: var(--text); }
  .card h2 .right { margin-left: auto; font-weight: 400; }
  .hr { border: 0; border-top: 1px solid var(--border); margin: 14px 0; }
  .note { color: var(--text-3); font-size: 12.5px; }
  .tag {
    display: inline-block; border-radius: 6px; padding: 1.5px 8px; font-size: 11.5px;
    background: var(--panel-2); color: var(--text-2); margin-right: 6px; white-space: nowrap;
    border: 1px solid var(--border-2);
  }
  .tag.blue { background: var(--accent-dim); color: var(--accent); border-color: rgba(110,121,242,.4); }
  .tag.green { background: var(--green-tint); color: var(--green); border-color: rgba(62,207,106,.4); }
  .tag.orange { background: var(--orange-tint); color: var(--orange); border-color: rgba(227,169,60,.4); }
  .tag.red { background: var(--red-tint); color: var(--red); border-color: rgba(242,86,107,.4); }
  /* Linear 风按钮：次按钮描边面板底、主按钮靛蓝、危险红，小圆角无药丸。 */
  .btn {
    display: inline-flex; align-items: center; gap: 6px; border-radius: 8px;
    border: 1px solid var(--border-2); background: var(--panel); color: var(--text);
    padding: 6px 13px; font-size: 12.5px; line-height: 18px; font-weight: 550; cursor: pointer; white-space: nowrap;
    transition: background .12s, color .12s, border-color .12s;
  }
  .btn:hover { background: var(--hover); border-color: var(--text-3); }
  .btn:active { background: var(--panel-2); }
  .btn.primary { background: var(--accent); color: #fff; border-color: transparent; }
  .btn.primary:hover { background: var(--accent-hover); }
  .btn.disabled, .btn.disabled:hover { opacity: .4; cursor: not-allowed; background: var(--panel); color: var(--text-2); transform: none; border-color: var(--border); }
  .btn.danger { background: transparent; color: var(--red); border-color: transparent; }
  .btn.danger:hover { background: var(--red-tint); border-color: rgba(242,86,107,.4); }
  .btn.sm { padding: 4px 11px; font-size: 12px; }
  /* ── 首页 Hero（gsap.com 风：近黑底 + 弹簧绿辉光 + 巨字渐变 + 跑马灯 + 描边发光卡）── */
  .home { position: relative; margin: -30px -36px -64px; min-height: calc(100vh - 62px); overflow: hidden; }
  .home-aurora { position: absolute; inset: -25% -10% 0; z-index: 0; filter: blur(70px); opacity: .9; pointer-events: none; }
  .home-aurora i { position: absolute; border-radius: 50%; display: block; }
  .home-aurora .a1 { width: 48vw; height: 48vw; left: -10vw; top: -12vw; background: radial-gradient(circle at 40% 40%, rgba(110,121,242,.55), transparent 66%); }
  .home-aurora .a2 { width: 40vw; height: 40vw; right: -8vw; top: -4vw; background: radial-gradient(circle at 60% 40%, rgba(92,255,174,.4), transparent 66%); }
  .home-aurora .a3 { width: 42vw; height: 42vw; left: 24vw; top: 18vw; background: radial-gradient(circle at 50% 50%, rgba(110,121,242,.28), transparent 70%); }
  .home-aurora .a4 { width: 32vw; height: 32vw; right: 10vw; top: 26vw; background: radial-gradient(circle at 50% 50%, rgba(60,210,255,.22), transparent 70%); }
  .home-grid { position: absolute; inset: 0; z-index: 0; pointer-events: none; opacity: .5;
    background-image: linear-gradient(rgba(255,255,255,.045) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.045) 1px, transparent 1px);
    background-size: 56px 56px; -webkit-mask-image: radial-gradient(circle at 50% 26%, #000 0%, transparent 72%); mask-image: radial-gradient(circle at 50% 26%, #000 0%, transparent 72%); }
  .home-hero { position: relative; z-index: 1; max-width: 960px; margin: 0 auto; padding: 10vh 36px 5vh; text-align: center; }
  .home-eyebrow { display: inline-flex; align-items: center; gap: 8px; padding: 6px 15px; border-radius: var(--pill); background: rgba(255,255,255,.05); -webkit-backdrop-filter: blur(12px); backdrop-filter: blur(12px); border: 1px solid rgba(110,121,242,.3); font-size: 11.5px; color: var(--accent-2); font-family: var(--mono); letter-spacing: 1px; text-transform: uppercase; box-shadow: 0 0 24px rgba(110,121,242,.12); }
  .home-eyebrow .pulse { width: 8px; height: 8px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 0 0 rgba(110,121,242,.55); }
  .home-title { font-size: clamp(50px, 9vw, 110px); line-height: .96; font-weight: 800; letter-spacing: -3.4px; margin: 22px 0 18px; background: linear-gradient(180deg, #ffffff 18%, #cfd4ff 50%, var(--accent) 108%); -webkit-background-clip: text; background-clip: text; color: transparent; text-shadow: 0 0 70px rgba(110,121,242,.18); }
  .home-title .em { background: linear-gradient(110deg, var(--accent), var(--accent-2)); -webkit-background-clip: text; background-clip: text; color: transparent; background-size: 220% auto; }
  .home-sub { font-size: clamp(16px, 2.1vw, 21px); color: var(--text-2); max-width: 660px; margin: 0 auto 34px; line-height: 1.6; }
  .home-cta-row { display: flex; gap: 12px; justify-content: center; flex-wrap: wrap; }
  .home-cta { font-size: 16px !important; padding: 14px 34px !important; }
  /* 跑马灯（gsap.com 招牌横向滚动条）：双份内容首尾相接，GSAP 无缝 loop。 */
  .marquee { position: relative; z-index: 1; margin: 8px 0 2px; padding: 13px 0; border-top: 1px solid var(--border); border-bottom: 1px solid var(--border); overflow: hidden; -webkit-mask-image: linear-gradient(90deg, transparent, #000 12%, #000 88%, transparent); mask-image: linear-gradient(90deg, transparent, #000 12%, #000 88%, transparent); }
  .marquee-track { display: inline-flex; gap: 0; white-space: nowrap; will-change: transform; }
  .marquee-track span { font-family: var(--mono); font-size: 14px; letter-spacing: 1px; color: var(--text-2); padding: 0 22px; display: inline-flex; align-items: center; gap: 22px; }
  .marquee-track span::after { content: "◆"; color: var(--accent); font-size: 9px; }
  .glass { background: rgba(255,255,255,.035); -webkit-backdrop-filter: saturate(150%) blur(20px); backdrop-filter: saturate(150%) blur(20px); border: 1px solid var(--border); box-shadow: var(--shadow-sm); border-radius: 18px; }
  .home-stats { display: flex; gap: 14px; justify-content: center; flex-wrap: wrap; margin: 44px auto 0; }
  .home-stat { padding: 18px 30px; min-width: 138px; text-align: center; transition: border-color .2s, box-shadow .2s, transform .2s; }
  .home-stat:hover { box-shadow: var(--glow); border-color: transparent; transform: translateY(-3px); }
  .home-stat .s-val { font-size: 36px; font-weight: 800; letter-spacing: -1.4px; color: var(--accent); text-shadow: 0 0 26px rgba(110,121,242,.3); }
  .home-stat .s-lbl { font-size: 11.5px; color: var(--text-2); margin-top: 3px; font-family: var(--mono); letter-spacing: .6px; text-transform: uppercase; }
  .home-feats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; max-width: 960px; margin: 26px auto 9vh; position: relative; z-index: 1; }
  .home-feat { padding: 26px; text-align: left; transition: border-color .22s, box-shadow .22s, transform .22s; }
  .home-feat:hover { box-shadow: var(--glow); border-color: transparent; transform: translateY(-4px); }
  .home-feat .f-ic { width: 42px; height: 42px; border-radius: 12px; background: var(--accent-dim); color: var(--accent); display: flex; align-items: center; justify-content: center; margin-bottom: 14px; box-shadow: inset 0 0 0 1px rgba(110,121,242,.3); }
  .home-feat .f-ic svg { width: 22px; height: 22px; }
  .home-feat h3 { margin: 0 0 6px; font-size: 16px; font-weight: 700; letter-spacing: -.2px; color: var(--text); }
  .home-feat p { margin: 0; font-size: 13px; color: var(--text-2); line-height: 1.65; }
  @media (max-width: 820px) { .home { margin: -18px -16px -48px; } .home-feats { grid-template-columns: 1fr; padding: 0 16px; } }
  .proj { padding: 10px 0; border-bottom: 1px solid var(--border); }
  .proj:last-child { border-bottom: 0; }
  .proj .name { font-weight: 600; font-size: 14px; }
  .proj .meta { margin: 4px 0 8px; }
  .proj .path { color: var(--text-2); font-size: 12px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .statline { display: flex; align-items: center; gap: 8px; margin: 6px 0; flex-wrap: wrap; }
  #logbox {
    background: #0d0e14; color: #c9d1d9; border-radius: 10px; padding: 12px 14px;
    font: 11.5px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace;
    height: 480px; overflow-y: auto; white-space: pre-wrap; word-break: break-all;
    border: 1px solid #1c1d27;
  }
  #logbox.tall { height: calc(100vh - 240px); min-height: 340px; }
  /* ── 后端管理页：每后端一张富信息行（版本 / 状态 / 体积 + 下载/更新/卸载）──────── */
  .bk-item { display: flex; align-items: center; gap: 14px; padding: 15px 4px; border-bottom: 1px solid var(--border); flex-wrap: wrap; }
  .bk-item:last-child { border-bottom: 0; }
  .bk-ic { width: 40px; height: 40px; border-radius: 10px; flex: none; display: flex; align-items: center; justify-content: center; font-size: 19px; background: var(--bg); border: 1px solid var(--border); }
  .bk-main { flex: 1; min-width: 200px; }
  .bk-name { font-weight: 640; font-size: 14.5px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .bk-meta { color: var(--text-3); font-size: 12.5px; margin-top: 3px; }
  .bk-actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .ver { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
  /* ── 后端 Agent 页（Linear 风：表格列表 + 详情）─────────────────────────────── */
  .bka-tbl { border: 1px solid var(--border); border-radius: 12px; overflow: hidden; background: var(--panel); }
  .bka-th, .bka-row { display: grid; grid-template-columns: minmax(0,2.3fr) 1.1fr 1.2fr 1.1fr 44px; align-items: center; }
  .bka-th { padding: 9px 16px; border-bottom: 1px solid var(--border); color: var(--text-3); font-size: 11.5px; font-weight: 600; }
  .bka-row { padding: 13px 16px; border-bottom: 1px solid var(--border); cursor: pointer; }
  .bka-row:last-child { border-bottom: 0; }
  .bka-row:hover { background: var(--hover); }
  .bka-ag { display: flex; align-items: center; gap: 12px; min-width: 0; }
  .bka-ic { width: 30px; height: 30px; border-radius: 8px; flex: none; display: flex; align-items: center; justify-content: center; background: var(--panel-2); border: 1px solid var(--border); font-size: 15px; }
  .bka-nm { font-weight: 600; font-size: 13.5px; display: flex; align-items: center; gap: 7px; min-width: 0; }
  .bka-nm .t { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .bka-sub { color: var(--text-3); font-size: 12px; margin-top: 1px; }
  .pill { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text-2); }
  .pill .dot { width: 7px; height: 7px; border-radius: 50%; flex: none; }
  .pill .dot.green { background: var(--green); box-shadow: 0 0 0 3px var(--green-tint); }
  .pill .dot.gray { background: #54545c; }
  .bka-proj { display: flex; align-items: center; gap: 7px; color: var(--text-2); font-size: 12.5px; }
  .bka-av { display: flex; }
  .bka-av span { width: 20px; height: 20px; border-radius: 6px; border: 1.5px solid var(--panel); background: var(--panel-2); margin-left: -6px; display: flex; align-items: center; justify-content: center; font-size: 9px; color: var(--text-2); }
  .bka-av span:first-child { margin-left: 0; }
  .bka-verm { font: 12px/1.4 var(--mono); color: var(--text-2); }
  .bka-verm small { color: var(--text-3); }
  .bka-rowact { display: flex; justify-content: flex-end; position: relative; }
  .iconbtn { border: 1px solid transparent; background: transparent; color: var(--text-2); cursor: pointer; border-radius: 7px; width: 28px; height: 26px; display: inline-flex; align-items: center; justify-content: center; }
  .iconbtn:hover { background: var(--hover); color: var(--text); }
  .iconbtn svg { width: 15px; height: 15px; }
  .menu { position: absolute; top: 28px; right: 0; background: #1c1c21; border: 1px solid var(--border-2); border-radius: 10px; padding: 5px; min-width: 152px; box-shadow: var(--shadow-md); z-index: 25; display: none; }
  .menu.open { display: block; }
  /* 末行的下拉向上展开：表格 .bka-tbl 用 overflow:hidden 做圆角，会裁掉最后一行
     向下展开的菜单（如 Claude 行的「检查更新」被切掉）——末行改为向上弹出即可避开。 */
  .bka-row:last-child .menu { top: auto; bottom: 30px; }
  .mi { display: flex; align-items: center; gap: 9px; padding: 7px 9px; border-radius: 7px; font-size: 12.5px; color: var(--text); cursor: pointer; }
  .mi svg { width: 14px; height: 14px; color: var(--text-2); }
  .mi:hover { background: var(--hover); }
  .mi.danger { color: var(--red); } .mi.danger svg { color: var(--red); }
  .mi.disabled { color: var(--text-3); cursor: not-allowed; } .mi.disabled:hover { background: transparent; }
  .bka-crumb { display: flex; align-items: center; gap: 8px; color: var(--text-2); font: 13px var(--mono); margin-bottom: 16px; }
  .bka-crumb a { color: var(--text-2); text-decoration: none; cursor: pointer; } .bka-crumb a:hover { color: var(--text); }
  .bka-crumb .sep { color: var(--text-3); }
  .bka-dgrid { display: grid; grid-template-columns: minmax(0,1fr) 290px; gap: 16px; align-items: start; }
  @media (max-width: 900px) { .bka-dgrid { grid-template-columns: 1fr; } }
  .bka-dhead { display: flex; align-items: center; gap: 13px; }
  .bka-dhead .ic { width: 42px; height: 42px; border-radius: 11px; background: var(--panel-2); border: 1px solid var(--border); display: flex; align-items: center; justify-content: center; font-size: 21px; flex: none; }
  .bka-dhead h2 { font-size: 17px; margin: 0; font-weight: 650; display: flex; align-items: center; gap: 10px; }
  .bka-dhead .dsub { color: var(--text-3); font-size: 12.5px; margin-top: 2px; }
  .bka-meta { display: grid; grid-template-columns: repeat(3,1fr); gap: 1px; margin-top: 16px; background: var(--border); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
  .bka-meta > div { background: var(--panel); padding: 12px 14px; }
  .bka-meta .k { font-size: 11px; color: var(--text-3); margin-bottom: 5px; }
  .bka-meta .v { font-size: 13px; font-weight: 550; }
  .bka-meta .v.mono { font-family: var(--mono); font-weight: 500; font-size: 12.5px; }
  .bka-pr { display: flex; align-items: center; gap: 12px; padding: 11px 0; border-bottom: 1px solid var(--border); }
  .bka-pr:last-child { border-bottom: 0; }
  .bka-pic { width: 28px; height: 28px; border-radius: 7px; background: var(--panel-2); border: 1px solid var(--border); display: flex; align-items: center; justify-content: center; flex: none; color: var(--text-2); }
  .bka-kv { display: flex; justify-content: space-between; align-items: center; padding: 7px 0; font-size: 12.5px; border-bottom: 1px solid var(--border); }
  .bka-kv:last-of-type { border-bottom: 0; }
  .bka-kv .k { color: var(--text-3); }
  .bka-path { font: 11.5px var(--mono); color: var(--text-2); word-break: break-all; background: var(--panel-2); border: 1px solid var(--border); border-radius: 7px; padding: 7px 9px; margin-top: 8px; }
  #logbox .hl { color: #79c0ff; }
  #logbox .warn { color: #e3b341; }
  #logbox .err { color: #ff7b72; }
  .drawer-mask { position: fixed; inset: 0; background: rgba(0,0,0,.35); display: none; z-index: 9; }
  .drawer {
    position: fixed; top: 0; right: -460px; width: 440px; max-width: 94vw; height: 100vh;
    background: #111411; border-left: 1px solid var(--border); z-index: 10; box-shadow: -8px 0 40px rgba(0,0,0,.6);
    transition: right .2s ease; padding: 18px 20px; overflow-y: auto;
  }
  .drawer.open { right: 0; }
  .drawer-mask.open { display: block; }
  .drawer h3 { margin: 0 0 4px; font-size: 16px; }
  .opt-row { display: flex; gap: 8px; margin: 6px 0 2px; flex-wrap: wrap; }
  .compact-input {
    width: 84px; border: 1px solid var(--border-2); border-radius: 8px; padding: 7px 9px;
    font: 13px var(--mono); background: #0c0e0c; color: var(--text);
  }
  .compact-input:focus { outline: 0; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-dim); }
  .backend-row { display: flex; align-items: center; gap: 8px; padding: 6px 0; }
  .backend-row .grow { flex: 1; min-width: 0; }
  .bk-group { margin: 6px 0 2px; }
  .bk-group .gh { font-weight: 600; font-size: 13px; margin: 8px 0 2px; }
  .bk-sub { padding-left: 10px; border-left: 2px solid var(--border); margin-left: 2px; }
  /* 后端管理卡（总览）：每后端一行 + 下载进度 */
  .mgr-row { display: flex; align-items: center; gap: 10px; padding: 8px 0; border-bottom: 1px solid var(--border); flex-wrap: wrap; }
  .mgr-row:last-child { border-bottom: 0; }
  .mgr-row .grow { flex: 1; min-width: 0; }
  .progress {
    height: 6px; background: var(--bg); border-radius: 4px; overflow: hidden; margin: 6px 0 2px;
  }
  .progress > div { height: 100%; background: var(--blue); width: 0; transition: width .25s; }
  .insttail {
    background: #0e1117; color: #c9d1d9; border-radius: 6px; padding: 6px 8px; margin-top: 6px;
    font: 11px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
    max-height: 120px; overflow-y: auto; white-space: pre-wrap; word-break: break-all;
  }
  #toast {
    position: fixed; left: 50%; bottom: 36px; transform: translateX(-50%);
    background: #14171480; -webkit-backdrop-filter: blur(14px); backdrop-filter: blur(14px);
    background: #161916; color: #fff; border: 1px solid rgba(110,121,242,.35); border-radius: 10px; padding: 9px 18px;
    font-size: 13px; display: none; z-index: 20; max-width: 80vw; box-shadow: var(--shadow-md);
  }
  .empty { color: var(--text-3); text-align: center; padding: 18px 0; }
  /* 首次使用欢迎 hero（零 bot 着陆：一句话装好桥后到这里扫码建第一个机器人）。 */
  .firstrun { text-align: center; padding: 26px 16px 22px; }
  .firstrun .fr-emoji { font-size: 40px; line-height: 1; }
  .firstrun .fr-title { font-size: 16px; font-weight: 600; margin: 12px 0 6px; color: var(--text); }
  .firstrun .fr-sub { font-size: 13px; color: var(--text-2); max-width: 420px; margin: 0 auto 16px; line-height: 1.7; }
  .firstrun .fr-cta { font-size: 14px; padding: 9px 26px; box-shadow: 0 6px 22px rgba(110,121,242,.36); }
  #wizMask, #confirmMask {
    position: fixed; inset: 0; background: rgba(0,0,0,.45); display: none; z-index: 30;
    overflow-y: auto; padding: 40px 16px;
  }
  #confirmMask { z-index: 40; }
  #wizMask.open, #confirmMask.open { display: block; }
  .switch { cursor: pointer; user-select: none; }
  .bot-row { display: flex; align-items: center; gap: 8px; padding: 9px 0; border-bottom: 1px solid var(--border); flex-wrap: wrap; }
  .bot-row:last-child { border-bottom: 0; }
  .bot-row .grow { flex: 1; min-width: 0; }
  .wiz {
    background: #141714; border: 1px solid var(--border); border-radius: var(--radius); max-width: 560px; margin: 0 auto;
    padding: 22px 24px 26px; box-shadow: var(--shadow-lg);
  }
  .wiz h3 { margin: 0 0 4px; font-size: 17px; color: var(--text); }
  .wiz .steps { display: flex; gap: 6px; margin: 12px 0 16px; }
  .wiz .step {
    flex: 1; text-align: center; font-size: 12px; color: var(--text-2);
    border-top: 3px solid var(--border); padding-top: 6px;
  }
  .wiz .step.on { color: var(--blue); border-top-color: var(--blue); font-weight: 600; }
  .wiz .step.done { color: var(--green); border-top-color: var(--green); }
  .wiz label { display: block; font-size: 13px; font-weight: 600; margin: 12px 0 4px; }
  .wiz input[type=text], .wiz input[type=password] {
    width: 100%; border: 1px solid var(--border-2); border-radius: 8px;
    padding: 8px 10px; font-size: 13px; font-family: var(--mono);
    background: #0c0e0c; color: var(--text);
  }
  .wiz input::placeholder { color: var(--text-3); }
  .wiz input:focus { outline: 0; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-dim); }
  .wiz .actions { display: flex; gap: 10px; margin-top: 18px; align-items: center; }
  .wiz .actions .grow { flex: 1; }
  .qrbox {
    display: flex; flex-direction: column; align-items: center; gap: 8px; margin: 14px 0;
    padding: 14px; border: 1px solid var(--border-2); border-radius: var(--radius); background: #fff; color: #1a1a1a;
  }
  .qrbox .qr-count { color: #555; }
  .qrbox svg { display: block; }
  .qr-count { font-size: 12px; color: var(--text-2); }
  .check-item {
    display: flex; align-items: flex-start; gap: 10px; padding: 10px 0;
    border-bottom: 1px solid var(--border);
  }
  .check-item:last-child { border-bottom: 0; }
  .check-item .ico { font-size: 16px; line-height: 1.5; width: 20px; flex: none; text-align: center; }
  .check-item .body { flex: 1; min-width: 0; }
  .check-item .body .t { font-weight: 600; font-size: 13.5px; }
  .check-item .body .d { color: var(--text-2); font-size: 12px; margin-top: 2px; }
  .spin {
    display: inline-block; width: 13px; height: 13px; border: 2px solid var(--border);
    border-top-color: var(--blue); border-radius: 50%; animation: spin .8s linear infinite;
    vertical-align: -1px;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .copybox {
    display: flex; gap: 8px; align-items: center; background: #0e1117; color: #c9d1d9;
    border-radius: 8px; padding: 8px 10px; margin: 6px 0;
    font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  .copybox code { flex: 1; min-width: 0; word-break: break-all; }
  /* ── 窄屏：侧栏变可滑出抽屉，汉堡按钮控制 ─────────────────────────────────── */
  @media (max-width: 820px) {
    .sidebar { transform: translateX(-100%); transition: transform .22s ease; box-shadow: var(--shadow-lg); }
    .sidebar.open { transform: translateX(0); }
    .main { margin-left: 0; }
    .hamburger { display: block; }
    .content { padding: 18px 16px 48px; }
    .topbar { padding: 0 16px; }
    .side-scrim { position: fixed; inset: 0; background: rgba(0,0,0,.4); z-index: 25; display: none; }
    .side-scrim.open { display: block; }
  }
</style>
</head>
<body>
<div class="app">
  <!-- 左侧深色导航栏：品牌 + 分组导航（概览 / 机器人 / 系统）+ 底部版本与在线态 -->
  <aside class="sidebar" id="sidebar">
    <div class="side-brand">
      <span class="side-logo"><img src="/vendor/logo.png" alt="Feishu Bridge"></span>
      <div class="side-brand-txt"><b>Feishu Bridge</b><span>本机控制台</span></div>
    </div>
    <nav class="side-nav" id="sideNav"></nav>
    <div class="side-foot" id="sideFoot"></div>
  </aside>
  <div class="side-scrim" id="sideScrim"></div>
  <div class="main">
    <!-- 顶栏：汉堡（窄屏）+ 面包屑标题 + 页面级操作 + 全局摘要 chip -->
    <header class="topbar">
      <button class="hamburger" id="hamburger" title="菜单" aria-label="菜单">☰</button>
      <div class="crumb" id="crumb"></div>
      <div class="topbar-actions" id="topActions"></div>
      <div class="gsum" id="globalSummary"></div>
    </header>
    <!-- 单内容容器：renderRoute 按 hash 路由清空重渲（仪表盘 / 机器人 / 后端 / 体检 / 日志） -->
    <div class="content" id="tabContent"></div>
  </div>
</div>

<div class="drawer-mask" id="drawerMask"></div>
<div class="drawer" id="drawer"></div>

<!-- ➕ 添加机器人向导：内容由 JS 按步骤渲染（扫码 → checklist → 完成） -->
<div id="wizMask"><div class="wiz" id="wizBody"></div></div>

<!-- 二次确认弹窗（重启 daemon / 删除机器人等破坏性操作） -->
<div id="confirmMask"><div class="wiz" id="confirmBody" style="max-width:440px"></div></div>

<div id="toast"></div>

<!-- 本地自带的 GSAP 动画引擎（/vendor 路由经 cookie 鉴权，不走 CDN）。同步加载置于下面
     的 app 脚本之前 → window.gsap 就绪；即便它加载失败，app 的动画层是无操作降级。 -->
<script src="/vendor/gsap.min.js"></script>
<script>
(function () {
  'use strict';

  // ── 纯逻辑片段（DOM-free，单测同款）：parseRoute / qrSvg / depTriState / … ─────
${UI_PURE_JS}

  // ── 全局单例状态 ────────────────────────────────────────────────────────────
  var state = null;          // /api/state 快照
  var daemon = null;         // /api/daemon
  var diag = null;           // /api/diagnosis 结果（当前 bot 的探测；切 Tab 必清）
  var catalog = null;        // /api/backends 缓存（后端管理卡 + 项目 picker 复用）
  var lastUpdate = null;     // /api/update/check 结果缓存：总览 5s 重渲不重查（每次查都 spawn npm view）
  var updateCheckedAt = 0;   // 上次检查时间戳；拿到结果超 30min、软失败超 ~2min 才随重渲自动复查
  var updateChecking = false;// in-flight 闸：npm view 可能数秒~20s，期间 5s 重渲不叠发第二个请求
  var updateInFlight = false; // 「升级并重启」in-flight：禁用按钮防重复点击（并发触发会绕过服务端更新锁的窄窗），并驱动轮询结果
  var drawerProject = null;  // 抽屉里打开的项目名
  var diagBotId = null;      // diag 属于哪个 bot（防串台）
  var bkDetailId = null;     // 后端 Agent 详情视图当前展开的后端 id（null=列表）

  // ── 动画层（GSAP 渐进增强）─────────────────────────────────────────────────
  // 没加载到 GSAP，或用户在系统里开了「减少动态效果」(prefers-reduced-motion) → fx.on=false，
  // 所有方法降级为「直接设最终态/无操作」，绝不影响任何功能或可访问性。动画只碰 transform/
  // autoAlpha（合成层，不触发 layout），进场只在路由切换时播一次（5s 刷新整页重渲不重放）。
  var fx = (function () {
    var g = window.gsap;
    var reduce = false;
    try { reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) {}
    var on = !!g && !reduce;
    if (g) { try { g.defaults({ ease: 'power2.out', duration: 0.4 }); } catch (e) {} }
    function arr(x) {
      if (!x) return [];
      return (x.length !== undefined && !x.nodeType) ? Array.prototype.slice.call(x) : [x];
    }
    return {
      on: on,
      // 卡片/行进场：自下而上淡入 + 错峰（仅路由切换时调）。
      enter: function (targets, opts) {
        var els = arr(targets); if (!on || !els.length) return;
        opts = opts || {};
        g.from(els, {
          autoAlpha: 0, y: opts.y == null ? 12 : opts.y, duration: opts.duration || 0.42,
          stagger: opts.stagger == null ? 0.06 : opts.stagger, overwrite: 'auto',
          clearProps: 'transform,opacity,visibility',
        });
      },
      // 弹层（向导/确认）：缩放 + 上移淡入。
      popIn: function (target) {
        if (!on || !target) return;
        g.from(target, {
          autoAlpha: 0, y: 14, scale: 0.96, duration: 0.34, ease: 'back.out(1.5)',
          overwrite: 'auto', clearProps: 'transform,opacity,visibility',
        });
      },
      // toast：从下方滑入 / 滑出（!on 时直接走 done）。
      toastIn: function (target) {
        if (!on || !target) return;
        g.fromTo(target, { autoAlpha: 0, y: 16 }, { autoAlpha: 1, y: 0, duration: 0.3, overwrite: 'auto' });
      },
      toastOut: function (target, done) {
        if (!on || !target) { if (done) done(); return; }
        g.to(target, { autoAlpha: 0, y: 12, duration: 0.24, overwrite: 'auto', onComplete: done });
      },
      // 进度条宽度：平滑补间（比直接赋 width 的跳变顺；!on 时直接赋值）。
      width: function (target, pct) {
        if (!target) return;
        if (!on) { target.style.width = pct + '%'; return; }
        g.to(target, { width: pct + '%', duration: 0.4, ease: 'power1.out', overwrite: 'auto' });
      },
    };
  })();

  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }
  // 单色线性图标（SF Symbols 观感，替代 emoji）。24x24，stroke=currentColor。
  var ICONS = {
    home: '<path d="M3 11l9-7 9 7"/><path d="M5 10v9a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-9"/>',
    grid: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.6"/><rect x="13" y="3.5" width="7" height="7" rx="1.6"/><rect x="3.5" y="13" width="7" height="7" rx="1.6"/><rect x="13" y="13" width="7" height="7" rx="1.6"/>',
    bot: '<rect x="5" y="7" width="14" height="12" rx="3"/><path d="M12 3v4M8 12h.01M16 12h.01M9 16h6"/>',
    add: '<circle cx="12" cy="12" r="8.5"/><path d="M12 8.5v7M8.5 12h7"/>',
    backend: '<path d="M12 3l8.5 4.7-8.5 4.7-8.5-4.7L12 3z"/><path d="M3.5 12.3L12 17l8.5-4.7"/>',
    doctor: '<path d="M3 12h4l2.2-7 3.6 14 2.2-7H21"/>',
    logs: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M7 9.5l3 2.5-3 2.5M13 15h4"/>',
    server: '<rect x="3.5" y="4.5" width="17" height="6" rx="2"/><rect x="3.5" y="13.5" width="17" height="6" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>',
    folder: '<path d="M3.5 7a2 2 0 0 1 2-2h3.6l2 2.2H18.5a2 2 0 0 1 2 2v7.3a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2V7z"/>',
    cube: '<path d="M12 3l8.5 4.7v8.6L12 21l-8.5-4.7V7.7L12 3z"/><path d="M12 3v18M3.5 7.7L12 12.4l8.5-4.7"/>',
    bolt: '<path d="M13 3L5 13h6l-1 8 8-10h-6l1-8z"/>',
    zap: '<path d="M13 3L5 13h6l-1 8 8-10h-6l1-8z"/>',
    shield: '<path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6l7-3z"/>',
    rocket: '<path d="M12 3c3 1.5 5 4.5 5 8 0 2-.7 3.5-1.5 4.7L12 18l-3.5-2.3C7.7 14.5 7 13 7 11c0-3.5 2-6.5 5-8z"/><circle cx="12" cy="10" r="1.6"/><path d="M9 18l-2 3M15 18l2 3"/>',
    download: '<path d="M12 4v11M7.5 10.5L12 15l4.5-4.5M5 19h14"/>',
    dots: '<circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/>',
    refresh: '<path d="M21 12a9 9 0 1 1-3-6.7M21 4v5h-5"/>',
    trash: '<path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/>',
  };
  function icSvg(name) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (ICONS[name] || '') + '</svg>';
  }
  function ic(name, cls) { var s = el('span', cls || 'ic'); s.innerHTML = icSvg(name); return s; }
  function toast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.style.display = 'block';
    fx.toastIn(t);
    clearTimeout(t._tm);
    t._tm = setTimeout(function () {
      fx.toastOut(t, function () { t.style.display = 'none'; });
    }, 3200);
  }

  // 当前路由派生的 botId（不再是「点 Tab 改的全局变量」，从 hash 派生）。
  function currentBotId() {
    var r = parseRoute(location.hash);
    return r.tab === 'bot' ? r.botId : null;
  }

  // 二次确认弹窗（破坏性操作通用）。
  function confirmDialog(opts) {
    var mask = $('confirmMask');
    var body = $('confirmBody');
    body.textContent = '';
    body.appendChild(el('h3', null, opts.title));
    (opts.lines || []).forEach(function (line) { body.appendChild(el('div', 'note', line)); });
    var actions = el('div', 'actions');
    var cancel = el('button', 'btn', '取消');
    cancel.onclick = function () { mask.classList.remove('open'); };
    actions.appendChild(cancel);
    actions.appendChild(el('div', 'grow'));
    var ok = el('button', 'btn ' + (opts.danger ? 'danger' : 'primary'), opts.confirmLabel || '确认');
    ok.onclick = function () { mask.classList.remove('open'); opts.onConfirm(); };
    actions.appendChild(ok);
    body.appendChild(actions);
    mask.classList.add('open');
    fx.popIn(body);
  }

  // ── 文案（与 DM 卡片 src/card/dm-cards.ts 对齐）───────────────────────────
  function kindLabel(kind) { return kind === 'single' ? '💬 单会话群' : '👥 多话题群'; }
  function tierLabel(m) {
    if (m === 'qa') return '🔒 项目内只读';
    if (m === 'write') return '✏️ 项目内读写';
    return '⚠️ 完全访问';
  }
  function permissionSummary(p) {
    return p.mode === p.guestMode
      ? '所有人：' + tierLabel(p.mode)
      : '管理员：' + tierLabel(p.mode) + ' · 其他人：' + tierLabel(p.guestMode);
  }
  function eventDiagText(d) {
    if (!d) return '（未检测）';
    if (d.state === 'ok') return '✅ 已生效（版本 v' + (d.version || '?') + ' 已订阅 im.message.receive_v1）';
    if (d.state === 'missing') return '❌ 已发布版本 v' + (d.version || '?') + ' 缺事件：' + (d.missingRequired || []).join('、') + ' —— @机器人不会有反应';
    if (d.state === 'unpublished') return '❌ 从未发布过版本 —— 事件订阅尚未生效，@机器人不会有反应';
    return '⚠️ 未能自动检测（' + (d.reason || '未知原因') + '）';
  }
  function connText(s) {
    if (s === 'connected') return '✅ 已连接';
    if (s === 'connecting') return '⏳ 连接中';
    if (s === 'reconnecting') return '↻ 重连中';
    if (s === 'disconnected') return '❌ 已断开';
    return s;
  }
  function familyName(f) { return f === 'codex' ? 'Codex' : f === 'claude' ? 'Claude' : f; }
  function botTitle(b) { return (b.running ? '🟢 ' : '🟠 ') + (b.botName || b.name); }

  function fmtUptime(ms) {
    if (typeof ms !== 'number') return '—';
    var s = Math.floor(ms / 1000);
    var d = Math.floor(s / 86400); s -= d * 86400;
    var h = Math.floor(s / 3600); s -= h * 3600;
    var m = Math.floor(s / 60);
    if (d > 0) return d + '天' + h + '小时';
    if (h > 0) return h + '小时' + m + '分';
    return m + '分钟';
  }
  function fmtBytes(n) {
    if (typeof n !== 'number' || n <= 0) return '0 B';
    var u = ['B', 'KB', 'MB', 'GB'];
    var i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return (i === 0 ? n : n.toFixed(1)) + ' ' + u[i];
  }

  function botOf(appId) {
    if (!state) return null;
    for (var i = 0; i < state.bots.length; i++) if (state.bots[i].appId === appId) return state.bots[i];
    return null;
  }

  // ── 数据拉取 ──────────────────────────────────────────────────────────────
  function loadState() {
    fetch('/api/state').then(function (r) {
      if (r.status === 401) { toast('登录态失效：请用启动日志里带 token 的 URL 重新打开'); throw new Error('401'); }
      return r.json();
    }).then(function (s) {
      state = s;
      renderSidebar();
      renderGlobalSummary();
      // 当前可见页重渲。但体检/日志页不跟 5s 轮询重渲：体检是按「重新检测」才刷的快照
      // （否则整页闪、还白拉一次体检），日志有自己的 SSE（重渲会断流重连）。其余页(总览/
      // 机器人/后端)要跟着活数据走，照常重渲。
      var tab = parseRoute(location.hash).tab;
      if (tab !== 'doctor' && tab !== 'logs') renderRoute();
    }).catch(function () { /* 下个周期重试 */ });
  }
  function loadDaemon() {
    fetch('/api/daemon').then(function (r) { return r.json(); })
      .then(function (d) {
        daemon = d;
        // 运行中的实际版本一旦跟版本检查缓存里的 current 对不上（多半是刚更新+重启完成），
        // 就作废缓存并当场补查一次（若在总览页），把「有新版」立刻翻成「已是最新版」——不等
        // 下一轮 renderRoute，消除 loadState/loadDaemon 同周期竞态导致的 ~10s 延迟与横幅残留。
        // 只在版本真变时才查（稳态 d.version===current），既留住更新后的即时反馈，又不回到 5s 空转。
        if (lastUpdate && d.version && d.version !== lastUpdate.current) {
          lastUpdate = null; updateCheckedAt = 0;
          if (parseRoute(location.hash).tab === 'overview') { var ub = $('updateBody'); if (ub) loadUpdate(ub); }
        }
        if (parseRoute(location.hash).tab === 'overview') { var b = $('daemonBody'); if (b) renderDaemon(b); }
        renderSidebarFoot();
        renderGlobalSummary();
      })
      .catch(function () { /* 下个周期重试 */ });
  }
  function loadCatalog() {
    return fetch('/api/backends').then(function (r) { return r.json(); })
      .then(function (c) { catalog = c; return c; })
      .catch(function () { return null; });
  }

  // ── 只读预览 → 可写控制台自动切换 ───────────────────────────────────────────
  // 只读预览(web 命令)占着 51847 时，用户点「启动」拉起的 daemon 会退到临时端口，其可写
  // 控制台不在本页。轮询 /api/console/live：daemon 一起来就醒目提示 + 自动把页面带过去，
  // 端口在哪都不用用户操心——修「Feishu Bridge 明明在跑却提示只读、点下载不动」的陷阱。
  // daemon 自身的控制台没注入 liveConsole → 永远 live:false，不会自跳成环。
  var liveConsoleSwitching = false;
  function checkLiveConsole() {
    if (liveConsoleSwitching) return;
    fetch('/api/console/live').then(function (r) { return r.json(); }).then(function (j) {
      if (j && j.live && j.url) switchToLiveConsole(j.url);
    }).catch(function () { /* 下个周期重试 */ });
  }
  function switchToLiveConsole(url) {
    if (liveConsoleSwitching) return;
    liveConsoleSwitching = true;
    var bar = el('div');
    bar.style.cssText = 'position:fixed;left:0;right:0;top:0;z-index:9999;display:flex;align-items:center;gap:14px;justify-content:center;padding:13px 18px;background:linear-gradient(90deg,#3a2fb0,#5b4ddb);color:#fff;font-size:14px;font-weight:600;box-shadow:0 6px 24px rgba(0,0,0,.35)';
    bar.appendChild(document.createTextNode('✅ Feishu Bridge 已在运行 —— 当前页是只读预览，正在带你进入可写控制台…'));
    var go = el('button');
    go.style.cssText = 'background:#fff;color:#3a2fb0;border:0;border-radius:8px;padding:7px 14px;font-weight:700;cursor:pointer';
    go.textContent = '立即进入 →';
    go.onclick = function () { location.replace(url); };
    bar.appendChild(go);
    document.body.appendChild(bar);
    setTimeout(function () { location.replace(url); }, 1800);
  }

  // ── 路由 → 页面标题/副标题（顶栏面包屑 + 页头复用）─────────────────────────
  function routeTitle(r) {
    if (r.tab === 'home') return { t: '首页', s: 'Feishu Bridge 总览' };
    if (r.tab === 'bot') { var b = botOf(r.botId); return { t: (b ? botTitle(b) : '机器人'), s: '单机器人 · 项目 / 接入诊断' }; }
    if (r.tab === 'backends') return { t: '后端 Agent', s: '按需下载 / 更新 / 卸载 agent 后端' };
    if (r.tab === 'doctor') return { t: '宿主机体检', s: '本机后端环境与运行时信息' };
    if (r.tab === 'logs') return { t: '实时日志', s: '当日文件日志 SSE 实时跟随' };
    return { t: '仪表盘', s: '全局总览 · 机器人 / 后端 / Feishu Bridge' };
  }

  // ── 路由：单 #tabContent 按 hash 清空重渲 ───────────────────────────────────
  var _lastRouteKey = null;
  var _homeStateLoaded = false; // 首页是否已用真实 state 渲染过（初次空渲染后置位，触发一次重建）
  function renderRoute() {
    var r = parseRoute(location.hash);
    var key = r.tab + ':' + (r.botId || '');
    var navigated = key !== _lastRouteKey; // 仅「切换路由」时播进场；5s 刷新整页重渲不重放
    _lastRouteKey = key;
    renderSidebar();
    renderTopbar(r);
    var box = $('tabContent');
    if (!box) return;
    // 首页是炫技 hero，只在「切换到首页」或「首次拿到 state（初次空渲染后）」时构建；
    // 之后 5s 刷新不重放动画（数字略陈无妨）。
    if (r.tab === 'home') { if (navigated || !_homeStateLoaded) { box.textContent = ''; renderHome(box); } return; }
    box.textContent = '';
    if (r.tab === 'bot') renderBotTab(box, r.botId);
    else if (r.tab === 'backends') renderBackendsPage(box);
    else if (r.tab === 'doctor') renderDoctorPage(box);
    else if (r.tab === 'logs') renderLogsPage(box);
    else renderOverviewTab(box);
    if (navigated) fx.enter(box.querySelectorAll('.kpi, .card'));
  }

  // ── 左侧导航：首页 / 概览 / 机器人（每个 + 添加）/ 系统（后端·体检·日志）─────────
  function navItem(o) {
    var it = el('button', 'nav-item' + (o.on ? ' on' : '') + (o.add ? ' add' : ''));
    it.appendChild(ic(o.icon));
    it.appendChild(el('span', 'lbl', o.label));
    if (o.dot !== undefined) it.appendChild(el('span', 'nav-dot ' + (o.dot ? 'on' : 'off')));
    if (o.badge) it.appendChild(el('span', 'nav-badge', o.badge));
    it.onclick = o.onClick;
    return it;
  }
  function renderSidebar() {
    var nav = $('sideNav');
    if (!nav) return;
    nav.textContent = '';
    var r = parseRoute(location.hash);
    nav.appendChild(el('div', 'nav-sec', '概览'));
    nav.appendChild(navItem({ icon: 'grid', label: '仪表盘', on: r.tab === 'overview', onClick: function () { go({ tab: 'overview' }); } }));
    nav.appendChild(el('div', 'nav-sec', '飞书机器人'));
    var bots = (state && state.bots) || [];
    bots.forEach(function (b) {
      nav.appendChild(navItem({ icon: 'bot', label: botTitle(b), on: r.tab === 'bot' && r.botId === b.appId, dot: !!b.running, onClick: function () { go({ tab: 'bot', botId: b.appId }); } }));
    });
    nav.appendChild(navItem({ icon: 'add', label: '添加机器人', add: true, onClick: function () { tryAddBot(); } }));
    nav.appendChild(el('div', 'nav-sec', '配置'));
    nav.appendChild(navItem({ icon: 'backend', label: '后端 Agent', on: r.tab === 'backends', onClick: function () { go({ tab: 'backends' }); } }));
    nav.appendChild(navItem({ icon: 'doctor', label: '宿主机体检', on: r.tab === 'doctor', onClick: function () { go({ tab: 'doctor' }); } }));
    nav.appendChild(navItem({ icon: 'logs', label: '实时日志', on: r.tab === 'logs', onClick: function () { go({ tab: 'logs' }); } }));
    renderSidebarFoot();
  }
  function renderSidebarFoot() {
    var foot = $('sideFoot');
    if (!foot) return;
    foot.textContent = '';
    var online = !!(daemon && daemon.running);
    foot.appendChild(el('span', 'nav-dot ' + (online ? 'on' : 'off')));
    foot.appendChild(el('span', null, (online ? 'Feishu Bridge 运行中' : 'Feishu Bridge 未运行') + ' · v' + ((state && state.version) || '?')));
  }
  function renderTopbar(r) {
    var crumb = $('crumb');
    if (crumb) {
      crumb.textContent = '';
      var ti = routeTitle(r);
      crumb.appendChild(document.createTextNode(ti.t));
      crumb.appendChild(el('span', 'sub', ti.s));
    }
    var act = $('topActions');
    if (act) {
      act.textContent = '';
      if (r.tab === 'overview' || r.tab === 'bot') {
        var add = el('button', 'btn primary sm', '➕ 添加机器人');
        add.onclick = function () { tryAddBot(); };
        act.appendChild(add);
      }
    }
  }

  function renderGlobalSummary() {
    var box = $('globalSummary');
    if (!box) return;
    box.textContent = '';
    var s = summarizeState(state);
    box.appendChild(el('span', 'gtag', '🟢 在线 ' + s.online + '/' + s.total));
    box.appendChild(el('span', 'gtag', '📁 项目 ' + s.projects));
    if (daemon && daemon.running && daemon.uptimeMs !== undefined) box.appendChild(el('span', 'gtag', '⏱ ' + fmtUptime(daemon.uptimeMs)));
  }

  // 窄屏抽屉式侧栏开合。
  function openSidebar() { var s = $('sidebar'); if (s) s.classList.add('open'); var sc = $('sideScrim'); if (sc) sc.classList.add('open'); }
  function closeSidebar() { var s = $('sidebar'); if (s) s.classList.remove('open'); var sc = $('sideScrim'); if (sc) sc.classList.remove('open'); }

  // hash 路由切换：切页必清上一个 bot 的 diag（防串台），关抽屉与移动端侧栏。
  function go(route) {
    diag = null; diagBotId = null; bkDetailId = null;
    closeDrawer(); closeSidebar();
    if (route.tab === 'bot') location.hash = '#bot/' + encodeURIComponent(route.botId);
    else if (route.tab === 'backends' || route.tab === 'doctor' || route.tab === 'logs' || route.tab === 'home') location.hash = '#' + route.tab;
    else location.hash = '#overview';
  }
  window.addEventListener('hashchange', function () { diag = null; diagBotId = null; bkDetailId = null; closeDrawer(); closeSidebar(); renderRoute(); });

  // 小工具：一张 KPI 磁贴（线性图标 + 标签 + 大数字 + 副文）；catalog 后端 id → 显示名。
  function kpiTile(iconName, label, val, sub, ok) {
    var t = el('div', 'kpi');
    var top = el('div', 'k-top');
    var icel = ic(iconName, 'k-ic');
    if (ok !== undefined) { icel.style.background = ok ? 'var(--green-tint)' : 'var(--orange-tint)'; icel.style.color = ok ? '#1c8c3d' : '#b96a00'; }
    top.appendChild(icel);
    top.appendChild(el('span', null, label));
    t.appendChild(top);
    t.appendChild(el('div', 'k-val', val));
    t.appendChild(el('div', 'k-sub', sub || ''));
    return t;
  }
  function backendName(id) {
    if (catalog && catalog.entries) { for (var i = 0; i < catalog.entries.length; i++) if (catalog.entries[i].id === id) return catalog.entries[i].displayName; }
    return id || '—';
  }

  // ════════════════════════════════════════════════════════════════════════════
  //  首页 Hero（炫技层：极光渐变 + 玻璃磁贴 + GSAP 入场/数字滚动；管理页才走苹果安静风）
  // ════════════════════════════════════════════════════════════════════════════
  function renderHome(root) {
    var s = summarizeState(state);
    _homeStateLoaded = !!(state && state.bots); // state 到位后这次渲染才算「真渲染」
    var hasBots = s.total > 0;
    var home = el('div', 'home');

    var aurora = el('div', 'home-aurora');
    ['a1', 'a2', 'a3', 'a4'].forEach(function (c) { aurora.appendChild(el('i', c)); });
    home.appendChild(aurora);
    home.appendChild(el('div', 'home-grid'));

    var hero = el('div', 'home-hero');
    var eb = el('div', 'home-eyebrow');
    eb.appendChild(el('span', 'pulse'));
    eb.appendChild(el('span', null, (daemon && daemon.running) ? 'Feishu Bridge 运行中 · 127.0.0.1' : '本机控制台 · 127.0.0.1'));
    hero.appendChild(eb);
    var title = el('div', 'home-title');
    title.appendChild(document.createTextNode('Codex '));
    title.appendChild(el('span', 'em', 'Bridge'));
    hero.appendChild(title);
    hero.appendChild(el('div', 'home-sub', '把飞书接到本机的 Codex —— 一个群一个项目，@一句话就开干。多机器人、多群并行，全程跑在你这台机器上，私有可控。'));
    var ctaRow = el('div', 'home-cta-row');
    var primary = el('button', 'btn primary home-cta', hasBots ? '进入控制台' : '➕ 扫码创建第一个机器人');
    primary.onclick = function () { if (hasBots) go({ tab: 'overview' }); else tryAddBot(); };
    ctaRow.appendChild(primary);
    if (hasBots) {
      var sec = el('button', 'btn home-cta', '后端管理');
      sec.onclick = function () { go({ tab: 'backends' }); };
      ctaRow.appendChild(sec);
    }
    hero.appendChild(ctaRow);

    var stats = el('div', 'home-stats');
    function stat(val, lbl) {
      var d = el('div', 'glass home-stat');
      var v = el('div', 's-val', String(val)); v.setAttribute('data-to', String(val));
      d.appendChild(v); d.appendChild(el('div', 's-lbl', lbl));
      return d;
    }
    stats.appendChild(stat(s.total, '机器人'));
    stats.appendChild(stat(s.online, '在线'));
    stats.appendChild(stat(s.projects, '项目'));
    hero.appendChild(stats);
    home.appendChild(hero);

    // 跑马灯（gsap.com 招牌）：同一组词复制两份首尾相接，GSAP 把整条向左无缝平移。
    var marquee = el('div', 'marquee');
    var track = el('div', 'marquee-track');
    var words = ['CODEX', '一群一项目', '话题即会话', '@ 一句话开干', '流式卡片', '私有可控', '127.0.0.1'];
    for (var mq = 0; mq < 2; mq++) words.forEach(function (wd) { track.appendChild(el('span', null, wd)); });
    marquee.appendChild(track);
    home.appendChild(marquee);

    var feats = el('div', 'home-feats');
    [
      { i: 'bot', t: '一群一项目', d: '把机器人拉进群，群就是项目；@它提需求，它在绑定的目录里干活。' },
      { i: 'cube', t: '轻核心·本机 Codex', d: '只依赖本机的 Codex CLI，不捆任何重运行时；每会话独立进程，卡死有 watchdog 兜底。' },
      { i: 'shield', t: '私有可控', d: '全程跑在你这台机器上，凭据进本地加密库，控制台只听 127.0.0.1。' },
    ].forEach(function (f) {
      var c = el('div', 'glass home-feat');
      c.appendChild(ic(f.i, 'f-ic'));
      c.appendChild(el('h3', null, f.t));
      c.appendChild(el('p', null, f.d));
      feats.appendChild(c);
    });
    home.appendChild(feats);
    root.appendChild(home);

    // ── GSAP 编排（炫技：极光漂移 + 标题流光 + 错峰入场 + 数字滚动）──
    if (fx.on && window.gsap) {
      var g = window.gsap;
      try {
        var blobs = aurora.querySelectorAll('i');
        for (var i = 0; i < blobs.length; i++) {
          g.to(blobs[i], { x: (i % 2 ? 60 : -60), y: (i % 2 ? -40 : 40), duration: 9 + i * 2, ease: 'sine.inOut', repeat: -1, yoyo: true });
        }
        // 强调词「Bridge」绿色流光（横向 background-size 220% 来回扫）。
        g.to('.home-title .em', { backgroundPosition: '220% center', duration: 6, ease: 'sine.inOut', repeat: -1, yoyo: true });
        g.from([eb, title, hero.querySelector('.home-sub'), ctaRow], {
          autoAlpha: 0, y: 26, duration: 0.75, stagger: 0.1, ease: 'power3.out', clearProps: 'transform,opacity,visibility',
        });
        g.from('.home-title .em', { autoAlpha: 0, scale: 0.8, duration: 0.7, delay: 0.18, ease: 'back.out(2)', clearProps: 'transform,opacity,visibility' });
        g.from(stats.children, { autoAlpha: 0, y: 18, scale: 0.96, duration: 0.6, stagger: 0.08, delay: 0.35, ease: 'back.out(1.6)', clearProps: 'transform,opacity,visibility' });
        g.from(marquee, { autoAlpha: 0, duration: 0.6, delay: 0.5, clearProps: 'opacity,visibility' });
        g.from(feats.children, { autoAlpha: 0, y: 26, duration: 0.6, stagger: 0.1, delay: 0.55, ease: 'power3.out', clearProps: 'transform,opacity,visibility' });
        var vals = stats.querySelectorAll('.s-val');
        for (var j = 0; j < vals.length; j++) (function (elv) {
          var to = parseInt(elv.getAttribute('data-to'), 10) || 0;
          var o = { n: 0 };
          g.to(o, { n: to, duration: 1.1, delay: 0.45, ease: 'power2.out', onUpdate: function () { elv.textContent = Math.round(o.n); } });
        })(vals[j]);
        // 跑马灯无缝滚动：track 是两份内容，平移一半宽度后归零，视觉无接缝。
        var half = track.scrollWidth / 2;
        if (half > 0) g.fromTo(track, { x: 0 }, { x: -half, duration: Math.max(14, half / 55), ease: 'none', repeat: -1 });
        g.fromTo('.home-eyebrow .pulse', { boxShadow: '0 0 0 0 rgba(110,121,242,.6)' }, { boxShadow: '0 0 0 10px rgba(110,121,242,0)', duration: 1.6, ease: 'power1.out', repeat: -1 });
      } catch (e) {}
    }
  }

  // ════════════════════════════════════════════════════════════════════════════
  //  仪表盘（全局总览：KPI 磁贴 + 机器人 + daemon）
  // ════════════════════════════════════════════════════════════════════════════
  // 服务管理器名 → 人话标签（不暴露 launchd/systemd 这类没人懂的术语，只留「哪个系统 · 开机自启」）。
  function svcLabel(pn) {
    if (!pn) return '后台服务';
    if (pn.indexOf('launchd') >= 0 || pn.indexOf('macOS') >= 0) return 'macOS · 开机自启';
    if (pn.indexOf('systemd') >= 0 || pn.indexOf('Linux') >= 0) return 'Linux · 开机自启';
    if (pn.indexOf('Windows') >= 0) return 'Windows · 登录自启';
    return '后台服务';
  }

  function renderOverviewTab(root) {
    var s = summarizeState(state);
    var daemonOn = !!(daemon && daemon.running);

    // KPI 磁贴行
    var kpis = el('div', 'kpis');
    kpis.appendChild(kpiTile('server', 'Feishu Bridge', daemonOn ? '运行中' : '未运行',
      daemonOn && daemon.uptimeMs !== undefined ? '已运行 ' + fmtUptime(daemon.uptimeMs) : svcLabel(daemon && daemon.platformName), daemonOn));
    kpis.appendChild(kpiTile('bot', '在线机器人', s.online + ' / ' + s.total, s.active + ' 个在活跃集'));
    kpis.appendChild(kpiTile('folder', '项目总数', String(s.projects), '跨全部机器人'));
    kpis.appendChild(kpiTile('cube', '默认后端', catalog ? backendName(catalog.defaultBackend) : '…', '项目未指定时路由到它'));
    root.appendChild(kpis);
    if (!catalog) loadCatalog().then(function () { if (parseRoute(location.hash).tab === 'overview') renderRoute(); });

    // 🛰️ Feishu Bridge（放在机器人卡上面：机器人可增删、列表会变长，全局控制放最前位置更稳定）
    var daemonCard = el('div', 'card');
    var dh = el('h2'); dh.appendChild(document.createTextNode('🛰️ Feishu Bridge'));
    // 生命周期按钮按运行态由 renderDaemon 动态填充（运行中→重启/停止；未运行→启动）。
    var dright = el('span', 'right'); dright.id = 'daemonActions';
    dh.appendChild(dright);
    daemonCard.appendChild(dh);
    var daemonBody = el('div', 'note', '加载中…'); daemonBody.id = 'daemonBody';
    daemonCard.appendChild(daemonBody);
    daemonCard.appendChild(el('hr', 'hr'));
    var updateBody = el('div', 'note', '版本检查中…'); updateBody.id = 'updateBody';
    daemonCard.appendChild(updateBody);
    root.appendChild(daemonCard);
    renderDaemon(daemonBody);
    // 版本检查会在服务端 spawn「npm view」，不能跟着 5s 重渲每次都跑：有缓存就直接渲，
    // 只在首次或缓存过期（30min）时才真查一次。手动「检查更新」按钮仍强制刷新。
    if (lastUpdate) {
      renderUpdate(updateBody, lastUpdate);
      if (Date.now() - updateCheckedAt > 30 * 60 * 1000) loadUpdate(updateBody);
    } else {
      loadUpdate(updateBody);
    }

    // 🤖 机器人（在 Feishu Bridge 卡下面，各自占满宽度）
    var botsCard = el('div', 'card');
    var bh = el('h2'); bh.appendChild(document.createTextNode('🤖 机器人 '));
    var bcount = el('span', 'right note'); bh.appendChild(bcount);
    botsCard.appendChild(bh);
    var botsList = el('div'); botsCard.appendChild(botsList);
    root.appendChild(botsCard);
    renderBots(botsList, bcount);
  }

  // ════════════════════════════════════════════════════════════════════════════
  //  系统分页：后端管理 / 宿主机体检 / 实时日志
  // ════════════════════════════════════════════════════════════════════════════
  function renderBackendsPage(root) {
    if (!catalog) {
      root.appendChild(el('div', 'note', '加载中…'));
      loadCatalog().then(function (c) { if (c && parseRoute(location.hash).tab === 'backends') renderRoute(); });
      return;
    }
    if (bkDetailId) {
      var ent = catalogEntryById(bkDetailId);
      if (ent) { renderBackendDetail(root, ent); return; }
      bkDetailId = null; // 找不到（已卸载等）→ 退回列表
    }
    renderBackendList(root);
  }
  function catalogEntryById(id) {
    if (!catalog || !catalog.entries) return null;
    for (var i = 0; i < catalog.entries.length; i++) if (catalog.entries[i].id === id) return catalog.entries[i];
    return null;
  }
  function bkFamilyIcon(family) { return family === 'codex' ? '⚡' : family === 'claude' ? '✳️' : '🧩'; }
  // 该后端被哪些项目关联（项目在创建时选定后端，运行时固定）。从 /api/state 派生。
  function projectsForBackend(id) {
    var out = [];
    var bots = (state && state.bots) || [];
    bots.forEach(function (b) {
      (b.projects || []).forEach(function (p) {
        if (p.backend === id) out.push({ name: p.name, kind: p.kind, mode: p.mode, botName: b.botName || b.name, sessions: p.sessionCount });
      });
    });
    return out;
  }

  // ── 后端 Agent 列表（Linear 表格：后端 / 状态 / 关联项目 / 版本·体积 / ⋯）─────────
  function renderBackendList(root) {
    var entries = catalog.entries || [];
    var head = el('div', 'ph');
    var hwrap = el('div'); hwrap.style.cssText = 'display:flex;align-items:center;gap:10px;width:100%';
    var h1 = el('h1', null, '后端 Agent '); h1.style.cssText = 'font-size:17px;font-weight:650;margin:0';
    h1.appendChild(el('span', null, String(entries.length))).style.cssText = 'color:var(--text-3);font-weight:500;margin-left:4px';
    hwrap.appendChild(h1);
    var sp = el('div'); sp.style.flex = '1'; hwrap.appendChild(sp);
    var chk = el('button', 'btn sm', '检查更新'); chk.onclick = function () { checkAllUpdates(chk); };
    hwrap.appendChild(chk);
    head.appendChild(hwrap);
    root.appendChild(head);
    root.appendChild(el('p', 'pdesc', '每个后端 Agent 是一种编码引擎；下载到本机用户目录（零 sudo）。新建项目时选定后端，之后固定不变。默认仅内置 Codex App Server，其余按需下载。'))
      .style.cssText = 'color:var(--text-2);font-size:13px;margin:2px 0 18px';

    var tbl = el('div', 'bka-tbl');
    var th = el('div', 'bka-th');
    ['后端 Agent', '状态', '关联项目', '版本', ''].forEach(function (t) { th.appendChild(el('div', null, t)); });
    tbl.appendChild(th);
    entries.forEach(function (e) { tbl.appendChild(renderBackendRow(e)); });
    root.appendChild(tbl);
  }

  function renderBackendRow(e) {
    var tri = depTriState(e);
    var installed = e.depState === 'installed';
    var extInstalled = installed && !e.canUninstall && !e.isDefault;
    var row = el('div', 'bka-row');
    row.onclick = function () { openBackendDetail(e.id); };

    // 后端名 + 家族
    var agc = el('div', 'bka-ag');
    var icon = el('div', 'bka-ic', bkFamilyIcon(e.agentFamily)); if (!installed) icon.style.opacity = '.55';
    agc.appendChild(icon);
    var nmwrap = el('div'); nmwrap.style.minWidth = '0';
    var nm = el('div', 'bka-nm');
    var nmT = el('span', 't', e.displayName); if (!installed) nmT.style.color = 'var(--text-2)';
    nm.appendChild(nmT);
    if (e.isDefault) nm.appendChild(el('span', 'tag blue', '内置'));
    nmwrap.appendChild(nm);
    nmwrap.appendChild(el('div', 'bka-sub', familyName(e.agentFamily) + ' · ' + (e.access || '')));
    agc.appendChild(nmwrap);
    row.appendChild(agc);

    // 状态
    var stwrap = el('div');
    var pill = el('span', 'pill');
    if (installed) { pill.appendChild(el('span', 'dot green')); pill.appendChild(el('span', null, e.isDefault ? '已装 · 在线' : (extInstalled ? '外部已装' : '已下载'))); }
    else { pill.appendChild(el('span', 'dot gray')); var u = el('span', null, '未下载'); u.style.color = 'var(--text-3)'; pill.appendChild(u); }
    stwrap.appendChild(pill);
    row.appendChild(stwrap);

    // 关联项目
    var pj = projectsForBackend(e.id);
    var pjwrap = el('div');
    if (pj.length) {
      var pc = el('div', 'bka-proj');
      var av = el('div', 'bka-av');
      pj.slice(0, 3).forEach(function (p) { av.appendChild(el('span', null, (p.name || '·').slice(0, 1))); });
      pc.appendChild(av);
      pc.appendChild(el('span', null, pj.length + ' 个项目'));
      pjwrap.appendChild(pc);
    } else { var dash = el('span', null, '—'); dash.style.color = 'var(--text-3)'; pjwrap.appendChild(dash); }
    row.appendChild(pjwrap);

    // 版本（体积不在列表占位——下载前的体积提示挪到「下载」按钮上）
    var verwrap = el('div', 'bka-verm');
    var shownVer = e.installedVersion || (installed ? e.version : '');
    var vtxt = '';
    if (shownVer) vtxt = /^\\d/.test(shownVer) ? 'v' + shownVer : shownVer;
    if (vtxt) {
      verwrap.appendChild(document.createTextNode(vtxt));
      if (e.isDefault) verwrap.appendChild(el('small', null, ' · 内置'));
    } else if (e.isDefault) {
      verwrap.appendChild(el('small', null, '内置'));
    } else {
      var dashv = el('small', null, '—'); dashv.style.color = 'var(--text-3)'; verwrap.appendChild(dashv);
    }
    row.appendChild(verwrap);

    // 操作
    var act = el('div', 'bka-rowact');
    act.onclick = function (ev) { ev.stopPropagation(); };
    if (tri.action === 'download') {
      var dl = el('button', 'iconbtn'); dl.title = '下载'; dl.innerHTML = icSvg('download');
      dl.onclick = function () { openBackendDetail(e.id); };
      act.appendChild(dl);
    } else if (installed) {
      var mb = el('button', 'iconbtn'); mb.innerHTML = icSvg('dots');
      var menu = el('div', 'menu');
      var miU = el('div', 'mi'); miU.innerHTML = icSvg('refresh') + '<span>检查更新</span>';
      miU.onclick = function () { closeAllMenus(); openBackendDetail(e.id); };
      menu.appendChild(miU);
      if (e.canUninstall) {
        var miD = el('div', 'mi danger'); miD.innerHTML = icSvg('trash') + '<span>删除</span>';
        miD.onclick = function () { closeAllMenus(); askUninstallBackend(e); };
        menu.appendChild(miD);
      } else if (e.isDefault) {
        var miX = el('div', 'mi disabled'); miX.innerHTML = icSvg('trash') + '<span>删除（内置）</span>';
        menu.appendChild(miX);
      } else {
        var miE = el('div', 'mi disabled'); miE.innerHTML = icSvg('trash') + '<span>删除（外部已装）</span>';
        miE.title = '该后端在仓库/全局 node_modules 里被探到，非桥按需下载的副本，桥不托管、不在此删除。';
        menu.appendChild(miE);
      }
      mb.onclick = function () { var open = menu.classList.contains('open'); closeAllMenus(); if (!open) menu.classList.add('open'); };
      act.appendChild(mb); act.appendChild(menu);
    }
    row.appendChild(act);
    return row;
  }
  function closeAllMenus() { document.querySelectorAll('.menu.open').forEach(function (m) { m.classList.remove('open'); }); }

  function openBackendDetail(id) { bkDetailId = id; var c = document.querySelector('.content'); if (c) c.scrollTop = 0; renderRoute(); }
  function backBackendList() { bkDetailId = null; renderRoute(); }

  // ── 后端 Agent 详情：头部 + 元信息 + 关联项目 + 右栏诊断/操作 ────────────────────
  function renderBackendDetail(root, e) {
    var tri = depTriState(e);
    var installed = e.depState === 'installed';
    // 探到已装、但既非内置(codex)又不在桥私装目录 → 仓库/全局 node_modules 的外部副本，桥不托管。
    var extInstalled = installed && !e.canUninstall && !e.isDefault;
    var crumb = el('div', 'bka-crumb');
    var back = el('a', null, '← 全部后端 Agent'); back.onclick = backBackendList;
    crumb.appendChild(back);
    crumb.appendChild(el('span', 'sep', '/'));
    crumb.appendChild(el('span', null, e.displayName));
    root.appendChild(crumb);

    var grid = el('div', 'bka-dgrid');
    var left = el('div'); var right = el('div');

    // 头部卡
    var hcard = el('div', 'card');
    var dh = el('div', 'bka-dhead');
    var ic = el('div', 'ic', bkFamilyIcon(e.agentFamily)); if (!installed) ic.style.opacity = '.55';
    dh.appendChild(ic);
    var htxt = el('div'); htxt.style.flex = '1';
    var h2 = el('h2', null, e.displayName);
    var sp2 = el('span', 'pill');
    if (installed) { sp2.appendChild(el('span', 'dot green')); var on = el('span', null, '在线'); on.style.color = 'var(--green)'; sp2.appendChild(on); }
    else { sp2.appendChild(el('span', 'dot gray')); var off = el('span', null, '未下载'); off.style.color = 'var(--text-3)'; sp2.appendChild(off); }
    h2.appendChild(sp2);
    htxt.appendChild(h2);
    htxt.appendChild(el('div', 'dsub', (e.isDefault ? '内置后端，随桥打包' : (extInstalled ? '仓库/全局 node_modules 已装 · 桥不托管' : (installed ? '已下载到用户私装目录' : '尚未下载'))) + (e.blurb ? ' · ' + e.blurb : '')));
    dh.appendChild(htxt);
    hcard.appendChild(dh);
    // 元信息四宫格
    var meta = el('div', 'bka-meta');
    function mcell(k, v, mono) { var c = el('div'); c.appendChild(el('div', 'k', k)); c.appendChild(el('div', 'v' + (mono ? ' mono' : ''), v)); return c; }
    var shownVer = e.installedVersion || (installed ? e.version : '') || '—';
    meta.appendChild(mcell('家族', familyName(e.agentFamily)));
    meta.appendChild(mcell('安装方式', e.isDefault ? '内置（随桥）' : (extInstalled ? '外部已装' : (installed ? '按需下载' : '未下载'))));
    meta.appendChild(mcell('版本', /^\\d/.test(shownVer) ? 'v' + shownVer : shownVer, true));
    hcard.appendChild(meta);
    left.appendChild(hcard);

    // 关联项目卡
    var pj = projectsForBackend(e.id);
    var pcard = el('div', 'card');
    var ph = el('div'); ph.style.cssText = 'font-size:13px;font-weight:600;margin-bottom:3px';
    ph.appendChild(document.createTextNode('关联项目 '));
    ph.appendChild(el('span', null, '· ' + pj.length)).style.color = 'var(--text-3)';
    pcard.appendChild(ph);
    pcard.appendChild(el('div', 'note', '这些项目在创建时选定了该后端，运行时固定使用它（不支持中途切换后端）。'))
      .style.cssText = 'color:var(--text-3);font-size:12px;margin-bottom:10px';
    if (pj.length) {
      pj.forEach(function (p) {
        var pr = el('div', 'bka-pr');
        var pic = el('div', 'bka-pic'); pic.innerHTML = icSvg('folder'); pr.appendChild(pic);
        var pt = el('div'); pt.style.minWidth = '0';
        pt.appendChild(el('div', null, p.name)).style.cssText = 'font-weight:550;font-size:13px';
        pt.appendChild(el('div', 'note', kindLabel(p.kind) + ' · ' + p.botName)).style.fontSize = '11.5px';
        pr.appendChild(pt);
        var psp = el('div'); psp.style.flex = '1'; pr.appendChild(psp);
        pr.appendChild(el('span', 'tag ' + (p.mode === 'full' ? 'orange' : p.mode === 'write' ? 'green' : ''), tierLabel(p.mode)));
        var sc = el('span', 'note', (p.sessions || 0) + ' 话题'); sc.style.color = 'var(--text-3)'; pr.appendChild(sc);
        pcard.appendChild(pr);
      });
    } else {
      pcard.appendChild(el('div', 'note', installed ? '暂无项目使用。新建项目时可选用它。' : '未下载，暂无项目。下载后即可在「新建项目」时选用。'))
        .style.cssText = 'color:var(--text-3);font-size:12.5px;padding:6px 0';
    }
    left.appendChild(pcard);

    // 右栏：诊断
    var diagCard = el('div', 'card');
    diagCard.appendChild(el('div', 'note', '诊断')).style.cssText = 'font-size:12px;color:var(--text-3);font-weight:600;margin-bottom:8px';
    function kv(k, v, color) { var r = el('div', 'bka-kv'); r.appendChild(el('span', 'k', k)); var vv = el('span', 'v', v); if (color) vv.style.color = color; r.appendChild(vv); return r; }
    diagCard.appendChild(kv('可用性', installed ? '✓ 可用' : '未下载', installed ? 'var(--green)' : 'var(--text-3)'));
    diagCard.appendChild(kv('家族', familyName(e.agentFamily)));
    diagCard.appendChild(kv('安装方式', e.isDefault ? '内置（不可删）' : (extInstalled ? '外部 node_modules（桥不托管）' : (installed ? '用户私装目录' : '未下载'))));
    if (e.hint && !installed) diagCard.appendChild(el('div', 'bka-path', e.hint));
    right.appendChild(diagCard);

    // 右栏：操作（下载 / 更新 / 删除）
    var opCard = el('div', 'card');
    opCard.appendChild(el('div', 'note', '操作')).style.cssText = 'font-size:12px;color:var(--text-3);font-weight:600;margin-bottom:10px';
    var opBox = el('div'); opCard.appendChild(opBox);
    renderBackendOps(opBox, e, tri);
    right.appendChild(opCard);

    grid.appendChild(left); grid.appendChild(right);
    root.appendChild(grid);
  }

  // 详情右栏的操作区：未下载→下载；已装→更新 + 删除（内置不可删则禁用）。进度就地展示。
  function renderBackendOps(box, e, tri) {
    box.textContent = '';
    if (tri.action === 'download') {
      var dl = el('button', 'btn primary'); dl.style.cssText = 'width:100%;justify-content:center';
      dl.textContent = '⬇ 下载' + (e.approxSizeMB ? '（约 ' + e.approxSizeMB + 'M）' : '');
      dl.onclick = function () { startBackendInstall(e, box, dl, 'install'); };
      box.appendChild(dl);
      if (e.hint) box.appendChild(el('div', 'note', '装法：' + e.hint)).style.cssText = 'margin-top:8px;font-size:12px';
      return;
    }
    if (e.depState === 'installed') {
      var upd = el('button', 'btn'); upd.style.cssText = 'width:100%;justify-content:center'; upd.textContent = '检查更新';
      upd.onclick = function () { checkBackendUpdate(e, box, upd); };
      box.appendChild(upd);
      var gap = el('div'); gap.style.height = '8px'; box.appendChild(gap);
      if (e.canUninstall) {
        var rm = el('button', 'btn danger'); rm.style.cssText = 'width:100%;justify-content:center;border:1px solid var(--border-2)'; rm.textContent = '删除后端';
        rm.onclick = function () { askUninstallBackend(e); };
        box.appendChild(rm);
      } else if (e.isDefault) {
        var dis = el('button', 'btn disabled'); dis.style.cssText = 'width:100%;justify-content:center'; dis.disabled = true; dis.textContent = '内置 · 不可删除';
        box.appendChild(dis);
      } else {
        var disE = el('button', 'btn disabled'); disE.style.cssText = 'width:100%;justify-content:center'; disE.disabled = true; disE.textContent = '外部已装 · 不在此删除';
        box.appendChild(disE);
        box.appendChild(el('div', 'note', '在仓库/全局 node_modules 里被探到（非桥按需下载到私装目录的副本），桥不托管、不在此删除。')).style.cssText = 'margin-top:8px;font-size:12px';
      }
    }
  }

  function checkAllUpdates(btn) {
    btn.disabled = true; btn.className = 'btn sm disabled'; btn.textContent = '查询中…';
    toast('正在检查各后端最新版本…');
    setTimeout(function () { btn.disabled = false; btn.className = 'btn sm'; btn.textContent = '检查更新'; }, 1500);
  }
  function renderDoctorPage(root) {
    var card = el('div', 'card');
    var h = el('h2'); h.appendChild(document.createTextNode('🩺 宿主机体检 '));
    var right = el('span', 'right');
    var btn = el('button', 'btn sm', '🔄 重新检测'); right.appendChild(btn); h.appendChild(right);
    card.appendChild(h);
    var body = el('div', 'note', '🔍 正在检测…');
    card.appendChild(body);
    btn.onclick = function () { loadHostDoctor(body); };
    root.appendChild(card);
    loadHostDoctor(body); // 进页即自动检测
  }
  function renderLogsPage(root) {
    var card = el('div', 'card');
    var h = el('h2'); h.appendChild(document.createTextNode('📜 实时日志 '));
    var lstatus = el('span', 'right note', logState.status); lstatus.id = 'logStatus';
    h.appendChild(lstatus); card.appendChild(h);
    var logbox = el('div', 'tall'); logbox.id = 'logbox'; card.appendChild(logbox);
    card.appendChild(el('div', 'note', '当日文件日志 SSE 实时跟随；切到别的页不断连，回来把缓冲挂回。'));
    root.appendChild(card);
    mountLogBox(logbox);
  }

  function renderDaemon(box) {
    box.textContent = '';
    // actions 容器在同卡片内（box 的父节点 = daemonCard）。用相对查找而非 document.getElementById：
    // 仪表盘初次构建时整张卡片还没 append 进文档，getElementById 会扑空 → 生命周期按钮不画（曾导致
    // 「启动/停止」按钮整体消失）。沿 box.parentNode 找即便脱离文档也命中。
    var acts = (box && box.parentNode && box.parentNode.querySelector)
      ? box.parentNode.querySelector('#daemonActions') : $('daemonActions');
    if (acts) acts.textContent = '';
    var d = daemon;
    if (!d) { box.textContent = '加载中…'; return; }
    if (!d.supported) {
      box.appendChild(el('div', null, '⚠️ 本平台不支持后台服务'));
      box.appendChild(el('div', 'note', '用 feishu-codex-bridge run 前台运行；重启请在终端 Ctrl+C 后重跑。'));
      return;
    }
    // 生命周期按钮（运行中 → 重启 + 停止；未运行 → 启动）。「更新并重启」在下方版本区按需出现。
    if (acts) {
      if (d.running) {
        var rb = el('button', 'btn sm', '🔁 重启'); rb.onclick = askRestart; acts.appendChild(rb);
        var sb = el('button', 'btn sm danger', '⏹ 停止'); sb.style.marginLeft = '6px'; sb.onclick = askStop; acts.appendChild(sb);
      } else {
        var pb = el('button', 'btn sm primary', '▶️ 启动'); pb.onclick = askStart; acts.appendChild(pb);
      }
      // 检查更新入口：始终在（不管跑没跑）。没启动时能做的就是「启动」+「更新」。
      var ub = el('button', 'btn sm', '🔄 检查更新'); ub.style.marginLeft = '6px';
      ub.onclick = function () { var bx = $('updateBody'); if (bx) { bx.textContent = '版本检查中…'; loadUpdate(bx); } toast('🔄 正在检查更新…'); };
      acts.appendChild(ub);
    }
    var line = el('div', 'statline');
    if (d.running) line.appendChild(el('span', 'tag green', '✅ 运行中' + (d.pid ? ' · pid ' + d.pid : '')));
    else line.appendChild(el('span', 'tag orange', d.installed ? '🟠 已安装但未在运行' : '🟠 未后台启动'));
    line.appendChild(el('span', 'tag', svcLabel(d.platformName)));
    box.appendChild(line);
    // 版本要醒目：大号数字独占一行（取代原来 statline 里那枚小 tag）。
    var ver = el('div'); ver.style.cssText = 'margin-top:12px;display:flex;align-items:baseline;gap:9px';
    var vnum = el('span'); vnum.style.cssText = 'font-size:27px;font-weight:700;letter-spacing:-.6px;color:var(--text)';
    vnum.textContent = 'v' + d.version;
    ver.appendChild(vnum);
    var vlab = el('span'); vlab.style.cssText = 'font-size:12px;color:var(--text-3)'; vlab.textContent = 'Feishu Bridge 版本';
    ver.appendChild(vlab);
    box.appendChild(ver);
    if (d.uptimeMs !== undefined && d.running) box.appendChild(el('div', 'note', '已运行 ' + fmtUptime(d.uptimeMs)));
    if (d.selfHosted) box.appendChild(el('div', 'note', '⚠️ 手动运行，未注册为开机自启 —— 关机/登出后不会自动拉起。运行 feishu-codex-bridge install 注册为后台服务。'));
    if (d.lastExit !== undefined && d.lastExit !== '0') box.appendChild(el('div', 'note', '上次退出码：' + d.lastExit));
  }

  function loadUpdate(box) {
    if (updateChecking) return;          // 在途就不叠发：慢检查（npm view 最长 20s）期间 5s 重渲不重复 spawn
    updateChecking = true;
    updateCheckedAt = Date.now();        // 乐观占位：in-flight 期间 30min 边界不再被反复判真
    fetch('/api/update/check').then(function (r) { return r.json(); })
      .then(function (u) {
        lastUpdate = u;
        // 软失败：非 dev 却没拿到 latest（多半 registry 不可达/超时，服务端仍回 200），只缓存 ~2min
        // 便自动复查，别把「查询失败」钉住 30min；拿到 latest 或 dev 模式才按完整 30min TTL。
        updateCheckedAt = (u && (u.dev || u.latest)) ? Date.now() : Date.now() - 28 * 60 * 1000;
        renderUpdate(box, u);
      })
      .catch(function () { box.textContent = '⚠️ 版本检查失败（网络或 npm registry）'; })
      .then(function () { updateChecking = false; });  // finally：无论成败都松闸
  }
  function renderUpdate(box, u) {
    box.textContent = '';
    if (u.dev) {
      box.appendChild(el('div', null, '🧩 源码开发模式（仓库内有 .git）'));
      box.appendChild(el('div', 'note', '当前 v' + u.current + '；升级请用 git pull && npm i（不走全局安装）。'));
      return;
    }
    if (u.hasUpdate && u.latest) {
      box.appendChild(el('div', null, '🆕 有新版 v' + u.latest + '（当前 v' + u.current + '）'));
      var row = el('div', 'statline');
      // updateInFlight 期间显示禁用的「更新中…」——即使卡片每 5s 重渲，按钮也保持禁用，
      // 挡住重复提交（重复触发是并发绕过服务端更新锁的入口）。
      var up = el('button', 'btn primary', updateInFlight ? '⏳ 更新中…' : ('⬆️ 更新并重启 · v' + u.latest));
      if (updateInFlight) { up.disabled = true; }
      else { up.onclick = function () { askUpdate(u.latest); }; }
      row.appendChild(up);
      row.appendChild(el('span', 'note', updateInFlight ? '安装中，完成后会自动重启…' : '默认只检测不自动升级；点上方按钮装最新版并自动重启。'));
      box.appendChild(row);
    } else {
      box.appendChild(el('div', 'note', '✅ 已是最新版 v' + u.current + (u.latest ? '' : '（最新版查询失败，可稍后重试）')));
    }
  }
  function askRestart() {
    confirmDialog({
      title: '🔁 重启 Feishu Bridge？',
      lines: [
        '重启期间所有群短暂无响应（通常数秒）。',
        '正在进行的 codex 会话会被优雅关闭并在重启后可继续。',
        '本机服务管理器会在旧实例退出后自动拉起新实例。',
      ],
      confirmLabel: '确认重启',
      onConfirm: function () { postAction('/api/daemon/restart', '重启'); },
    });
  }
  function askStart() {
    confirmDialog({
      title: '▶️ 启动 Feishu Bridge？',
      lines: [
        '将把 Feishu Bridge 注册为后台服务并拉起（开机自启、崩溃自动拉起）。',
        '起来后本页会自动把你带进可写控制台 —— 端口在哪、要不要重开都不用你操心。',
      ],
      confirmLabel: '确认启动',
      onConfirm: function () { postAction('/api/daemon/start', '启动'); },
    });
  }
  function askStop() {
    confirmDialog({
      title: '⏹ 停止 Feishu Bridge？',
      danger: true,
      lines: [
        '将停止 Feishu Bridge 并移除开机自启（与 CLI stop 一致）。',
        '所有群将无响应，直到你重新「启动」或运行 feishu-codex-bridge start。',
        '本控制台由 Feishu Bridge 提供 —— 停止后会断开连接（属正常，不是出错）。',
      ],
      confirmLabel: '确认停止',
      onConfirm: function () { postAction('/api/daemon/stop', '停止'); },
    });
  }
  function askUpdate(latest) {
    confirmDialog({
      title: '⬆️ 更新并重启到 v' + latest + '？',
      lines: [
        '将执行 npm i -g 安装最新版，完成后自动重启 Feishu Bridge 加载新代码。',
        '重启期间所有群短暂无响应；正在进行的会话会被优雅关闭。',
      ],
      confirmLabel: '确认更新',
      onConfirm: function () { postUpdate(latest); },
    });
  }
  // 升级：POST 后轮询 /api/update/status，失败会明确报出来（否则 detached helper 的失败对
  // 网页端完全静默、用户只看到「已发起」）；成功会重启 daemon → 连接短暂断开，由版本变更流
  // 接管显示「已是最新版」。updateInFlight 兼作按钮 in-flight 闸，挡住重复点击。
  function postUpdate(latest) {
    if (updateInFlight) { toast('⏳ 升级已在进行中…'); return; }
    updateInFlight = true;
    var box = $('updateBody'); if (box && lastUpdate) renderUpdate(box, lastUpdate); // 立刻把按钮切成禁用的「更新中…」
    fetch('/api/update', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      .then(function (r) { return r.json().then(function (j) { return { status: r.status, body: j }; }); })
      .then(function (resp) {
        if (resp.status !== 202) {
          updateInFlight = false;
          toast((resp.status === 501 ? '⏳ ' : '❌ ') + (resp.body.message || ('HTTP ' + resp.status)));
          var b = $('updateBody'); if (b) loadUpdate(b);
          return;
        }
        toast('✅ ' + (resp.body.message || '升级已发起'));
        pollUpdateStatus(0, latest);
      })
      .catch(function () { updateInFlight = false; toast('❌ 请求失败'); });
  }
  function pollUpdateStatus(tries, latest) {
    if (tries > 60) { updateInFlight = false; toast('⏳ 安装仍在后台进行，稍后刷新页面查看'); return; } // ~90s 兜底：别无限轮询
    fetch('/api/update/status').then(function (r) { return r.json(); })
      .then(function (s) {
        if (!s || s.phase === 'installing' || s.phase === 'restarting') {
          setTimeout(function () { pollUpdateStatus(tries + 1, latest); }, 1500);
          return;
        }
        updateInFlight = false;
        if (s.phase === 'error') {
          toast('❌ 升级失败：' + (s.message || '未知错误'));
          var box = $('updateBody'); if (box) loadUpdate(box); // 恢复可点的更新卡供重试
        } else if (s.phase === 'done') {
          toast('✅ 已更新到 v' + (s.to || latest || '') + '，正在重启…');
          lastUpdate = null; updateCheckedAt = 0; // 作废缓存：重启后版本变更流会翻成「已是最新版」
        }
      })
      .catch(function () {
        // 拿不到状态：多半 daemon 正在重启（成功路径）→ 交给重连/版本变更流收尾。
        updateInFlight = false;
      });
  }
  // 202 = 已发起（detached helper 接管）；501 = 只读预览（无 daemon）。
  function postAction(path, label) {
    fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      .then(function (r) { return r.json().then(function (j) { return { status: r.status, body: j }; }); })
      .then(function (resp) {
        if (resp.status === 202) toast('✅ ' + (resp.body.message || (label + '已发起')));
        else if (resp.status === 501) toast('⏳ ' + (resp.body.message || (label + '需要 Feishu Bridge 在跑（当前为只读预览）')));
        else toast('❌ ' + (resp.body.message || ('HTTP ' + resp.status)));
      })
      .catch(function () { toast('❌ 请求失败'); });
  }

  // ── 多机器人聚合（总览：全局总览 + enabled 快速开关 + ➕；删除主入口在 bot Tab 头部）──
  function renderBots(box, countEl) {
    box.textContent = '';
    if (!state || state.bots.length === 0) {
      // 首次使用欢迎 hero：一句话装好桥后落到这里，醒目引导扫码建第一个机器人（全程浏览器）。
      box.className = '';
      var hero = el('div', 'firstrun');
      hero.appendChild(el('div', 'fr-emoji', '🚀'));
      hero.appendChild(el('div', 'fr-title', '欢迎！还差最后一步：创建你的第一个飞书机器人'));
      hero.appendChild(el('div', 'fr-sub', '点下面的按钮，用飞书扫码即可创建并授权——全程在这个网页里完成，不用碰终端。'));
      var cta = el('button', 'btn primary fr-cta', '➕ 扫码创建第一个机器人');
      cta.onclick = function () { tryAddBot(); };
      hero.appendChild(cta);
      box.appendChild(hero);
      if (countEl) countEl.textContent = '';
      return;
    }
    box.className = '';
    if (countEl) countEl.textContent = '共 ' + state.bots.length + ' 个';
    state.bots.forEach(function (b) {
      var row = el('div', 'bot-row');
      var grow = el('div', 'grow');
      var head = el('div', 'statline');
      var nameLink = el('span', null, botTitle(b));
      nameLink.style.cursor = 'pointer';
      nameLink.style.fontWeight = '600';
      nameLink.onclick = function () { go({ tab: 'bot', botId: b.appId }); };
      head.appendChild(nameLink);
      head.appendChild(el('span', 'tag', b.tenant === 'lark' ? 'Lark' : '飞书'));
      head.appendChild(el('span', 'tag', b.appId));
      if (b.current) head.appendChild(el('span', 'tag blue', '主'));
      grow.appendChild(head);
      grow.appendChild(el('div', 'note',
        (b.running ? '运行中' + (b.pid ? ' · pid ' + b.pid : '') : '未在运行') +
        ' · ' + ((b.projects && b.projects.length) || 0) + ' 个项目'));
      row.appendChild(grow);
      // 已启用 ≠ 已上线：加进活跃集了，但 Feishu Bridge 没在跑就不会真正连上。明确提示别误会。
      if (b.active && daemon && !daemon.running) {
        var warn = el('span', 'tag orange', '⚠️ Feishu Bridge 未运行');
        warn.title = '已加入活跃集，但 Feishu Bridge 没在跑 —— 去仪表盘「启动」后这个机器人才真正上线。';
        warn.style.marginRight = '8px';
        row.appendChild(warn);
      }
      var sw = el('button', 'btn' + (b.active ? ' primary' : ''), b.active ? '✅ 已启用' : '⛔ 已停用');
      sw.title = b.active ? '点一下停用（退出活跃集）' : '点一下启用（加入活跃集）';
      sw.onclick = function () { toggleBotEnabled(b); };
      row.appendChild(sw);
      var open = el('button', 'btn', '管理 →');
      open.onclick = function () { go({ tab: 'bot', botId: b.appId }); };
      row.appendChild(open);
      box.appendChild(row);
    });
  }

  function toggleBotEnabled(b) {
    var enabling = !b.active;
    fetch('/api/bots/' + encodeURIComponent(b.appId), {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: enabling }),
    }).then(function (r) { return r.json().then(function (j) { return { status: r.status, body: j }; }); })
      .then(function (resp) {
        if (resp.status === 200) {
          toast('✅ ' + (resp.body.message || '已保存'));
          loadState();
          // 改活跃集要重启 Feishu Bridge 才生效。daemon 在跑 → 弹窗确认，确认就帮用户
          // 自动重启（postAction → /api/daemon/restart，detached helper 拉新实例），省去
          // 终端 restart。daemon 没在跑（只读预览）就不弹——那种情况要 start 不是重启，
          // 现有 toast 已引导。（注意：本文件整体在模板字符串里，注释/代码都禁用反引号。）
          if (daemon && daemon.running) {
            var who = '「' + (b.botName || b.name) + '」';
            confirmDialog({
              title: '🔄 立即重启 Feishu Bridge 让改动生效？',
              lines: [
                who + (enabling ? ' 已加入活跃集，重启后会被拉起上线。' : ' 已移出活跃集，重启后会停止运行。'),
                '重启约数秒，期间所有在线机器人的长连接会短暂断开并自动重连。',
              ],
              confirmLabel: '立即重启',
              onConfirm: function () { postAction('/api/daemon/restart', '重启'); },
            });
          }
        } else toast('❌ ' + (resp.body.message || ('HTTP ' + resp.status)));
      })
      .catch(function () { toast('❌ 请求失败'); });
  }

  function askDeleteBot(b) {
    confirmDialog({
      title: '🗑️ 删除机器人「' + (b.botName || b.name) + '」？',
      lines: [
        '将永久删除：注册表项 + 本机加密密钥 + 状态目录（项目 / 话题记录）。',
        '此操作不可撤销。删除后需重新 init 才能再次接入这个 App。',
      ],
      danger: true,
      confirmLabel: '确认删除',
      onConfirm: function () {
        fetch('/api/bots/' + encodeURIComponent(b.appId), { method: 'DELETE' })
          .then(function (r) { return r.json().then(function (j) { return { status: r.status, body: j }; }); })
          .then(function (resp) {
            if (resp.status === 200) {
              toast('✅ ' + (resp.body.message || '已删除'));
              go({ tab: 'overview' });
              loadState();
            } else toast('❌ ' + (resp.body.message || ('HTTP ' + resp.status)));
          })
          .catch(function () { toast('❌ 请求失败'); });
      },
    });
  }

  // ── 🧠 后端管理（按 agentFamily 分组；每后端一张富信息行：版本/状态 + 下载/更新/卸载）──
  function refreshBackends() {
    loadCatalog().then(function () { if (parseRoute(location.hash).tab === 'backends' || parseRoute(location.hash).tab === 'overview') renderRoute(); });
  }
  // 「检查更新」：GET /version → 有新版则把按钮变成「更新到 vX」（点了走 update SSE）。
  function checkBackendUpdate(e, item, btn) {
    btn.disabled = true; btn.className = 'btn sm disabled'; btn.textContent = '🔍 查询中…';
    fetch('/api/backends/' + encodeURIComponent(e.id) + '/version').then(function (r) { return r.json(); }).then(function (v) {
      if (v.hasUpdate && v.latest) {
        btn.className = 'btn primary sm'; btn.disabled = false; btn.textContent = '🔄 更新到 v' + v.latest;
        btn.onclick = function () { startBackendInstall(e, item, btn, 'update'); };
        toast('🆕 有新版 v' + v.latest + '（当前 v' + (v.installed || '?') + '）');
      } else {
        btn.textContent = '✅ 已是最新' + (v.installed ? ' v' + v.installed : (v.latest ? ' v' + v.latest : ''));
        setTimeout(function () { btn.className = 'btn sm'; btn.disabled = false; btn.textContent = '🔄 检查更新'; btn.onclick = function () { checkBackendUpdate(e, item, btn); }; }, 2600);
      }
    }).catch(function () { btn.className = 'btn sm'; btn.disabled = false; btn.textContent = '🔄 检查更新'; toast('❌ 版本查询失败（网络/registry）'); });
  }

  function askUninstallBackend(e) {
    confirmDialog({
      title: '🗑️ 卸载「' + e.displayName + '」？',
      lines: [
        '将删除用户私装目录里的该后端依赖' + (e.approxSizeMB ? '（约 ' + e.approxSizeMB + 'M）' : '') + '。',
        '随时可再点「下载」装回。正在用它的项目记得改回其它后端。',
      ],
      danger: true, confirmLabel: '确认卸载',
      onConfirm: function () {
        fetch('/api/backends/' + encodeURIComponent(e.id), { method: 'DELETE' })
          .then(function (r) { return r.json().then(function (j) { return { status: r.status, body: j }; }); })
          .then(function (resp) {
            if (resp.status === 200) { toast('✅ ' + (resp.body.message || '已卸载')); refreshBackends(); }
            else if (resp.status === 501) toast('⏳ ' + (resp.body.message || '需要 Feishu Bridge 在跑'));
            else toast('❌ ' + (resp.body.message || ('HTTP ' + resp.status)));
          }).catch(function () { toast('❌ 请求失败'); });
      },
    });
  }

  // 按需安装/更新：POST /api/backends/:id/(install|update) 的 SSE（{type:'log'} → done/error）。
  function startBackendInstall(entry, item, btn, mode) {
    var isUpd = mode === 'update';
    btn.className = 'btn primary sm disabled'; btn.disabled = true; btn.textContent = isUpd ? '⏳ 更新中…' : '⏳ 安装中…';
    var bar = el('div', 'progress'); var fill = el('div'); bar.appendChild(fill);
    item.appendChild(bar);
    var tail = el('div', 'insttail');
    item.appendChild(tail);
    var lines = 0;
    function bump() { lines++; var pct = Math.min(92, 8 + lines * 4); fx.width(fill, pct); }

    fetch('/api/backends/' + encodeURIComponent(entry.id) + '/' + (isUpd ? 'update' : 'install'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    }).then(function (resp) {
      if (!resp.body || !resp.body.getReader) { tail.textContent = '（浏览器不支持流式读取，请改用终端安装）'; return; }
      var reader = resp.body.getReader();
      var dec = new TextDecoder();
      var buf = '';
      function pump() {
        return reader.read().then(function (chunk) {
          if (chunk.done) return;
          buf += dec.decode(chunk.value, { stream: true });
          var parts = buf.split('\\n\\n');
          buf = parts.pop();
          parts.forEach(function (block) { handleInstallBlock(block, tail, fill, btn, entry, bump, isUpd); });
          return pump();
        });
      }
      return pump();
    }).catch(function () {
      btn.className = 'btn primary sm'; btn.disabled = false; btn.textContent = isUpd ? '🔄 重试更新' : '⬇️ 重试';
      tail.textContent += '\\n❌ 请求失败';
    });
  }

  function handleInstallBlock(block, tail, fill, btn, entry, bump, isUpd) {
    var msg = parseSseDataBlock(block);
    if (!msg) return;
    if (msg.type === 'log') {
      bump();
      tail.textContent += (tail.textContent ? '\\n' : '') + msg.chunk;
      tail.scrollTop = tail.scrollHeight;
    } else if (msg.type === 'done') {
      fx.width(fill, 100);
      btn.textContent = isUpd ? '✅ 已更新' : '✅ 已安装'; btn.className = 'btn sm disabled';
      toast('✅ 「' + entry.displayName + '」' + (isUpd ? '更新' : '安装') + '完成');
      refreshBackends();
    } else if (msg.type === 'error') {
      btn.className = 'btn primary sm'; btn.disabled = false; btn.textContent = isUpd ? '🔄 重试更新' : '⬇️ 重试';
      var hint = msg.code === 'not_wired_yet'
        ? '需要 Feishu Bridge 在跑（当前为只读预览）'
        : msg.code === 'aborted' ? '已取消' : (msg.message || '失败');
      tail.textContent += (tail.textContent ? '\\n' : '') + '❌ ' + hint;
      toast('❌ ' + hint);
    }
  }

  // ── 宿主机体检 ──────────────────────────────────────────────────────────────
  function loadHostDoctor(box) {
    box.textContent = '🔍 正在检测…';
    fetch('/api/host-doctor').then(function (r) { return r.json(); })
      .then(function (h) { renderHostDoctor(box, h); })
      .catch(function () { box.textContent = '⚠️ 体检请求失败'; });
  }
  function renderHostDoctor(box, h) {
    box.textContent = '';
    var rt = el('div', 'statline');
    rt.appendChild(el('span', 'tag blue', 'Node ' + h.node));
    rt.appendChild(el('span', 'tag', h.platform + '/' + h.arch));
    rt.appendChild(el('span', 'tag', 'v' + h.version));
    box.appendChild(rt);
    box.appendChild(el('div', 'path', '🗂️ 配置目录：' + h.appDir));
    box.appendChild(el('div', 'path', '📜 日志目录：' + h.logsDir + '（' + fmtBytes(h.logBytes) + '）'));
    var title = el('div', null, '🧠 后端环境：');
    title.style.marginTop = '6px';
    box.appendChild(title);
    (h.backends || []).forEach(function (bk) {
      var row = el('div', 'statline');
      row.appendChild(el('span', null, (bk.ok ? '✅' : '❌') + ' ' + bk.name + (bk.version ? ' ' + bk.version : '') + (bk.isDefault ? '（默认）' : '')));
      if (bk.ok && bk.location) row.appendChild(el('span', 'note', bk.location));
      if (!bk.ok && bk.hint) row.appendChild(el('span', 'note', bk.hint));
      box.appendChild(row);
    });
  }

  // ════════════════════════════════════════════════════════════════════════════
  //  每 bot 一个 Tab（单 bot 维度）
  // ════════════════════════════════════════════════════════════════════════════
  function renderBotTab(root, botId) {
    var b = botOf(botId);
    if (!b) {
      var empty = el('div', 'card');
      empty.appendChild(el('div', 'empty', '这个机器人不存在或已删除。'));
      var back = el('button', 'btn primary', '← 回总览');
      back.onclick = function () { go({ tab: 'overview' }); };
      empty.appendChild(back);
      root.appendChild(empty);
      return;
    }

    // 头部：bot 概览 + 停用/删除（下沉到 bot Tab 头部）
    var headCard = el('div', 'card');
    var hh = el('h2');
    hh.appendChild(document.createTextNode('📡 ' + (b.botName || b.name) + ' '));
    var hright = el('span', 'right');
    var sw = el('button', 'btn' + (b.active ? ' primary' : ''), b.active ? '✅ 已启用' : '⛔ 已停用');
    sw.onclick = function () { toggleBotEnabled(b); };
    hright.appendChild(sw);
    var del = el('button', 'btn danger', '🗑️ 删除');
    del.style.marginLeft = '8px';
    del.onclick = function () { askDeleteBot(b); };
    hright.appendChild(del);
    hh.appendChild(hright);
    headCard.appendChild(hh);
    renderBotOverview(headCard, b);
    root.appendChild(headCard);

    var cols = el('div', 'cols');
    var left = el('div');
    var right = el('div');

    // 🩺 事件订阅诊断 + setup-status
    var diagCard = el('div', 'card');
    var dh = el('h2'); dh.appendChild(document.createTextNode('🩺 接入诊断 '));
    var dright = el('span', 'right');
    var diagBtn = el('button', 'btn', '🩺 诊断');
    diagBtn.onclick = function () { loadDiagnosis(botId, diagBody); };
    dright.appendChild(diagBtn); dh.appendChild(dright);
    diagCard.appendChild(dh);
    var diagBody = el('div', 'note', '点「🩺 诊断」检测事件订阅与各后端环境（约 3 秒）。');
    diagCard.appendChild(diagBody);
    left.appendChild(diagCard);
    // 切回来时若 diag 仍属本 bot，直接重渲。
    if (diag && diagBotId === botId) renderDiagnosis(diagBody);

    // 📁 项目列表
    var projCard = el('div', 'card');
    var ph = el('h2'); ph.appendChild(document.createTextNode('📁 项目列表 '));
    var pcount = el('span', 'right note'); ph.appendChild(pcount);
    projCard.appendChild(ph);
    var projList = el('div'); projCard.appendChild(projList);
    left.appendChild(projCard);
    renderProjects(projList, pcount, b);

    // 🔔 普通任务结束提醒（每 bot 独立）。选择即保存；仅 long 额外展示分钟阈值。
    renderCompletionReminderCard(right, b);

    cols.appendChild(left);
    cols.appendChild(right);
    root.appendChild(cols);

    // 抽屉若在该 bot 打开过，恢复（轮询不刷没）。
    if (drawerProject) renderDrawer(drawerProject);
  }

  // 飞书 applink「打开机器人」：在飞书客户端里直接拉起与该 bot 的私聊（同开发者后台
  // 「创建成功 → 打开应用」那条链）。feishu / lark 各自域名。
  function botOpenLink(appId, tenant) {
    var host = tenant === 'lark' ? 'applink.larksuite.com' : 'applink.feishu.cn';
    return 'https://' + host + '/client/bot/open?appId=' + encodeURIComponent(appId || '');
  }
  function openBotBtn(appId, tenant, label) {
    var a = el('a', 'btn', label || '🔗 在飞书中打开');
    a.href = botOpenLink(appId, tenant); a.target = '_blank'; a.rel = 'noopener';
    return a;
  }

  function renderBotOverview(card, b) {
    var line1 = el('div', 'statline');
    line1.appendChild(el('span', 'tag', b.tenant === 'lark' ? 'Lark' : '飞书'));
    line1.appendChild(el('span', 'tag', b.appId));
    if (b.current) line1.appendChild(el('span', 'tag blue', '主 bot'));
    if (b.active) line1.appendChild(el('span', 'tag blue', '活跃集'));
    card.appendChild(line1);
    var openRow = el('div'); openRow.style.marginTop = '8px';
    openRow.appendChild(openBotBtn(b.appId, b.tenant, '🔗 在飞书中打开机器人'));
    card.appendChild(openRow);
    var line2 = el('div', 'statline');
    if (b.running) {
      line2.appendChild(el('span', 'tag green', '✅ bridge 运行中 · pid ' + b.pid));
      if (b.connection) {
        var connOk = b.connection === 'connected';
        line2.appendChild(el('span', 'tag ' + (connOk ? 'green' : 'orange'), '长连接 ' + connText(b.connection)));
      }
    } else {
      line2.appendChild(el('span', 'tag orange', '⚠️ bridge 未在运行'));
      line2.appendChild(el('span', 'note', '终端执行 run / start 后这里显示实时状态'));
    }
    card.appendChild(line2);
    card.appendChild(el('div', 'note', '版本 v' + state.version + ' · 快照 ' + new Date(state.generatedAt).toLocaleTimeString()));
  }

  function loadDiagnosis(botId, box) {
    box.textContent = '🔍 正在检测事件订阅与各后端环境…';
    fetch('/api/diagnosis?bot=' + encodeURIComponent(botId)).then(function (r) { return r.json(); })
      .then(function (d) {
        diag = d; diagBotId = botId;
        // 只有当前仍停在该 bot Tab 才渲染（避免切走后串台）。
        if (currentBotId() === botId) renderDiagnosis(box);
      })
      .catch(function () { box.textContent = '⚠️ 诊断请求失败'; });
  }
  function renderDiagnosis(box) {
    box.textContent = '';
    box.className = 'note';
    if (!diag) return;
    box.appendChild(el('div', null, 'ℹ️ 事件订阅：请自行到「事件与回调」确认已订阅 im.message.receive_v1（长连接）；此项系统无法可靠检测，仅作提醒。'));
    var title = el('div', null, '🧠 后端环境：');
    title.style.marginTop = '6px';
    box.appendChild(title);
    (diag.backends || []).forEach(function (bk) {
      var row = el('div', 'statline');
      row.appendChild(el('span', null, (bk.ok ? '✅' : '❌') + ' ' + bk.name + (bk.version ? ' ' + bk.version : '') + (bk.isDefault ? '（默认）' : '')));
      if (!bk.ok && bk.hint) row.appendChild(el('span', 'note', bk.hint));
      box.appendChild(row);
    });
  }

  function renderCompletionReminderCard(root, b) {
    var reminder = b.completionReminder || { mode: 'failures', longTaskMinutes: 3 };
    var card = el('div', 'card');
    card.appendChild(el('h2', null, '🔔 完成提醒'));
    card.appendChild(el('div', 'note', '任务结束后是否另发一条消息 @ 发起人。每个机器人独立设置，保存后立即生效。'));
    var modes = [
      { label: '仅手动', value: 'manual' },
      { label: '长任务', value: 'long' },
      { label: '失败或超时', value: 'failures' },
      { label: '每次结束', value: 'always' },
    ];
    card.appendChild(optButtons(modes, reminder.mode, function (mode) {
      postWrite('/api/bots/' + encodeURIComponent(b.appId) + '/completion-reminder', {
        mode: mode,
        longTaskMinutes: reminder.longTaskMinutes,
      });
    }));

    var descriptions = {
      manual: '运行卡显示「完成后提醒我」，只有本轮发起人点过才通知。',
      long: '任务耗时达到阈值后通知；运行卡不显示提醒按钮。',
      failures: '仅任务失败或假死超时时通知；运行卡不显示提醒按钮。',
      always: '每次正常结束、失败或超时都通知；运行卡不显示提醒按钮。',
    };
    card.appendChild(el('div', 'note', descriptions[reminder.mode] || descriptions.failures));

    if (reminder.mode === 'long') {
      var threshold = el('div', 'statline');
      threshold.appendChild(el('span', null, '长任务阈值'));
      var input = el('input', 'compact-input');
      input.type = 'number'; input.min = '1'; input.max = '1440'; input.step = '1';
      input.value = String(reminder.longTaskMinutes);
      input.setAttribute('aria-label', '长任务阈值（分钟）');
      threshold.appendChild(input);
      threshold.appendChild(el('span', 'note', '分钟（1–1440）'));
      var save = el('button', 'btn primary sm', '保存阈值');
      save.onclick = function () {
        var minutes = Number(input.value);
        if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) {
          toast('❌ 长任务阈值请输入 1–1440 的整数分钟');
          return;
        }
        postWrite('/api/bots/' + encodeURIComponent(b.appId) + '/completion-reminder', {
          mode: 'long', longTaskMinutes: minutes,
        });
      };
      threshold.appendChild(save);
      card.appendChild(threshold);
    }
    root.appendChild(card);
  }

  function renderProjects(box, countEl, b) {
    box.textContent = '';
    var projects = (b && b.projects) || [];
    if (countEl) countEl.textContent = '共 ' + projects.length + ' 个项目';
    if (projects.length === 0) {
      box.className = 'empty';
      box.textContent = '还没有项目。到飞书私聊机器人，点「➕ 新建项目」创建。';
      return;
    }
    box.className = '';
    projects.forEach(function (p) {
      var item = el('div', 'proj');
      var head = el('div', 'statline');
      head.appendChild(el('span', 'name', p.name + (p.blank ? '（空白）' : '')));
      if (p.branch && p.branch !== '—') head.appendChild(el('span', 'tag', '🌿 ' + p.branch));
      item.appendChild(head);
      var meta = el('div', 'meta');
      meta.appendChild(el('span', 'tag', kindLabel(p.kind)));
      if (p.origin === 'joined') meta.appendChild(el('span', 'tag', '🔗 已加入'));
      meta.appendChild(el('span', 'tag ' + (p.mode === 'full' ? 'orange' : 'green'), '🔐 ' + permissionSummary(p)));
      meta.appendChild(el('span', 'tag blue', '🧠 ' + p.backend));
      meta.appendChild(el('span', 'tag', '🧵 ' + p.sessionCount + ' 话题'));
      meta.appendChild(el('span', 'tag', '✋ 免@：' + (p.noMention ? '开' : '关')));
      item.appendChild(meta);
      item.appendChild(el('div', 'path', '📂 ' + p.cwd));
      var ops = el('div', 'statline');
      var btn = el('button', 'btn primary', '⚙️ 设置');
      btn.onclick = function () { openDrawer(p.name); };
      ops.appendChild(btn);
      item.appendChild(ops);
      box.appendChild(item);
    });
  }

  // ── 项目详情抽屉 ────────────────────────────────────────────────────────────
  function openDrawer(name) {
    drawerProject = name;
    renderDrawer(name);
    $('drawer').classList.add('open');
    $('drawerMask').classList.add('open');
  }
  function closeDrawer() {
    drawerProject = null;
    var d = $('drawer'); if (d) d.classList.remove('open');
    var m = $('drawerMask'); if (m) m.classList.remove('open');
  }

  function findProject(name) {
    var b = botOf(currentBotId());
    var list = (b && b.projects) || [];
    for (var i = 0; i < list.length; i++) if (list[i].name === name) return list[i];
    return null;
  }

  // 写操作统一入口：200 ✅；501 = 只读预览；其余把服务端中文 message 弹出来。
  function postWrite(path, body) {
    var botId = currentBotId();
    fetch(path + '?bot=' + encodeURIComponent(botId), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    }).then(function (r) { return r.json().then(function (j) { return { status: r.status, body: j }; }); })
      .then(function (resp) {
        if (resp.status === 501) toast('⏳ ' + (resp.body.message || '写操作需要 Feishu Bridge 在跑（当前为只读预览）'));
        else if (resp.status === 200) { toast('✅ 已保存'); loadState(); }
        else toast('❌ ' + (resp.body.message || ('HTTP ' + resp.status)));
      })
      .catch(function () { toast('❌ 请求失败'); });
  }

  function optButtons(opts, current, onPick) {
    var row = el('div', 'opt-row');
    opts.forEach(function (o) {
      var b = el('button', 'btn' + (o.value === current ? ' primary' : ''), o.label);
      b.onclick = function () { onPick(o.value); };
      row.appendChild(b);
    });
    return row;
  }

  function renderDrawer(name) {
    var p = findProject(name);
    var d = $('drawer');
    d.textContent = '';
    if (!p) { d.appendChild(el('div', 'empty', '项目不存在或已删除')); return; }
    var close = el('button', 'btn', '✕ 关闭');
    close.style.cssFloat = 'right';
    close.onclick = closeDrawer;
    d.appendChild(close);
    d.appendChild(el('h3', null, '⚙️ 项目设置 · ' + p.name));
    d.appendChild(el('div', 'note', kindLabel(p.kind) + ' · 📂 ' + p.cwd));
    d.appendChild(el('hr', 'hr'));

    // 🔐 权限
    d.appendChild(el('div', null, '🔐 权限'));
    d.appendChild(el('div', 'note', '当前 ' + permissionSummary(p) + ' · codex 沙箱可访问的范围（管理员 / 普通用户可分设）'));
    var tiers = [
      { label: '🔒 项目内只读', value: 'qa' },
      { label: '✏️ 项目内读写', value: 'write' },
      { label: '⚠️ 完全访问', value: 'full' },
    ];
    d.appendChild(el('div', 'note', '👑 管理员档'));
    d.appendChild(optButtons(tiers, p.mode, function (v) {
      postWrite('/api/project/' + encodeURIComponent(p.name) + '/permission', { mode: v, guestMode: p.guestMode, network: p.network });
    }));
    d.appendChild(el('div', 'note', '👥 普通用户档'));
    d.appendChild(optButtons(tiers, p.guestMode, function (v) {
      postWrite('/api/project/' + encodeURIComponent(p.name) + '/permission', { mode: p.mode, guestMode: v, network: p.network });
    }));
    d.appendChild(el('hr', 'hr'));

    // 🧠 后端（只读：创建时选定，运行时固定，不支持切换 —— 改后端需删项目重建）
    d.appendChild(el('div', null, '🧠 后端'));
    var bkName = p.backend ? backendName(p.backend) : 'Codex App Server（默认）';
    var bkRO = el('div', 'statline');
    bkRO.appendChild(el('span', 'tag blue', '🧠 ' + bkName));
    bkRO.appendChild(el('span', 'tag', '🔒 创建时锁定'));
    d.appendChild(bkRO);
    d.appendChild(el('div', 'note', '后端在新建项目时选定，运行时固定、不支持切换。如需更改，请删除该项目后用新后端重新创建。'));
    d.appendChild(el('hr', 'hr'));

    // ✋ 免@
    d.appendChild(el('div', null, '✋ 免@（不用 @ 也回复）'));
    d.appendChild(optButtons(
      [{ label: '开', value: 'on' }, { label: '关', value: 'off' }],
      p.noMention ? 'on' : 'off',
      function (v) { postWrite('/api/project/' + encodeURIComponent(p.name) + '/no-mention', { on: v === 'on' }); }
    ));
    d.appendChild(el('div', 'note', p.kind === 'single'
      ? '开启后：本群所有消息(不用 @)都交给机器人处理。'
      : '开启后：话题内消息(不用 @)都处理；开新话题仍需 @机器人。'));
    d.appendChild(el('hr', 'hr'));

    // 🗜️ 自动压缩
    d.appendChild(el('div', null, '🗜️ 自动压缩上下文'));
    d.appendChild(optButtons(
      [{ label: '开', value: 'on' }, { label: '关', value: 'off' }],
      p.autoCompact ? 'on' : 'off',
      function (v) { postWrite('/api/project/' + encodeURIComponent(p.name) + '/auto-compact', { on: v === 'on' }); }
    ));
    d.appendChild(el('div', 'note', '开启后：上下文接近上限时 Codex 自动总结早前对话、释放空间（默认开）。'));
    d.appendChild(el('hr', 'hr'));

    // 🧵 话题
    d.appendChild(el('div', null, '🧵 话题 · 共 ' + p.sessionCount + ' 个'));
    var topicBox = el('div', 'note', '加载中…');
    d.appendChild(topicBox);
    fetch('/api/project/' + encodeURIComponent(p.name) + '/sessions?bot=' + encodeURIComponent(currentBotId()))
      .then(function (r) { return r.json(); })
      .then(function (j) {
        topicBox.textContent = '';
        var list = j.sessions || [];
        if (list.length === 0) { topicBox.textContent = '（暂无话题）'; return; }
        list.slice(0, 50).forEach(function (s) {
          var line = (s.summary || '(空)').replace(/\\s+/g, ' ').slice(0, 50);
          topicBox.appendChild(el('div', null, '· ' + line + ' · ' + new Date(s.updatedAt).toLocaleString()));
        });
        if (list.length > 50) topicBox.appendChild(el('div', null, '· …还有 ' + (list.length - 50) + ' 个话题'));
      })
      .catch(function () { topicBox.textContent = '⚠️ 话题加载失败'; });
  }

  // ════════════════════════════════════════════════════════════════════════════
  //  ➕ 添加机器人向导（扫码 → checklist → 完成）
  // ════════════════════════════════════════════════════════════════════════════
  var wizStep = 1;          // 1=扫码 2=checklist 3=完成
  var wizBotId = null;
  var wizPoll = null;       // setup-status 轮询定时器
  var wizSetup = null;
  var wizEs = null;         // 扫码 SSE EventSource
  var wizQrSessionId = null;
  var wizCountdown = null;  // 二维码过期倒计时
  var wizAutoEnabled = false;    // 新 bot 是否已自动加入活跃集（一次性）
  var wizRestartPrompted = false; // 完成步是否已弹过「重启拉起」确认（一次性）

  // 添加机器人是写操作：Feishu Bridge 没在跑时控制台为只读，不能加（与「没启动只读」一致）。
  // 没在跑就引导先启动，而不是打开向导让用户扫码后再被 501 挡回。
  function tryAddBot() {
    if (daemon && daemon.running) { openWizard(); return; }
    confirmDialog({
      title: '需要先启动 Feishu Bridge',
      lines: [
        'Feishu Bridge 未在运行时控制台为只读，无法添加机器人。',
        '先启动 Feishu Bridge，再回来添加。',
      ],
      confirmLabel: '立即启动',
      onConfirm: function () { postAction('/api/daemon/start', '启动'); },
    });
  }

  function openWizard() {
    wizStep = 1; wizBotId = null; wizSetup = null;
    wizAutoEnabled = false; wizRestartPrompted = false;
    stopWizPoll(); stopWizQr();
    $('wizMask').classList.add('open');
    renderWizard();
    fx.popIn($('wizBody'));
  }
  function closeWizard() {
    stopWizPoll(); stopWizQr();
    $('wizMask').classList.remove('open');
    loadState();
  }
  function stopWizPoll() { if (wizPoll) { clearInterval(wizPoll); wizPoll = null; } }
  function stopWizQr() {
    if (wizEs) { try { wizEs.close(); } catch (e) {} wizEs = null; }
    if (wizCountdown) { clearInterval(wizCountdown); wizCountdown = null; }
    if (wizQrSessionId) {
      // 主动取消后台扫码会话（防僵尸轮询打飞书）。
      fetch('/api/bots/register-qr?sessionId=' + encodeURIComponent(wizQrSessionId), { method: 'DELETE' }).catch(function () {});
      wizQrSessionId = null;
    }
  }

  function wizStepBar(active) {
    var bar = el('div', 'steps');
    ['① 扫码创建', '② 接入检测', '③ 完成'].forEach(function (lab, i) {
      var n = i + 1;
      bar.appendChild(el('div', 'step' + (n === active ? ' on' : (n < active ? ' done' : '')), lab));
    });
    return bar;
  }

  function renderWizard() {
    if (wizStep === 1) return renderWizScan();
    if (wizStep === 2) return renderWizChecklist();
    return renderWizDone();
  }

  // ── ① 扫码注册 ────────────────────────────────────────────────────────────
  function renderWizScan() {
    var w = $('wizBody');
    w.textContent = '';
    w.appendChild(el('h3', null, '➕ 添加机器人'));
    w.appendChild(el('div', 'note', '用飞书 App 扫一下二维码 —— 创建或复用应用、拿密钥入库，并自动将你设为管理员。'));
    w.appendChild(wizStepBar(1));

    var qrWrap = el('div', 'qrbox');
    qrWrap.id = 'wizQrWrap';
    qrWrap.appendChild(el('div', 'note', '正在生成二维码…'));
    w.appendChild(qrWrap);

    var steps = el('div', 'note');
    steps.style.cssText = 'margin-top:6px;line-height:1.7';
    steps.textContent = '① 用飞书 App 扫码 → ② 在飞书里点「创建并授权」 → ③ 回到本页（无需手动刷新），创建成功会自动进入第②步「接入检测」。';
    w.appendChild(steps);

    var statusLine = el('div', 'note'); statusLine.id = 'wizScanStatus';
    statusLine.style.textAlign = 'center';
    w.appendChild(statusLine);

    var actions = el('div', 'actions');
    var cancel = el('button', 'btn', '取消');
    cancel.onclick = closeWizard;
    actions.appendChild(cancel);
    w.appendChild(actions);

    startWizQr();
  }

  // 扫码 SSE：EventSource /api/bots/register-qr/stream → qr / status / done / error。
  function startWizQr() {
    stopWizQr();
    var es = new EventSource('/api/bots/register-qr/stream');
    wizEs = es;
    es.addEventListener('qr', function (ev) {
      var info; try { info = JSON.parse(ev.data); } catch (e) { return; }
      wizQrSessionId = info.sessionId || null;
      renderWizQrCode(info.qrUrl, info.expireIn);
      setScanStatus('📱 用飞书扫码并确认创建…');
    });
    es.addEventListener('status', function (ev) {
      var info; try { info = JSON.parse(ev.data); } catch (e) { return; }
      setScanStatus(scanStatusText(info.status));
    });
    es.addEventListener('done', function (ev) {
      var info; try { info = JSON.parse(ev.data); } catch (e) { return; }
      stopWizQr();
      wizBotId = info.appId;
      wizSetup = info.botName ? { botName: info.botName } : null;
      wizStep = 2; renderWizard(); startWizPoll();
    });
    es.addEventListener('error', function (ev) {
      // EventSource 原生 onerror（无 data）只是连接抖动；带 data 的是服务端 error 事件。
      if (!ev.data) return;
      var info; try { info = JSON.parse(ev.data); } catch (e) { return; }
      var text = scanErrorText(info.code, info.message);
      stopWizQr();
      if (text === null) return; // abort：静默不弹
      renderWizQrError(text);
    });
  }

  function setScanStatus(msg) { var s = $('wizScanStatus'); if (s) s.textContent = msg; }

  function renderWizQrCode(url, expireIn) {
    var wrap = $('wizQrWrap');
    if (!wrap) return;
    wrap.textContent = '';
    var holder = el('div');
    holder.innerHTML = qrSvg(url, { size: 220 });
    wrap.appendChild(holder);
    var cd = el('div', 'qr-count');
    wrap.appendChild(cd);
    var link = el('a', null, '也可以在浏览器打开 ↗');
    link.href = url; link.target = '_blank'; link.rel = 'noopener';
    link.style.fontSize = '12px';
    wrap.appendChild(link);
    var remain = typeof expireIn === 'number' ? expireIn : 600;
    if (wizCountdown) clearInterval(wizCountdown);
    function tick() {
      if (remain <= 0) {
        clearInterval(wizCountdown); wizCountdown = null;
        cd.textContent = '二维码已过期';
        renderWizQrExpired();
        return;
      }
      cd.textContent = '二维码 ' + remain + ' 秒后过期';
      remain--;
    }
    tick();
    wizCountdown = setInterval(tick, 1000);
  }

  function renderWizQrExpired() {
    var wrap = $('wizQrWrap');
    if (!wrap) return;
    var re = el('button', 'btn primary', '🔄 重新生成二维码');
    re.style.marginTop = '8px';
    re.onclick = function () { startWizQr(); var w = $('wizQrWrap'); if (w) { w.textContent = ''; w.appendChild(el('div', 'note', '正在生成二维码…')); } };
    wrap.appendChild(re);
  }

  function renderWizQrError(text) {
    var wrap = $('wizQrWrap');
    if (!wrap) return;
    wrap.textContent = '';
    wrap.appendChild(el('div', 'note', '❌ ' + text));
    var re = el('button', 'btn primary', '🔄 重新生成');
    re.style.marginTop = '8px';
    re.onclick = function () { wrap.textContent = ''; wrap.appendChild(el('div', 'note', '正在生成二维码…')); startWizQr(); };
    wrap.appendChild(re);
  }

  // ── ② checklist（复用 getSetupStatus 5s 轮询）─────────────────────────────
  function startWizPoll() { stopWizPoll(); pollWizSetup(); wizPoll = setInterval(pollWizSetup, 5000); }
  function pollWizSetup() {
    if (!wizBotId) return;
    // 新 bot 默认就加入活跃集——用户不必手动点按钮 / 跑 bot use。一次性；失败下周期重试。
    // 真正「拉起上线」要重启 Feishu Bridge，那一步留到「完成」时弹窗确认（重启会短暂
    // 影响其它在线 bot，所以不静默重启）。
    if (!wizAutoEnabled) {
      wizAutoEnabled = true;
      fetch('/api/bots/' + encodeURIComponent(wizBotId), {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: true }),
      }).catch(function () { wizAutoEnabled = false; });
    }
    fetch('/api/bots/' + encodeURIComponent(wizBotId) + '/setup-status')
      .then(function (r) { return r.json(); })
      .then(function (s) {
        wizSetup = s;
        if (wizStep === 2) renderWizChecklist();
      })
      .catch(function () { /* 下个周期重试 */ });
  }

  function checkItem(ico, title, desc, extra) {
    var item = el('div', 'check-item');
    var ic = el('div', 'ico');
    if (ico === 'spin') ic.appendChild(el('span', 'spin')); else ic.textContent = ico;
    item.appendChild(ic);
    var body = el('div', 'body');
    body.appendChild(el('div', 't', title));
    if (desc) body.appendChild(el('div', 'd', desc));
    if (extra) body.appendChild(extra);
    item.appendChild(body);
    return item;
  }

  function renderWizChecklist() {
    var w = $('wizBody');
    w.textContent = '';
    w.appendChild(el('h3', null, '② 接入检测'));
    w.appendChild(el('div', 'note', '机器人「' + (wizBotId || '') + '」已注册。下面逐项检测接入状态，事件订阅生效后即可去群里 @它。'));
    w.appendChild(wizStepBar(2));
    var s = wizSetup;
    if (!s || !s.credentials) {
      w.appendChild(checkItem('spin', '正在检测…', '首次拉取约 2~3 秒'));
      w.appendChild(wizChecklistActions());
      return;
    }
    w.appendChild(checkItem(
      s.credentials && s.credentials.ok ? '✅' : '❌',
      '密钥有效',
      s.credentials && s.credentials.ok ? '凭据探活通过' + (s.botName ? '（' + s.botName + '）' : '') : ('凭据校验失败：' + ((s.credentials && s.credentials.reason) || '未知'))
    ));
    if (s.credentials && s.credentials.ok && s.scopes) {
      var miss = s.scopes.missingRequired;
      if (miss === undefined) {
        w.appendChild(checkItem('⚠️', '权限检测', '未能读取已授权权限（缺 application:app_version 等只读 scope 时会这样），可先继续。'));
      } else if (miss.length === 0) {
        w.appendChild(checkItem('✅', '必需权限齐全', '核心消息权限已全部授权'));
      } else {
        var grant = el('div', 'note');
        var ga = el('a', null, '一键去授权页补齐这 ' + miss.length + ' 项 ↗');
        ga.href = s.scopes.grantUrl; ga.target = '_blank'; ga.rel = 'noopener';
        grant.appendChild(ga);
        w.appendChild(checkItem('⚠️', '缺 ' + miss.length + ' 项必需权限', miss.join('、'), grant));
      }
    }
    // 「加入活跃集 + 拉起上线」全程静默：新 bot 已在 pollWizSetup 自动加入活跃集，真正拉起
    // 靠最后一步「完成」弹窗确认重启——这里不再显示「待拉起上线」之类的中间态项。
    // 事件订阅：系统无法可靠检测（长连接订阅在已发布版本里的体现不稳定），故只做提醒、不下结论、
    // 不阻塞「下一步」。用户自行去后台核对。
    var evHint = el('div');
    var ea = el('a', null, '打开「事件与回调」配置页 ↗');
    ea.href = (s.eventConfigUrl || '#'); ea.target = '_blank'; ea.rel = 'noopener';
    evHint.appendChild(ea);
    w.appendChild(checkItem('ℹ️', '事件订阅（请自行确认）',
      '请到「事件与回调」确认已订阅 im.message.receive_v1（长连接模式）并已发布版本，否则 @机器人不会有反应。此项系统无法可靠检测，仅作提醒。', evHint));
    w.appendChild(wizChecklistActions());
  }

  function wizChecklistActions() {
    var actions = el('div', 'actions');
    var back = el('button', 'btn', '稍后再说');
    back.onclick = closeWizard;
    actions.appendChild(back);
    actions.appendChild(el('div', 'grow'));
    var next = el('button', 'btn primary', '下一步');
    next.onclick = function () { wizStep = 3; stopWizPoll(); renderWizard(); };
    actions.appendChild(next);
    return actions;
  }

  function copyRow(text) {
    var row = el('div', 'copybox');
    row.appendChild(el('code', null, text));
    var btn = el('button', 'btn', '复制');
    btn.onclick = function () {
      var done = function () { toast('✅ 已复制'); };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, function () { toast('复制失败，请手动选中'); });
      } else { toast('请手动选中复制'); }
    };
    row.appendChild(btn);
    return row;
  }

  // ── ③ 完成：建群引导 + 跳到该 bot 的 Tab ─────────────────────────────────────
  function renderWizDone() {
    var w = $('wizBody');
    w.textContent = '';
    w.appendChild(el('h3', null, '🎉 接入完成'));
    w.appendChild(wizStepBar(3));
    var who = (wizSetup && wizSetup.botName) || wizBotId || '';
    // 到这一步只剩一件事：重启 Feishu Bridge 让新 bot 上线。不再堆「新建项目/拉群/@」那套
    // 引导（那会让人以为得先做完才能继续）。重启入口**只此一处**：主按钮「重启使其上线」；
    // 想晚点再说就点「稍后再重启」。
    w.appendChild(el('div', 'note', '机器人「' + who + '」已加入活跃集。最后一步：重启 Feishu Bridge 让它上线（约数秒，其它在线机器人会短暂断连后自动重连）。'));
    var openRow = el('div'); openRow.style.margin = '4px 0 12px';
    openRow.appendChild(openBotBtn(wizBotId, wizSetup && wizSetup.tenant, '🔗 在飞书中打开机器人'));
    w.appendChild(openRow);
    var gotoBot = function () { var id = wizBotId; closeWizard(); if (id) go({ tab: 'bot', botId: id }); };
    var actions = el('div', 'actions');
    var later = el('button', 'btn', '稍后再重启');
    later.onclick = gotoBot;
    actions.appendChild(later);
    actions.appendChild(el('div', 'grow'));
    var restart = el('button', 'btn primary', '🔁 重启使其上线');
    restart.onclick = function () { postAction('/api/daemon/restart', '重启'); gotoBot(); };
    actions.appendChild(restart);
    w.appendChild(actions);
  }

  // ── 日志 SSE（页面级常驻 ring 缓冲；切 Tab 不断连，重新 mount 把缓冲挂回 DOM）──
  var MAX_LOG_LINES = 500;
  var logState = { status: '连接中…', lines: [], box: null };
  function startLogStream() {
    var es = new EventSource('/api/logs/stream');
    es.onopen = function () { logState.status = '🟢 已连接'; setLogStatus(); };
    es.onerror = function () { logState.status = '🔁 重连中…'; setLogStatus(); };
    es.onmessage = function (ev) {
      if (!ev.data) return;
      var cls = null;
      if (ev.data.indexOf('stream.timing') >= 0 || ev.data.indexOf('"phase":"agent"') >= 0 || ev.data.indexOf('agent.') >= 0) cls = 'hl';
      if (ev.data.indexOf('"level":"warn"') >= 0) cls = 'warn';
      if (ev.data.indexOf('"level":"error"') >= 0) cls = 'err';
      logState.lines.push({ text: ev.data, cls: cls });
      while (logState.lines.length > MAX_LOG_LINES) logState.lines.shift();
      appendLogLine(logState.lines[logState.lines.length - 1]);
    };
  }
  function setLogStatus() { var s = $('logStatus'); if (s) s.textContent = logState.status; }
  function mountLogBox(box) {
    logState.box = box;
    box.textContent = '';
    logState.lines.forEach(function (ln) { box.appendChild(el('div', ln.cls, ln.text)); });
    box.scrollTop = box.scrollHeight;
    setLogStatus();
  }
  function appendLogLine(ln) {
    var box = logState.box;
    if (!box || !box.isConnected) return; // 不在当前 Tab：只进 ring，不碰 DOM
    var stick = box.scrollTop + box.clientHeight >= box.scrollHeight - 24;
    box.appendChild(el('div', ln.cls, ln.text));
    while (box.childNodes.length > MAX_LOG_LINES) box.removeChild(box.firstChild);
    if (stick) box.scrollTop = box.scrollHeight;
  }

  // ── 启动 ─────────────────────────────────────────────────────────────────
  $('drawerMask').onclick = closeDrawer;
  $('confirmMask').onclick = function (e) { if (e.target === $('confirmMask')) $('confirmMask').classList.remove('open'); };
  var hb = $('hamburger'); if (hb) hb.onclick = openSidebar;
  var scrim = $('sideScrim'); if (scrim) scrim.onclick = closeSidebar;
  // 点击空白处关闭后端 Agent 行内 ⋯ 菜单（菜单按钮所在的 .bka-rowact 已 stopPropagation）。
  document.addEventListener('click', function (e) { if (!e.target.closest || !e.target.closest('.bka-rowact')) closeAllMenus(); });
  startLogStream();
  loadCatalog();
  loadState();
  loadDaemon();
  checkLiveConsole();
  renderRoute();
  // 一次性首屏入场：侧栏淡入 + 顶栏从上滑入（仅首次，5s 刷新不重放）。
  if (fx.on) {
    try {
      window.gsap.from('.sidebar', { autoAlpha: 0, x: -16, duration: 0.5, clearProps: 'transform,opacity,visibility' });
      window.gsap.from('.topbar', { autoAlpha: 0, y: -12, duration: 0.45, delay: 0.05, clearProps: 'transform,opacity,visibility' });
    } catch (e) {}
  }
  setInterval(loadState, 5000);  // /api/state 5s 刷新
  setInterval(loadDaemon, 5000); // daemon 状态/时长同频
  setInterval(checkLiveConsole, 4000); // 只读预览：daemon 一起来就自动切到可写控制台
})();
</script>
</body>
</html>
`;
