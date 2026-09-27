import { activeBots, currentBot, findBot, type BotEntry, type BotsRegistry } from '../config/bots';
import { loadConfig } from '../config/store';
import { getCliBridgePreferences, isComplete, type AppConfig } from '../config/schema';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { botDir, paths } from '../config/paths';

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

type HookConfigLoader = (appId: string) => Promise<Partial<AppConfig>>;

export async function selectCliBridgeHookBot(
  reg: BotsRegistry,
  opts: { requested?: string; loadConfigForBot?: HookConfigLoader; route?: CliBridgeRoute } = {},
): Promise<BotEntry | undefined> {
  const route = opts.route ?? readCliBridgeRoute();
  if (route.kind === 'none') return undefined;
  if (route.kind === 'agent') {
    const target = findBot(reg, route.botId);
    if (!target || target.active === false) return undefined;
    const cfg = await (opts.loadConfigForBot ?? ((appId: string) => loadConfig(join(botDir(appId), 'config.json'))))(target.appId).catch(() => undefined);
    return cfg && isComplete(cfg) && getCliBridgePreferences(cfg).enabled ? target : undefined;
  }
  const requested = opts.requested?.trim();
  if (requested) {
    return findBot(reg, requested) ?? { name: requested, appId: requested, tenant: 'feishu', createdAt: 0 };
  }

  const loadConfigForBot = opts.loadConfigForBot ?? ((appId) => loadConfig(join(botDir(appId), 'config.json')));
  const current = currentBot(reg);
  const active = activeBots(reg);
  const candidates = active.length > 0 ? active : current ? [current] : reg.bots;
  let firstEnabled: BotEntry | undefined;

  for (const bot of candidates) {
    const cfg = await loadConfigForBot(bot.appId).catch(() => undefined);
    if (!cfg || !isComplete(cfg) || !getCliBridgePreferences(cfg).enabled) continue;
    if (bot.appId === current?.appId) return bot;
    firstEnabled ??= bot;
  }

  return firstEnabled ?? current ?? candidates[0];
}
