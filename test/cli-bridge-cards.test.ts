import { describe, expect, it } from 'vitest';
import {
  buildCliBridgeApprovalCard,
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
    });
    const json = JSON.stringify(section);
    expect(json).toContain('飞书接管本地 agent');
    expect(json).toContain('默认：仅当 Mac 空闲超过一段时间时转发');
    expect(json).not.toContain('锁屏或空闲');
    expect(json).toContain('与 agent2lark 冲突');
    // conflict present → warn that 修复 will overwrite agent2lark's hooks
    expect(json).toContain('会用本 bridge 覆盖它');
    expect(json).not.toContain('转发模式');
    expect(json).not.toContain('始终');
    expect(json).not.toContain('包含群聊会话用于调试');
    expect(values(section)).not.toContain(CLI.setDelivery);
    expect(values(section)).not.toContain(CLI.toggleIncludeBridge);
    expect(values(section)).toContain(CLI.repairHooks);
  });

  it('omits the agent2lark overwrite warning when there is no conflict', () => {
    const section = cliBridgeSettingsSection({
      enabled: true,
      statuses: {
        claude: { agent: 'claude', status: 'installed', details: [] },
        codex: { agent: 'codex', status: 'not_installed', details: [] },
      },
      canEnable: { ok: true },
    });
    expect(JSON.stringify(section)).not.toContain('会用本 bridge 覆盖它');
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
      createdAt: new Date('2026-06-12T10:50:00+08:00').getTime(),
    });
    const approvalJson = JSON.stringify(approval);
    expect(approvalJson).toContain('🔐 **等待审批**');
    expect(approvalJson).toContain('🛠️ **Bash**');
    expect(approvalJson).toContain('🔗 PermissionRequest');
    expect(approvalJson).toContain('💻 **命令**');
    expect(approvalJson).toContain('📁 **工作目录**');
    expect(approvalJson).toContain('Session ID: session-1');
    expect(values(approval)).toEqual([
      CLI.approveOnce,
      CLI.approveSession,
      CLI.deny,
    ]);

    const question = buildCliBridgeQuestionCard({
      id: 'q1',
      source: 'claude',
      cwd: '/repo',
      question: 'Pick?',
      options: [{ label: 'A', description: 'Alpha' }, { label: 'B' }],
      hookEventName: 'PermissionRequest',
      createdAt: new Date('2026-06-12T10:51:00+08:00').getTime(),
    });
    const questionJson = JSON.stringify(question);
    expect(questionJson).toContain('🧭 **等待选择**');
    expect(questionJson).toContain('❓ **AskUserQuestion**');
    expect(questionJson).toContain('🧩 **问题**');
    expect(questionJson).toContain('🗂️ **可选项**');
    expect(questionJson).toContain('1. A');
    expect(questionJson).toContain('Alpha');

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
      createdAt: new Date('2026-06-12T10:52:00+08:00').getTime(),
    });
    const completionJson = JSON.stringify(completion);
    expect(completionJson).toContain('⏳ **等待确认**');
    expect(completionJson).toContain('🏁 **Stop**');
    expect(completionJson).toContain('Session: session-stop');
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
    expect(JSON.stringify(approved)).toContain('✅ **已允许**');
    expect(values(approved)).toEqual([]);

    const selected = buildCliBridgeQuestionCard({
      id: 'q3',
      source: 'claude',
      cwd: '/repo',
      question: 'Pick?',
      options: [{ label: 'A' }],
      status: 'approved',
      selectedOptionLabel: 'A',
    });
    expect(JSON.stringify(selected)).toContain('✅ **已选择**');
    expect(JSON.stringify(selected)).toContain('已选择：A');
    expect(values(selected)).toEqual([]);

    const done = buildCliBridgeTaskCompletionCard({
      id: 't3',
      source: 'claude',
      cwd: '/repo',
      status: 'completed',
      summary: 'done',
      replyEnabled: false,
      replyDoneAt: new Date('2026-06-12T10:55:00+08:00').getTime(),
    });
    expect(JSON.stringify(done)).toContain('✅ **已确认完成**');
    expect(JSON.stringify(done)).toContain('✅ 已完成');
    expect(values(done)).toEqual([]);
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
    });
    const json = JSON.stringify(buildSettingsCard({
      accounts: { app: { id: 'app', secret: 'secret', tenant: 'feishu' } },
      preferences: { access: { ownerOpenId: 'ou_owner' } },
    }, section));
    // One card: the global settings header plus the inlined local-agents controls.
    expect(json).toContain('全局设置');
    expect(json).toContain('🖥️ 本地 agent');
    expect(json).toContain('飞书接管本地 agent');
  });
});
