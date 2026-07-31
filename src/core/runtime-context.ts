import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { UpdateCheck } from '../service/update.js';

/** Exact upstream identity represented by this compatibility snapshot. */
export const UPSTREAM_PACKAGE_NAME = '@modelzen/feishu-codex-bridge';
export const UPSTREAM_BRIDGE_VERSION = '0.6.10';

export interface EmbeddedRuntimeHost {
  requestRestart(): void | Promise<void>;
  checkUpdate?(): Promise<UpdateCheck>;
}

let embeddedHost: EmbeddedRuntimeHost | undefined;

/**
 * Bind host-only operations when the upstream kernel is embedded in Vonvon.
 * Each bot has its own process, so this intentionally remains process-global.
 */
export function configureEmbeddedRuntimeHost(
  host: EmbeddedRuntimeHost,
): () => void {
  embeddedHost = host;
  return () => {
    if (embeddedHost === host) embeddedHost = undefined;
  };
}

export function currentEmbeddedRuntimeHost(): EmbeddedRuntimeHost | undefined {
  return embeddedHost;
}

/**
 * A CJS/ESM-neutral anchor for createRequire(). The bundled desktop sidecar is
 * CJS, where import.meta.url is unavailable; the standalone upstream build is
 * ESM. An absolute entry filename works for both module systems.
 */
export function runtimeRequireAnchor(): string {
  const entry = process.argv[1];
  if (entry && isAbsolute(entry)) return entry;
  return join(process.cwd(), '__feishu_codex_bridge_runtime_anchor__.cjs');
}

/**
 * Best-effort CLI entry used only by the legacy service-control diagnostics.
 * In embedded mode there is no separately installed CLI entry, so identify the
 * currently running executable without inventing an invalid package path.
 */
export function compatibilityCliBinPath(): string {
  if (embeddedHost) return runtimeEntryPath();
  return resolve(process.cwd(), 'bin', 'feishu-codex-bridge.mjs');
}

export function runtimeEntryPath(): string {
  const entry = process.argv[1];
  return entry && isAbsolute(entry) ? entry : process.execPath;
}

/** Locate a checkout marker without relying on the importing module's URL. */
export function isRuntimeCheckout(): boolean {
  if (embeddedHost) return false;
  let directory = process.cwd();
  for (;;) {
    if (existsSync(join(directory, '.git'))) return true;
    const parent = dirname(directory);
    if (parent === directory) return false;
    directory = parent;
  }
}
