import { createLarkChannel, Domain, type LarkChannel } from '@larksuiteoapi/node-sdk';
import {
  createProjectGroup,
  deleteCreatedProjectGroup,
  finalizeCreatedProjectGroup,
} from './group-provisioning';
import type { Project } from './registry';

export interface DesktopProjectGroupCredentials {
  appId: string;
  appSecret: string;
  tenant: 'feishu' | 'lark';
}

export interface ProvisionDesktopProjectGroupInput {
  credentials: DesktopProjectGroupCredentials;
  name: string;
  ownerOpenId: string;
}

export interface FinalizeDesktopProjectGroupInput {
  credentials: DesktopProjectGroupCredentials;
  project: {
    name: string;
    chatId: string;
    cwd: string;
    createdAt: number;
    kind: 'multi' | 'single';
    backend?: string;
    noMention?: boolean;
  };
}

export interface RollbackDesktopProjectGroupInput {
  credentials: DesktopProjectGroupCredentials;
  chatId: string;
}

/**
 * Credential-based façade used by the desktop sidecar. It deliberately owns no
 * local registry state: the desktop store transaction remains the source of
 * truth, while this module shares the exact Feishu group behavior of the card
 * flow.
 */
export async function provisionDesktopProjectGroup(
  input: ProvisionDesktopProjectGroupInput,
): Promise<string> {
  return await createProjectGroup(channelFor(input.credentials), {
    name: input.name,
    ownerOpenId: input.ownerOpenId,
  });
}

export async function finalizeDesktopProjectGroup(
  input: FinalizeDesktopProjectGroupInput,
): Promise<void> {
  const project: Project = {
    ...input.project,
    blank: false,
    origin: 'created',
    mode: 'full',
    network: false,
  };
  await finalizeCreatedProjectGroup(channelFor(input.credentials), project);
}

export async function rollbackDesktopProjectGroup(
  input: RollbackDesktopProjectGroupInput,
): Promise<void> {
  await deleteCreatedProjectGroup(channelFor(input.credentials), input.chatId);
}

function channelFor(credentials: DesktopProjectGroupCredentials): LarkChannel {
  return createLarkChannel({
    appId: credentials.appId,
    appSecret: credentials.appSecret,
    domain: credentials.tenant === 'lark' ? Domain.Lark : Domain.Feishu,
    source: 'vonvon-bridge',
    policy: { requireMention: false },
    safety: { batch: { text: { delayMs: 0 } } },
  });
}
