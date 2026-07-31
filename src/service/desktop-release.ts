import { UPSTREAM_BRIDGE_VERSION } from '../core/runtime-context.js';
import type { DesktopManualUpdateCheck } from './update.js';
export type { DesktopManualUpdateCheck } from './update.js';

export interface DesktopReleaseProviderOptions {
  currentVersion: string;
  manifestUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

interface DesktopReleaseManifest {
  schemaVersion: 1;
  channel: 'stable' | 'beta';
  version: string;
  releasePageUrl?: string;
  dmgUrl?: string;
  critical?: boolean;
  minimumMacOS?: string;
  sha256?: string;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024;
const MANIFEST_KEYS = new Set([
  'schemaVersion',
  'channel',
  'version',
  'releasePageUrl',
  'dmgUrl',
  'critical',
  'minimumMacOS',
  'sha256',
]);
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

export class DesktopReleaseProvider {
  readonly #currentVersion: string;
  readonly #manifestUrl: string | undefined;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #maxResponseBytes: number;

  constructor(options: DesktopReleaseProviderOptions) {
    if (!parseSemver(options.currentVersion)) {
      throw new Error('DesktopReleaseProvider requires a valid semantic currentVersion.');
    }
    this.#currentVersion = options.currentVersion;
    this.#manifestUrl = options.manifestUrl;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  }

  async check(): Promise<DesktopManualUpdateCheck> {
    if (!this.#manifestUrl) {
      return {
        mode: 'manual',
        state: 'unpublished',
        current: this.#currentVersion,
        compatVersion: UPSTREAM_BRIDGE_VERSION,
        latest: null,
        hasUpdate: false,
        dev: false,
        message: '桌面更新通道尚未发布，当前为测试构建。',
      };
    }
    try {
      const manifestUrl = httpsUrl(this.#manifestUrl);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
      try {
        const response = await this.#fetch(manifestUrl, {
          credentials: 'omit',
          redirect: 'error',
          headers: { accept: 'application/json' },
          signal: controller.signal,
        });
        if (!response.ok) throw new Error('Release manifest request failed.');
        const mediaType = response.headers
          .get('content-type')
          ?.split(';', 1)[0]
          ?.trim()
          .toLowerCase();
        if (mediaType !== 'application/json') {
          throw new Error('Release manifest must be JSON.');
        }
        const manifest = parseManifest(await readManifestText(
          response,
          this.#maxResponseBytes,
        ));
        return manualCheck(this.#currentVersion, manifest);
      } finally {
        clearTimeout(timer);
      }
    } catch {
      return {
        mode: 'manual',
        state: 'unavailable',
        current: this.#currentVersion,
        compatVersion: UPSTREAM_BRIDGE_VERSION,
        latest: null,
        hasUpdate: false,
        dev: false,
        message: `暂时无法检查桌面更新，请稍后重试。当前桌面版本 v${this.#currentVersion}。`,
      };
    }
  }
}

function manualCheck(
  currentVersion: string,
  manifest: DesktopReleaseManifest,
): DesktopManualUpdateCheck {
  const hasUpdate = compareSemver(manifest.version, currentVersion) > 0;
  const shared = {
    mode: 'manual' as const,
    current: currentVersion,
    compatVersion: UPSTREAM_BRIDGE_VERSION,
    latest: manifest.version,
    hasUpdate,
    dev: false as const,
    channel: manifest.channel,
    ...(manifest.releasePageUrl === undefined
      ? {}
      : { releasePageUrl: manifest.releasePageUrl }),
    ...(manifest.dmgUrl === undefined ? {} : { dmgUrl: manifest.dmgUrl }),
    ...(manifest.critical === undefined ? {} : { critical: manifest.critical }),
    ...(manifest.minimumMacOS === undefined
      ? {}
      : { minimumMacOS: manifest.minimumMacOS }),
    ...(manifest.sha256 === undefined ? {} : { sha256: manifest.sha256 }),
  };
  return hasUpdate
    ? {
        ...shared,
        state: 'available',
        message: `发现 Vonvon Bridge 桌面新版 v${manifest.version}，请手动下载并安装签名 DMG。`,
      }
    : {
        ...shared,
        state: 'current',
        message: manifest.version === currentVersion
          ? `当前桌面版本 v${currentVersion} 与发布通道一致。`
          : `当前桌面版本 v${currentVersion} 不低于发布通道版本 v${manifest.version}。`,
      };
}

function parseManifest(text: string): DesktopReleaseManifest {
  const value: unknown = JSON.parse(text);
  if (!isRecord(value) || Object.keys(value).some((key) => !MANIFEST_KEYS.has(key))) {
    throw new Error('Release manifest has an invalid schema.');
  }
  if (
    value.schemaVersion !== 1
    || (value.channel !== 'stable' && value.channel !== 'beta')
    || typeof value.version !== 'string'
    || !parseSemver(value.version)
    || (
      value.releasePageUrl === undefined
      && value.dmgUrl === undefined
    )
    || (
      value.releasePageUrl !== undefined
      && typeof value.releasePageUrl !== 'string'
    )
    || (value.dmgUrl !== undefined && typeof value.dmgUrl !== 'string')
    || (value.critical !== undefined && typeof value.critical !== 'boolean')
    || (
      value.minimumMacOS !== undefined
      && (
        typeof value.minimumMacOS !== 'string'
        || !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*))?$/u.test(value.minimumMacOS)
      )
    )
    || (
      value.sha256 !== undefined
      && (
        typeof value.sha256 !== 'string'
        || !/^[0-9a-f]{64}$/u.test(value.sha256)
      )
    )
  ) {
    throw new Error('Release manifest has an invalid schema.');
  }
  const releasePageUrl = value.releasePageUrl === undefined
    ? undefined
    : httpsUrl(value.releasePageUrl);
  const dmgUrl = value.dmgUrl === undefined ? undefined : httpsUrl(value.dmgUrl);
  return {
    schemaVersion: 1,
    channel: value.channel,
    version: value.version,
    ...(releasePageUrl === undefined ? {} : { releasePageUrl }),
    ...(dmgUrl === undefined ? {} : { dmgUrl }),
    ...(value.critical === undefined ? {} : { critical: value.critical }),
    ...(value.minimumMacOS === undefined
      ? {}
      : { minimumMacOS: value.minimumMacOS }),
    ...(value.sha256 === undefined ? {} : { sha256: value.sha256 }),
  };
}

async function readManifestText(
  response: Response,
  maxResponseBytes: number,
): Promise<string> {
  const declaredLength = response.headers.get('content-length');
  if (
    declaredLength !== null
    && (
      !/^\d+$/u.test(declaredLength)
      || Number(declaredLength) > maxResponseBytes
    )
  ) {
    throw new Error('Release manifest is too large.');
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxResponseBytes) {
        await reader.cancel('Release manifest is too large.');
        throw new Error('Release manifest is too large.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

function httpsUrl(input: string): string {
  if (input.length === 0 || input.length > 4_096) {
    throw new Error('Release URL is invalid.');
  }
  const value = new URL(input);
  if (value.protocol !== 'https:' || value.username || value.password) {
    throw new Error('Release URL must use HTTPS without credentials.');
  }
  return value.toString();
}

interface ParsedSemver {
  major: string;
  minor: string;
  patch: string;
  prerelease: string[];
}

function parseSemver(version: string): ParsedSemver | undefined {
  const match = SEMVER.exec(version);
  if (!match) return undefined;
  return {
    major: match[1]!,
    minor: match[2]!,
    patch: match[3]!,
    prerelease: match[4]?.split('.') ?? [],
  };
}

function compareSemver(left: string, right: string): number {
  const a = parseSemver(left);
  const b = parseSemver(right);
  if (!a || !b) throw new Error('Cannot compare invalid semantic versions.');
  for (const key of ['major', 'minor', 'patch'] as const) {
    const precedence = compareNumericIdentifier(a[key], b[key]);
    if (precedence !== 0) return precedence;
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    if (a.prerelease.length === b.prerelease.length) return 0;
    return a.prerelease.length === 0 ? 1 : -1;
  }
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const ai = a.prerelease[index];
    const bi = b.prerelease[index];
    if (ai === bi) continue;
    if (ai === undefined) return -1;
    if (bi === undefined) return 1;
    const aNumeric = /^\d+$/u.test(ai);
    const bNumeric = /^\d+$/u.test(bi);
    if (aNumeric && bNumeric) return compareNumericIdentifier(ai, bi);
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    return ai > bi ? 1 : -1;
  }
  return 0;
}

function compareNumericIdentifier(left: string, right: string): number {
  if (left.length !== right.length) return left.length > right.length ? 1 : -1;
  if (left === right) return 0;
  return left > right ? 1 : -1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
