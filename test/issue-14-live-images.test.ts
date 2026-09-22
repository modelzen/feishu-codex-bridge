import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, parse, relative } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { AgentEvent } from '../src/agent/types';
import { ANSWER_EID, buildRunCard, runningAnswerText } from '../src/card/run-card';
import { RunCardStream } from '../src/card/run-card-stream';
import { initialState, reduce, type RunState } from '../src/card/run-state';
import { IMAGE_FINALIZE_GRACE_MS, MAX_IMAGES, StreamingImages, uploadOutboundImages } from '../src/card/outbound-images';

/**
 * Regression coverage for issue #14 — "没法正常显示图片，而且一显示就卡".
 *
 * Two defects are pinned here:
 *
 *  1. A relative `![](video_frames/x.png)` was resolved against the bridge
 *     process's cwd instead of the run's project cwd. The launchd service has no
 *     WorkingDirectory, so that fallback was `/` and `resolve('/', 'video/x.png')`
 *     then failed the workspace-boundary test → every relative ref was logged
 *     image-outside-cwd and never uploaded.
 *  2. An image only uploaded after the turn ended, so a running card carried raw
 *     `![alt](path)` markdown for the whole turn. The Feishu client parses that
 *     into an image NODE (resolving the target as an `image_key`), so the card
 *     showed a broken image — visibly stalling right at the reference.
 */

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const dirs: string[] = [];
async function tmpDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'issue14-'));
  dirs.push(d);
  return d;
}
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

/** Fake LarkChannel: cardkit writes + image uploads, all recorded. */
function fakeChannel() {
  const updates: string[] = [];
  const contents: Array<{ element_id?: string; content: string }> = [];
  const state = { uploads: 0 };
  const channel = {
    rawClient: {
      cardkit: {
        v1: {
          card: {
            create: async () => ({ data: { card_id: 'c_1' } }),
            update: async (p: { data: { card: { data: string } } }) => {
              updates.push(p.data.card.data);
              return {};
            },
            settings: async () => ({}),
          },
          cardElement: {
            content: async (p: { path: { element_id: string }; data: { content: string } }) => {
              contents.push({ element_id: p.path.element_id, content: p.data.content });
              return {};
            },
          },
        },
      },
      im: {
        v1: {
          image: {
            create: async () => {
              state.uploads += 1;
              return { image_key: `img_key_${state.uploads}` };
            },
          },
          message: { create: async () => ({ data: { message_id: 'om_1' } }) },
        },
      },
    },
  };
  return { channel: channel as never, updates, contents, state };
}

function run(events: AgentEvent[]): RunState {
  let s = initialState;
  for (const ev of events) s = reduce(s, ev);
  return s;
}

/** Poll until `check()` is true (background uploads/repaints are async). */
async function until(check: () => boolean, ms = 2_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not reached in time');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('issue #14 — relative image ref resolves against the RUN cwd', () => {
  it('uploads a cwd-relative ref when the fallback cwd is a filesystem root', async () => {
    // launchd falls back to `/`. Use the fixture's own drive root on Windows:
    // the checkout and temporary directory can live on different drives.
    const project = await tmpDir();
    const root = parse(project).root;
    await writeFile(join(project, 'a.png'), PNG);
    const { channel, state } = fakeChannel();
    const src = relative(root, join(project, 'a.png')); // e.g. var/folders/…/a.png

    const map = await uploadOutboundImages(channel, [src], root, 'write');
    expect(map.get(src)).toMatch(/^img_key_/);
    expect(state.uploads).toBe(1);
  });

  it('still refuses to read outside the cwd for a qa/write project', async () => {
    const project = await tmpDir();
    const outside = await tmpDir();
    await writeFile(join(outside, 'secret.png'), PNG);
    const { channel, state } = fakeChannel();

    const map = await uploadOutboundImages(channel, [join(outside, 'secret.png')], project, 'write');
    expect(map.size).toBe(0);
    expect(state.uploads).toBe(0);
  });

  it('a full-permission project may reference a local image anywhere', async () => {
    const project = await tmpDir();
    const outside = await tmpDir();
    await writeFile(join(outside, 'shot.png'), PNG);
    const { channel, state } = fakeChannel();

    const map = await uploadOutboundImages(channel, [join(outside, 'shot.png')], project, 'full');
    expect(map.get(join(outside, 'shot.png'))).toMatch(/^img_key_/);
    expect(state.uploads).toBe(1);
  });
});

