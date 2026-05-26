import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getSecret } from './keystore';
import { paths } from './paths';
import type { AppConfig, ProviderConfig, SecretInput, SecretRef } from './schema';
import { isSecretRef, secretKeyForApp } from './schema';

/**
 * Resolve the bot App Secret from config: plain string, "${VAR}" template,
 * or { source: env|file|exec } SecretRef. The exec branch short-circuits
 * when the provider command is this bridge's own secrets-getter wrapper —
 * we read the AES keystore directly instead of spawning ourselves.
 */

const ENV_TEMPLATE_RE = /^\$\{([A-Z][A-Z0-9_]{0,127})\}$/;
const DEFAULT_PROVIDER = 'default';
const DEFAULT_EXEC_TIMEOUT_MS = 5_000;
const DEFAULT_EXEC_MAX_OUTPUT = 64 * 1024;

export async function resolveAppSecret(cfg: AppConfig): Promise<string> {
  const appId = cfg.accounts.app.id;
  return resolveSecretInput(cfg.accounts.app.secret, cfg.secrets, appId);
}

async function resolveSecretInput(
  input: SecretInput,
  secretsCfg: AppConfig['secrets'],
  appId: string,
): Promise<string> {
  if (!input) throw new Error('app secret is missing');
  if (typeof input === 'string') return resolvePlainOrTemplate(input);
  if (!isSecretRef(input)) throw new Error(`unsupported secret form: ${JSON.stringify(input)}`);
  switch (input.source) {
    case 'env':
      return resolveEnvRef(input, lookupProvider(secretsCfg, input));
    case 'file':
      return resolveFileRef(input, lookupProvider(secretsCfg, input));
    case 'exec':
      return resolveExecRef(input, lookupProvider(secretsCfg, input), appId);
    default:
      throw new Error(`unknown secret source: ${(input as { source?: string }).source}`);
  }
}

function resolvePlainOrTemplate(value: string): string {
  if (!value) throw new Error('app secret is empty');
  const m = ENV_TEMPLATE_RE.exec(value);
  if (m) {
    const name = m[1] as string;
    const v = process.env[name];
    if (!v) throw new Error(`env var ${name} referenced by secret is not set`);
    return v;
  }
  return value;
}

function lookupProvider(secretsCfg: AppConfig['secrets'], ref: SecretRef): ProviderConfig | undefined {
  if (!secretsCfg?.providers) return undefined;
  const name = ref.provider ?? secretsCfg.defaults?.[ref.source] ?? DEFAULT_PROVIDER;
  return secretsCfg.providers[name];
}

function resolveEnvRef(ref: SecretRef, pc: ProviderConfig | undefined): string {
  if (pc?.allowlist && pc.allowlist.length > 0 && !pc.allowlist.includes(ref.id)) {
    throw new Error(`env var ${ref.id} is not allowlisted in provider`);
  }
  const v = process.env[ref.id];
  if (!v) throw new Error(`env var ${ref.id} is not set`);
  return v;
}

async function resolveFileRef(ref: SecretRef, pc: ProviderConfig | undefined): Promise<string> {
  const path = pc?.path ? join(pc.path, ref.id) : ref.id;
  return (await readFile(path, 'utf8')).trim();
}

async function resolveExecRef(
  ref: SecretRef,
  pc: ProviderConfig | undefined,
  appId: string,
): Promise<string> {
  if (!pc?.command) throw new Error('exec provider missing `command`');
  if (isSelfBridgeCommand(pc.command, pc.args)) {
    const candidate = await getSecret(ref.id);
    if (candidate !== undefined) return candidate;
    const conventional = secretKeyForApp(appId);
    const fallback = await getSecret(conventional);
    if (fallback !== undefined) return fallback;
    throw new Error(`keystore has no entry for "${ref.id}" or "${conventional}"`);
  }
  return spawnExecProvider(pc, ref);
}

function isSelfBridgeCommand(command: string, args: string[] | undefined): boolean {
  if (command === paths.secretsGetterScript) return true;
  if (args && args.length >= 2) {
    const a = args[args.length - 2];
    const b = args[args.length - 1];
    if (a === 'secrets' && b === 'get') return true;
  }
  return false;
}

async function spawnExecProvider(pc: ProviderConfig, ref: SecretRef): Promise<string> {
  const timeoutMs = pc.noOutputTimeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
  const maxOutput = pc.maxOutputBytes ?? DEFAULT_EXEC_MAX_OUTPUT;
  const providerName = ref.provider ?? DEFAULT_PROVIDER;
  return new Promise<string>((resolve, reject) => {
    const env: NodeJS.ProcessEnv = {};
    if (pc.passEnv) for (const k of pc.passEnv) { const v = process.env[k]; if (v) env[k] = v; }
    if (pc.env) Object.assign(env, pc.env);
    const child = spawn(pc.command!, pc.args ?? [], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', truncated = false, settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`exec provider timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      if (truncated) return;
      if (stdout.length + chunk.length > maxOutput) { truncated = true; child.kill('SIGKILL'); return; }
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`exec provider failed to start: ${err.message}`));
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (truncated) return reject(new Error(`exec provider stdout exceeded ${maxOutput} bytes`));
      if (code !== 0) {
        const detail = stderr.trim() ? `: ${stderr.trim().slice(0, 200)}` : '';
        return reject(new Error(`exec provider exited with code ${code}${detail}`));
      }
      try {
        const parsed = JSON.parse(stdout) as {
          values?: Record<string, string>;
          errors?: Record<string, { message?: string }>;
        };
        const value = parsed.values?.[ref.id];
        if (typeof value === 'string') return resolve(value);
        const err = parsed.errors?.[ref.id]?.message;
        reject(new Error(`exec provider did not return secret for ${ref.id}${err ? `: ${err}` : ''}`));
      } catch (err) {
        reject(new Error(`exec provider returned invalid JSON: ${(err as Error).message}`));
      }
    });
    child.stdin.end(JSON.stringify({ protocolVersion: 1, provider: providerName, ids: [ref.id] }));
  });
}
