import { log } from '../core/logger';
import { spawn } from 'node:child_process';
import type { AppConfig } from '../config/schema';
import { getMemoryContextConfig } from '../config/schema';

export interface MemoryContextInput {
  chat_id: string;
  message_id: string;
  thread_id?: string;
  sender_id?: string;
  sender_name?: string;
  create_time?: number;
  msg_type?: string;
  query: string;
}

export async function loadMemoryContext(cfg: AppConfig, input: MemoryContextInput): Promise<string> {
  if ((cfg.preferences?.contextBriefing && cfg.preferences.contextBriefing.enabled !== false) || cfg.preferences?.memoryContext?.inject === false) return '';
  const config = getMemoryContextConfig(cfg);
  if (!config) return '';

  return await new Promise<string>((resolve) => {
    const child = spawn(config.command, config.args, {
      stdio: ['pipe', 'pipe', 'ignore'],
      env: { ...process.env },
    });
    const stdout: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;

    const finish = (value = ''): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value.trim());
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish();
    }, config.timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > config.maxOutputBytes) {
        child.kill('SIGKILL');
        finish();
        return;
      }
      stdout.push(chunk);
    });
    child.on('error', () => finish());
    child.on('close', (code) => finish(code === 0 ? Buffer.concat(stdout).toString('utf8') : ''));
    child.stdin.on('error', () => undefined);
    child.stdin.end(JSON.stringify(input));
  });
}

export function weaveMemoryContext(text: string, memory: string): string {
  return memory.trim() ? `${memory.trim()}\n\n${text}` : text;
}

let syncStarted = false;
let syncRunning = false;

export function startMemorySync(cfg: AppConfig): void {
  if (syncStarted) return;
  const config = getMemoryContextConfig(cfg);
  if (!config || config.syncArgs.length === 0) return;
  syncStarted = true;

  const run = (): void => {
    if (syncRunning) return;
    syncRunning = true;
    const child = spawn(config.command, config.syncArgs, {
      stdio: 'ignore',
      env: { ...process.env },
    });
    child.unref();
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      log.warn('intake', 'memory-sync-timeout', {});
      // Wait for close before allowing another child; never overlap a survivor.
    }, config.syncTimeoutMs);
    timer.unref();
    const finished = (): void => { clearTimeout(timer); syncRunning = false; };
    child.once('error', finished);
    child.once('close', finished);
  };

  const initial = setTimeout(run, 1_000);
  initial.unref();
  const interval = setInterval(run, config.syncIntervalMs);
  interval.unref();
}
