import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from '../config/paths';

export type CliBridgeRoute =
  | { kind: 'legacy' }
  | { kind: 'none' }
  | { kind: 'agent'; botId: string };

export function readCliBridgeRoute(appDir = paths.appDir): CliBridgeRoute {
  const file = join(appDir, 'cli-bridge-route.json');
  if (!existsSync(file)) return { kind: 'legacy' };
  try {
    const value: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (typeof value !== 'object' || value === null || !('botId' in value)) throw new Error('Invalid route');
    const botId = value.botId;
    if (botId === null) return { kind: 'none' };
    if (typeof botId === 'string' && /^cli_[A-Za-z0-9_-]{1,200}$/.test(botId)) return { kind: 'agent', botId };
    throw new Error('Invalid route');
  } catch {
    return { kind: 'none' };
  }
}

export function cliBridgeRouteRevision(route: CliBridgeRoute): string {
  return createHash('sha256').update(JSON.stringify(route)).digest('hex');
}

export function saveCliBridgeRoute(botId: string | null, expectedRevision: string, appDir = paths.appDir): CliBridgeRoute | null {
  if (botId !== null && !/^cli_[A-Za-z0-9_-]{1,200}$/.test(botId)) throw new Error('Invalid notification Agent');
  if (cliBridgeRouteRevision(readCliBridgeRoute(appDir)) !== expectedRevision) return null;
  const value = botId === null ? { kind: 'none' as const } : { kind: 'agent' as const, botId };
  mkdirSync(appDir, { recursive: true });
  const file = join(appDir, 'cli-bridge-route.json');
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ botId })}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(temporary, file);
  return value;
}
