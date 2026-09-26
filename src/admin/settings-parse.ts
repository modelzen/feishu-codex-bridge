import { isAbsolute } from 'node:path';
import { REASONING_EFFORTS } from '../agent/types';
import type { SettingsAction, SettingsEdit, SettingsScope, ModelQuery } from './settings-types';
export class SettingsInputError extends Error {
}
type Rule = (value: unknown) => boolean;
const bool: Rule = value => typeof value === 'boolean';
const text: Rule = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 1000;
const one = (...values: readonly unknown[]): Rule => value => values.includes(value);
const integer = (min: number, max: number): Rule => value => typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
const identifier = (prefix: string): Rule => value => typeof value === 'string' && new RegExp(`^${prefix}_[A-Za-z0-9_-]{1,200}$`).test(value);
const array = (rule: Rule): Rule => value => Array.isArray(value) && value.length <= 1000 && value.every(rule);
const path: Rule = value => value === null || typeof value === 'string' && value.length <= 4096 && !/[\r\n\0]/.test(value) && (isAbsolute(value) || value === '~' || value.startsWith('~/'));
export function settingsObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new SettingsInputError('设置请求必须是对象');
  return value as Record<string, unknown>;
}
function shape(rules: Record<string, Rule>, partial = false): Rule {
  return value => {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      return false;
    const record = settingsObject(value);
    return Object.keys(record).every(key => Object.hasOwn(rules, key) && rules[key]!(record[key])) && (partial || Object.keys(rules).every(key => Object.hasOwn(record, key)));
  };
}
const selection: Rule = value => shape({
  kind: one('default')
})(value) || shape({
  kind: one('explicit'),
  model: text,
  effort: one(...REASONING_EFFORTS)
})(value);
const title: Rule = value => shape({
  enabled: one(false)
})(value) || shape({
  enabled: one(true),
  model: text,
  effort: one(...REASONING_EFFORTS)
})(value);
const schemas: Record<string, Record<string, Rule>> = {
  agent: {
    cards: shape({
      showToolCalls: bool,
      showModel: one('off', 'running', 'always')
    }, true),
    run: shape({
      maxConcurrentRuns: integer(1, 50),
      runIdleTimeoutSeconds: value => value === 0 || integer(10, 3600)(value),
      pendingPolicy: one('steer', 'queue')
    }, true),
    completion: shape({
      mode: one('manual', 'long', 'failures', 'always'),
      longTaskMinutes: integer(1, 1440)
    }, true),
    cliBridge: shape({
      agents: shape({
        claude: bool,
        codex: bool
      }),
      notifyScope: one('all', 'bound_projects', 'none'),
      keepAwake: shape({
        enabled: bool
      }),
      approval: shape({
        enabled: bool,
        timeoutSeconds: integer(1, 86400)
      }),
      taskCompletion: shape({
        enabled: bool,
        replyEnabled: bool,
        replyTimeoutSeconds: integer(1, 86400)
      }),
      allowCache: shape({
        enabled: bool,
        scope: one('session')
      }),
      presence: shape({
        enabled: bool,
        platform: one('auto', 'macos'),
        idleThresholdSeconds: integer(10, 3600)
      })
    }, true),
    comments: shape({
      backend: text,
      selection
    }, true),
    titles: shape({
      byBackend: value => {
        const map = settingsObject(value);
        return Object.keys(map).length === 1 && Object.entries(map).every(([key, policy]) => text(key) && !['__proto__', 'constructor', 'prototype'].includes(key) && title(policy));
      }
    }),
    paths: shape({
      projectsRootDir: path
    }, true),
    access: shape({
      allowedChats: array(identifier('oc'))
    }, true),
  },
  project: {
    permission: shape({
      mode: one('qa', 'write', 'full'),
      guestMode: one('qa', 'write', 'full'),
      network: bool
    }, true),
    response: shape({
      noMention: bool
    }, true),
    compact: shape({
      autoCompact: bool
    }, true),
    model: shape({
      selection
    })
  },
  session: {
    model: shape({
      selection
    })
  },
  host: {
    execution: shape({
      codexBin: path
    })
  },
};
export function parseSettingsScope(input: unknown): SettingsScope {
  const object = settingsObject(input);
  const scopes: Record<string, Rule> = {
    host: shape({
      kind: one('host')
    }),
    agent: shape({
      kind: one('agent'),
      botId: identifier('cli')
    }),
    project: shape({
      kind: one('project'),
      botId: identifier('cli'),
      projectName: text
    }),
    session: shape({
      kind: one('session'),
      botId: identifier('cli'),
      threadId: text
    }),
  };
  if (typeof object.kind !== 'string' || !Object.hasOwn(scopes, object.kind) || !scopes[object.kind]!(object))
    throw new SettingsInputError('设置作用域无效');
  return object as SettingsScope;
}
export function parseSettingsEdit(input: unknown): SettingsEdit {
  const object = settingsObject(input);
  if (!shape({
    scope: () => true,
    section: text,
    revision: text,
    patch: () => true
  })(object))
    throw new SettingsInputError('设置保存参数无效');
  const scope = parseSettingsScope(object.scope);
  const section = String(object.section);
  const rule = schemas[scope.kind]?.[section];
  if (!Object.hasOwn(schemas[scope.kind]!, section) || !rule || !rule(object.patch) || Object.keys(settingsObject(object.patch)).length === 0)
    throw new SettingsInputError('设置字段、类型或范围无效');
  return {
    ...object,
    scope
  } as SettingsEdit;
}
export function parseModelQuery(input: unknown): ModelQuery {
  if (!shape({
    botId: identifier('cli'),
    backend: text,
    purpose: one('project', 'session', 'comments', 'titles')
  })(input))
    throw new SettingsInputError('模型查询无效');
  return input as ModelQuery;
}
export function parseSettingsAction(input: unknown): SettingsAction {
  const object = settingsObject(input);
  const common = {
    kind: text,
    botId: identifier('cli')
  };
  const revision = text;
  const membership = one('present', 'absent');
  const rules: Record<string, Rule> = {
    setCliBridgeEnabled: shape({
      ...common,
      enabled: bool,
      revision
    }),
    repairCliHooks: shape(common),
    voice: shape({
      ...common,
      action: shape({
        action: one('enable', 'disable', 'test', 'refreshPermission')
      })
    }),
    adminMember: shape({
      ...common,
      openId: identifier('ou'),
      membership,
      revision
    }),
    projectMember: shape({
      ...common,
      projectName: text,
      openId: identifier('ou'),
      membership,
      revision
    }),
    projectAudience: shape({
      ...common,
      projectName: text,
      audience: one('all'),
      revision
    }),
    commentInstructions: shape({
      ...common,
      revision,
      content: value => shape({
        kind: one('default')
      })(value) || shape({
        kind: one('custom'),
        text: v => typeof v === 'string' && v.trim().length > 0 && v.length <= 30000
      })(value)
    }),
  };
  if (typeof object.kind !== 'string' || !Object.hasOwn(rules, object.kind) || !rules[object.kind]!(object))
    throw new SettingsInputError('设置操作参数无效');
  return object as SettingsAction;
}
