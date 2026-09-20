import { execFile } from 'node:child_process';
import type { LarkChannel, NormalizedMessage } from '@larksuiteoapi/node-sdk';
import { extractMessageText } from './context-weave';

export interface HistoryMessage {
  messageId: string; chatId: string; threadId?: string; parentMessageId?: string;
  senderName: string; senderId: string; senderType: string;
  createTime: number; text: string; receivedOrder?: number; deleted?: boolean;
}
export interface HistoryResult { messages: HistoryMessage[]; gaps: string[] }
export interface HistoryLookup { kind: 'search' | 'before' | 'around'; query: string; messageId: string; beforeMs: number }
export interface HistoryRequest { chatId: string; threadId?: string; cutoff: number; start: number; currentMessageId?: string }
export interface BriefingHistory {
  recent(request: HistoryRequest, signal: AbortSignal): Promise<HistoryResult>;
  lookup(request: HistoryRequest, lookup: HistoryLookup, limit: number, signal: AbortSignal): Promise<HistoryResult>;
  observe?(msg: NormalizedMessage): void;
}

export function inboundHistory(msg: NormalizedMessage): HistoryMessage {
  return { messageId: msg.messageId, chatId: msg.chatId, threadId: msg.threadId,
    parentMessageId: msg.replyToMessageId,
    senderName: msg.senderName || msg.senderId || '未知', senderId: msg.senderId,
    senderType: 'user', createTime: msg.createTime || Date.now(), text: msg.content };
}

export function mergeHistory(messages: HistoryMessage[], request: HistoryRequest, limit = 100): HistoryMessage[] {
  const map = new Map<string, HistoryMessage>();
  for (const m of messages) {
    if (!m.messageId || m.chatId !== request.chatId || m.createTime < request.start || m.createTime > request.cutoff) continue;
    if (m.deleted) { map.delete(m.messageId); continue; }
    if (!m.text.trim()) continue;
    const old = map.get(m.messageId);
    map.set(m.messageId, { ...m,
      senderName: m.senderName === m.senderId && old?.senderName ? old.senderName : m.senderName,
      text: /^\[(?:卡片消息|interactive card)\]$/.test(m.text) && old?.text ? old.text : m.text });
  }
  return [...map.values()].sort((a, b) => a.createTime - b.createTime || a.messageId.localeCompare(b.messageId)).slice(-limit);
}

// All archive operations are parameterized, read-only and chat-scoped. The
// model never controls a database path, SQL, chat identity or executable.
export const ARCHIVE_QUERY = `
import sqlite3,json,sys,pathlib
p=json.load(sys.stdin)
c=sqlite3.connect(pathlib.Path(sys.argv[1]).resolve().as_uri()+'?mode=ro',uri=True,timeout=1)
c.row_factory=sqlite3.Row
c.execute('PRAGMA query_only=ON')
where='chat_id=? AND deleted=0 AND create_ms<=? AND msg_type!=?'
args=[p['chatId'],p['cutoff'],'system']
k=p.get('kind','recent')
if k=='recent':
 where+=' AND create_ms>=?'; args.append(p['start'])
elif k=='before':
 where+=' AND create_ms<?'; args.append(min(p['beforeMs'],p['cutoff']+1))
elif k=='around':
 a=c.execute('SELECT create_ms,thread_id FROM messages WHERE chat_id=? AND message_id=? AND deleted=0',(p['chatId'],p['messageId'])).fetchone()
 if a is None: print('[]'); sys.exit(0)
 if a['thread_id']: where+=' AND thread_id=?'; args.append(a['thread_id'])
 where+=' AND create_ms BETWEEN ? AND ?'; args.extend([a['create_ms']-86400000,a['create_ms']+86400000])
elif k=='search':
 terms=p['query'].split()[:8]
 if not terms: print('[]'); sys.exit(0)
 where+=' AND ('+' OR '.join(["content LIKE ? ESCAPE '\\\\'" for _ in terms])+')'
 args.extend('%'+s.replace('\\\\','\\\\\\\\').replace('%','\\\\%').replace('_','\\\\_')+'%' for s in terms)
else: raise ValueError('invalid lookup')
rows=c.execute('SELECT message_id,chat_id,thread_id,sender_name,sender_id,sender_type,create_ms,substr(content,1,16000) AS content FROM messages WHERE '+where+' ORDER BY create_ms DESC,message_id DESC LIMIT ?',args+[min(2000 if k=='recent' else 200,max(1,p['limit']))]).fetchall()
print(json.dumps([dict(r) for r in rows],ensure_ascii=False))
`;

