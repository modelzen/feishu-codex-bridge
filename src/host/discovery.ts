import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DataRootMigrationError, resolveDataRoot } from '../config/data-root';
import { DataAccessError, isDead } from '../config/data-access';

export type HostRefusal = {
  kind: 'blocked';
  reason: 'busy' | 'inspection-failed' | 'migration-pending' | 'startup-failed' | 'service-registered';
  message: string;
};
export type HostInspection = { kind: 'absent' } | { kind: 'attached'; pid: number } | HostRefusal;
export interface HostEndpoint { port: number; token: string; pid: number; startedAt: number }

export function refusal(error: unknown): HostRefusal {
  return { kind: 'blocked', reason: error instanceof DataRootMigrationError ? 'migration-pending' : error instanceof DataAccessError ? 'busy' : 'inspection-failed', message: error instanceof Error ? error.message : String(error) };
}

export async function readHostEndpoint(home: string): Promise<HostEndpoint | HostRefusal | undefined> {
  try {
    const root = resolveDataRoot(home);
    let record: unknown;
    try { record = JSON.parse(readFileSync(join(root.path, 'web-console.json'), 'utf8')); }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
      throw new Error('Cannot read Host discovery. Repair its record before starting another Host.', { cause: error });
    }
    if (typeof record !== 'object' || record === null
      || !('port' in record) || typeof record.port !== 'number' || !Number.isInteger(record.port) || record.port < 1 || record.port > 65535
      || !('token' in record) || typeof record.token !== 'string' || record.token.length === 0
      || !('pid' in record) || typeof record.pid !== 'number' || !Number.isSafeInteger(record.pid) || record.pid < 1
      || !('startedAt' in record) || typeof record.startedAt !== 'number' || !Number.isFinite(record.startedAt)) {
      throw new Error('Invalid Host discovery. Refusing duplicate startup.');
    }
    if (isDead(record.pid)) return;
    const endpoint = { port: record.port, token: record.token, pid: record.pid, startedAt: record.startedAt };
    const response = await endpointRequest(endpoint, '/api/state', { signal: AbortSignal.timeout(2500) });
    if (!response.ok) throw new Error(`A live Host cannot be authenticated (${response.status}).`);
    const body: unknown = await response.json();
    if (typeof body !== 'object' || body === null || !('version' in body) || typeof body.version !== 'string'
      || !('generatedAt' in body) || typeof body.generatedAt !== 'number' || !('bots' in body) || !Array.isArray(body.bots)) {
      throw new Error('Live endpoint did not return a Bridge state response.');
    }
    return endpoint;
  } catch (error) { return refusal(error); }
}

export function endpointRequest(endpoint: HostEndpoint, path: string, init: RequestInit = {}): Promise<Response> {
  const origin = `http://127.0.0.1:${endpoint.port}`;
  const url = new URL(path, origin);
  if (!path.startsWith('/api/') || path.includes('\\') || url.origin !== origin || !url.pathname.startsWith('/api/') || url.username || url.password) {
    throw new Error('Host requests must stay under the local /api/ endpoint.');
  }
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${endpoint.token}`);
  headers.delete('Origin');
  headers.delete('Host');
  return fetch(url, { ...init, headers, redirect: 'error' });
}
