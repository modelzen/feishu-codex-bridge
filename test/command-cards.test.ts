import { describe, expect, it } from 'vitest';
import { buildResumeCard, type ResumeCardState } from '../src/card/command-cards';
import type { ThreadSummary } from '../src/agent/types';

function buttons(node: unknown, acc: any[] = []): any[] {
  if (Array.isArray(node)) node.forEach((n) => buttons(n, acc));
  else if (node && typeof node === 'object') {
    const o = node as Record<string, unknown>;
    if (o.tag === 'button') acc.push(o);
    for (const k of Object.keys(o)) buttons(o[k], acc);
  }
  return acc;
}

function state(threads: ThreadSummary[]): ResumeCardState {
  return { chatId: 'oc_x', originalMsgId: 'om_x', requesterOpenId: 'ou_x', cwd: '/x', threads, createdAt: Date.now() };
}

const NOW = Math.floor(Date.now() / 1000);

describe('buildResumeCard', () => {
  it('renders one labeled button per session (time · title), unambiguous', () => {
    const longTitle = 'X-Alimail-AntiSpam:AC=CONTINUE;BC=-1|1;BR=01201311R271S09ruler050_05242_201210;CH=green';
    const threads: ThreadSummary[] = [
      { codexThreadId: 'c1', preview: '查看功能', name: '查看功能', createdAt: NOW - 1500, updatedAt: NOW - 1500 },
      { codexThreadId: 'c2', preview: longTitle, name: '', createdAt: NOW - 20 * 86400, updatedAt: NOW - 20 * 86400 },
      // two same-title sessions, different times → must get different labels
      { codexThreadId: 'c3', preview: '分析 SLS 告警', name: '分析 SLS 告警', createdAt: NOW - 20 * 86400, updatedAt: NOW - 20 * 86400 },
      { codexThreadId: 'c4', preview: '分析 SLS 告警', name: '分析 SLS 告警', createdAt: NOW - 20 * 86400 - 4000, updatedAt: NOW - 20 * 86400 - 4000 },
    ];
    const card = buildResumeCard(state(threads));
    const btns = buttons(card);

    // exactly one button per session, each carrying its codexThreadId
    expect(btns.length).toBe(4);
    expect(btns.map((b) => b.behaviors[0].value.t)).toEqual(['c1', 'c2', 'c3', 'c4']);
    // every label is the time·title button (no bare "恢复" buttons)
    for (const b of btns) expect(b.text.content).toMatch(/^↩️ .+ · /);
    // long/garbage title is truncated to one line with …
    const longLabel = btns[1].text.content as string;
    expect(longLabel).toContain('…');
    expect(longLabel.length).toBeLessThan(60); // bounded, not the full ~90-char title
    expect(longLabel).not.toContain('\n');
    // same-title sessions are disambiguated by the timestamp
    expect(btns[2].text.content).not.toBe(btns[3].text.content);
  });

  it('shows an empty-state hint and no buttons when there is no history', () => {
    const card = buildResumeCard(state([]));
    expect(buttons(card).length).toBe(0);
    expect(JSON.stringify(card)).toContain('还没有历史会话');
  });
});