export async function readArchive(path: string, python: string, request: HistoryRequest,
  lookup: HistoryLookup | undefined, limit: number, signal: AbortSignal): Promise<HistoryMessage[]> {
  signal.throwIfAborted();
  const output = await new Promise<string>((resolve, reject) => {
    const child = execFile(python, ['-c', ARCHIVE_QUERY, path], { signal, timeout: 2500, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => err ? reject(err) : resolve(stdout));
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(JSON.stringify({ ...request, ...lookup, limit }));
  });
  return (JSON.parse(output) as Record<string, unknown>[]).map(r => ({
    messageId: String(r.message_id), chatId: String(r.chat_id), threadId: r.thread_id ? String(r.thread_id) : undefined,
    senderName: String(r.sender_name || r.sender_id || '未知'), senderId: String(r.sender_id || ''),
    senderType: String(r.sender_type || 'user'), createTime: Number(r.create_ms), text: String(r.content || ''),
  }));
}

export class ChatHistory implements BriefingHistory {
  private observed = new Map<string, HistoryMessage[]>();
  private receiveOrder = 0;
  constructor(private channel: LarkChannel, private archivePath?: string, private python = 'python3') {}

  observe(msg: NormalizedMessage): void {
    const existing = this.observed.get(msg.chatId) ?? [];
    this.observed.delete(msg.chatId);
    this.observed.set(msg.chatId, [...existing.filter(m => m.messageId !== msg.messageId),
      { ...inboundHistory(msg), receivedOrder: existing.find(m => m.messageId === msg.messageId)?.receivedOrder ?? ++this.receiveOrder }].slice(-2000));
    if (this.observed.size > 200) this.observed.delete(this.observed.keys().next().value!);
  }

  private async live(request: HistoryRequest, signal: AbortSignal, threadId?: string, max = 2000): Promise<HistoryMessage[]> {
    const out: HistoryMessage[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < 40 && out.length < max; page++) {
      signal.throwIfAborted();
      const result = await this.channel.rawClient.im.v1.message.list({ params: {
        container_id_type: threadId ? 'thread' : 'chat', container_id: threadId ?? request.chatId,
        sort_type: 'ByCreateTimeDesc', page_size: 50, page_token: pageToken, card_msg_content_type: 'raw_card_content',
        ...(threadId ? {} : { start_time: String(Math.floor(request.start / 1000)), end_time: String(Math.floor(request.cutoff / 1000) + 1) }),
      } });
      if (result.code && result.code !== 0) throw new Error(`history API ${result.code}`);
      for (const item of result.data?.items ?? []) {
        if (item.msg_type === 'system') continue;
        const sender = item.sender as { id?: string; sender_type?: string; sender_name?: string } | undefined;
        const text = extractMessageText(item.msg_type, item.body?.content, item.mentions);
        // Live bridge cards can repeat a growing answer; ignore running cards.
        if (item.msg_type === 'interactive' && /"(?:run\\.stop|run\\.kill)"/.test(item.body?.content ?? '')) continue;
        out.push({ messageId: item.message_id ?? '', chatId: request.chatId, deleted: item.deleted,
          threadId: item.thread_id || threadId, parentMessageId: item.parent_id, senderName: sender?.sender_name || sender?.id || '未知',
          senderId: sender?.id ?? '', senderType: sender?.sender_type ?? 'user',
          createTime: Number(item.create_time) || 0, text });
      }
      if (!result.data?.has_more || !result.data.page_token) break;
      if (out.length && out[out.length - 1]!.createTime < request.start) break;
      // A newest-first prefix is sufficient once it contains the briefing
      // window and already exceeds the gate. If the checkpoint falls inside
      // this prefix, ALL newer messages have also been collected.
      const chars = out.reduce((n, m) => n + Array.from(m.text.replace(/\s/gu, '')).length, 0);
      if (out.length >= 100 && chars >= 800) break;
      pageToken = result.data.page_token;
    }
    return out;
  }

  async recent(request: HistoryRequest, signal: AbortSignal): Promise<HistoryResult> {
    const gaps: string[] = [];
    const messages: HistoryMessage[] = [...(this.observed.get(request.chatId) ?? [])];
    const collect = async (p: Promise<HistoryMessage[]>, label: string) => {
      try { return await p; } catch { gaps.push(label); return []; }
    };
    const parts = await Promise.all([
      this.archivePath ? collect(readArchive(this.archivePath, this.python, request, undefined, 2000, signal), '本地归档不可用') : Promise.resolve([]),
      collect(this.live(request, signal), '群历史读取失败'),
      request.threadId ? collect(this.live(request, signal, request.threadId), '当前话题读取失败') : Promise.resolve([]),
    ]);
    messages.push(...parts.flat());
    // Expand recent known roots: chat listing alone omits topic replies.
    const topics = [...new Set(messages.filter(m => m.createTime >= request.start).map(m => m.threadId).filter(Boolean))]
      .filter(t => t !== request.threadId);
    const expanded = await Promise.all(topics.slice(0, 4).map(t => collect(this.live(request, signal, t, 2000), '部分话题读取失败')));
    messages.push(...expanded.flat());
    if (topics.length > 4) gaps.push('仅实时展开当前话题及最近四个其他话题，其余依赖归档');
    const observed = this.observed.get(request.chatId) ?? [];
    const order = observed.find(m => m.messageId === request.currentMessageId)?.receivedOrder;
    const future = new Set(observed.filter(m => order !== undefined && m.receivedOrder! > order).map(m => m.messageId));
    return { messages: mergeHistory(messages.filter(m => !future.has(m.messageId)), request, 2000), gaps };
  }

  async lookup(request: HistoryRequest, lookup: HistoryLookup, limit: number, signal: AbortSignal): Promise<HistoryResult> {
    const scoped = { ...request, start: 0 };
    try {
      const archived = this.archivePath ? await readArchive(this.archivePath, this.python, scoped, lookup, limit, signal) : [];
      if (archived.length) return { messages: mergeHistory(archived, scoped, limit), gaps: ['旧消息来自本地归档，可能不完整'] };
      if (lookup.kind === 'before') return { messages: mergeHistory(await this.live({ ...scoped,
        cutoff: Math.min(scoped.cutoff, lookup.beforeMs - 1) }, signal, request.threadId, limit), scoped, limit), gaps: [] };
      return { messages: [], gaps: ['当前群归档中未找到匹配前文'] };
    } catch { return { messages: [], gaps: ['追加历史读取失败'] }; }
  }
}
