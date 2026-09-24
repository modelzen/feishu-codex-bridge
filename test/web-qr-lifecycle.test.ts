import { describe, expect, it } from 'vitest';
import { createReadonlyAdminService } from '../src/admin/service';
import { createWebServer } from '../src/web/server';

function gate() {
  let release = (): void => {};
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

async function fixture() {
  const aborted = gate();
  const persist = gate();
  let saved = false;
  const service = createReadonlyAdminService();
  service.registerBotByQr = async options => {
    options.signal.addEventListener('abort', aborted.release, { once: true });
    await persist.promise;
    saved = true;
    return { ok: true, appId: 'cli_saved', name: 'Saved', tenant: 'feishu', adminOpenId: 'ou_fixture', missingScopes: [] };
  };
  const server = createWebServer({ service, token: 'qr-lifecycle-fixture' });
  const { port } = await server.listen(0);
  const request = (path: string, method = 'GET') => fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { authorization: 'Bearer qr-lifecycle-fixture' } });
  return { server, request, aborted, persist, saved: () => saved };
}

describe('QR registration persistence lifetime', () => {
  it('exposes the session before QR and waits for persistence before cancellation acknowledgement', async () => {
    const f = await fixture();
    try {
      const stream = await f.request('/api/bots/register-qr/stream');
      const id = stream.headers.get('x-registration-session-id');
      expect(id).toMatch(/^[a-f0-9-]{36}$/);
      let acknowledged = false;
      const cancellation = f.request(`/api/bots/register-qr?sessionId=${id}`, 'DELETE').then(response => { acknowledged = true; return response; });
      await f.aborted.promise;
      await new Promise(resolve => setTimeout(resolve, 30));
      expect(acknowledged).toBe(false);
      expect(f.saved()).toBe(false);
      f.persist.release();
      expect((await cancellation).status).toBe(204);
      expect(f.saved()).toBe(true);
      expect((await f.request(`/api/bots/register-qr?sessionId=${id}`, 'DELETE')).status).toBe(204);
      await stream.body?.cancel();
    } finally { f.persist.release(); await f.server.close(); }
  });

  it('retains the session after disconnect and rejects unknown cancellation identities', async () => {
    const f = await fixture();
    try {
      const stream = await f.request('/api/bots/register-qr/stream');
      const id = stream.headers.get('x-registration-session-id');
      await stream.body?.cancel();
      await f.aborted.promise;
      expect((await f.request('/api/bots/register-qr?sessionId=00000000-0000-0000-0000-000000000000', 'DELETE')).status).toBe(404);
      expect((await f.request('/api/bots/register-qr?sessionId=bad', 'DELETE')).status).toBe(400);
      const cancellation = f.request(`/api/bots/register-qr?sessionId=${id}`, 'DELETE');
      f.persist.release();
      expect((await cancellation).status).toBe(204);
      expect(f.saved()).toBe(true);
    } finally { f.persist.release(); await f.server.close(); }
  });

  it('cancelling a retained old session never aborts the newer session', async () => {
    const signals: AbortSignal[] = [];
    const service = createReadonlyAdminService();
    service.registerBotByQr = options => new Promise(resolve => {
      signals.push(options.signal);
      options.signal.addEventListener('abort', () => resolve({ ok: false, code: 'abort', reason: 'cancelled' }), { once: true });
    });
    const server = createWebServer({ service, token: 'qr-identity-fixture' });
    const { port } = await server.listen(0);
    const request = (path: string, method = 'GET') => fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { authorization: 'Bearer qr-identity-fixture' } });
    try {
      const first = await request('/api/bots/register-qr/stream');
      const second = await request('/api/bots/register-qr/stream');
      const id = first.headers.get('x-registration-session-id');
      expect(signals).toHaveLength(2);
      expect(signals[0]?.aborted).toBe(true);
      expect((await request(`/api/bots/register-qr?sessionId=${id}`, 'DELETE')).status).toBe(204);
      expect(signals[1]?.aborted).toBe(false);
      await first.body?.cancel();
      await second.body?.cancel();
    } finally { await server.close(); }
  });

  it('keeps Host close pending until disconnected registration persistence settles', async () => {
    const f = await fixture();
    try {
      const stream = await f.request('/api/bots/register-qr/stream');
      await stream.body?.cancel();
      await f.aborted.promise;
      let closed = false;
      const closing = f.server.close().then(() => { closed = true; });
      await new Promise(resolve => setTimeout(resolve, 30));
      expect(closed).toBe(false);
      f.persist.release();
      await closing;
      expect(f.saved()).toBe(true);
    } finally { f.persist.release(); await f.server.close(); }
  });
});
