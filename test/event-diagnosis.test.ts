import { describe, expect, it } from 'vitest';
import {
  diagnoseEventSubscription,
  pollEventSubscription,
  summarizeEventDiagnosis,
  REQUIRED_EVENTS,
  OPTIONAL_EVENTS,
} from '../src/utils/event-diagnosis';
import { APP_VERSION_SCOPES, GRANT_SCOPES, REQUIRED_SCOPES } from '../src/config/scopes';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** fetch stub：token 端点 + app_versions 端点，各自可覆写返回体/状态码。 */
function fetchStub(over: {
  token?: unknown;
  tokenStatus?: number;
  versions?: unknown;
  versionsStatus?: number;
} = {}): typeof fetch {
  return (async (url: Parameters<typeof fetch>[0]) => {
    const u = String(url);
    if (u.includes('tenant_access_token')) {
      return jsonResponse(over.token ?? { code: 0, tenant_access_token: 't-x' }, over.tokenStatus ?? 200);
    }
    if (u.includes('app_versions')) {
      return jsonResponse(over.versions ?? { code: 0, data: { items: [] } }, over.versionsStatus ?? 200);
    }
    throw new Error(`unexpected fetch ${u}`);
  }) as typeof fetch;
}

const ALL_EVENTS = [...REQUIRED_EVENTS, ...OPTIONAL_EVENTS];

