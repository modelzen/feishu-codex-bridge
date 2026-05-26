import { AsyncLocalStorage } from 'node:async_hooks';
import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { open, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { paths } from '../config/paths';

/** Days of `YYYY-MM-DD.log` history to keep. Override via env. */
const LOG_RETENTION_DAYS = Math.max(
  1,
  Number(process.env.FEISHU_CODEX_LOG_DAYS ?? 7) || 7,
);

/**
 * Stdout is for humans tailing the terminal. Only these noisy-but-meaningful
 * events bubble up; everything else lives in the JSON log file.
 */
const STDOUT_INFO_ALLOWLIST = new Set<string>([
  'ws.connected',
  'ws.reconnecting',
  'ws.reconnected',
  'intake.enter',
  'intake.recv',
  'intake.reject',
  'card.final',
  'card.config',
  'card.action',
  'card.launch',
  'agent.spawn',
  'agent.exit',
]);

export interface LogContext {
  traceId?: string;
  chatId?: string;
  msgId?: string;
}

const als = new AsyncLocalStorage<LogContext>();

let stream: WriteStream | null = null;
let currentDate = '';

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function logsDir(): string {
  return join(paths.appDir, 'logs');
}

function getStream(): WriteStream | null {
  const today = todayKey();
  if (stream && currentDate === today) return stream;
  if (stream) {
    try {
      stream.end();
    } catch {
      /* noop */
    }
  }
  try {
    mkdirSync(logsDir(), { recursive: true });
    stream = createWriteStream(join(logsDir(), `${today}.log`), { flags: 'a' });
    currentDate = today;
    return stream;
  } catch {
    return null;
  }
}

type Level = 'info' | 'warn' | 'error';
export type LogFields = Record<string, unknown>;

const RESERVED_KEYS = new Set([
  'ts',
  'level',
  'phase',
  'event',
  'traceId',
  'chatId',
  'msgId',
]);

function emit(level: Level, phase: string, event: string, fields: LogFields = {}): void {
  const ctx = als.getStore() ?? {};
  const entry: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    phase,
    event,
    ...ctx,
  };
  for (const [k, v] of Object.entries(fields)) {
    if (RESERVED_KEYS.has(k)) {
      entry[`_${k}`] = v;
    } else {
      entry[k] = v;
    }
  }
  const s = getStream();
  if (s) {
    try {
      s.write(`${JSON.stringify(entry)}\n`);
    } catch {
      /* swallow disk errors — logging should never crash the bot */
    }
  }

  const showOnStdout =
    level !== 'info' || STDOUT_INFO_ALLOWLIST.has(`${phase}.${event}`);
  if (!showOnStdout) return;

  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  fn(formatStdout(level, phase, event, ctx, fields));
}

function formatStdout(
  level: Level,
  phase: string,
  event: string,
  ctx: LogContext,
  fields: LogFields,
): string {
  if (phase === 'ws') {
    if (event === 'connected') {
      const bot = fields.bot ?? '-';
      const appId = fields.appId ? ` (${fields.appId})` : '';
      return `✓ 已连接  bot: ${bot}${appId}`;
    }
    if (event === 'reconnecting') return '↻ 正在重连…';
    if (event === 'reconnected') return '✓ 已重连';
    if (event === 'fail') return `✗ WS 错误: ${fields.err ?? ''}`;
  }
  if (phase === 'intake' && event === 'enter') {
    const c = ctx.chatId ? ctx.chatId.slice(-6) : '-';
    const sender = fields.sender ?? '-';
    const preview = fields.preview ?? '';
    return `▸ ${fields.chatType ?? '?'}/${c} ${sender}: ${preview}`;
  }
  if (phase === 'card' && event === 'final') {
    const c = ctx.chatId ? ctx.chatId.slice(-6) : '-';
    const t = fields.terminal;
    const mark = t === 'done' ? '✓' : t === 'interrupted' ? '⏹' : '✗';
    return `  ${mark} ${c} ${t}`;
  }

  const ctxBits: string[] = [];
  if (ctx.traceId) ctxBits.push(`t=${ctx.traceId}`);
  if (ctx.chatId) ctxBits.push(`c=${ctx.chatId.slice(-6)}`);
  const ctxStr = ctxBits.length > 0 ? ` ${ctxBits.join(' ')}` : '';
  const summary = formatFields(fields);
  const tag = level === 'error' ? '✗' : level === 'warn' ? '⚠' : '·';
  return `${tag} [${phase}.${event}]${ctxStr}${summary ? ` ${summary}` : ''}`;
}

