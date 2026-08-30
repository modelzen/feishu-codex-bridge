import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { paths } from '../../config/paths';
import type {
  AgentBackend,
  AgentCapabilities,
  AgentThread,
  BackendProbe,
  ModelInfo,
  PermissionMode,
  ResumeThreadOptions,
  StartThreadOptions,
  ThreadHistory,
  ThreadSummary,
} from '../types';
import { BRIDGE_DEVELOPER_INSTRUCTIONS } from '../bridge-instructions';
import { backendsBinPath, installedBackendVersion } from '../backend-loader';
import { DSH_BIN_NAME, DSH_MAIN_PACKAGE, DSH_VERSION } from './constants';
import { DSH_MODELS, resolveDshModel } from './models';
import { ensureDshProfile } from './profile';
import { DshThread } from './thread';

export interface DshBackendDeps {
  locateBin?: () => string | null;
  installedVersion?: (pkg: string) => string | null;
  ensureProfile?: () => Promise<string>;
  sessionsDir?: () => string;
  runtimeArgs?: (profileFile: string) => readonly string[];
  runtimeEnv?: NodeJS.ProcessEnv;
}

interface LaunchConfig {
  command: string;
  args: readonly string[];
  profileFile: string;
  sessionsDir: string;
  model: string;
  effort: NonNullable<StartThreadOptions['effort']>;
}

/** Experimental DeepSeek Harness backend over its official stdio JSON-RPC runtime. */
export class DshBackend implements AgentBackend {
  readonly id = 'dsh-sdk';
  readonly displayName = 'DeepSeek Harness';
  readonly supportedModes: readonly PermissionMode[] = ['full'];
  readonly capabilities: AgentCapabilities = {
    goal: false,
    steer: false,
    compact: false,
    // Bridge restart recovery still uses resumeThread internally. This flag only
    // hides the user-facing history picker because v1 does not parse DSH JSONL.
    resume: false,
    approvals: false,
  };

  constructor(private readonly deps: DshBackendDeps = {}) {}

  async isAvailable(): Promise<boolean> {
    return (await this.doctor()).ok;
  }

  async doctor(): Promise<BackendProbe> {
    try {
      const version = this.version();
      const bin = this.bin();
      if (!bin || version !== DSH_VERSION) {
        return {
          ok: false,
          version,
          location: bin ?? undefined,
          installable: true,
          depState: 'not-installed',
          hint: version && version !== DSH_VERSION
            ? `DSH 版本为 ${version}，需要修复为 ${DSH_VERSION}`
            : '点「下载」安装实验性 DSH 后端（约 285MB，零 sudo）',
        };
      }
      await this.profile();
      return {
        ok: true,
        version,
        location: bin,
        depState: 'installed',
        hint: '从本机环境或 $DSH_HOME/.credentials.yaml 读取 provider 凭据',
      };
    } catch (error) {
      return {
        ok: false,
        version: this.version(),
        location: this.bin() ?? undefined,
        installable: true,
        depState: 'not-installed',
        hint: `DSH 配置检查失败：${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    return DSH_MODELS.map((model) => ({
      ...model,
      supportedEfforts: [...model.supportedEfforts],
    }));
  }

  async listThreads(_cwd: string, _limit?: number): Promise<ThreadSummary[]> {
    return [];
  }

  async readHistory(
    _cwd: string,
    _sessionId: string,
    _maxTurns?: number,
  ): Promise<ThreadHistory> {
    return { turns: [], totalTurns: 0 };
  }

  async startThread(opts: StartThreadOptions): Promise<AgentThread> {
    const launch = await this.prepareLaunch(opts);
    return this.thread(randomUUID(), opts.cwd, launch);
  }

  async resumeThread(opts: ResumeThreadOptions): Promise<AgentThread> {
    if (!opts.sessionId.trim()) throw new Error('DSH sessionId 不能为空');
    const launch = await this.prepareLaunch(opts);
    return this.thread(opts.sessionId, opts.cwd, launch);
  }

  private async prepareLaunch(opts: StartThreadOptions): Promise<LaunchConfig> {
    if ((opts.mode ?? 'full') !== 'full') {
      throw new Error('DSH 后端当前仅支持 full（完全访问），不会静默提升 qa/write 权限');
    }
    const selected = resolveDshModel(opts.model, opts.effort);
    const version = this.version();
    const command = this.bin();
    if (!command || version !== DSH_VERSION) {
      throw new Error(`DSH 后端未就绪，请在后端管理中安装或修复到 ${DSH_VERSION}`);
    }
    const profileFile = await this.profile();
    const sessionsDir = this.sessionsDir();
    await mkdir(sessionsDir, { recursive: true });
    return {
      command,
      args: (this.deps.runtimeArgs ?? ((file: string) => [file]))(profileFile),
      profileFile,
      sessionsDir,
      model: selected.info.id,
      effort: selected.effort,
    };
  }

  private thread(sessionId: string, cwd: string, launch: LaunchConfig): DshThread {
    return new DshThread({
      sessionId,
      cwd,
      model: launch.model,
      effort: launch.effort,
      command: launch.command,
      args: launch.args,
      profileFile: launch.profileFile,
      sessionsDir: launch.sessionsDir,
      runtimeEnv: this.deps.runtimeEnv,
      systemPrompt: BRIDGE_DEVELOPER_INSTRUCTIONS,
    });
  }

  private bin(): string | null {
    return (this.deps.locateBin ?? (() => backendsBinPath(DSH_BIN_NAME)))();
  }

  private version(): string | null {
    return (this.deps.installedVersion ?? installedBackendVersion)(DSH_MAIN_PACKAGE);
  }

  private profile(): Promise<string> {
    return (this.deps.ensureProfile ?? (() => ensureDshProfile()))();
  }

  private sessionsDir(): string {
    return (this.deps.sessionsDir ?? (() => paths.dshSessionsDir))();
  }
}
