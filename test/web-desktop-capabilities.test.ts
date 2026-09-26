import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWebServer, type WebServer } from '../src/web/server';
import { createReadonlyAdminService, type AdminService, type AdminProject } from '../src/admin/service';
import { CodexSetupService } from '../src/agent/codex-appserver/setup';
import { AdminWriteError } from '../src/admin/ops';
import { GroupUpstreamError } from '../src/admin/groups';

const servers: WebServer[] = [];
const tools: CodexSetupService[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => server.close())); await Promise.all(tools.splice(0).map(value => value.close())); vi.unstubAllEnvs(); });
function service(): AdminService {
  return { ...createReadonlyAdminService(), async listBots() { return [{ name: 'Bot', appId: 'cli_a', tenant: 'feishu', active: true, current: true, running: true, completionReminder: { mode: 'failures', longTaskMinutes: 3 } }]; }, async listProjects() { return []; } };
}
async function http(admin: AdminService) {
  const server = createWebServer({ service: admin, token: 'fixture-token' }); servers.push(server);
  const { port } = await server.listen(0);
  return { server, request: (path: string, method = 'GET', body?: unknown, token = 'fixture-token') => fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }) };
}
const bind = { chatId: 'oc_chat', projectName: 'Project', directory: '/tmp', backend: 'codex-appserver', kind: 'multi' };

