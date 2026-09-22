import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { uploadOutboundImages } from '../src/card/outbound-images';

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

describe('uploadOutboundImages', () => {
  it('uploads a local file inside cwd and maps src → image_key', async () => {
    const cwd = await tmpDir();
    await writeFile(join(cwd, 'a.png'), PNG);
    const { channel, state } = fakeChannel();

    const map = await uploadOutboundImages(channel, ['a.png'], cwd, 'write');
    expect(map.get('a.png')).toMatch(/^img_key_/);
    expect(state.calls).toBe(1);
  });

  it('caches by path+mtime+size — a repeat src does not re-upload', async () => {
    const cwd = await tmpDir();
    await writeFile(join(cwd, 'b.png'), PNG);
    const { channel, state } = fakeChannel();

    await uploadOutboundImages(channel, ['b.png'], cwd, 'write');
    const callsAfterFirst = state.calls;
    await uploadOutboundImages(channel, ['b.png'], cwd, 'write');
    expect(state.calls).toBe(callsAfterFirst); // cache hit, no second upload
  });

  it('rejects a path that escapes the run cwd (no upload, absent from map)', async () => {
    const cwd = await tmpDir();
    const outside = await tmpDir();
    await writeFile(join(outside, 'secret.png'), PNG);
    const { channel, state } = fakeChannel();

    const map = await uploadOutboundImages(channel, [join(outside, 'secret.png'), '../escape.png'], cwd, 'write');
    expect(map.size).toBe(0);
    expect(state.calls).toBe(0);
  });

  it('skips a disallowed extension', async () => {
    const cwd = await tmpDir();
    await writeFile(join(cwd, 'note.txt'), PNG);
    const { channel, state } = fakeChannel();

    const map = await uploadOutboundImages(channel, ['note.txt'], cwd, 'write');
    expect(map.size).toBe(0);
    expect(state.calls).toBe(0);
  });

  it('skips a missing file but keeps a sibling that resolves', async () => {
    const cwd = await tmpDir();
    await writeFile(join(cwd, 'real.png'), PNG);
    const { channel } = fakeChannel();

    const map = await uploadOutboundImages(channel, ['gone.png', 'real.png'], cwd, 'write');
    expect(map.has('gone.png')).toBe(false);
    expect(map.get('real.png')).toMatch(/^img_key_/);
  });
});
