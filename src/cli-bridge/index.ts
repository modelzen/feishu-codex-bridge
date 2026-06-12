import { join } from 'node:path';
import { botDir, paths, useBotDir } from '../config/paths';
import { activeBots, currentBot, findBot, loadBots, type BotEntry, type BotsRegistry } from '../config/bots';
import { loadConfig } from '../config/store';
import { getCliBridgePreferences, isComplete, type AppConfig } from '../config/schema';
import { readStdin } from '../core/stdin';
import { sendCliHookMessage } from './ipc';
import { parseHookPayload } from './parser';
import { buildHookStdout } from './protocol';
import type { CliBridgeAgent, CliHookResponse } from './types';

export { createCliBridgeService, shouldStartCliBridge } from './service';

type HookConfigLoader = (appId: string) => Promise<Partial<AppConfig>>;

export async function selectCliBridgeHookBot(
  reg: BotsRegistry,
  opts: { requested?: string; loadConfigForBot?: HookConfigLoader } = {},
): Promise<BotEntry | undefined> {
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

export async function runHookCommand(agent: string, bot?: string): Promise<void> {
  if (agent !== 'claude' && agent !== 'codex') {
    process.stderr.write(`Unsupported hook agent: ${agent}\n`);
    process.exitCode = 2;
    return;
  }
  // Point paths at the selected bot so the hook hits the same per-bot socket the
  // running daemon listens on. Installed hooks include --bot when repaired from a
  // bot daemon; older hooks fall back to the current enabled active bot.
  try {
    const selected = await selectCliBridgeHookBot(await loadBots(), { requested: bot });
    if (selected) useBotDir(selected.appId);
  } catch {
    if (bot?.trim()) useBotDir(bot.trim());
    // ignore: fall through with the default path
  }
  const raw = await readStdin();
  const msg = parseHookPayload(agent as CliBridgeAgent, raw);
  if (msg.type === 'post_tool_use') {
    process.stdout.write('{}\n');
    return;
  }
  let response: CliHookResponse;
  try {
    response = await sendCliHookMessage(paths.cliBridgeSocket, msg);
  } catch {
    response = { decision: 'fallback_local', reason: 'daemon_unavailable' };
  }
  const stdout = buildHookStdout(msg, response);
  if (stdout) process.stdout.write(stdout + (stdout.endsWith('\n') ? '' : '\n'));
}
