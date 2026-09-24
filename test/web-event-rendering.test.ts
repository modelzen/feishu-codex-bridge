import { describe, expect, it } from 'vitest';
import { UI_HTML, UI_PURE_JS } from '../src/web/ui';
import type { EventDiagnosis } from '../src/utils/event-diagnosis';

class Element {
  children: Element[] = [];
  href = '';
  style = {};
  private value = '';
  constructor(readonly tag: string, text = '') { this.value = text; }
  set textContent(text: string) { this.value = text; this.children = []; }
  get textContent(): string { return this.value + this.children.map((child) => child.textContent).join('\n'); }
  get lastChild(): Element | undefined { return this.children.at(-1); }
  appendChild(child: Element): Element { this.children.push(child); return child; }
  links(): string[] { return [...(this.href ? [this.href] : []), ...this.children.flatMap((child) => child.links())]; }
}

function pageFunction(name: string): string {
  const start = UI_HTML.indexOf(`  function ${name}(`);
  const end = UI_HTML.indexOf('\n  function ', start + 1);
  if (start < 0 || end < 0) throw new Error(`missing UI function ${name}`);
  return UI_HTML.slice(start, end);
}

const execute = new Function('box', 'el', 'diagnosis', 'surface', UI_PURE_JS + [
  'checkItem', 'appendEventDiagnosis', 'renderDiagnosis', 'renderWizChecklist',
].map(pageFunction).join('\n') + `
  var url = 'https://open.feishu.cn/app/cli_test/event';
  var diag = { event: diagnosis, eventConfigUrl: url, backends: [] };
  var wizSetup = { credentials: { ok: true }, scopes: { missingRequired: [] }, event: diagnosis, eventConfigUrl: url };
  var wizBotId = 'cli_test';
  function $(id) { return box; }
  function wizStepBar() { return el('div'); }
  function wizChecklistActions() { return el('div'); }
  if (surface === 'wizard') renderWizChecklist(); else renderDiagnosis(box);
`);

const cases: { d: EventDiagnosis; text: string; link: boolean }[] = [
  { d: { state: 'ok', version: '1.2', missingOptional: [] }, text: '已发布版本 v1.2 已订阅 im.message.receive_v1', link: false },
  { d: { state: 'ok', missingOptional: ['application.bot.menu_v6'] }, text: '可选事件未订阅：application.bot.menu_v6', link: true },
  { d: { state: 'missing', missingRequired: ['im.message.receive_v1'] }, text: '缺少：im.message.receive_v1', link: true },
  { d: { state: 'unpublished' }, text: '未找到已发布版本', link: true },
  { d: { state: 'unchecked', reason: 'no permission' }, text: 'no permission', link: true },
];

for (const surface of ['wizard', 'diagnosis']) {
  describe(`${surface} renders the event query`, () => {
    it.each(cases)('$d.state displays its result and appropriate link', ({ d, text, link }) => {
      const box = new Element('div');
      execute(box, (tag: string, _className?: string, value?: string) => new Element(tag, value), d, surface);
      expect(box.textContent).toContain(text);
      expect(box.textContent).not.toContain('请自行确认');
      expect(box.links()).toEqual(link ? ['https://open.feishu.cn/app/cli_test/event'] : []);
      expect(box.textContent).toContain('card.action.trigger');
    });
  });
}
