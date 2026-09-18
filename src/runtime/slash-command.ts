/** Stable slash-command vocabulary shared by the CLI Runtime and embedded hosts. */
export const BRIDGE_RUNTIME_SLASH_COMMANDS = [
  'resume',
  'model',
  'settings',
  'help',
  'compact',
  'context',
  'clear',
  'goal',
] as const;

export type BridgeRuntimeSlashCommandName = (typeof BRIDGE_RUNTIME_SLASH_COMMANDS)[number];

/** Commands whose upstream behavior changes durable project/session administration. */
export const BRIDGE_RUNTIME_ADMIN_SLASH_COMMANDS = ['resume', 'settings', 'clear'] as const;

export type BridgeRuntimeAdminSlashCommandName = (typeof BRIDGE_RUNTIME_ADMIN_SLASH_COMMANDS)[number];

const BRIDGE_COMMANDS = new Set<string>(BRIDGE_RUNTIME_SLASH_COMMANDS);
const ADMIN_COMMANDS = new Set<string>(BRIDGE_RUNTIME_ADMIN_SLASH_COMMANDS);

export interface RuntimeSlashCommand {
  /** Lowercase name without the leading slash. */
  readonly name: string;
  /** Exact suffix after the command name, including separator whitespace. */
  readonly rawInput: string;
  /** Whether the complete Bridge Runtime owns a native implementation. */
  readonly knownToBridge: boolean;
  /** Whether Bridge requires the robot owner or an administrator. */
  readonly administratorOnly: boolean;
}

/**
 * Parse one exact leading slash command without confusing paths, URLs, or
 * slash-prefixed prose for commands. Embedded hosts use the same syntax gate
 * before delegating to their own Agent Runtime command registry.
 */
export function parseRuntimeSlashCommand(text: string): RuntimeSlashCommand | undefined {
  const match = /^\/([a-z][a-z0-9_-]*)(?=$|[\t\n\r ])/iu.exec(text);
  if (match === null) return undefined;
  const rawName = match[1];
  if (rawName === undefined) return undefined;
  const name = rawName.toLowerCase();
  return Object.freeze({
    name,
    rawInput: text.slice(match[0].length),
    knownToBridge: BRIDGE_COMMANDS.has(name),
    administratorOnly: ADMIN_COMMANDS.has(name),
  });
}

/**
 * Detect Bridge's whitespace-delimited `/goal` intent anywhere in a message.
 * Paths and URLs containing `/goal` remain ordinary model input.
 */
export function parseRuntimeGoalTrigger(text: string): string | null {
  if (!/(^|\s)\/goal(?=\s|$)/i.test(text)) return null;
  const objective = text
    .replace(/(^|\s)\/goal(?=\s|$)/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return objective.length > 0 ? objective : null;
}
