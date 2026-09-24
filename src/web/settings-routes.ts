import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseSettingsScope, parseSettingsEdit, parseSettingsAction, parseModelQuery, settingsObject, SettingsInputError } from '../admin/settings-parse';
import type { HostSettings, SettingsScope } from '../admin/settings-types';
function send(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(body));
}
async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 200000)
      throw new SettingsInputError('设置请求过大');
    chunks.push(chunk);
  }
  try {
    return settingsObject(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  }
  catch {
    throw new SettingsInputError('请求体必须是 JSON 对象');
  }
}
export async function handleSettingsRoute(req: IncomingMessage, res: ServerResponse, url: URL, settings?: HostSettings): Promise<boolean> {
  const agent = /^\/api\/bots\/([^/]+)\/settings(?:\/([^/]+))?$/.exec(url.pathname);
  const project = /^\/api\/project\/([^/]+)\/settings$/.exec(url.pathname);
  const session = /^\/api\/bots\/([^/]+)\/sessions\/([^/]+)\/settings$/.exec(url.pathname);
  const models = /^\/api\/bots\/([^/]+)\/models$/.exec(url.pathname);
  const host = url.pathname === '/api/settings/host';
  if (!agent && !project && !session && !models && !host)
    return false;
  if (!settings) {
    send(res, 404, {
      error: 'unsupported_settings',
      message: '当前 Bridge 版本不支持此设置'
    });
    return true;
  }
  try {
    if (models && req.method === 'GET') {
      send(res, 200, await settings.models(parseModelQuery({
        botId: decodeURIComponent(models[1]!),
        backend: url.searchParams.get('backend'),
        purpose: url.searchParams.get('purpose')
      })));
      return true;
    }
    if (agent?.[2] === 'actions' && req.method === 'POST') {
      const action = parseSettingsAction(await body(req));
      if (action.botId !== decodeURIComponent(agent[1]!))
        throw new SettingsInputError('Agent 标识不一致');
      const result = await settings.act(action);
      send(res, result.kind === 'conflict' ? 409 : result.kind === 'unavailable' ? 503 : result.kind === 'rejected' ? 400 : 200, result);
      return true;
    }
    const scope: SettingsScope = parseSettingsScope(host ? {
      kind: 'host'
    } : project ? {
      kind: 'project',
      botId: url.searchParams.get('bot'),
      projectName: decodeURIComponent(project[1]!)
    } : session ? {
      kind: 'session',
      botId: decodeURIComponent(session[1]!),
      threadId: decodeURIComponent(session[2]!)
    } : {
      kind: 'agent',
      botId: decodeURIComponent(agent?.[1] ?? '')
    });
    if (req.method === 'GET' && !agent?.[2]) {
      send(res, 200, await settings.read(scope));
      return true;
    }
    if (req.method === 'PATCH') {
      const input = await body(req);
      const edit = parseSettingsEdit({
        ...input,
        scope,
        ...(agent ? {
          section: agent[2]
        } : {})
      });
      const result = await settings.save(edit);
      send(res, result.kind === 'conflict' ? 409 : result.kind === 'unavailable' ? 503 : result.kind === 'rejected' ? 400 : 200, result);
      return true;
    }
    send(res, 405, {
      error: 'method_not_allowed'
    });
  }
  catch (error) {
    if (error instanceof SettingsInputError)
      send(res, req.method === 'GET' && /不存在/.test(error.message) ? 404 : 400, {
        kind: 'rejected',
        fields: [{
            field: 'settings',
            message: error.message
          }]
      });
    else
      send(res, 503, {
        kind: 'unavailable',
        reason: {
          kind: 'readonly',
          reason: 'owner-offline',
          message: '设置读取或保存失败，请刷新后重试'
        }
      });
  }
  return true;
}
