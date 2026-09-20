import { mkdtemp, mkdir, symlink, rm, copyFile, chmod } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { AppServerClient } from './app-server-client';
import { log } from '../../core/logger';
import { resolveCodexBin } from './locate';
import type { ReasoningEffort } from '../types';
import type { BriefingModel } from './briefing-runner';

export interface DiscussModelOptions {
  storageRoot?: string; resumeId?: string; fast?: boolean;
  model: string; effort: ReasoningEffort; instructions: string;
  sourceId?: string; sourcePath?: string; lastTurnId?: string; beforeTurnId?: string;
}
export interface DiscussModel extends BriefingModel { sessionId?: string }
export interface DiscussSource { path: string; lastTurnId?: string; beforeTurnId?: string }
/** Metadata client never consumes the main thread's notification stream. */
export async function readDiscussSource(id: string, signal: AbortSignal): Promise<DiscussSource> {
  const bin = resolveCodexBin();
  if (!bin) throw new Error('Codex unavailable');
  const client = new AppServerClient({ bin, cwd: tmpdir(), clientName: 'feishu-discuss-source' });
  const abort = () => { void client.close(100); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    signal.throwIfAborted();
    await client.connect();
    const { thread } = await client.request<{ thread: { path: string; turns: { id: string; status: string }[] } }>(
      'thread/read', { threadId: id, includeTurns: false });
    const running = (thread.turns ?? []).find(t => t.status === 'inProgress');
    const ended = (thread.turns ?? []).filter(t => t.status !== 'inProgress').at(-1);
    if (!thread.path) throw new Error('Main rollout path unavailable');
    return { path: thread.path, ...(running ? { beforeTurnId: running.id } : ended ? { lastTurnId: ended.id } : {}) };
  } finally { signal.removeEventListener('abort', abort); await client.close(100); }
}

export const AUX_CONFIG = {
  web_search: 'disabled', project_doc_max_bytes: 0,
  'features.shell_tool': false, 'features.unified_exec': false, 'features.code_mode': false,
  'features.code_mode_host': false, 'features.multi_agent': false, 'features.multi_agent_v2': false,
  'features.hooks': false, 'features.apps': false, 'features.browser_use': false,
  'features.computer_use': false, 'features.image_generation': false, 'features.skill_search': false,
  'features.skip_host_skill_discovery': true, 'features.view_image': false, 'features.sleep_tool': false, 'features.goals': false,
};

/** A long-lived auxiliary conversation in an isolated home. Only auth is linked.
 * Restart recovery seeds a new conversation from the durable summary. */
