import { describe, expect, it } from 'vitest';
import { buildDoctorCard, type DoctorInfo } from '../src/card/dm-cards';

function info(over: Partial<DoctorInfo> = {}): DoctorInfo {
  return {
    codexOk: true,
    codexVer: 'codex-cli 0.45.0',
    conn: 'connected',
    bridgeVer: '0.1.2',
    node: 'v20.11.0',
    platform: 'darwin-arm64',
    logStdout: '/Users/me/.feishu-codex-bridge/service.log',
    logStderr: '/Users/me/.feishu-codex-bridge/service.err.log',
    configFile: '/Users/me/.feishu-codex-bridge/bots/cli_x/config.json',
    missingScopes: [], // healthy baseline: all required scopes granted
    scopeGrantUrl: 'https://open.feishu.cn/app/cli_x/auth?q=',
    missingJoinScopes: [], // healthy baseline: 加入存量群 scopes granted too
    joinScopeGrantUrl: 'https://open.feishu.cn/app/cli_x/auth?q=join',
    ...over,
  };
}

/** The copy-paste prompt the card renders into a fenced code block. */
function codeBlock(card: object): string {
  const json = JSON.stringify(card);
  const m = json.match(/```\\n([\s\S]*?)\\n```/);
  if (!m) throw new Error('no fenced code block in doctor card');
  // unescape the JSON string back into the literal prompt text
  return JSON.parse(`"${m[1]}"`) as string;
}

/** Every open_url default_url anywhere in the card tree. */
function collectUrls(card: object): string[] {
  const urls: string[] = [];
  const walk = (n: unknown): void => {
    if (Array.isArray(n)) n.forEach(walk);
    else if (n && typeof n === 'object') {
      const o = n as Record<string, unknown>;
      if (o.type === 'open_url' && typeof o.default_url === 'string') urls.push(o.default_url);
      Object.values(o).forEach(walk);
    }
  };
  walk(card);
  return urls;
}

describe('buildDoctorCard', () => {
  it('renders an initial diagnosis with codex + connection state', () => {
    const json = JSON.stringify(buildDoctorCard(info()));
    expect(json).toContain('初步诊断');
    expect(json).toContain('✅ 可用');
    expect(json).toContain('codex-cli 0.45.0');
    expect(json).toContain('✅ 已连接'); // connected → friendly label
    expect(json).toContain('bridge v0.1.2');
    expect(json).toContain('darwin-arm64');
  });

  it('shows the bot open_id as copy-friendly code when known', () => {
    const json = JSON.stringify(buildDoctorCard(info({ botOpenId: 'ou_abc123' })));
    expect(json).toContain('机器人 open_id');
    expect(json).toContain('`ou_abc123`'); // backticked so 飞书 renders it click-to-copy
  });

  it('says 未能获取 (stays blue) when the bot open_id could not be resolved', () => {
    const card = buildDoctorCard(info({ botOpenId: undefined }));
    const json = JSON.stringify(card);
    expect(json).toContain('机器人 open_id');
    expect(json).toContain('未能获取');
    // open_id 拿不到不是硬故障 → header 保持蓝
    expect((card as { header: { template: string } }).header.template).toBe('blue');
  });

  it('shows both daemon log paths and the foreground hint', () => {
    const json = JSON.stringify(buildDoctorCard(info()));
    expect(json).toContain('/Users/me/.feishu-codex-bridge/service.log');
    expect(json).toContain('/Users/me/.feishu-codex-bridge/service.err.log');
    expect(json).toContain('终端窗口'); // foreground run logs live in the terminal
  });

  it('embeds a copy-paste prompt carrying repo link, version, log paths and config', () => {
    const prompt = codeBlock(buildDoctorCard(info()));
    expect(prompt).toContain('https://github.com/modelzen/feishu-codex-bridge');
    expect(prompt).toContain('https://github.com/modelzen/feishu-codex-bridge/issues');
    expect(prompt).toContain('v0.1.2');
    expect(prompt).toContain('codex-cli 0.45.0');
    expect(prompt).toContain('v20.11.0');
    expect(prompt).toContain('darwin-arm64');
    expect(prompt).toContain('/Users/me/.feishu-codex-bridge/service.log');
    expect(prompt).toContain('/Users/me/.feishu-codex-bridge/service.err.log');
    expect(prompt).toContain('/Users/me/.feishu-codex-bridge/bots/cli_x/config.json');
    // no nested fence that would break the outer code block
    expect(prompt).not.toContain('```');
  });

  it('reflects an unavailable codex: warning header + ❌ + "未找到" in the prompt', () => {
    const card = buildDoctorCard(info({ codexOk: false, codexVer: null, conn: 'disconnected' }));
    const json = JSON.stringify(card);
    expect((card as { header: { template: string } }).header.template).toBe('orange');
    expect(json).toContain('❌ 不可用');
    expect(json).toContain('❌ 已断开');
    expect(codeBlock(card)).toContain('未找到');
  });

  it('uses a blue header when codex is available', () => {
    const card = buildDoctorCard(info());
    expect((card as { header: { template: string } }).header.template).toBe('blue');
  });

  it('shows an unknown connection state verbatim', () => {
    const json = JSON.stringify(buildDoctorCard(info({ conn: 'unknown' })));
    expect(json).toContain('飞书长连接：unknown');
  });

  it('links to the repo and issues via buttons', () => {
    const urls: string[] = [];
    const walk = (n: unknown): void => {
      if (Array.isArray(n)) n.forEach(walk);
      else if (n && typeof n === 'object') {
        const o = n as Record<string, unknown>;
        if (o.type === 'open_url' && typeof o.default_url === 'string') urls.push(o.default_url);
        Object.values(o).forEach(walk);
      }
    };
    walk(buildDoctorCard(info()));
    expect(urls).toContain('https://github.com/modelzen/feishu-codex-bridge');
    expect(urls).toContain('https://github.com/modelzen/feishu-codex-bridge/issues');
  });
});