describe('issue #14 — the running card shows the image, never raw markdown', () => {
  const ANSWER =
    '下面这张是 `video_frames/contact_sheet.jpg` 的预览：\n\n![豆包 App 截图拼图](video_frames/contact_sheet.jpg)';

  it('swaps the reference for an img element mid-turn and never emits ![', async () => {
    const project = await tmpDir();
    await mkdir(join(project, 'video_frames'), { recursive: true });
    await writeFile(join(project, 'video_frames', 'contact_sheet.jpg'), PNG);
    const { channel, updates } = fakeChannel();

    const rs = run([{ type: 'text_delta', itemId: 'a', delta: ANSWER }]);
    const rc: { rs: RunState; cardKey: string; images?: ReadonlyMap<string, string> } = { rs, cardKey: 'om_1' };
    const stream = new RunCardStream();
    await stream.create(channel, 'oc_1', buildRunCard(rc as never), {});
    const worker = new StreamingImages(
      (sources) => uploadOutboundImages(channel, sources, project, 'write'),
      () => {
        rc.images = worker.images;
        void stream.updateLiveCard(channel, buildRunCard(rc as never)).catch(() => undefined);
      },
    );
    stream.setImageWorker(worker, () => runningAnswerText(rc.rs));

    stream.streamCoalesced(channel, buildRunCard(rc as never), ANSWER_EID);
    await until(() => updates.some((u) => u.includes('"tag":"img"')));
    await stream.drain();

    const last = updates[updates.length - 1] ?? '';
    expect(last).toContain('"tag":"img"');
    expect(last).toContain('img_key_1');
    expect(last).toContain('豆包 App 截图拼图'); // alt text survives
    // The whole point: no frame ever handed the client a raw image ref.
    expect(updates.some((u) => u.includes('!['))).toBe(false);
    expect((await stream.settleImages(ANSWER)).get('video_frames/contact_sheet.jpg')).toBe('img_key_1');
  });

  it('text that follows a resolved image keeps streaming through the element typewriter', async () => {
    const project = await tmpDir();
    await writeFile(join(project, 'shot.png'), PNG);
    const { channel, contents } = fakeChannel();

    let rs = run([{ type: 'text_delta', itemId: 'a', delta: '前 ![x](shot.png)' }]);
    const rc: { rs: RunState; cardKey: string; images?: ReadonlyMap<string, string> } = { rs, cardKey: 'om_1' };
    const stream = new RunCardStream();
    await stream.create(channel, 'oc_1', buildRunCard(rc as never), {});
    const worker = new StreamingImages(
      (sources) => uploadOutboundImages(channel, sources, project, 'write'),
      () => {
        rc.images = worker.images;
        void stream.updateLiveCard(channel, buildRunCard(rc as never)).catch(() => undefined);
      },
    );
    stream.setImageWorker(worker, () => runningAnswerText(rc.rs));
    stream.streamCoalesced(channel, buildRunCard(rc as never), ANSWER_EID);
    await until(() => worker.images.size === 1);
    await stream.drain();

    // The image split the answer; the segment written AFTER it must still be a
    // streamed (typewriter) element, not a whole-card repaint every token.
    rs = run([{ type: 'text_delta', itemId: 'a', delta: '前 ![x](shot.png) 后' }]);
    rc.rs = rs;
    stream.streamCoalesced(channel, buildRunCard(rc as never), ANSWER_EID);
    await stream.drain();
    rs = run([{ type: 'text_delta', itemId: 'a', delta: '前 ![x](shot.png) 后 续' }]);
    rc.rs = rs;
    stream.streamCoalesced(channel, buildRunCard(rc as never), ANSWER_EID);
    await stream.drain();

    expect(contents.some((c) => c.element_id === ANSWER_EID && c.content === '后 续')).toBe(true);
  });

  it('holds back an unfinished ![…](path while it is still being written', () => {
    const rs = run([{ type: 'text_delta', itemId: 'a', delta: '预览：\n\n![图](video_frames/conta' }]);
    const json = JSON.stringify(buildRunCard({ rs, cardKey: 'om_1' }));
    expect(json).not.toContain('![');
    expect(json).not.toContain('video_frames/conta'); // streamed only once complete
  });

  it('shows a placeholder (not a broken image node) while the upload is in flight', () => {
    const rs = run([{ type: 'text_delta', itemId: 'a', delta: '图：![拼图](video_frames/contact_sheet.jpg) 完' }]);
    const json = JSON.stringify(buildRunCard({ rs, cardKey: 'om_1' }));
    expect(json).not.toContain('![');
    expect(json).toContain('图片处理中');
  });

  it('terminal render degrades an unresolved ref to text + code, keeping the path visible', () => {
    const rs = run([
      { type: 'text_delta', itemId: 'a', delta: '图：![拼图](/Users/misty/out/ref-v2) 完' },
      { type: 'done', turnId: 't1' },
    ]);
    const json = JSON.stringify(buildRunCard({ rs }));
    expect(json).not.toContain('![');
    expect(json).toContain('未能显示：`/Users/misty/out/ref-v2`');
    expect(json).toContain('拼图');
  });
});

