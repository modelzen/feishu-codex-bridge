import { describe, expect, it } from 'vitest';
import {
  buildCliBridgeApprovalCard,
  buildCliBridgeAwayNoticeCard,
  buildCliBridgeQuestionCard,
  buildCliBridgeTaskCompletionCard,
  cliBridgeSettingsSection,
  CLI,
} from '../src/cli-bridge/cards';
import type { CliHookStatus } from '../src/cli-bridge/types';

function values(node: unknown, acc: string[] = []): string[] {
  if (Array.isArray(node)) node.forEach((n) => values(n, acc));
  else if (node && typeof node === 'object') {
    const o = node as Record<string, unknown>;
    const behaviors = o.behaviors;
    if (Array.isArray(behaviors)) {
      for (const b of behaviors) {
        const v = (b as { value?: { a?: string } }).value;
        if (v?.a) acc.push(v.a);
      }
    }
    for (const k of Object.keys(o)) values(o[k], acc);
  }
  return acc;
}

describe('cli bridge cards', () => {
  const statuses: Record<'claude' | 'codex', CliHookStatus> = {
    claude: { agent: 'claude', status: 'installed', details: [] },
    codex: { agent: 'codex', status: 'conflict_agent2lark', details: ['old hook'] },
  };

  it('renders compact settings controls', () => {
    const section = cliBridgeSettingsSection({
      enabled: true,
      statuses,
      canEnable: { ok: true },
      notifyScope: 'all',
      agents: { claude: true, codex: true },
      keepAwake: true,
    });
    const json = JSON.stringify(section);
    expect(json).toContain('☕ 咖啡一下'); // recognizable feature name
    expect(json).toContain('咖啡一下：开'); // master toggle label
    // away copy now names lock as an instant-away signal
    expect(json).toContain('锁屏');
    expect(json).not.toContain('默认：仅当 Mac 空闲超过一段时间时转发');
    expect(json).toContain('与 agent2lark 冲突');
    // conflict present → warn that 修复 will overwrite agent2lark's hooks
    expect(json).toContain('会用本 bridge 覆盖它');
    // hooks are machine-global; surfaced so multi-bot users know it won't double-install
    expect(json).toContain('修复不会重复安装');
    expect(json).not.toContain('转发模式');
    expect(json).not.toContain('包含群聊会话用于调试');
    expect(values(section)).not.toContain(CLI.setDelivery);
    expect(values(section)).not.toContain(CLI.toggleIncludeBridge);
    expect(values(section)).toContain(CLI.repairHooks);
    // the three new axes each render their controls
    expect(json).toContain('📣 通知范围');
    expect(json).toContain('🤖 转发哪些后端');
    expect(json).toContain('🔋 离开保活');
    expect(values(section)).toContain(CLI.setNotifyScope);
    expect(values(section)).toContain(CLI.toggleAgent);
    expect(values(section)).toContain(CLI.toggleKeepAwake);
  });

  it('highlights the active notify scope and reflects per-agent / keep-awake state', () => {
    const section = cliBridgeSettingsSection({
      enabled: true,
      statuses,
      canEnable: { ok: true },
      notifyScope: 'bound_projects',
      agents: { claude: true, codex: false },
      keepAwake: false,
    });
    const json = JSON.stringify(section);
    expect(json).toContain('仅绑定项目');
    expect(json).toContain('Claude Code：开');
    expect(json).toContain('Codex：关');
    expect(json).toContain('离开保活：关');
    expect(values(section)).toContain(CLI.toggleAgent);
  });

  it('omits the agent2lark overwrite warning when there is no conflict', () => {
    const section = cliBridgeSettingsSection({
      enabled: true,
      statuses: {
        claude: { agent: 'claude', status: 'installed', details: [] },
        codex: { agent: 'codex', status: 'not_installed', details: [] },
      },
      canEnable: { ok: true },
      notifyScope: 'all',
      agents: { claude: true, codex: true },
      keepAwake: true,
    });
    expect(JSON.stringify(section)).not.toContain('会用本 bridge 覆盖它');
  });

  it('renders the away heads-up card (brand, agent, full cwd — the only card with cwd)', () => {
    const json = JSON.stringify(buildCliBridgeAwayNoticeCard({ source: 'claude', cwd: '/repo/x' }));
    expect(json).toContain('Vonvon Bridge');
    expect(json).toContain('当前项目'); // cwd section, unique to the away card
    expect(json).toContain('Claude Code');
    expect(json).toContain('/repo/x');
    // purely informational — carries no action callbacks
    expect(values(buildCliBridgeAwayNoticeCard({ source: 'codex', cwd: '/repo' }))).toHaveLength(0);
  });

  it('renders approval, question, and completion actions', () => {
    const approval = buildCliBridgeApprovalCard({
      id: 'p1',
      source: 'codex',
      cwd: '/repo',
      toolName: 'Bash',
      command: 'git status',
      hookEventName: 'PermissionRequest',
      sessionId: 'session-1',
    });
    const approvalJson = JSON.stringify(approval);
    expect(approvalJson).toContain('Vonvon Bridge');
    expect(approvalJson).toContain('Bash'); // tool chip in the meta line
    expect(approvalJson).toContain('💻 **命令**');
    expect(approvalJson).toContain('git status');
    expect(approvalJson).not.toContain('工作目录'); // cwd dropped on non-away cards
    expect(values(approval)).toEqual([
      CLI.approveOnce,
      CLI.approveSession,
      CLI.deny,
    ]);

    const question = buildCliBridgeQuestionCard({
      id: 'q1',
      source: 'claude',
      cwd: '/repo',
      questions: [{ question: 'Pick?', header: 'Choice', multiSelect: false, options: [{ label: 'A', description: 'Alpha' }, { label: 'B' }] }],
      hookEventName: 'PermissionRequest',
    });
    const questionJson = JSON.stringify(question);
    expect(questionJson).toContain('Vonvon Bridge');
    expect(questionJson).toContain('Pick?');
    expect(questionJson).toContain('select_static'); // single-select → dropdown
    expect(questionJson).toContain('A — Alpha'); // option label carries a short description
    expect(questionJson).toContain('都不合适'); // always-visible custom free-text box
    // one atomic form submit — no per-option / per-custom buttons that lock the card
    expect(values(question)).toEqual([CLI.questionSubmit]);

    const completion = buildCliBridgeTaskCompletionCard({
      id: 't1',
      source: 'codex',
      cwd: '/repo',
      sessionId: 'session-stop',
      hookEventName: 'Stop',
      status: 'completed',
      summary: 'done',
      replyEnabled: true,
      replyExpiresAt: new Date('2026-06-12T11:02:00+08:00').getTime(),
    });
    const completionJson = JSON.stringify(completion);
    expect(completionJson).toContain('Vonvon Bridge');
    expect(completionJson).toContain('等待确认');
    expect(completionJson).toContain('📝 **Agent 输出**');
    expect(completionJson).toContain('有效期至');
    expect(values(completion)).toContain(CLI.taskCompletionDone);
  });

  it('renders resolved local-agent cards without live actions', () => {
    const approved = buildCliBridgeApprovalCard({
      id: 'p3',
      source: 'codex',
      cwd: '/repo',
      toolName: 'Bash',
      command: 'git status',
      status: 'approved',
      sessionId: 's',
    });
    expect(JSON.stringify(approved)).toContain('✅ 已允许');
    expect(values(approved)).toEqual([]);

    const selected = buildCliBridgeQuestionCard({
      id: 'q3',
      source: 'claude',
      cwd: '/repo',
      questions: [{ question: 'Pick?', header: 'Choice', multiSelect: false, options: [{ label: 'A' }, { label: 'B' }] }],
      status: 'approved',
      answers: { 'Pick?': 'A' },
    });
    expect(JSON.stringify(selected)).toContain('✅ 已回答');
    expect(JSON.stringify(selected)).toContain('A'); // the chosen answer is shown
    expect(values(selected)).toEqual([]); // resolved view carries no live actions

    const done = buildCliBridgeTaskCompletionCard({
      id: 't3',
      source: 'claude',
      cwd: '/repo',
      status: 'completed',
      summary: 'done',
      replyEnabled: false,
      replyDoneAt: new Date('2026-06-12T10:55:00+08:00').getTime(),
    });
    expect(JSON.stringify(done)).toContain('✅ 已确认完成');
    expect(JSON.stringify(done)).toContain('✅ 已完成');
    expect(values(done)).toEqual([]);
  });

  it('renders a multi-question form with single + multi-select dropdowns and per-question custom fields', () => {
    const card = buildCliBridgeQuestionCard({
      id: 'mq',
      source: 'claude',
      cwd: '/repo',
      questions: [
        { question: 'Deploy where?', header: 'Env', multiSelect: false, options: [{ label: 'staging' }, { label: 'prod' }] },
        { question: 'Which checks?', header: 'Checks', multiSelect: true, options: [{ label: 'lint' }, { label: 'test' }] },
      ],
    });
    const json = JSON.stringify(card);
    // questions are numbered only when there is more than one
    expect(json).toContain('1. Env');
    expect(json).toContain('2. Checks');
    expect(json).toContain('select_static'); // single-select → dropdown
    expect(json).toContain('multi_select_static'); // multi-select → multi dropdown
    expect(json).toContain('可多选');
    // every question carries its own always-visible custom free-text box
    expect(json).toContain('q0_custom');
    expect(json).toContain('q1_custom');
    // still exactly one atomic submit for the whole form
    expect(values(card)).toEqual([CLI.questionSubmit]);
  });

  it('hides session approval when allow-cache is disabled', () => {
    expect(values(buildCliBridgeApprovalCard({
      id: 'p2',
      source: 'codex',
      cwd: '/repo',
      toolName: 'Bash',
      allowSession: false,
    }))).toEqual([
      CLI.approveOnce,
      CLI.deny,
    ]);
  });

  it('caps an oversized final answer so the card stays within Feishu limits', () => {
    const huge = 'x'.repeat(50_000);
    const json = JSON.stringify(buildCliBridgeTaskCompletionCard({ id: 't2', source: 'claude', cwd: '/repo', status: 'completed', summary: huge, replyEnabled: true }));
    expect(json.length).toBeLessThan(10_000);
    expect(json).toContain('truncated');
  });

  it('inlines the local agents section into the global settings card (no sub-page)', async () => {
    const { buildSettingsCard } = await import('../src/card/dm-cards');
    const { cliBridgeSettingsSection } = await import('../src/cli-bridge/cards');
    const section = cliBridgeSettingsSection({
      enabled: true,
      statuses,
      canEnable: { ok: true },
      notifyScope: 'all',
      agents: { claude: true, codex: true },
      keepAwake: true,
    });
    const json = JSON.stringify(buildSettingsCard({
      accounts: { app: { id: 'app', secret: 'secret', tenant: 'feishu' } },
      preferences: { access: { ownerOpenId: 'ou_owner' } },
    }, section));
    // One card: the global settings header plus the inlined 咖啡一下 controls.
    expect(json).toContain('全局设置');
    expect(json).toContain('☕ 咖啡一下');
    expect(json).toContain('咖啡一下：开');
  });
});