describe('buildDoctorCard — 飞书权限自检', () => {
  const GRANT = 'https://open.feishu.cn/app/cli_x/auth?q=im%3Amessage.group_msg%2Ccardkit%3Acard%3Awrite';

  it('lists missing scopes with an orange header and a one-click grant button', () => {
    const card = buildDoctorCard(
      info({ missingScopes: ['im:message.group_msg', 'cardkit:card:write'], scopeGrantUrl: GRANT }),
    );
    const json = JSON.stringify(card);
    expect((card as { header: { template: string } }).header.template).toBe('orange');
    expect(json).toContain('缺 2 项');
    expect(json).toContain('im:message.group_msg');
    expect(json).toContain('cardkit:card:write');
    expect(collectUrls(card)).toContain(GRANT); // grant button → developer-console auth page
  });

  it('labels the image-upload scope so a missing im:resource reads as 图片, not a raw token', () => {
    const json = JSON.stringify(buildDoctorCard(info({ missingScopes: ['im:resource'], scopeGrantUrl: GRANT })));
    expect(json).toContain('图片'); // friendly label surfaces the capability
    expect(json).toContain('im:resource'); // raw token still shown for the console
  });

  it('confirms all granted (no grant button, stays blue) when missingScopes is empty', () => {
    const card = buildDoctorCard(info({ missingScopes: [], scopeGrantUrl: GRANT }));
    expect((card as { header: { template: string } }).header.template).toBe('blue');
    expect(JSON.stringify(card)).toContain('必需权限已全部开通');
    expect(collectUrls(card)).not.toContain(GRANT); // nothing to grant → no button
  });

  it('says 无法自动检查 with a verify button, header stays blue, when the check could not run', () => {
    const card = buildDoctorCard(info({ missingScopes: undefined, scopeGrantUrl: GRANT }));
    expect(JSON.stringify(card)).toContain('无法自动检查');
    // undefined = "couldn't check", NOT a hard failure → header stays blue (codex still ok)
    expect((card as { header: { template: string } }).header.template).toBe('blue');
    expect(collectUrls(card)).toContain(GRANT);
  });

  it('carries the scope status into the copy-paste codex prompt (all three states)', () => {
    expect(codeBlock(buildDoctorCard(info({ missingScopes: ['im:resource'] })))).toContain('缺失 1 项');
    expect(codeBlock(buildDoctorCard(info({ missingScopes: [] })))).toContain('必需权限齐全');
    expect(codeBlock(buildDoctorCard(info({ missingScopes: undefined })))).toContain('未能自动检查');
  });
});

describe('buildDoctorCard — 加入存量群（opt-in scope 提示）', () => {
  const JOIN_GRANT = 'https://open.feishu.cn/app/cli_x/auth?q=im%3Achat%3Areadonly%2Cim%3Achat.members%3Awrite_only';

  it('always reminds about the two un-checkable bot member events', () => {
    // events have no query API → surfaced as a note regardless of scope state
    const json = JSON.stringify(buildDoctorCard(info()));
    expect(json).toContain('im.chat.member.bot.added_v1');
    expect(json).toContain('im.chat.member.bot.deleted_v1');
  });

  it('surfaces the missing join scopes with a one-click grant button', () => {
    const card = buildDoctorCard(
      info({ missingJoinScopes: ['im:chat:readonly', 'im:chat.members:write_only'], joinScopeGrantUrl: JOIN_GRANT }),
    );
    const json = JSON.stringify(card);
    expect(json).toContain('加入存量群');
    expect(json).toContain('缺 2 项');
    expect(json).toContain('im:chat:readonly');
    expect(collectUrls(card)).toContain(JOIN_GRANT);
    // opt-in: a missing join scope must NOT escalate the header to orange
    expect((card as { header: { template: string } }).header.template).toBe('blue');
  });

  it('shows 已开通 (no button) when join scopes are all granted', () => {
    const card = buildDoctorCard(info({ missingJoinScopes: [], joinScopeGrantUrl: JOIN_GRANT }));
    expect(JSON.stringify(card)).toContain('已开通');
    expect(collectUrls(card)).not.toContain(JOIN_GRANT);
  });

  it('says 未能自动检查 with a button when the scope check could not run', () => {
    const card = buildDoctorCard(info({ missingJoinScopes: undefined, joinScopeGrantUrl: JOIN_GRANT }));
    expect(JSON.stringify(card)).toContain('未能自动检查');
    expect(collectUrls(card)).toContain(JOIN_GRANT);
  });
});

