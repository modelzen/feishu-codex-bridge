import { paths, useBotDir } from '../config/paths';
import { loadBots } from '../config/bots';
import { readStdin } from '../core/stdin';
import { sendCliHookMessage } from './ipc';
import { parseHookPayload } from './parser';
import { buildHookStdout } from './protocol';
import type { CliBridgeAgent, CliHookResponse } from './types';
import { readCliBridgeRoute, selectCliBridgeHookBot } from './route';

export { createCliBridgeService, shouldStartCliBridge } from './service';

export { selectCliBridgeHookBot } from './route';

export async function runHookCommand(agent: string, bot?: string): Promise<void> {
  if (agent !== 'claude' && agent !== 'codex') {
    process.stderr.write(`Unsupported hook agent: ${agent}\n`);
    process.exitCode = 2;
    return;
  }
  // Point paths at the selected bot so the hook hits the same per-bot socket the
  // running daemon listens on. Installed hooks include --bot when repaired from a
  // bot daemon; older hooks fall back to the current enabled active bot.
  let unavailableRoute = false;
  try {
    const selected = await selectCliBridgeHookBot(await loadBots(), { requested: bot });
    if (selected) useBotDir(selected.appId);
    else unavailableRoute = readCliBridgeRoute().kind !== 'legacy';
  } catch {
    if (readCliBridgeRoute().kind === 'legacy' && bot?.trim()) useBotDir(bot.trim());
    else unavailableRoute = true;
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
    if (unavailableRoute) throw new Error('No enabled notification Agent');
    response = await sendCliHookMessage(paths.cliBridgeSocket, msg);
  } catch {
    response = { decision: 'fallback_local', reason: 'daemon_unavailable' };
  }
  const stdout = buildHookStdout(msg, response);
  if (stdout) process.stdout.write(stdout + (stdout.endsWith('\n') ? '' : '\n'));
}