function formatFields(fields: LogFields): string {
  const keys = Object.keys(fields);
  if (keys.length === 0) return '';
  const parts: string[] = [];
  for (const k of keys) {
    const v = fields[k];
    if (v === undefined || v === null) continue;
    if (k === 'stack') continue;
    if (typeof v === 'string') {
      parts.push(`${k}=${v.length > 80 ? `${v.slice(0, 80)}…` : v}`);
    } else if (typeof v === 'number' || typeof v === 'boolean') {
      parts.push(`${k}=${v}`);
    } else {
      try {
        const str = JSON.stringify(v);
        parts.push(`${k}=${str.length > 80 ? `${str.slice(0, 80)}…` : str}`);
      } catch {
        parts.push(`${k}=?`);
      }
    }
  }
  return parts.join(' ');
}

export const log = {
  info(phase: string, event: string, fields?: LogFields): void {
    emit('info', phase, event, fields);
  },
  warn(phase: string, event: string, fields?: LogFields): void {
    emit('warn', phase, event, fields);
  },
  fail(phase: string, err: unknown, fields?: LogFields): void {
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    const apiData = (err as { response?: { data?: unknown } })?.response?.data;
    const apiStatus = (err as { response?: { status?: unknown } })?.response?.status;
    emit('error', phase, 'fail', {
      ...fields,
      err: message,
      apiStatus,
      apiData,
      stack,
    });
  },
};

/** Run `fn` inside a logging context; all `log.*` inside pick up the fields. */
export function withTrace<T>(ctx: LogContext, fn: () => Promise<T>): Promise<T> {
  const traceId = ctx.traceId ?? newTraceId();
  return als.run({ ...ctx, traceId }, fn);
}

export function newTraceId(): string {
  return Math.random().toString(36).slice(2, 10);
}

/** Delete log files older than the retention window. Best-effort. */
export async function gcOldLogs(): Promise<number> {
  const dir = logsDir();
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return 0;
  }
  const cutoff = Date.now() - LOG_RETENTION_DAYS * 86_400_000;
  let removed = 0;
  for (const name of entries) {
    const m = name.match(/^(\d{4}-\d{2}-\d{2})\.log$/);
    if (!m) continue;
    const fileMs = Date.parse(`${m[1]}T00:00:00Z`);
    if (Number.isNaN(fileMs) || fileMs >= cutoff) continue;
    try {
      await rm(join(dir, name));
      removed++;
    } catch {
      /* skip */
    }
  }
  if (removed > 0) {
    log.info('logger', 'gc', { removed, retentionDays: LOG_RETENTION_DAYS });
  }
  return removed;
}

/** Read the tail (up to maxBytes of complete JSON lines) of recent logs. */
export async function readRecentLogs(opts: { maxBytes: number }): Promise<string> {
  const today = todayKey();
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const tail = await readTail(join(logsDir(), `${today}.log`), opts.maxBytes);
  if (tail.length >= opts.maxBytes / 2) return tail;
  const remaining = opts.maxBytes - Buffer.byteLength(tail, 'utf8');
  const earlier = await readTail(join(logsDir(), `${yesterday}.log`), remaining);
  return earlier + tail;
}

async function readTail(path: string, maxBytes: number): Promise<string> {
  try {
    const st = await stat(path);
    const start = Math.max(0, st.size - maxBytes);
    const handle = await open(path, 'r');
    try {
      const buf = Buffer.alloc(st.size - start);
      await handle.read(buf, 0, buf.length, start);
      let content = buf.toString('utf8');
      if (start > 0) {
        const nl = content.indexOf('\n');
        if (nl !== -1) content = content.slice(nl + 1);
      }
      return content;
    } finally {
      await handle.close();
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw err;
  }
}
