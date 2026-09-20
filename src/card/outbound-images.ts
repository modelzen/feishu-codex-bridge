import type { PermissionMode } from '../agent/types';
import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, resolve, sep } from 'node:path';
import type { LarkChannel } from '@larksuiteoapi/node-sdk';
import { log } from '../core/logger';

/**
 * Outbound image handling: the mirror of {@link ../bot/media} (inbound). Feishu
 * never renders markdown `![](…)` — to show an image in a card you must upload
 * the bytes via `im.v1.image.create` to get an `image_key`, then reference it
 * with an `img` element (see {@link ./cards}.image). This module turns the
 * image sources found in codex's reply into `src → image_key`.
 *
 * Sources are either a LOCAL file (relative to the run cwd, or an absolute path
 * inside that cwd subtree for qa/write; full permits any local path) or an
 * `http(s)` URL. Everything is best-effort: a rejected
 * path, a missing file, an oversized image or a failed upload is logged and
 * skipped — the original markdown text stays in place, never throwing.
 */

/** Cap each streaming/final-answer pass so a flood cannot hammer the upload API. */
const MAX_IMAGES = 9;
/** Feishu rejects uploads over 10MB (and 0-byte files). */
const MAX_BYTES = 10 * 1024 * 1024;
/** Abort a remote fetch that stalls — a hung URL must not hold up the reply. */
const DOWNLOAD_TIMEOUT_MS = 10_000;
/** Formats `im.v1.image.create` accepts (JPEG/PNG/WEBP/GIF/TIFF/BMP/ICO). */
const ALLOWED_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'tif', 'tiff', 'bmp', 'ico']);

/**
 * Process-lifetime cache: resolved cache-key → Feishu `image_key`. Keyed by
 * path+mtime+size (local) or URL (remote) so the same file isn't re-uploaded
 * across a turn's terminal render or repeat turns. Lost on restart (fine — a
 * stale key just means one more upload).
 */
const cache = new Map<string, string>();

/** Markdown image: `![alt](src)`, `![](src "title")`, `![](<src with space>)`.
 * Group 1 = alt, group 2 = src (possibly angle-bracketed). */
