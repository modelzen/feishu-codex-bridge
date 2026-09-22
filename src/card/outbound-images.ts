import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { LarkChannel } from '@larksuiteoapi/node-sdk';
import { log } from '../core/logger';
import type { PermissionMode } from '../agent/types';
import { imageSources } from './md-scan';

/**
 * Outbound image handling: the mirror of {@link ../bot/media} (inbound). Feishu
 * never renders markdown `![](…)` in a card the way a browser does — the client
 * parses that syntax into an image NODE and resolves the target as an
 * `image_key`, so a path/URL there renders as a broken image (and can stall the
 * element's typewriter). To show an image you must upload the bytes via
 * `im.v1.image.create` to get an `image_key`, then reference it with an `img`
 * element (see {@link ./cards}.image). This module turns the image sources found
 * in codex's reply into `src → image_key`.
 *
 * Sources are either a LOCAL file (relative to the run cwd, or an absolute path
 * INSIDE that cwd subtree — outside is refused for qa/write so the agent can't
 * make the bot upload `~/.ssh/…`; a `full`-permission project may read any local
 * image, matching what its shell can already print) or an `http(s)` URL.
 * Everything is best-effort: a rejected path, a missing file, an oversized image
 * or a failed upload is logged and skipped — never throwing.
 */

/** Cap per reply so a flood of refs can't wedge a turn or hammer the upload API.
 * A file-listing answer legitimately references dozens of images, so the cap is
 * generous; the CONCURRENCY limit is what actually protects the API. It is also
 * the reply's budget for {@link StreamingImages}: once the streaming pass has
 * attempted this many refs, only the still-missing ones get a finalize pass. */
export const MAX_IMAGES = 30;
/** How many uploads may be in flight at once. Each one holds a file buffer, so
 * this also bounds peak memory (30 × 10MB read at once would be 300MB). */
const UPLOAD_CONCURRENCY = 4;
/** Feishu rejects uploads over 10MB (and 0-byte files). */
const MAX_BYTES = 10 * 1024 * 1024;
/** Abort a remote fetch that stalls — a hung URL must not hold up the reply. */
const DOWNLOAD_TIMEOUT_MS = 10_000;
/** Abort an upload that stalls. The SDK's axios client has NO request timeout, so
 * without this a single wedged `image.create` hangs its caller forever — and the
 * terminal card frame is sequenced behind it, leaving the card stuck on
 * 「正在输出」with a live ⏹ (issue #14: "一显示就卡"). */
const UPLOAD_TIMEOUT_MS = 15_000;
/** How long {@link StreamingImages.finalize} may hold the terminal frame: it is
 * the ONE deadline for both the wait on in-flight uploads and the tail pass, so a
 * card is never held hostage by the upload API. Whatever misses it renders as
 * text and the orphaned upload still lands later (see the class doc). */
export const IMAGE_FINALIZE_GRACE_MS = 3_000;
/** Formats `im.v1.image.create` accepts (JPEG/PNG/WEBP/GIF/TIFF/BMP/ICO). */
const ALLOWED_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'tif', 'tiff', 'bmp', 'ico']);

/**
 * Process-lifetime cache: resolved cache-key → Feishu `image_key`. Keyed by
 * path+mtime+size (local) or URL (remote) so the same file isn't re-uploaded
 * across a turn's terminal render or repeat turns. Lost on restart (fine — a
 * stale key just means one more upload).
 */
const cache = new Map<string, string>();

/**
 * Upload every resolvable source and return `src → image_key` for the ones that
 * succeeded (a source that can't be resolved is simply absent, and the renderer
 * degrades it to text — see {@link ./md-scan}.unresolvedRefText). Capped at
 * {@link MAX_IMAGES}, at most {@link UPLOAD_CONCURRENCY} in flight.
 */
export async function uploadOutboundImages(
  channel: LarkChannel,
  sources: string[],
  cwd: string,
  mode: PermissionMode,
): Promise<Map<string, string>> {
  const picked = sources.slice(0, MAX_IMAGES);
  if (sources.length > picked.length) {
    log.warn('outbound', 'image-cap', { skipped: sources.length - picked.length });
  }
  const results = await mapPool(picked, UPLOAD_CONCURRENCY, async (src) => {
    try {
      return [src, await resolveAndUpload(channel, src, cwd, mode)] as const;
    } catch (err) {
      log.warn('outbound', 'image-failed', { src: src.slice(0, 80), err: String(err) });
      return [src, undefined] as const;
    }
  });
  const out = new Map<string, string>();
  for (const [src, key] of results) if (key) out.set(src, key);
  if (out.size > 0) log.info('outbound', 'images', { want: sources.length, uploaded: out.size });
  return out;
}

