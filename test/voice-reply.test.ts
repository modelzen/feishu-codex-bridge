import { describe, expect, it } from 'vitest';
import { buildRunCard, buildRunCardPlain, buildQueuedCard, ANSWER_EID } from '../src/card/run-card';
import { initialState, reduce, markInterrupted } from '../src/card/run-state';
import { voiceReplyElements } from '../src/card/voice-reply';

const transcript = '第一段 <at id=all>所有人</at> **不是加粗**\n\n第二段 /goal 不执行命令 🙂';
const voice = { messageId: 'voice-1', text: transcript, transcribed: true };
const elements = (card: any): any[] => card.body.elements;

describe('bridge-owned voice transcript panels', () => {
  it('keeps full literal text above both the running and final answer', () => {
    const running = reduce(initialState, { type: 'text_delta', itemId: 'reply', delta: 'agent 的回复'.repeat(400) });
    const terminal = reduce(running, { type: 'done', turnId: 'turn' });
    for (const rs of [initialState, running, terminal, markInterrupted(running)]) {
      const card = buildRunCard({ rs, voiceMessages: [voice] });
      const [panel] = elements(card);
      expect(panel).toMatchObject({ tag: 'collapsible_panel', expanded: true, background_color: 'grey-50' });
      expect(panel.elements).toEqual([{ tag: 'div', text: { tag: 'plain_text', content: transcript } }]);
      expect(elements(card).filter(e => e.element_id?.startsWith('voice_'))).toHaveLength(1);
    }
    const answer = elements(buildRunCard({ rs: running, voiceMessages: [voice] })).find(e => e.element_id === ANSWER_EID);
    expect(answer.content).toBe('agent 的回复'.repeat(400));
    expect(elements(buildRunCardPlain({ rs: terminal, voiceMessages: [voice] }))[0]).toEqual(voiceReplyElements([voice])[0]);
  });

  it('preserves queued and cancelled transcripts, without changing text-only replies', () => {
    for (const cancelled of [false, true]) {
      expect(elements(buildQueuedCard({ position: 2, cancelled, voiceMessages: [voice] }))[0]).toEqual(voiceReplyElements([voice])[0]);
    }
    expect(JSON.stringify(buildRunCard({ rs: initialState }))).not.toContain('voice_');
  });

  it('deduplicates events by message identity but keeps repeated spoken words from different messages', () => {
    const panels = voiceReplyElements([voice, voice, { ...voice, messageId: 'voice-2' }]);
    expect(panels).toHaveLength(2);
    expect(panels[0]!.element_id).not.toBe(panels[1]!.element_id);
  });

  it('retains unusually long Unicode transcripts within per-panel byte limits', () => {
    const text = '🙂超长原文\n'.repeat(2500);
    const panels = voiceReplyElements([{ ...voice, text }]) as any[];
    expect(panels.length).toBeGreaterThan(1);
    expect(panels.map(p => p.elements[0].text.content).join('')).toBe(text);
    for (const panel of panels) expect(Buffer.byteLength(JSON.stringify(panel))).toBeLessThan(30000);
  });

  it('shows a short failure notice instead of inventing a transcript', () => {
    const [notice] = voiceReplyElements([{ messageId: 'failed', transcribed: false, text: '语音未转写，已将原音频交给 agent。' }]);
    expect(notice).toMatchObject({ tag: 'div', text: { tag: 'plain_text', content: '语音未转写，已将原音频交给 agent。' } });
  });
});