describe('StreamingImages — background uploads never block the turn', () => {
  it('attempts each ref once and repaints when a key lands', async () => {
    const seen: string[][] = [];
    let repaints = 0;
    const worker = new StreamingImages(
      async (sources) => {
        seen.push(sources);
        return new Map(sources.map((s) => [s, `key_${s}`]));
      },
      () => {
        repaints += 1;
      },
    );

    worker.refresh('a ![one](1.png)');
    worker.refresh('a ![one](1.png) b'); // same snapshot + same ref: no re-attempt
    worker.refresh('a ![one](1.png) b ![two](2.png)');
    await until(() => worker.images.size === 2);

    expect(seen).toEqual([['1.png'], ['2.png']]);
    expect(repaints).toBe(2);
    expect(worker.images.get('2.png')).toBe('key_2.png');
  });

  it('a wedged streaming upload is abandoned at the grace deadline, not awaited forever', async () => {
    let call = 0;
    const worker = new StreamingImages(
      (sources) => {
        call += 1;
        // The streaming pass AND the finalize tail pass both hang — pre-fix the
        // tail ran with no deadline at all (a 200ms grace measured 2002ms), which
        // is exactly how the card ended up parked on 「正在输出」.
        if (call <= 2) return new Promise<Map<string, string>>(() => {});
        return Promise.resolve(new Map(sources.map((s) => [s, `key_${s}`])));
      },
      () => undefined,
    );

    worker.refresh('![x](slow.png)');
    const started = Date.now();
    const images = await worker.finalize('![x](slow.png)');
    // Bounded by ONE grace, never by the upload API.
    expect(Date.now() - started).toBeLessThan(IMAGE_FINALIZE_GRACE_MS + 1_000);
    expect(images.has('slow.png')).toBe(false); // unresolved → the renderer shows text
  });

  it('finalize 的兜底趟只补「还没有 key」的引用（旧实现会被 cap 挤掉尾部那张）', async () => {
    // 流式期 30 张全部上传失败 → attempted 用满本轮配额；答案末尾又出现第 31 张。
    // 旧实现把整份 sources 再交给 upload，cap(30) 被「已尝试过」的 30 张吃光，
    // 尾部那张永远轮不到。新实现只交「还没有 key」的引用，所以它一定在名单里。
    const batches: string[][] = [];
    const worker = new StreamingImages(async (sources) => {
      batches.push(sources);
      return new Map(sources.filter((s) => s.includes('late')).map((s) => [s, `key_${s}`]));
    }, () => undefined);

    const many = Array.from({ length: MAX_IMAGES }, (_, i) => `![i${i}](early${i}.png)`).join('\n');
    worker.refresh(many);
    await until(() => batches.length === 1);
    worker.refresh(`${many}\n![late](late.png)`); // 配额已满：流式期不会尝试第 31 张
    await new Promise((r) => setTimeout(r, 0));

    const images = await worker.finalize(`${many}\n![late](late.png)`);
    expect(batches[1]).toContain('late.png');
    expect(images.get('late.png')).toBe('key_late.png');
  });

  it('已经拿到 key 的引用不会在兜底趟被重复上传', async () => {
    const batches: string[][] = [];
    const worker = new StreamingImages(async (sources) => {
      batches.push(sources);
      return new Map(sources.map((s) => [s, `key_${s}`]));
    }, () => undefined);

    worker.refresh('![a](a.png)');
    await until(() => worker.images.size === 1);
    await worker.finalize('![a](a.png)\n![b](b.png)');
    expect(batches[1]).toEqual(['b.png']); // 只有缺的那张
  });

  it('a failing upload callback never rejects the turn', async () => {
    const worker = new StreamingImages(
      () => Promise.reject(new Error('boom')),
      () => undefined,
    );
    worker.refresh('![x](a.png)');
    await expect(worker.finalize('')).resolves.toBeInstanceOf(Map);
  });
});