describe('buildDoctorCard — 事件订阅诊断（版本信息 API）', () => {
  const EVT_URL = 'https://open.feishu.cn/app/cli_x/event';

  it('eventDiagnosis 未接线（undefined）→ 整块不渲染，保持旧卡片形状', () => {
    const json = JSON.stringify(buildDoctorCard(info()));
    expect(json).not.toContain('事件订阅');
    // join 块退回人工提醒（未能自动检测）
    expect(json).toContain('未能自动检测');
  });

  it('ok → ✅ + 版本号，header 保持蓝，可选缺失单列', () => {
    const card = buildDoctorCard(
      info({
        eventDiagnosis: {
          state: 'ok',
          version: '1.0.2',
          events: ['im.message.receive_v1'],
          missingRequired: [],
          missingOptional: ['application.bot.menu_v6'],
        },
        eventConfigUrl: EVT_URL,
      }),
    );
    const json = JSON.stringify(card);
    expect(json).toContain('事件订阅：✅');
    expect(json).toContain('v1.0.2');
    expect(json).toContain('可选事件未订阅');
    expect(json).toContain('application.bot.menu_v6');
    expect((card as { header: { template: string } }).header.template).toBe('blue');
  });

  it('missing → orange + 缺的事件名 + 去事件配置页按钮', () => {
    const card = buildDoctorCard(
      info({
        eventDiagnosis: { state: 'missing', version: '1.0.0', events: [], missingRequired: ['im.message.receive_v1'] },
        eventConfigUrl: EVT_URL,
      }),
    );
    const json = JSON.stringify(card);
    expect((card as { header: { template: string } }).header.template).toBe('orange');
    expect(json).toContain('im.message.receive_v1');
    expect(json).toContain('@我 不会有反应');
    expect(collectUrls(card)).toContain(EVT_URL);
  });

  it('unpublished → orange + 从未发布 + 发布指引', () => {
    const card = buildDoctorCard(info({ eventDiagnosis: { state: 'unpublished' }, eventConfigUrl: EVT_URL }));
    const json = JSON.stringify(card);
    expect((card as { header: { template: string } }).header.template).toBe('orange');
    expect(json).toContain('从未发布');
    expect(json).toContain('创建版本并发布');
    expect(collectUrls(card)).toContain(EVT_URL);
  });

  it('unchecked → 保持蓝（降级非硬故障）+ 提示开通诊断 scope', () => {
    const card = buildDoctorCard(info({ eventDiagnosis: { state: 'unchecked', reason: 'code=99991672 msg=no permission' } }));
    const json = JSON.stringify(card);
    expect((card as { header: { template: string } }).header.template).toBe('blue');
    expect(json).toContain('无法自动检查');
    expect(json).toContain('application:application.app_version:readonly');
  });

  it('诊断状态织进复制给 codex 的提示词', () => {
    const prompt = codeBlock(
      buildDoctorCard(info({ eventDiagnosis: { state: 'unpublished' }, eventConfigUrl: EVT_URL })),
    );
    expect(prompt).toContain('事件订阅：');
    expect(prompt).toContain('未找到已发布版本');
  });

  it('join 块在 events 可知时按真实订阅状态渲染', () => {
    const subscribed = JSON.stringify(
      buildDoctorCard(
        info({
          eventDiagnosis: {
            state: 'ok',
            version: '1.0.0',
            events: ['im.message.receive_v1', 'im.chat.member.bot.added_v1', 'im.chat.member.bot.deleted_v1'],
            missingRequired: [],
            missingOptional: [],
          },
        }),
      ),
    );
    expect(subscribed).toContain('事件：✅ 已订阅');
    const missing = JSON.stringify(
      buildDoctorCard(
        info({
          eventDiagnosis: { state: 'ok', version: '1.0.0', events: ['im.message.receive_v1'], missingRequired: [] },
        }),
      ),
    );
    expect(missing).toContain('还需在后台「事件与回调」订阅');
    expect(missing).toContain('im.chat.member.bot.added_v1');
  });
});
