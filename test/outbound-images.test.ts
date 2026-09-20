import { mkdtemp, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { imageSources, uploadOutboundImages } from '../src/card/outbound-images';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // tiny but non-empty

const dirs: string[] = [];
async function tmpDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'outbound-img-'));
  dirs.push(d);
  return d;
}
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

/** A LarkChannel stub whose image.create returns a fresh key and counts calls. */
function fakeChannel() {
  const state = { calls: 0 };
  const channel = {
    rawClient: {
      im: {
        v1: {
          image: {
            create: async () => {
              state.calls += 1;
              return { image_key: `img_key_${state.calls}` };
            },
          },
        },
      },
    },
  };
  return { channel: channel as any, state };
}

describe('imageSources', () => {
  it('extracts srcs in order, deduped, unwrapping <> and dropping titles', () => {
    const text = '![a](one.png) text ![b](<two with space.png>) ![c](three.png "t") ![dup](one.png)';
    expect(imageSources(text)).toEqual(['one.png', 'two with space.png', 'three.png']);
  });

  it('finds image refs inside a ```feishu-card fence too (one scan covers both)', () => {
    const text = '答复\n\n```feishu-card\n# T\n![x](inside.png)\n```';
    expect(imageSources(text)).toEqual(['inside.png']);
  });

  it('returns [] when there are no images', () => {
    expect(imageSources('no images here, just `code`')).toEqual([]);
  });
});

describe('uploadOutboundImages', () => {
  it('uploads a local file inside cwd and maps src → image_key', async () => {
    const cwd = await tmpDir();
    await writeFile(join(cwd, 'a.png'), PNG);
    const { channel, state } = fakeChannel();

    const map = await uploadOutboundImages(channel, ['a.png'], cwd);
    expect(map.get('a.png')).toMatch(/^img_key_/);
    expect(state.calls).toBe(1);
  });

  it('caches by path+mtime+size — a repeat src does not re-upload', async () => {
    const cwd = await tmpDir();
    await writeFile(join(cwd, 'b.png'), PNG);
    const { channel, state } = fakeChannel();

    await uploadOutboundImages(channel, ['b.png'], cwd);
    const callsAfterFirst = state.calls;
    await uploadOutboundImages(channel, ['b.png'], cwd);
    expect(state.calls).toBe(callsAfterFirst); // cache hit, no second upload
  });

  it('rejects a path that escapes the run cwd (no upload, absent from map)', async () => {
    const cwd = await tmpDir();
    const outside = await tmpDir();
    await writeFile(join(outside, 'secret.png'), PNG);
    const { channel, state } = fakeChannel();

    const map = await uploadOutboundImages(channel, [join(outside, 'secret.png'), '../escape.png'], cwd);
    expect(map.size).toBe(0);
    expect(state.calls).toBe(0);
  });

  it('skips a disallowed extension', async () => {
    const cwd = await tmpDir();
    await writeFile(join(cwd, 'note.txt'), PNG);
    const { channel, state } = fakeChannel();

    const map = await uploadOutboundImages(channel, ['note.txt'], cwd);
    expect(map.size).toBe(0);
    expect(state.calls).toBe(0);
  });

  it('skips a missing file but keeps a sibling that resolves', async () => {
    const cwd = await tmpDir();
    await writeFile(join(cwd, 'real.png'), PNG);
    const { channel } = fakeChannel();

    const map = await uploadOutboundImages(channel, ['gone.png', 'real.png'], cwd);
    expect(map.has('gone.png')).toBe(false);
    expect(map.get('real.png')).toMatch(/^img_key_/);
  });
});


describe('project permission image boundaries', () => {
  it.each(['qa', 'write'] as const)('%s permits workspace files but rejects outside files and symlink escapes', async (mode) => {
    const cwd = await tmpDir();
    const outside = await tmpDir();
    await writeFile(join(cwd, 'inside.png'), PNG);
    await writeFile(join(outside, 'outside.png'), PNG);
    await symlink(join(outside, 'outside.png'), join(cwd, 'link.png'));
    const { channel, state } = fakeChannel();
    const map = await uploadOutboundImages(channel, ['inside.png', join(outside, 'outside.png'), 'link.png'], cwd, mode);
    expect([...map.keys()]).toEqual(['inside.png']);
    expect(state.calls).toBe(1);
  });

  it('full permits an image outside the workspace', async () => {
    const cwd = await tmpDir();
    const outside = await tmpDir();
    const path = join(outside, 'outside.png');
    await writeFile(path, PNG);
    const { channel, state } = fakeChannel();
    const map = await uploadOutboundImages(channel, [path], cwd, 'full');
    expect(map.has(path)).toBe(true);
    expect(state.calls).toBe(1);
  });
});
