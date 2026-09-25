import { isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import type { Project } from '../project/registry';
import { InvalidGroupInput } from './groups';

export type ProjectTarget = { projectName: string; chatId: string };
export type CollaborationRequest =
  | { action: 'createProject'; requestId: string; name: string; directory?: string; kind: 'single' | 'multi'; backend: 'codex-appserver' | 'claude-agent' }
  | ({ [K in 'project' | 'history' | 'shareUsage']: { action: K } & ProjectTarget }['project' | 'history' | 'shareUsage'])
  | ({ action: 'editProject'; expectedRevision: string; directory?: string; kind?: 'single' | 'multi'; enabled?: boolean } & ProjectTarget)
  | ({ action: 'removeProject'; expectedRevision: string } & ProjectTarget)
  | ({ [K in 'context' | 'clear' | 'compact']: { action: K; threadId: string } & ProjectTarget }['context' | 'clear' | 'compact'])
  | ({ action: 'resume'; sessionId: string; backend: string } & ProjectTarget)
  | ({ action: 'startGoal'; threadId: string; objective: string } & ProjectTarget)
  | ({ [K in 'stop' | 'endGoal']: { action: K; threadId: string; runId: string } & ProjectTarget }['stop' | 'endGoal'])
  | ({ action: 'reminder'; threadId: string; runId: string; requested: boolean } & ProjectTarget)
  | { action: 'usage'; force?: boolean };
export type AdminCollaborationOp = { kind: 'collaboration'; request: CollaborationRequest };
export function projectRevision(project: Project): string {
  return createHash('sha256').update(JSON.stringify(project)).digest('hex');
}
export function projectView(project: Project) {
  return { name: project.name, chatId: project.chatId, cwd: project.cwd, kind: project.kind ?? 'multi', backend: project.backend ?? 'codex-appserver', enabled: project.enabled !== false, revision: projectRevision(project) };
}
export function parseCollaborationRequest(raw: Record<string, unknown>): CollaborationRequest {
  const str = (key: string, max = 4096) => typeof raw[key] === 'string' && (raw[key] as string).trim().length > 0 && (raw[key] as string).length <= max && !(key === 'objective' ? /[\x00-\x08\x0b\x0c\x0e-\x1f]/ : /[\x00-\x1f]/).test(raw[key] as string);
  const allowed: Record<string, string[]> = {
    createProject: ['requestId','name','directory','kind','backend'], project: [], history: [], shareUsage: [],
    editProject: ['expectedRevision','directory','kind','enabled'], removeProject: ['expectedRevision'],
    context: ['threadId'], clear: ['threadId'], compact: ['threadId'], resume: ['sessionId','backend'],
    startGoal: ['threadId','objective'], stop: ['threadId','runId'], endGoal: ['threadId','runId'], reminder: ['threadId','runId','requested'], usage: ['force'],
  };
  const action = raw.action;
  if (typeof action !== 'string' || !Object.hasOwn(allowed, action)) throw new InvalidGroupInput('未知协作操作');
  const target = action !== 'createProject' && action !== 'usage';
  const keys = ['action', ...allowed[action]!, ...(target ? ['projectName','chatId'] : [])];
  if (Object.keys(raw).some(key => !keys.includes(key)) || (target && (!str('projectName',200) || !str('chatId',204) || !/^oc_[\w-]+$/.test(raw.chatId as string)))) throw new InvalidGroupInput('项目标识无效');
  for (const key of allowed[action]!) {
    if (['directory','kind','enabled','force'].includes(key) && raw[key] === undefined) continue;
    if (['enabled','force','requested'].includes(key)) { if (typeof raw[key] !== 'boolean') throw new InvalidGroupInput('布尔参数无效'); }
    else if (!str(key, key === 'objective' ? 16000 : 4096)) throw new InvalidGroupInput('协作参数无效');
  }
  if (raw.directory !== undefined && !isAbsolute(raw.directory as string)) throw new InvalidGroupInput('文件夹必须为绝对路径');
  if (raw.kind !== undefined && raw.kind !== 'single' && raw.kind !== 'multi') throw new InvalidGroupInput('会话类型无效');
  if (action === 'createProject' && (raw.kind === undefined || !['codex-appserver','claude-agent'].includes(raw.backend as string) || !/^[\w-]{16,80}$/.test(raw.requestId as string) || (!str('name',200) || /[\\/]/.test(raw.name as string) || ['.','..'].includes((raw.name as string).trim())))) throw new InvalidGroupInput('新项目参数无效');
  return raw as CollaborationRequest;
}