const IMG_RE = /!\[([^\]]*)\]\(\s*(<[^>]+>|[^)\s]+)(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;

/** Strip optional `<…>` wrapping and surrounding space from a markdown src. */
function cleanSrc(raw: string): string {
  let s = raw.trim();
  if (s.startsWith('<') && s.endsWith('>')) s = s.slice(1, -1).trim();
  return s;
}

/** Every `![](src)` source in `text`, in order, deduped. The fence content of a
 * ```feishu-card block is plain markdown too, so a single scan of the whole
 * reply covers both inline (run-card) images and clean-card images. */
export function imageSources(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = new RegExp(IMG_RE.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const src = cleanSrc(m[2] ?? '');
    if (src && !seen.has(src)) {
      seen.add(src);
      out.push(src);
    }
  }
  return out;
}

/**
 * Upload every resolvable source and return `src → image_key` for the ones that
 * succeeded (unresolved sources are simply absent — the renderer keeps their
 * original markdown text). Capped at {@link MAX_IMAGES}; uploads run in
 * parallel since a reply carries only a handful.
 */
export async function uploadOutboundImages(
  channel: LarkChannel,
  sources: string[],
  cwd: string,
  mode: PermissionMode = 'write',
): Promise<Map<string, string>> {
  const picked = sources.slice(0, MAX_IMAGES);
  if (sources.length > picked.length) {
    log.warn('outbound', 'image-cap', { skipped: sources.length - picked.length });
  }
  const results = await Promise.all(
    picked.map(async (src) => {
      try {
        return [src, await resolveAndUpload(channel, src, cwd, mode)] as const;
      } catch (err) {
        log.warn('outbound', 'image-failed', { src: src.slice(0, 80), err: String(err) });
        return [src, undefined] as const;
      }
    }),
  );
  const out = new Map<string, string>();
  for (const [src, key] of results) if (key) out.set(src, key);
  if (out.size > 0) log.info('outbound', 'images', { want: sources.length, uploaded: out.size });
  return out;
}

async function resolveAndUpload(channel: LarkChannel, src: string, cwd: string, mode: PermissionMode): Promise<string | undefined> {
  const { buffer, cacheKey } = await loadSource(src, cwd, mode);
  if (!buffer) return undefined;
  const hit = cache.get(cacheKey);
  if (hit) return hit;
  const key = await uploadBuffer(channel, buffer);
  if (key) cache.set(cacheKey, key);
  return key;
}

/** Load a source's bytes + a stable cache key. `buffer` undefined ⇒ rejected
 * (out of cwd / bad ext / missing / oversized / fetch failed); the cache key is
 * still returned but never populated, so it's harmless. */
async function loadSource(src: string, cwd: string, mode: PermissionMode): Promise<{ buffer?: Buffer; cacheKey: string }> {
  if (/^https?:\/\//i.test(src)) return loadRemote(src);
  return loadLocal(src, cwd, mode);
}

async function loadLocal(src: string, cwd: string, mode: PermissionMode): Promise<{ buffer?: Buffer; cacheKey: string }> {
  const cwdAbs = mode === 'full' ? resolve(cwd) : await realpath(resolve(cwd));
  const abs = await realpath(isAbsolute(src) ? resolve(src) : resolve(cwdAbs, src));
  // Follow project permissions: qa/write stay in the workspace; full can read
  // any local image. User-requested rationale: 反正用lark-cli也能发。
  // Resolve symlinks before checking the workspace boundary.
  if (mode !== 'full' && abs !== cwdAbs && !abs.startsWith(cwdAbs + sep)) {
    log.warn('outbound', 'image-outside-cwd', { src: src.slice(0, 80) });
    return { cacheKey: `local:${abs}` };
  }
  const ext = extname(abs).slice(1).toLowerCase();
  if (!ALLOWED_EXT.has(ext)) {
    log.warn('outbound', 'image-ext', { ext, src: src.slice(0, 80) });
    return { cacheKey: `local:${abs}` };
  }
  let size: number;
  let mtimeMs: number;
  try {
    const st = await stat(abs);
    if (!st.isFile()) throw new Error('not a file');
    size = st.size;
    mtimeMs = st.mtimeMs;
  } catch {
    log.warn('outbound', 'image-missing', { src: src.slice(0, 80) });
    return { cacheKey: `local:${abs}` };
  }
  if (size === 0 || size > MAX_BYTES) {
    log.warn('outbound', 'image-size', { size, src: src.slice(0, 80) });
    return { cacheKey: `local:${abs}:${size}` };
  }
  const buffer = await readFile(abs);
  return { buffer, cacheKey: `local:${abs}:${mtimeMs}:${size}` };
}

async function loadRemote(url: string): Promise<{ buffer?: Buffer; cacheKey: string }> {
  const cacheKey = `url:${url}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow' });
    if (!res.ok) {
      log.warn('outbound', 'image-http', { url: url.slice(0, 80), status: res.status });
      return { cacheKey };
    }
    const ct = (res.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase();
    if (ct && !ct.startsWith('image/')) {
      log.warn('outbound', 'image-ctype', { ct, url: url.slice(0, 80) });
      return { cacheKey };
    }
    const declared = Number(res.headers.get('content-length') ?? 0);
    if (declared > MAX_BYTES) {
      log.warn('outbound', 'image-size', { declared, url: url.slice(0, 80) });
      return { cacheKey };
    }
    const ab = await res.arrayBuffer();
    if (ab.byteLength === 0 || ab.byteLength > MAX_BYTES) {
      log.warn('outbound', 'image-size', { size: ab.byteLength, url: url.slice(0, 80) });
      return { cacheKey };
    }
    return { buffer: Buffer.from(ab), cacheKey };
  } catch (err) {
    log.warn('outbound', 'image-fetch', { url: url.slice(0, 80), err: String(err) });
    return { cacheKey };
  } finally {
    clearTimeout(timer);
  }
}

async function uploadBuffer(channel: LarkChannel, buffer: Buffer): Promise<string | undefined> {
  const res = await channel.rawClient.im.v1.image.create({
    data: { image_type: 'message', image: buffer },
  });
  // The SDK helper returns the data object directly; tolerate a `.data` wrap too.
  const key =
    (res as { image_key?: string } | null)?.image_key ??
    (res as { data?: { image_key?: string } } | null)?.data?.image_key;
  if (!key) {
    log.warn('outbound', 'image-no-key', { res: JSON.stringify(res).slice(0, 120) });
    return undefined;
  }
  return key;
}

/** Per-turn background uploads. Failed sources get one final retry at completion. */
export class StreamingImages {
  readonly images = new Map<string, string>();
  private attempted = new Set<string>();
  private pending = new Set<Promise<void>>();

  constructor(
    private upload: (sources: string[]) => Promise<Map<string, string>>,
    private repaint: () => void,
  ) {}

  refresh(text: string): void {
    const fresh = imageSources(text).filter((src) => !this.attempted.has(src))
      .slice(0, MAX_IMAGES - this.attempted.size);
    if (!fresh.length) return;
    for (const src of fresh) this.attempted.add(src);
    const task = Promise.resolve().then(() => this.upload(fresh)).then((images) => {
      for (const [src, key] of images) this.images.set(src, key);
      if (images.size) this.repaint();
    }).catch((err) => log.fail('outbound', err, { phase: 'stream-images' }));
    this.pending.add(task);
    void task.then(() => this.pending.delete(task));
  }

  async drain(): Promise<void> {
    while (this.pending.size) await Promise.all(this.pending);
  }

  /** Final-answer refs get their own bounded pass, even if progress messages
   * used the streaming budget. Merge rather than replace: images already shown
   * during the turn must remain visible in the terminal process panel. */
  async finalize(finalAnswer: string): Promise<ReadonlyMap<string, string>> {
    await this.drain();
    const sources = imageSources(finalAnswer).slice(0, MAX_IMAGES);
    if (sources.length) {
      const uploaded = await this.upload(sources);
      for (const [src, key] of uploaded) this.images.set(src, key);
    }
    return this.images;
  }
}
