import { DEFAULT_BACKEND_ID, type PermissionMode } from './types';
import {
  DSH_BIN_NAME,
  DSH_INSTALL_SPECS,
  DSH_MAIN_PACKAGE,
  DSH_VERSION,
} from './dsh/constants';

/**
 * 后端 catalog —— 后端的「元数据 + 管理面驱动」单一真源（依赖类型/体积/检测/安装/
 * 分组/文案）。运行时工厂表（REGISTRY，见 index.ts）只负责构造能跑的实例；catalog
 * 负责「Web / DM 怎么展示、怎么装、怎么探」。两者职责正交、不合并、靠 id 配对
 * （单测强制 catalog.id 集合 == REGISTRY id 集合，新后端漏一处即红——防回归）。
 *
 * 「加一个新 agent CLI 后端」= 实现 AgentBackend + REGISTRY 加工厂 + 这里加一条
 * catalog（设计 §3.5）。Web 后端页 / DM picker / doctor / 按需下载按钮全自动出现。
 */

/** 底层 agent 家族（picker 按此分组；当前仅 Codex 组；string 为未来 agent 预留）。 */
export type AgentFamily = 'codex' | 'claude' | (string & {});

/** 后端进程的接入方式（仅描述/分组用，不参与运行路由）。 */
export type BackendAccess = 'app-server' | 'sdk' | 'acp' | 'jsonrpc';

/**
 * 依赖类型 —— 决定「装哪 / 怎么检测 / 能不能一键按需装」。
 *   'external-cli'  外部 CLI（codex / 未来 gemini-cli），bridge 不负责装，doctor 探 PATH。
 *   'npm-ondemand'  npm 包，按需装到用户私装目录（库类 / bin 类两形态）。
 *                   **唯一可一键下载的类型。** 库类（无 binName）走 import + require.resolve；
 *                   bin 类（有 binName）被 spawn、走 node_modules/.bin 路径（见 backend-loader）。
 *                   当前内置后端均非此类（codex 是 external-cli），保留以备将来挂新后端。
 *   'npm-external'  外部 npm 包，用户自管（当前内置后端无此类，保留给未来不便按需装的包）。
 */
export type DepKind = 'external-cli' | 'npm-ondemand' | 'npm-external';

export interface BackendDep {
  kind: DepKind;
  /** npm 包名（npm-ondemand / npm-external 时）。 */
  pkg?: string;
  /**
   * 该包作为「被 spawn 的可执行文件」消费时的 bin 名（npm 装包生成 node_modules/.bin/<binName>）。
   * 有此字段 ⇒ bin 类后端：已装判定/命令解析走 .bin 路径而非 require.resolve
   *   （bin-only 包通常无 main 入口，resolve 必失败）。
   * 无此字段 ⇒ 库类后端：走 import() + require.resolve。
   */
  binName?: string;
  /** pin 版本（npm-ondemand，避免漂移）；undefined ⇒ latest。 */
  version?: string;
  /**
   * 一个后端需要原子安装的完整 npm 包集合（每项可带精确版本）。未声明时沿用
   * `pkg` + `version` 的单包行为；声明时 `pkg` 仍是版本展示与安装态判断的主包。
   */
  installSpecs?: readonly string[];
  /** 体积提示 MB（Web 下载确认用，给用户预期）。 */
  approxSizeMB?: number;
  /** 检测/装法的一句话提示（external-cli 探不到、npm-external 未装时给用户）。 */
  detectHint: string;
  /** 安装命令的一句话说明（installable=false 的手动装法 / installable=true 的旁注）。 */
  installCmd?: string;
}

export interface BackendCatalogEntry {
  /** 与 REGISTRY id 一一对应（单测强制配对）。 */
  id: string;
  agentFamily: AgentFamily;
  displayName: string;
  access: BackendAccess;
  dep: BackendDep;
  /** 本后端支持的权限档（= backend.supportedModes）；undefined ⇒ 全档（codex）。 */
  supportedModes?: readonly PermissionMode[];
  /** picker 副标题（一句话接入说明）。 */
  blurb?: string;
  /**
   * 「用户不可见」闸（通用机制：把尚未就绪的后端先对用户全隐藏；当前无隐藏后端，
   * 保留以备将来挂新后端）。
   * true ⇒ 不进任何**用户可见面**：Feishu 新建/绑定卡的后端选择器、Web 后端页、
   *        宿主机体检页、智能默认后端的候选集。但**仍保留在 catalog/REGISTRY**
   *        （catalogBackendIds 仍含它 → 与 REGISTRY 的配对单测不破；代码在仓、
   *        只是无入口可达）。要点亮：把对应条目的 `hidden: true` 删掉即可，零返工。
   * 设计：曝光过滤集中在 {@link projectCreatableBackends} / pickDefaultBackend(detect.ts) /
   *      listBackendCatalog(admin/service.ts) / doctorBackends(admin/host.ts) 四处。
   */
  hidden?: boolean;
}

/**
 * 一条 catalog 是否可一键按需下载：npm-ondemand 才可（external-cli / npm-external
 * 要用户手动装）。Web 据此决定「未安装」时出「下载」按钮还是「手动装法提示」。
 */
