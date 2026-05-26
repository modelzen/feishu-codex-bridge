/**
 * feishu-codex-bridge — public entry.
 *
 * Bridges Feishu/Lark to local Codex via app-server. Interaction model:
 * project=group=cwd, thread=session. See docs/design/feishu-codex-bridge-design.md.
 */
export { log, withTrace, newTraceId } from './core/logger';
export { paths } from './config/paths';
