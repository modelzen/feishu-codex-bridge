import { describe, expect, it } from 'vitest';
import {
  buildNewProjectDoneCard,
  buildNewProjectFormCard,
  buildProjectSettingsCard,
  type BackendProbeRow,
} from '../src/card/dm-cards';
import { probeBackends, validateBackendSwitch } from '../src/bot/handle-message';
import { createBackend } from '../src/agent';
import type { BackendProbe } from '../src/agent/types';


describe('probeBackends（并行 doctor + 单个超时兜底）', () => {
  const fast = (id: string, probe: BackendProbe) => ({
    id,
    displayName: id.toUpperCase(),
    supportedModes: undefined,
    doctor: async () => probe,
  });

  it('并行探测：每后端各成一行，带 id/displayName/supportedModes/probe，且 doctor 走 force（绕过缓存）', async () => {
    let seenForce: boolean | undefined;
    const be = {
      id: 'a',
      displayName: 'A',
      supportedModes: ['full'] as const,
      doctor: async (o?: { force?: boolean }) => {
        seenForce = o?.force;
        return { ok: true, version: '1.0' } satisfies BackendProbe;
      },
    };
    const rows = await probeBackends([be], 1000);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'a', name: 'A', probe: { ok: true, version: '1.0' } });
    expect(rows[0]!.supportedModes).toEqual(['full']);
    expect(seenForce).toBe(true);
  });

  it('单个后端卡死 → 超时兜底归一成 probe undefined（按不可用渲染），不拖垮同批其他后端', async () => {
    const hang = { id: 'h', displayName: 'H', supportedModes: undefined, doctor: () => new Promise<BackendProbe>(() => {}) };
    const rows = await probeBackends([hang, fast('ok', { ok: true, version: '2' })], 50);
    expect(rows[0]!.probe).toBeUndefined();
    expect(rows[1]!.probe).toEqual({ ok: true, version: '2' });
  });

  it('doctor 抛错同样归一成 probe undefined，绝不放行', async () => {
    const boom = {
      id: 'b',
      displayName: 'B',
      supportedModes: undefined,
      doctor: async (): Promise<BackendProbe> => {
        throw new Error('spawn ENOENT');
      },
    };
    const rows = await probeBackends([boom], 1000);
    expect(rows[0]!.probe).toBeUndefined();
  });
});

describe('buildProjectSettingsCard 的 🧠 后端区块', () => {
  const base = { name: 'P', cwd: '/x', kind: 'multi' as const, origin: 'created' as const };

  it('只读显示当前后端（缺省 = codex-appserver）+ 创建时锁定，不再有切换按钮', () => {
    const json = JSON.stringify(buildProjectSettingsCard(base));
    expect(json).toContain('🧠 后端');
    expect(json).toContain('codex-appserver'); // 缺省回退到默认 id
    expect(json).toContain('新建项目时选定'); // 锁定文案
    // 去切换：后端区块不再有「打开后端选择卡」的按钮（旧 dm.proj.backend 入口已删）
    expect(json).not.toContain('dm.proj.backend');
  });

  it('调用方传入展示名时优先用展示名', () => {
    const json = JSON.stringify(
      buildProjectSettingsCard({ ...base, backend: 'codex-appserver' }, 'Codex (app-server)'),
    );
    expect(json).toContain('Codex (app-server)');
  });

  it('notice 提示行渲染在卡顶（切换成功后的「✅ 已切到 xxx · 新话题生效」留痕）', () => {
    const card = buildProjectSettingsCard(base, 'Codex (app-server)', '✅ 已切到 **Codex (app-server)** · 新话题生效');
    const first = JSON.stringify((card.body as { elements: unknown[] }).elements[0]);
    expect(first).toContain('已切到');
    expect(first).toContain('新话题生效');
  });
});

