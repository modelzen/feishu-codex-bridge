import type { ModelInfo, PermissionMode, ReasoningEffort } from '../agent/types';
import type { ModelDisplayMode, PendingPolicy, ResolvedCliBridgePreferences, ResolvedCompletionReminderConfig } from '../config/schema';
import type { VoiceAction, VoiceView } from '../voice/types';
import type { CliHookStatus } from '../cli-bridge/types';
export type SettingsScope = {
  kind: 'host';
} | {
  kind: 'agent';
  botId: string;
} | {
  kind: 'project';
  botId: string;
  projectName: string;
} | {
  kind: 'session';
  botId: string;
  threadId: string;
};
export type BotSettingsScope = Exclude<SettingsScope, {
  kind: 'host';
}>;
export type ModelSelection = {
  kind: 'default';
} | {
  kind: 'explicit';
  model: string;
  effort: ReasoningEffort;
};
export type TitlePolicy = {
  enabled: false;
} | {
  enabled: true;
  model: string;
  effort: ReasoningEffort;
};
export interface AgentSections {
  cards: {
    showToolCalls: boolean;
    showModel: ModelDisplayMode;
  };
  run: {
    maxConcurrentRuns: number;
    runIdleTimeoutSeconds: number;
    pendingPolicy: PendingPolicy;
  };
  completion: ResolvedCompletionReminderConfig;
  cliBridge: Omit<ResolvedCliBridgePreferences, 'enabled' | 'delivery' | 'includeBridgeOwnedSessionsForDebugging'>;
  comments: {
    backend: string;
    selection: ModelSelection;
  };
  titles: {
    byBackend: Record<string, TitlePolicy>;
  };
  paths: {
    projectsRootDir: string | null;
  };
  access: {
    allowedChats: string[];
  };
}
export interface ProjectSections {
  permission: {
    mode: PermissionMode;
    guestMode: PermissionMode;
    network: boolean;
  };
  response: {
    noMention: boolean;
  };
  compact: {
    autoCompact: boolean;
  };
  model: {
    selection: ModelSelection;
  };
}
export interface SessionSections {
  model: {
    selection: ModelSelection;
  };
}
export interface HostSections {
  execution: {
    codexBin: string | null;
  };
}
export type SettingsAccess = {
  kind: 'writable';
} | {
  kind: 'readonly';
  reason: 'preview' | 'owner-offline' | 'unsupported-host' | 'stale';
  message: string;
};
export interface ApplyEffect {
  fields: string[];
  when: 'next-message' | 'next-turn' | 'task-completion' | 'new-session' | 'new-comment' | 'new-project' | 'next-hook' | 'next-presence-check' | 'restart' | 'session-rebind' | 'immediate';
  detail: string;
}
export interface SettingsSection<T> {
  stored: T;
  effective: T;
  revision: string;
  access: SettingsAccess;
  apply: ApplyEffect[];
}
type Sections<M> = {
  [K in keyof M]: SettingsSection<M[K]>;
};
export interface AgentSettingsView {
  scope: Extract<SettingsScope, {
    kind: 'agent';
  }>;
  sections: Sections<AgentSections>;
  ownerOpenId: string | null;
  administrators: {
    openIds: string[];
    revision: string;
  };
  voice: VoiceView;
  cliRuntime: {
    enabled: boolean;
    running: boolean;
    revision: string;
    hooks: {
      claude: CliHookStatus;
      codex: CliHookStatus;
    };
    keepAwakeSupported: boolean;
  };
  commentInstructions: {
    content: {
      kind: 'default';
      text: string;
    } | {
      kind: 'custom';
      text: string;
    };
    revision: string;
    maxEditLength: number;
  };
}
export interface ProjectSettingsView {
  scope: Extract<SettingsScope, {
    kind: 'project';
  }>;
  sections: Sections<ProjectSections>;
  identity: {
    chatId: string;
    backend: string;
    cwd: string;
    kind: string;
  };
  members: {
    openIds: string[];
    revision: string;
  };
}
export interface SessionSettingsView {
  scope: Extract<SettingsScope, {
    kind: 'session';
  }>;
  sections: Sections<SessionSections>;
  identity: {
    backend: string;
    sessionId: string;
    chatId: string;
    projectName: string | null;
  };
}
export interface HostSettingsView {
  scope: {
    kind: 'host';
  };
  sections: Sections<HostSections>;
  runtime: {
    codexBin: string | null;
    fallbackCwd: string;
    platform: string;
  };
}
export type SettingsView = AgentSettingsView | ProjectSettingsView | SessionSettingsView | HostSettingsView;
type SectionEdit<S, M> = {
  [K in keyof M]: {
    scope: S;
    section: K;
    revision: string;
    patch: Partial<M[K]>;
  };
}[keyof M];
export type BotSettingsEdit = SectionEdit<AgentSettingsView['scope'], AgentSections> | SectionEdit<ProjectSettingsView['scope'], ProjectSections> | SectionEdit<SessionSettingsView['scope'], SessionSections>;
export type SettingsEdit = BotSettingsEdit | SectionEdit<HostSettingsView['scope'], HostSections>;
type SectionView<S, M> = {
  [K in keyof M]: {
    scope: S;
    section: K;
    value: SettingsSection<M[K]>;
  };
}[keyof M];
export type SettingsSectionView = SectionView<AgentSettingsView['scope'], AgentSections> | SectionView<ProjectSettingsView['scope'], ProjectSections> | SectionView<SessionSettingsView['scope'], SessionSections> | SectionView<HostSettingsView['scope'], HostSections>;
export interface SettingsFieldError {
  field: string;
  message: string;
}
export type SettingsSave = {
  kind: 'saved';
  section: SettingsSectionView;
  effects: ApplyEffect[];
} | {
  kind: 'conflict';
  current: SettingsSectionView;
} | {
  kind: 'rejected';
  fields: SettingsFieldError[];
} | {
  kind: 'unavailable';
  reason: SettingsAccess;
};
export type SettingsAction = {
  kind: 'setCliBridgeEnabled';
  botId: string;
  enabled: boolean;
  revision: string;
} | {
  kind: 'repairCliHooks';
  botId: string;
} | {
  kind: 'voice';
  botId: string;
  action: VoiceAction;
} | {
  kind: 'adminMember';
  botId: string;
  openId: string;
  membership: 'present' | 'absent';
  revision: string;
} | {
  kind: 'projectMember';
  botId: string;
  projectName: string;
  openId: string;
  membership: 'present' | 'absent';
  revision: string;
} | {
  kind: 'projectAudience';
  botId: string;
  projectName: string;
  audience: 'all';
  revision: string;
} | {
  kind: 'commentInstructions';
  botId: string;
  revision: string;
  content: {
    kind: 'custom';
    text: string;
  } | {
    kind: 'default';
  };
};
export type BotSettingsAction = SettingsAction;
export type SettingsActionResult = {
  kind: 'saved';
  view: AgentSettingsView | ProjectSettingsView;
  effects: ApplyEffect[];
  warnings: string[];
} | {
  kind: 'conflict';
  view: AgentSettingsView | ProjectSettingsView;
} | {
  kind: 'rejected';
  fields: SettingsFieldError[];
} | {
  kind: 'unavailable';
  reason: SettingsAccess;
} | {
  kind: 'diverged';
  view: AgentSettingsView;
  message: string;
};
export interface ModelQuery {
  botId: string;
  backend: string;
  purpose: 'project' | 'session' | 'comments' | 'titles';
}
export interface ModelCatalog {
  backend: string;
  models: ModelInfo[];
  state: 'ready' | 'fallback' | 'unavailable';
  source: 'backend-provided';
  observedAt: string;
  error?: string;
  titleEfforts: ReasoningEffort[];
}
export interface HostSettings {
  read(scope: SettingsScope): Promise<SettingsView>;
  save(edit: SettingsEdit): Promise<SettingsSave>;
  models(query: ModelQuery): Promise<ModelCatalog>;
  act(action: SettingsAction): Promise<SettingsActionResult>;
}
