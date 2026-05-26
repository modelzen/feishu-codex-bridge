import type { AgentEvent } from '../agent/types';

interface ToolLine {
  title: string;
  done: boolean;
  exitCode?: number | null;
}

/**
 * Accumulates AgentEvents into a markdown string for the streaming card.
 * M1: text (agentMessage items, delta-accumulated) + tool lines. Thinking
 * is folded away by default to keep the card focused.
 */
export class RunRender {
  private texts = new Map<string, string>();
  private textOrder: string[] = [];
  private tools = new Map<string, ToolLine>();
  private toolOrder: string[] = [];
  private status: 'running' | 'done' | 'error' = 'running';
  private errorMsg = '';
  showTools = true;

  apply(ev: AgentEvent): void {
    switch (ev.type) {
      case 'text_delta':
        this.append(ev.itemId, ev.delta);
        break;
      case 'text':
        this.texts.set(ev.itemId, ev.text);
        if (!this.textOrder.includes(ev.itemId)) this.textOrder.push(ev.itemId);
        break;
      case 'tool_use':
        if (!this.tools.has(ev.itemId)) {
          this.tools.set(ev.itemId, { title: ev.title, done: false });
          this.toolOrder.push(ev.itemId);
        }
        break;
      case 'tool_result': {
        const t = this.tools.get(ev.itemId);
        if (t) {
          t.done = true;
          t.exitCode = ev.exitCode ?? null;
        }
        break;
      }
      case 'done':
        this.status = 'done';
        break;
      case 'error':
        this.status = 'error';
        this.errorMsg = ev.message;
        break;
      default:
        break;
    }
  }

  private append(itemId: string, delta: string): void {
    if (!this.texts.has(itemId)) {
      this.texts.set(itemId, '');
      this.textOrder.push(itemId);
    }
    this.texts.set(itemId, (this.texts.get(itemId) ?? '') + delta);
  }

  markdown(): string {
    const parts: string[] = [];
    if (this.showTools && this.toolOrder.length) {
      for (const id of this.toolOrder) {
        const t = this.tools.get(id)!;
        const mark = t.done ? (t.exitCode && t.exitCode !== 0 ? '✗' : '✓') : '▸';
        parts.push(`${mark} \`${truncate(t.title, 80)}\``);
      }
      parts.push('');
    }
    const body = this.textOrder.map((id) => this.texts.get(id) ?? '').join('\n').trim();
    if (body) parts.push(body);

    if (this.status === 'running') parts.push('\n✍️ 正在输出…');
    else if (this.status === 'error') parts.push(`\n❌ ${this.errorMsg}`);
    const out = parts.join('\n').trim();
    return out || '✍️ 正在输出…';
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