describe('buildNewProjectFormCard 的后端选择（创建时选定）', () => {
  // codex-only 现实：「可选后端」只有 codex 一个。下面单后端用例即默认主路径。
  const codexOnly = [{ label: 'Codex App Server', value: 'codex-appserver' }];

  it('仅一个可选后端（codex）→ 不出下拉，改静态文案显示默认后端名（默认主路径）', () => {
    const json = JSON.stringify(buildNewProjectFormCard({ backends: codexOnly }));
    expect(json).not.toContain('select_static');
    expect(json).toContain('Codex App Server');
    expect(json).toContain('基础信息');
    expect(json).toContain('项目配置');
    expect(json).toContain('会话方式');
    expect(json).toContain('创建多话题项目');
    expect(json).toContain('创建单会话项目');
  });

  it('多个可选后端 → 渲染 select_static 下拉（name=backend，预选第一个 codex）+ 固定文案', () => {
    // 渲染分支保留（backends.length > 1 走下拉），用一个泛化第二项触发，不引用已删后端。
    const multi = [...codexOnly, { label: '其它后端', value: 'other-backend' }];
    const json = JSON.stringify(buildNewProjectFormCard({ backends: multi }));
    expect(json).toContain('select_static');
    expect(json).toContain('other-backend');
    expect(json).toContain('固定不可切换');
    // 预选第一个（codex）
    expect(json).toContain('"initial_option":"codex-appserver"');
  });

  it('创建失败后的新卡保留用户选中的 Agent', () => {
    const multi = [...codexOnly, { label: '其它后端', value: 'other-backend' }];
    const json = JSON.stringify(buildNewProjectFormCard({
      backend: 'other-backend',
      backends: multi,
      error: '目录不存在',
    }));
    expect(json).toContain('"initial_option":"other-backend"');
  });

  it('未传 backends → 不渲染后端选择块（向后兼容）', () => {
    const json = JSON.stringify(buildNewProjectFormCard({}));
    expect(json).not.toContain('select_static');
    expect(json).not.toContain('后端 Agent');
  });

  it('完成卡显示选定后端（按 id 解析展示名；缺省回退默认 codex 名）', () => {
    const done = JSON.stringify(
      buildNewProjectDoneCard({ name: 'P', cwd: '/x', kind: 'multi', origin: 'created', backend: 'codex-appserver' } as never),
    );
    expect(done).toContain('🧠');
    expect(done).toContain('Codex'); // codex-appserver 的展示名 = Codex
  });
});

describe('validateBackendSwitch（切换校验的纯函数）', () => {
  const ok: BackendProbe = { ok: true, version: '1.0' };
  // 纯函数：registered/supportedModes 都是入参，不读真注册表。codex-only 现实下真注册表
  // 只有 codex-appserver；这里额外塞一个泛化 'full-only' 占位 id 以保住「仅支持 full」分支的覆盖
  // （不引用任何已删后端）。
  const registered = ['codex-appserver', 'full-only'];

  it('注册表里没有的 id 拒绝，并列出可用后端', () => {
    const reason = validateBackendSwitch({ target: 'no-such', registered, project: {}, probe: ok });
    expect(reason).toContain('未知后端');
    expect(reason).toContain('codex-appserver');
  });

  it('doctor 探测不通过拒绝，并把 hint（装法/登录提示）带给用户', () => {
    const reason = validateBackendSwitch({
      target: 'codex-appserver',
      registered,
      project: {},
      probe: { ok: false, version: null, hint: '未找到 codex CLI' },
    });
    expect(reason).toContain('不可用');
    expect(reason).toContain('未找到 codex CLI');
  });

  it('探测没跑成（probe undefined）按不可用拒绝，绝不放行', () => {
    expect(validateBackendSwitch({ target: 'codex-appserver', registered, project: {} })).toContain('不可用');
  });

  it('目标后端仅支持 full 时：项目任一档不是 full 都拒绝并说明（含 guestMode 分档）', () => {
    const supportedModes = ['full'] as const;
    // 管理员档非 full
    expect(
      validateBackendSwitch({ target: 'full-only', registered, project: { mode: 'qa' }, supportedModes, probe: ok }),
    ).toContain('仅支持');
    // 管理员档 full 但普通用户档 qa —— guest 档也必须被支持
    const reason = validateBackendSwitch({
      target: 'full-only',
      registered,
      project: { mode: 'full', guestMode: 'qa' },
      supportedModes,
      probe: ok,
    });
    expect(reason).toContain('完全访问');
    expect(reason).toContain('🔐 权限');
  });

  it('全过返回 null：注册 + 探活 + 档位支持（缺省档 = full 视为 full）', () => {
    expect(
      validateBackendSwitch({
        target: 'full-only',
        registered,
        project: {}, // 旧数据缺省 → effectiveMode 'full'
        supportedModes: ['full'],
        probe: ok,
      }),
    ).toBeNull();
  });

  it('supportedModes 未声明（codex）⇒ 任意档位放行', () => {
    expect(
      validateBackendSwitch({
        target: 'codex-appserver',
        registered,
        project: { mode: 'qa', guestMode: 'write' },
        probe: ok,
      }),
    ).toBeNull();
  });

  it('codex-appserver 后端实例 supportedModes 未声明（全档）—— 切换 UI 提前拦截与硬守卫同源', () => {
    expect(createBackend('codex-appserver').supportedModes).toBeUndefined();
  });
});