async function resolveAndUpload(
  channel: LarkChannel,
  src: string,
  cwd: string,
  mode: PermissionMode,
): Promise<string | undefined> {
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

/** True when `abs` is `cwdAbs` itself or lives under it. Deliberately a
 * relative-path test rather than a string prefix: with the service's fallback
 * cwd of `/` (or any path ending in a separator) `cwdAbs + sep` becomes `//` and
 * matches nothing, which silently rejected every image ref; `..` segments can
 * likewise never fake a match here. */
function lexicallyInside(cwdAbs: string, abs: string): boolean {
  if (abs === cwdAbs) return true;
  const rel = relative(cwdAbs, abs);
  return rel !== '' && !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel);
}

/** {@link lexicallyInside}, then once more on the symlink-resolved paths so a
 * project reachable through two names (macOS `/tmp` → `/private/tmp`, a
 * symlinked home) doesn't false-reject a genuine in-workspace file. Best-effort:
 * a missing path just fails the retry. */
async function insideWorkspace(cwdAbs: string, abs: string): Promise<boolean> {
  if (lexicallyInside(cwdAbs, abs)) return true;
  try {
    return lexicallyInside(await realpath(cwdAbs), await realpath(abs));
  } catch {
    return false;
  }
}

async function loadLocal(
  src: string,
  cwd: string,
  mode: PermissionMode,
): Promise<{ buffer?: Buffer; cacheKey: string }> {
  const cwdAbs = resolve(cwd);
  // A RELATIVE src resolves against the run's cwd — the project directory the
  // agent actually worked in, NOT the bridge process's own cwd. Callers must
  // hand us that cwd (see the run-cwd plumbing in ../bot/handle-message); a
  // wrong one turns every `![](video_frames/x.png)` into a bogus
  // image-outside-cwd rejection.
  const abs = isAbsolute(src) ? resolve(src) : resolve(cwdAbs, src);
  // Security: qa/write only reach inside the run cwd subtree — never an arbitrary
  // path the agent names (so it can't exfiltrate local images via the bot). A
  // `full` project already has unrestricted local read in its shell, so its
  // agent may reference any local image.
  if (mode !== 'full' && !(await insideWorkspace(cwdAbs, abs))) {
    log.warn('outbound', 'image-outside-cwd', { src: src.slice(0, 80), cwd: cwdAbs, mode });
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
  const res = await withTimeout(
    channel.rawClient.im.v1.image.create({ data: { image_type: 'message', image: buffer } }),
    UPLOAD_TIMEOUT_MS,
    `image.create timed out after ${UPLOAD_TIMEOUT_MS}ms`,
  );
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

/** `Promise.all` over `items` with at most `limit` running at a time, results in
 * input order. Uploading 30 images at once would spike memory and trip feishu's
 * rate limiter; a small pool keeps both flat while still finishing fast. */
async function mapPool<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** Resolve/reject with `p`, but give up after `ms` — the SDK's axios instance
 * carries no timeout, so an unanswered request would otherwise never settle. The
 * abandoned request keeps running (harmless: its result is simply ignored). */
function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolvePromise(v);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

/**
 * Per-turn background image uploads. The run card calls {@link refresh} with the
 * answer text on every frame, so a `![](…)` ref starts uploading the moment the
 * model finishes writing it — long before the turn ends. Keys that land trigger
 * a repaint, which is what turns a running card's reference into a real `img`
 * element mid-stream (issue #14: images used to be uploaded only after the turn
 * ended, so they never appeared while streaming).
 *
 * Everything here is best-effort and non-blocking: a failed source is simply
 * absent from {@link images}, and the renderer falls back to safe text.
 */
export class StreamingImages {
  private readonly keys = new Map<string, string>();
  /** Sources already given a streaming attempt (each ref is tried once). */
  private readonly attempted = new Set<string>();
  private pending = new Set<Promise<void>>();
  private lastScan = '';

  constructor(
    private readonly upload: (sources: string[]) => Promise<Map<string, string>>,
    /** Called when at least one new key landed — repaint the live card. */
    private readonly repaint: () => void,
  ) {}

  /** `src → image_key` resolved so far. */
  get images(): ReadonlyMap<string, string> {
    return this.keys;
  }

  /** Scan `text` for refs not yet attempted and upload them in the background. */
  refresh(text: string): void {
    if (text === this.lastScan) return; // same snapshot as the last frame
    this.lastScan = text;
    if (!text.includes('![')) return; // cheap bail: the overwhelmingly common case
    const room = MAX_IMAGES - this.attempted.size;
    if (room <= 0) return;
    const fresh = imageSources(text)
      .filter((src) => !this.attempted.has(src))
      .slice(0, room);
    if (fresh.length === 0) return;
    for (const src of fresh) this.attempted.add(src);
    const task = this.upload(fresh)
      .then((uploaded) => {
        for (const [src, key] of uploaded) this.keys.set(src, key);
        if (uploaded.size > 0) this.repaint();
      })
      .catch((err: unknown) => log.fail('outbound', err, { phase: 'stream-images' }));
    this.track(task);
  }

  /**
   * Resolve the turn's images for the terminal frame. The terminal frame is
   * sequenced behind this call, so the whole thing runs under ONE
   * {@link IMAGE_FINALIZE_GRACE_MS} deadline:
   *
   *  - a tail pass uploads the final answer's still-missing refs, concurrently
   *    with (not after) the wait for in-flight streaming uploads;
   *  - whatever hasn't landed when the deadline passes is simply left out —
   *    the renderer degrades that ref to text, and the orphaned upload keeps
   *    running in the background so a LATER frame can still show it.
   *
   * Never rejects and never blocks longer than the deadline, no matter what the
   * upload API does: this is the promise that keeps a wedged `image.create` from
   * parking the card on 「正在输出」forever (issue #14 "一显示就卡").
   */
  async finalize(finalAnswer: string): Promise<ReadonlyMap<string, string>> {
    const deadline = Date.now() + IMAGE_FINALIZE_GRACE_MS;
    // Only refs that still have no key: `attempted` already spent part of the
    // reply's {@link MAX_IMAGES} budget on the streaming pass, so handing the
    // WHOLE source list to `upload` again let the cap be consumed by re-trying
    // refs that had already failed — and starved a ref that first appeared in
    // the final answer.
    const missing = imageSources(finalAnswer).filter((src) => !this.keys.has(src));
    const tail = missing.length === 0 ? Promise.resolve() : this.uploadImages(missing);
    const settled = (async (): Promise<void> => {
      await this.settle(deadline);
      await tail;
    })();
    if (await raceDeadline(settled, IMAGE_FINALIZE_GRACE_MS)) {
      log.warn('outbound', 'image-finalize-timeout', {
        deadlineMs: IMAGE_FINALIZE_GRACE_MS,
        pending: this.pending.size,
        missing: missing.length,
      });
    }
    return this.keys;
  }

  /** Upload `sources` and fold the keys in, logging (never throwing) a failure. */
  private uploadImages(sources: string[]): Promise<void> {
    return this.upload(sources)
      .then((uploaded) => {
        for (const [src, key] of uploaded) this.keys.set(src, key);
      })
      .catch((err: unknown) => log.fail('outbound', err, { phase: 'final-images' }));
  }

  /**
   * Wait for in-flight uploads, but never past `deadline` (an absolute epoch ms,
   * shared with the tail pass so the two together cost one grace, not two). The
   * deadline is absolute on purpose: re-arming a relative timeout per round would
   * turn a steady trickle of uploads into an unbounded wait.
   */
  private async settle(deadline: number): Promise<void> {
    while (this.pending.size > 0) {
      const left = deadline - Date.now();
      if (left <= 0) return;
      if (await raceDeadline(Promise.all([...this.pending]).then(() => undefined), left)) return;
    }
  }

  /** Track a background task so {@link settle} can wait for it. */
  private track(task: Promise<void>): void {
    this.pending.add(task);
    void task.then(() => this.pending.delete(task));
  }
}

/**
 * Resolve `p` within `ms`, reporting whether the deadline passed instead of
 * rejecting: the abandoned work keeps running harmlessly in the background (its
 * result is ignored, or folded in by whatever awaits it later), and the caller
 * gets to draw its frame NOW.
 */
function raceDeadline(p: Promise<void>, ms: number): Promise<boolean> {
  return Promise.race([
    p.then(() => false),
    new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(true), ms);
      // Don't hold the process open for a deadline nobody is waiting on anymore.
      if (typeof timer === 'object' && 'unref' in timer) timer.unref();
    }),
  ]);
}