export function isInstallable(entry: BackendCatalogEntry): boolean {
  return entry.dep.kind === 'npm-ondemand';
}

export const BACKEND_CATALOG: readonly BackendCatalogEntry[] = [
  {
    id: 'codex-appserver',
    agentFamily: 'codex',
    displayName: 'Codex',
    access: 'app-server',
    dep: {
      kind: 'external-cli',
      pkg: 'codex',
      detectHint: '未找到 codex CLI（设 CODEX_BIN、装 Codex.app，或 npm i -g @openai/codex）',
      installCmd: 'npm i -g @openai/codex（或装 Codex.app / 设 CODEX_BIN），然后 codex login',
    },
    // supportedModes undefined ⇒ 全档（qa/write/full）。
    blurb: '能力最全（goal/steer/compact/resume + 真沙箱只读档）',
  },
  {
    id: 'claude-agent',
    agentFamily: 'claude',
    displayName: 'Claude',
    access: 'sdk',
    dep: {
      // SDK 是桥的硬依赖（随桥内置），isBackendDepInstalled 路径①经 bridge 自身
      // node_modules 的 require.resolve 恒命中 → 在 picker 里始终判为「已装」可选。
      kind: 'npm-ondemand',
      pkg: '@anthropic-ai/claude-agent-sdk',
      // 实测 SDK + 依赖装到用户目录约 265MB（含自带 Claude Code 运行时）；首次下载较久。
      approxSizeMB: 265,
      detectHint: '按需下载 @anthropic-ai/claude-agent-sdk（约 265MB，复用本机 Claude 登录态）',
      installCmd: '随桥已内置（如缺失：npm i @anthropic-ai/claude-agent-sdk）',
    },
    // 必须与 ClaudeAgentBackend.supportedModes 完全一致（单测强制）。
    supportedModes: ['qa', 'write', 'full'],
    blurb: 'Claude Code（SDK 内置，复用本机登录；qa/write 走 OS 沙箱，能力较 Codex 精简）',
  },
  {
    id: 'dsh-sdk',
    agentFamily: 'dsh',
    displayName: 'DeepSeek Harness',
    access: 'jsonrpc',
    dep: {
      kind: 'npm-ondemand',
      pkg: DSH_MAIN_PACKAGE,
      binName: DSH_BIN_NAME,
      version: DSH_VERSION,
      installSpecs: DSH_INSTALL_SPECS,
      approxSizeMB: 285,
      detectHint: `按需下载 DSH ${DSH_VERSION} 运行包（约 285MB）`,
      installCmd: `由 Bridge 私装精确版本 ${DSH_VERSION}（零 sudo）`,
    },
    supportedModes: ['full'],
    blurb: '实验性多模型 DSH JSON-RPC 后端（仅 full；使用各 provider API key）',
  },
];

/**
 * 用户可见的后端 catalog（滤掉 {@link BackendCatalogEntry.hidden}）——Web 后端页 /
 * 宿主机体检页等「用户可见面」的列举从此取，而非裸 BACKEND_CATALOG。catalogBackendIds /
 * REGISTRY 配对仍走全量（hidden 只挡曝光、不退注册）。
 */
export function visibleCatalog(): BackendCatalogEntry[] {
  return BACKEND_CATALOG.filter((e) => !e.hidden);
}

/** 按 id 取一条 catalog（未注册返回 undefined）。 */
export function catalogById(id: string): BackendCatalogEntry | undefined {
  return BACKEND_CATALOG.find((e) => e.id === id);
}

/** 按 agent 家族取 catalog（picker 分组用）。 */
export function catalogByFamily(family: AgentFamily): BackendCatalogEntry[] {
  return BACKEND_CATALOG.filter((e) => e.agentFamily === family);
}

/** catalog 声明的全部后端 id（index.ts 的 backendIds 从此派生 → catalog 是单一注册入口）。 */
export function catalogBackendIds(): string[] {
  return BACKEND_CATALOG.map((e) => e.id);
}

/**
 * 新建项目时「可选后端」（飞书新建/绑定卡的后端下拉数据源）。规则（产品定）：
 *   ① codex（DEFAULT_BACKEND_ID）始终可选 —— 它是 external-cli 基线（全局 codex / Codex.app），
 *      isBackendEntryInstalled 对 external-cli 恒 false，但作为默认后端必须始终能选；
 *   ② 其余后端「已下载」才列（isInstalled 注入，本模块不碰文件系统、便于单测）；
 *   ③ 再按项目权限档过滤：后端 supportedModes 不含该档则剔除（仅支持部分档的后端，
 *      在不支持的档下自然不出现）。
 * 卡片里下不了后端 → 未下载的直接不显示，引导去 Web「后端 Agent」页下载。
 */
export function projectCreatableBackends(
  mode: PermissionMode,
  isInstalled: (entry: BackendCatalogEntry) => boolean,
): BackendCatalogEntry[] {
  return BACKEND_CATALOG.filter((e) => {
    if (e.hidden) return false; // 用户不可见闸：隐藏后端不进 picker
    const installed = e.id === DEFAULT_BACKEND_ID || isInstalled(e);
    if (!installed) return false;
    if (e.supportedModes && !e.supportedModes.includes(mode)) return false;
    return true;
  });
}