export async function createDiscussModel(opts: DiscussModelOptions, signal: AbortSignal): Promise<DiscussModel> {
  const bin = resolveCodexBin();
  if (!bin) throw new Error('Codex unavailable');
  const root = opts.storageRoot ?? await mkdtemp(join(tmpdir(), 'feishu-discuss-'));
  const home = join(root, 'home'), cwd = join(root, 'work');
  let client: AppServerClient | undefined;
  const abort = () => { void client?.close(100); };
  const close = async () => { signal.removeEventListener('abort', abort); await client?.close(100).catch(() => undefined); if (!opts.storageRoot) await rm(root, { recursive: true, force: true }); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    signal.throwIfAborted();
    await Promise.all([mkdir(home, { recursive: true, mode: 0o700 }), mkdir(cwd, { recursive: true, mode: 0o700 })]);
    await symlink(join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'auth.json'), join(home, 'auth.json')).catch(error => { if (error.code !== 'EEXIST') throw error; });
    // Paginated forks resolve the source ID through this home's session index,
    // even when a path is supplied. Import an unchanged, private snapshot before
    // starting the server so native backfill can index it. Never share writable
    // main-session files or databases with the auxiliary process.
    let sourcePath = opts.sourcePath;
    if (sourcePath) {
      const sessions = join(home, 'sessions');
      await mkdir(sessions, { recursive: true, mode: 0o700 });
      const snapshot = join(sessions, basename(sourcePath));
      await copyFile(sourcePath, snapshot);
      await chmod(snapshot, 0o600);
      sourcePath = snapshot;
    }
    signal.throwIfAborted();
    client = new AppServerClient({ bin, cwd, env: { CODEX_HOME: home }, clientName: 'feishu-discuss' });
    await client.connect();
    signal.throwIfAborted();
    const common = { cwd, model: opts.model, approvalPolicy: 'never', sandbox: 'read-only', ephemeral: !opts.storageRoot,
      config: AUX_CONFIG, ...(opts.fast === undefined ? {} : { serviceTier: opts.fast ? 'fast' : null }), developerInstructions: opts.instructions };
    let resumed: { thread: { id: string } } | undefined;
    if (opts.storageRoot && opts.resumeId) {
      resumed = await client.request<{ thread: { id: string } }>('thread/resume', {
        ...common, threadId: opts.resumeId, baseInstructions: opts.instructions,
      }).catch(() => undefined);
    }
    const response = resumed ?? await client.request<{ thread: { id: string } }>(sourcePath ? 'thread/fork' : 'thread/start',
      sourcePath ? { ...common, excludeTurns: true, threadId: opts.sourceId, path: sourcePath,
        lastTurnId: opts.lastTurnId, beforeTurnId: opts.beforeTurnId }
        : { ...common, baseInstructions: opts.instructions, ...(opts.storageRoot ? { historyMode: 'legacy' } : {}) });
    const threadId = response.thread.id;
    const iterator = client.stream()[Symbol.asyncIterator]();
    let first = true;
    return {
      sessionId: threadId,
      async ask(input, schema, turnSignal) {
        const cancel = () => { void client!.close(100); };
        turnSignal.addEventListener('abort', cancel, { once: true });
        try {
          turnSignal.throwIfAborted();
          const boundary = first ? '上下文边界：继承历史仅供参考，不继续其中任务或审批。仅处理本边界后的分类/摘要请求。禁止执行任务、发消息、修改文件或委派。\n' : '';
          first = false;
          const { turn } = await client!.request<{ turn: { id: string } }>('turn/start', {
            threadId, model: opts.model, effort: opts.effort, ...(opts.fast === undefined ? {} : { serviceTier: opts.fast ? 'fast' : null }),
            input: [{ type: 'text', text: boundary + input, text_elements: [] }], outputSchema: schema,
          });
          let text = '';
          for (;;) {
            const step = await iterator.next();
            turnSignal.throwIfAborted();
            if (step.done) throw new Error('Auxiliary stream closed');
            const n = step.value;
            if ('threadId' in n.params && n.params.threadId !== threadId) continue;
            if (n.method === 'thread/tokenUsage/updated') {
              const usage = n.params.tokenUsage.last;
              log.info('agent', 'discuss-usage', { model: opts.model, inputTokens: usage.inputTokens, cachedInputTokens: usage.cachedInputTokens, outputTokens: usage.outputTokens });
            }
            if (n.method === 'model/rerouted' && n.params.toModel !== opts.model) throw new Error('Auxiliary model rerouted');
            if (n.method === 'item/completed' && n.params.turnId === turn.id) {
              if (n.params.item.type === 'agentMessage') text = n.params.item.text;
              else if (['commandExecution', 'fileChange', 'mcpToolCall', 'webSearch', 'collabAgentToolCall'].includes(n.params.item.type)) throw new Error('Auxiliary native tools forbidden');
            }
            if (n.method === 'turn/completed' && n.params.turn.id === turn.id) {
              if (n.params.turn.status !== 'completed') throw new Error('Auxiliary turn failed');
              return text;
            }
            if (n.method === 'error' && !n.params.willRetry) throw new Error('Auxiliary model error');
          }
        } finally { turnSignal.removeEventListener('abort', cancel); }
      }, close,
    };
  } catch (error) { await close(); throw error; }
}