describe('authenticated desktop companion HTTP', () => {
  it('returns cursor pages, rejects malformed/inactive/upstream operations and preserves appId ownership', async () => {
    const admin = service();
    admin.joinedGroups = vi.fn(async () => ({ groups: [{ chatId: 'oc_chat', name: 'local name', bound: false }], nextCursor: 'next' }));
    admin.bindGroup = vi.fn(async (): Promise<AdminProject> => ({ name: 'Project', chatId: 'oc_chat', cwd: '/tmp', blank: false, kind: 'multi', origin: 'joined', noMention: false, autoCompact: true, mode: 'qa', guestMode: 'qa', network: false, backend: 'codex-appserver', allowedUsersCount: 0, sessionCount: 0, createdAt: 1 }));
    const { request } = await http(admin);
    expect((await request('/api/bots/cli_a/joined-groups', 'GET', undefined, 'wrong')).status).toBe(401);
    const list = await request('/api/bots/cli_a/joined-groups?cursor=opaque');
    expect(list.status).toBe(200); expect(await list.json()).toMatchObject({ nextCursor: 'next' });
    expect(admin.joinedGroups).toHaveBeenCalledWith('cli_a', 'opaque');
    const result = await request('/api/bots/cli_a/bind-group', 'POST', bind);
    expect(result.status).toBe(200); expect(await result.json()).toMatchObject({ project: { chatId: 'oc_chat' } });
    expect(admin.bindGroup).toHaveBeenCalledWith('cli_a', bind);
    expect((await request('/api/bots/cli_a/bind-group', 'POST', { ...bind, directory: 'relative' })).status).toBe(400);
    expect((await request('/api/bots/cli_inactive/joined-groups')).status).toBe(409);
    expect((await request('/api/bots/%xx/joined-groups')).status).toBe(400);
    expect((await request('/api/bots/cli_a/joined-groups?cursor=')).status).toBe(400);
    admin.joinedGroups = async () => { throw new GroupUpstreamError('scope denied'); };
    expect((await request('/api/bots/cli_a/joined-groups')).status).toBe(502);
    admin.bindGroup = async () => { throw new AdminWriteError('different binding'); };
    expect((await request('/api/bots/cli_a/bind-group', 'POST', bind)).status).toBe(409);
  });

  it('routes authenticated collaboration to only the selected running owner and validates the request', async () => {
    const admin = service(); admin.collaboration = vi.fn(async () => ({ ok: true }));
    const { request } = await http(admin);
    const body = { action: 'compact', projectName: 'Project', chatId: 'oc_chat', threadId: 'omt_topic' };
    expect((await request('/api/bots/cli_a/collaboration', 'POST', body, 'wrong')).status).toBe(401);
    expect((await request('/api/bots/cli_unknown/collaboration', 'POST', body)).status).toBe(409);
    expect((await request('/api/bots/cli_a/collaboration', 'POST', { ...body, actor: 'ou_forged' })).status).toBe(400);
    expect(admin.collaboration).not.toHaveBeenCalled();
    expect((await request('/api/bots/cli_a/collaboration', 'POST', body)).status).toBe(200);
    expect(admin.collaboration).toHaveBeenCalledWith('cli_a', body);
    expect((await request('/api/bots/cli_a/collaboration')).status).toBe(405);
    admin.collaboration = async () => { throw new AdminWriteError('session is busy'); };
    expect((await request('/api/bots/cli_a/collaboration', 'POST', body)).status).toBe(409);
  });

  it('reports project read errors instead of an empty successful snapshot', async () => {
    const admin = service(); admin.listProjects = async () => { throw new Error('corrupt projects'); };
    const { request } = await http(admin);
    expect(await (await request('/api/state')).json()).toMatchObject({ bots: [{ projects: [], projectsError: 'corrupt projects' }] });
  });

  it('reports unsupported read-only/older capability explicitly', async () => {
    const admin = service(); delete admin.joinedGroups; delete admin.codexSetup;
    const { request } = await http(admin);
    expect((await request('/api/bots/cli_a/joined-groups')).status).toBe(501);
    expect((await request('/api/tools/codex/setup')).status).toBe(501);
    expect((await request('/api/tools/codex/install', 'POST')).status).toBe(501);
  });

  it('owns jobs beyond requests, serializes admission, cancels exact ids and awaits shutdown cleanup', async () => {
    vi.stubEnv('CODEX_BIN', '');
    let finishCleanup = (): void => {};
    const setup = new CodexSetupService({ install: signal => new Promise<void>(resolve => {
      signal.addEventListener('abort', () => { finishCleanup = resolve; }, { once: true });
    }) }); tools.push(setup);
    const admin = service();
    admin.startCodexJob = type => setup.start(type); admin.codexJob = id => setup.get(id); admin.cancelCodexJob = id => setup.cancel(id); admin.close = () => setup.close();
    const { request, server } = await http(admin);
    const post = await request('/api/tools/codex/install', 'POST'); expect(post.status).toBe(202);
    const { id } = await post.json() as { id: string };
    expect((await request('/api/tools/codex/login', 'POST')).status).toBe(409);
    expect((await request('/api/tools/codex/install', 'POST', { command: 'injected' })).status).toBe(400);
    expect(await (await request(`/api/tools/codex/jobs/${id}`)).json()).toMatchObject({ id, state: 'running' });
    expect((await request('/api/tools/codex/jobs/00000000-0000-0000-0000-000000000000', 'DELETE')).status).toBe(404);
    let closed = false;
    const closing = server.close().then(() => { closed = true; });
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(closed).toBe(false);
    finishCleanup(); await closing;
    expect(setup.get(id)?.state).toBe('cancelled');
    servers.splice(servers.indexOf(server), 1);
  });

  it('retains cancelled snapshots and makes repeated DELETE idempotent', async () => {
    vi.stubEnv('CODEX_BIN', '');
    const setup = new CodexSetupService({ install: signal => new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })) }); tools.push(setup);
    const admin = service(); admin.startCodexJob = type => setup.start(type); admin.codexJob = id => setup.get(id); admin.cancelCodexJob = id => setup.cancel(id); admin.close = () => setup.close();
    const { request } = await http(admin);
    const { id } = await (await request('/api/tools/codex/install', 'POST')).json() as { id: string };
    const first = await (await request(`/api/tools/codex/jobs/${id}`, 'DELETE')).json();
    expect(first).toMatchObject({ state: 'cancelled' });
    expect(await (await request(`/api/tools/codex/jobs/${id}`, 'DELETE')).json()).toEqual(first);
  });
});

it('exposes pending events without requiring a group executor and preserves errors', async () => {
  const admin = service();
  const groups = [{ chatId: 'oc_pending', name: 'Research', addedAt: 123 }];
  admin.pendingGroups = vi.fn(async () => ({ groups }));
  const { request } = await http(admin);
  expect((await request('/api/bots/cli_a/pending-groups', 'GET', undefined, 'wrong')).status).toBe(401);
  const result = await request('/api/bots/cli_a/pending-groups');
  expect(result.status).toBe(200); expect(await result.json()).toEqual({ groups });
  expect(admin.pendingGroups).toHaveBeenCalledWith('cli_a');
  expect((await request('/api/bots/cli_a/pending-groups', 'POST', {})).status).toBe(405);
  admin.pendingGroups = async () => { throw new Error('corrupt pending file'); };
  expect((await request('/api/bots/cli_a/pending-groups')).status).toBe(500);
});
