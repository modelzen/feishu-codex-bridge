export const DSH_VERSION = '0.1.1-rc.2';
export const DSH_MAIN_PACKAGE = '@deepseek-ai/dsh';
export const DSH_BIN_NAME = 'dsh-jsonrpc-agent';

/** Every package named directly by the generated profile, plus the runtime/bin bundles. */
export const DSH_PACKAGES = [
  DSH_MAIN_PACKAGE,
  '@deepseek-ai/dsh-sdk-jsonrpc-demo',
  '@deepseek-ai/dsh-sdk-jsonrpc-server',
  '@deepseek-ai/dsh-credentials-local',
  '@deepseek-ai/dsh-llm-pi-ai',
  '@deepseek-ai/dsh-sandbox-local',
  '@deepseek-ai/dsh-sandbox-policy',
  '@deepseek-ai/dsh-subprocess-local',
  '@deepseek-ai/dsh-bash-sandbox',
  '@deepseek-ai/dsh-user-approval',
  '@deepseek-ai/dsh-agent-spine-demo',
  '@deepseek-ai/dsh-session-persistence-jsonl',
  '@deepseek-ai/dsh-session-checkpoint-policy',
  '@deepseek-ai/dsh-tool-todo',
  '@deepseek-ai/dsh-fs-sandbox',
  '@deepseek-ai/dsh-fs-observation-policy',
  '@deepseek-ai/dsh-tool-fs',
  '@deepseek-ai/dsh-token-meter',
  '@deepseek-ai/dsh-compaction-basic',
] as const;

export const DSH_INSTALL_SPECS: readonly string[] = DSH_PACKAGES.map(
  (pkg) => `${pkg}@${DSH_VERSION}`,
);