describe('diagnoseEventSubscription — 三态 + unchecked 降级', () => {
  it('ok：最新已上架版本含 im.message.receive_v1（可选事件单列、不影响状态）', async () => {
    const d = await diagnoseEventSubscription('cli_x', 's', 'feishu', fetchStub({
      versions: {
        code: 0,
        data: { items: [{ version: '1.0.2', status: 1, events: ['im.message.receive_v1'] }] },
      },
    }));
    expect(d.state).toBe('ok');
    expect(d.version).toBe('1.0.2');
    expect(d.missingRequired).toEqual([]);
    expect(d.missingOptional).toEqual([...OPTIONAL_EVENTS]); // 全缺也仍是 ok
  });

  it('ok：必需 + 可选全订阅时 missingOptional 为空', async () => {
    const d = await diagnoseEventSubscription('cli_x', 's', 'feishu', fetchStub({
      versions: { code: 0, data: { items: [{ version: '2.0.0', status: 1, events: ALL_EVENTS }] } },
    }));
    expect(d.state).toBe('ok');
    expect(d.missingOptional).toEqual([]);
    expect(d.events).toEqual(ALL_EVENTS);
  });

  it('reads stable event types when events contains localized display names', async () => {
    const d = await diagnoseEventSubscription('cli_x', 's', 'feishu', fetchStub({
      versions: { code: 0, data: { items: [{
        version: '1.0.7', status: 1,
        events: ['接收消息', '机器人自定义菜单事件'],
        event_infos: [
          { event_type: 'im.message.receive_v1', event_name: '接收消息' },
          { event_type: 'application.bot.menu_v6', event_name: '机器人自定义菜单事件' },
        ],
      }] } },
    }));
    expect(d.state).toBe('ok');
    expect(d.events).toEqual(['im.message.receive_v1', 'application.bot.menu_v6']);
    expect(d.missingRequired).toEqual([]);
    expect(d.missingOptional).not.toContain('application.bot.menu_v6');
  });

  it('uses event_infos as authoritative even when events claims a required ID', async () => {
    const d = await diagnoseEventSubscription('cli_x', 's', 'feishu', fetchStub({
      versions: { code: 0, data: { items: [{
        version: '1.0.7', status: 1, events: ['im.message.receive_v1'],
        event_infos: [{ event_type: 'application.bot.menu_v6' }],
      }] } },
    }));
    expect(d.state).toBe('missing');
    expect(d.events).toEqual(['application.bot.menu_v6']);
    expect(d.missingRequired).toEqual(['im.message.receive_v1']);
  });

  it.each([
    { events: ['接收消息'] },
    {},
    { event_infos: null },
    { event_infos: [{ event_type: 'im.message.receive_v1' }, {}] },
    { event_infos: [null] },
  ])('reports unknown metadata as unchecked rather than missing: %j', async (metadata) => {
    const d = await diagnoseEventSubscription('cli_x', 's', 'feishu', fetchStub({
      versions: { code: 0, data: { items: [{ version: '1.0', status: 1, ...metadata }] } },
    }));
    expect(d.state).toBe('unchecked');
    expect(d.reason).toBeTruthy();
    expect(d.missingRequired).toBeUndefined();
  });

  it('treats an explicitly empty structured list as authoritative', async () => {
    const d = await diagnoseEventSubscription('cli_x', 's', 'feishu', fetchStub({
      versions: { code: 0, data: { items: [{ status: 1, events: ALL_EVENTS, event_infos: [] }] } },
    }));
    expect(d.state).toBe('missing');
    expect(d.missingRequired).toEqual(['im.message.receive_v1']);
  });

  it('missing：已发布但缺 im.message.receive_v1', async () => {
    const d = await diagnoseEventSubscription('cli_x', 's', 'feishu', fetchStub({
      versions: {
        code: 0,
        data: { items: [{ version: '1.0.0', status: 1, events: ['application.bot.menu_v6'] }] },
      },
    }));
    expect(d.state).toBe('missing');
    expect(d.missingRequired).toEqual(['im.message.receive_v1']);
    expect(d.version).toBe('1.0.0');
  });

  it('unpublished：从未发布过版本（items 为空）', async () => {
    const d = await diagnoseEventSubscription('cli_x', 's', 'feishu', fetchStub());
    expect(d.state).toBe('unpublished');
  });

  it('unpublished：只有未过审版本（status≠1 不算生效）', async () => {
    const d = await diagnoseEventSubscription('cli_x', 's', 'feishu', fetchStub({
      versions: { code: 0, data: { items: [{ version: '1.0.0', status: 3, events: ALL_EVENTS }] } },
    }));
    expect(d.state).toBe('unpublished');
  });

  it('取列表里第一个 status=1 的版本（order=0 倒序 → 即当前在线版本）', async () => {
    const d = await diagnoseEventSubscription('cli_x', 's', 'feishu', fetchStub({
      versions: {
        code: 0,
        data: {
          items: [
            { version: '1.1.0', status: 4, events: [] }, // 新草稿未提审 → 跳过
            { version: '1.0.0', status: 1, events: ['im.message.receive_v1'] },
          ],
        },
      },
    }));
    expect(d.state).toBe('ok');
    expect(d.version).toBe('1.0.0');
  });

  it('unchecked：版本接口非 0 错误码（典型 = 缺 app_version:readonly scope），带原因', async () => {
    const d = await diagnoseEventSubscription('cli_x', 's', 'feishu', fetchStub({
      versions: { code: 99991672, msg: 'no permission' },
    }));
    expect(d.state).toBe('unchecked');
    expect(d.reason).toContain('99991672');
    expect(d.reason).toContain('no permission');
    expect(d.reason).toContain('application:application.app_version:readonly'); // scope 提示
  });

  it('unchecked：app_versions HTTP 400 且 body 不可解析 → 带「可能缺 app_version scope」提示', async () => {
    const fetchFn = (async (url: Parameters<typeof fetch>[0]) => {
      const u = String(url);
      if (u.includes('tenant_access_token')) return jsonResponse({ code: 0, tenant_access_token: 't-x' });
      return new Response('<html>400</html>', { status: 400 }); // 非 JSON body
    }) as typeof fetch;
    const d = await diagnoseEventSubscription('cli_x', 's', 'feishu', fetchFn);
    expect(d.state).toBe('unchecked');
    expect(d.reason).toContain('HTTP 400');
    expect(d.reason).toContain('app_version'); // 缺 scope 提示，而非裸状态码
  });

  it('unchecked：app_versions HTTP 400 但带飞书 {code,msg} → 读出可读原因', async () => {
    const fetchFn = (async (url: Parameters<typeof fetch>[0]) => {
      const u = String(url);
      if (u.includes('tenant_access_token')) return jsonResponse({ code: 0, tenant_access_token: 't-x' });
      return jsonResponse({ code: 99991672, msg: 'Access denied' }, 400);
    }) as typeof fetch;
    const d = await diagnoseEventSubscription('cli_x', 's', 'feishu', fetchFn);
    expect(d.state).toBe('unchecked');
    expect(d.reason).toContain('Access denied');
  });

  it('unchecked：token 换取失败 / token 端点 HTTP 错', async () => {
    const bad = await diagnoseEventSubscription('cli_x', 's', 'feishu', fetchStub({
      token: { code: 10003, msg: 'invalid secret' },
    }));
    expect(bad.state).toBe('unchecked');
    expect(bad.reason).toContain('10003');
    const http = await diagnoseEventSubscription('cli_x', 's', 'feishu', fetchStub({ tokenStatus: 503 }));
    expect(http.state).toBe('unchecked');
    expect(http.reason).toContain('503');
  });

  it('unchecked：网络异常绝不 throw', async () => {
    const boom = (async () => {
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch;
    const d = await diagnoseEventSubscription('cli_x', 's', 'feishu', boom);
    expect(d.state).toBe('unchecked');
    expect(d.reason).toContain('ECONNRESET');
  });
});

describe('summarizeEventDiagnosis — 一行中文摘要', () => {
  it('四态各有可读输出', () => {
    expect(summarizeEventDiagnosis({ state: 'ok', version: '1.0.2' })).toContain('已订阅');
    expect(summarizeEventDiagnosis({ state: 'ok', version: '1.0.2' })).toContain('v1.0.2');
    expect(
      summarizeEventDiagnosis({ state: 'missing', version: '1.0.0', missingRequired: ['im.message.receive_v1'] }),
    ).toContain('im.message.receive_v1');
    expect(summarizeEventDiagnosis({ state: 'unpublished' })).toContain('未找到已发布版本');
    expect(summarizeEventDiagnosis({ state: 'unchecked', reason: 'HTTP 503' })).toContain('HTTP 503');
  });
});

describe('pollEventSubscription — 配置生效闭环确认', () => {
  it('从 missing 轮询到 ok 后返回该诊断', async () => {
    let calls = 0;
    const flip = (async (url: Parameters<typeof fetch>[0]) => {
      const u = String(url);
      if (u.includes('tenant_access_token')) return jsonResponse({ code: 0, tenant_access_token: 't-x' });
      calls++;
      const events = calls >= 2 ? ['im.message.receive_v1'] : [];
      return jsonResponse({ code: 0, data: { items: [{ version: '1.0.0', status: 1, events }] } });
    }) as typeof fetch;
    const d = await pollEventSubscription('cli_x', 's', 'feishu', { intervalMs: 1, timeoutMs: 1000, fetchFn: flip });
    expect(d?.state).toBe('ok');
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it('一直未生效则超时返回 null（不 throw）', async () => {
    const d = await pollEventSubscription('cli_x', 's', 'feishu', { intervalMs: 5, timeoutMs: 20, fetchFn: fetchStub() });
    expect(d).toBeNull();
  });
});

describe('APP_VERSION_SCOPES — 预选不卡门', () => {
  it('诊断 scope 进 GRANT_SCOPES（一键开通顺带拿到）但不进 REQUIRED_SCOPES（不挡安装门）', () => {
    expect(GRANT_SCOPES).toContain(APP_VERSION_SCOPES[0]);
    expect(REQUIRED_SCOPES as readonly string[]).not.toContain(APP_VERSION_SCOPES[0]);
  });
});
