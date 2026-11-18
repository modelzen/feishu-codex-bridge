import type { LarkChannel } from '@larksuiteoapi/node-sdk';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../src/config/schema';
import {
  printVonvonRecommendation,
  sendVonvonNoticeOnce,
  VONVON_RECOMMENDATION,
  VONVON_SITE,
} from '../src/core/vonvon-notice';

// 0.6.15：macOS 上推荐 Vonvon Bot。终端推荐行、给主人私聊一次（每个 bot 只发一次）。
// Windows、Linux 完全不提示。

const OWNER = 'ou_owner_open_id';
const cfgWith = (access: object): AppConfig => ({ preferences: { access } }) as unknown as AppConfig;

type Create = (payload: {
  params: { receive_id_type: string };
  data: { receive_id: string; msg_type: string; content: string };
}) => Promise<unknown>;

function fakeChannel(create: Create): Pick<LarkChannel, 'rawClient'> {
  return { rawClient: { im: { v1: { message: { create } } } } } as unknown as Pick<LarkChannel, 'rawClient'>;
}

let dir: string;
let recordFile: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vonvon-notice-'));
  recordFile = join(dir, 'bots', 'cli_a', 'vonvon-notice.json');
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe('终端推荐行', () => {
  it('macOS：打印那一句推荐，带网址和一键导入', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    printVonvonRecommendation('darwin');
    expect(log).toHaveBeenCalledTimes(1);
    const line = String(log.mock.calls[0]![0]);
    expect(line).toBe(
      'Mac 用户推荐改用 Vonvon Bot（免费）：https://vonvon.bot ，可以一键导入现有的 bot、群和会话。',
    );
    expect(line).toBe(VONVON_RECOMMENDATION);
    expect(line).not.toContain('停止维护');
  });

  it.each(['linux', 'win32', 'freebsd'] as const)('%s：完全不提示', (platform) => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    printVonvonRecommendation(platform);
    expect(log).not.toHaveBeenCalled();
  });
});

describe('sendVonvonNoticeOnce', () => {
  it('macOS 第一次：只私聊主人（open_id），内容是推荐，不写停止维护；随后记下已发', async () => {
    const create = vi.fn<Create>().mockResolvedValue({ code: 0, data: { message_id: 'om_1' } });
    const r = await sendVonvonNoticeOnce({
      cfg: cfgWith({ ownerOpenId: OWNER, admins: ['ou_admin'] }),
      channel: fakeChannel(create),
      platform: 'darwin',
      recordFile,
      now: () => Date.UTC(2026, 9, 27),
    });
    expect(r).toBe('sent');
    expect(create).toHaveBeenCalledTimes(1);
    const call = create.mock.calls[0]![0];
    expect(call.params).toEqual({ receive_id_type: 'open_id' });
    expect(call.data.receive_id).toBe(OWNER); // 只发主人，管理员和群都没有
    expect(call.data.msg_type).toBe('text');
    const text = (JSON.parse(call.data.content) as { text: string }).text;
    expect(text).toContain(VONVON_SITE);
    expect(text).toContain(VONVON_RECOMMENDATION);
    expect(text).not.toContain('停止维护');
    expect(JSON.parse(readFileSync(recordFile, 'utf8'))).toEqual({ version: 1, sentAt: '2026-10-27T00:00:00.000Z' });
  });

  it('以后再启动不再发（记录在）', async () => {
    const create = vi.fn<Create>().mockResolvedValue({ code: 0 });
    const opts = { cfg: cfgWith({ ownerOpenId: OWNER }), channel: fakeChannel(create), platform: 'darwin', recordFile } as const;
    expect(await sendVonvonNoticeOnce(opts)).toBe('sent');
    expect(await sendVonvonNoticeOnce(opts)).toBe('skipped');
    expect(await sendVonvonNoticeOnce(opts)).toBe('skipped');
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('记录文件内容坏了也算发过，不重复打扰', async () => {
    mkdirSync(dirname(recordFile), { recursive: true }); // 记录在 bots/cli_a/ 下，目录要先建
    writeFileSync(recordFile, '{broken');
    const create = vi.fn<Create>();
    const r = await sendVonvonNoticeOnce({
      cfg: cfgWith({ ownerOpenId: OWNER }),
      channel: fakeChannel(create),
      platform: 'darwin',
      recordFile,
    });
    expect(r).toBe('skipped');
    expect(create).not.toHaveBeenCalled();
  });

  it('老 config 没有 ownerOpenId：回退到第一个管理员（和 resolveOwner 一致），仍只发一个人', async () => {
    const create = vi.fn<Create>().mockResolvedValue({ code: 0 });
    await sendVonvonNoticeOnce({
      cfg: cfgWith({ admins: ['ou_first', 'ou_second'] }),
      channel: fakeChannel(create),
      platform: 'darwin',
      recordFile,
    });
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]![0].data.receive_id).toBe('ou_first');
  });

  it.each(['linux', 'win32'] as const)('%s：不发私聊，也不写记录', async (platform) => {
    const create = vi.fn<Create>();
    const r = await sendVonvonNoticeOnce({
      cfg: cfgWith({ ownerOpenId: OWNER }),
      channel: fakeChannel(create),
      platform,
      recordFile,
    });
    expect(r).toBe('skipped');
    expect(create).not.toHaveBeenCalled();
    expect(existsSync(recordFile)).toBe(false);
  });

  it('找不到主人（从未注册）：跳过，不乱发', async () => {
    const create = vi.fn<Create>();
    const r = await sendVonvonNoticeOnce({
      cfg: cfgWith({}),
      channel: fakeChannel(create),
      platform: 'darwin',
      recordFile,
    });
    expect(r).toBe('skipped');
    expect(create).not.toHaveBeenCalled();
  });

  it('发送抛错：返回 failed、不抛出、不记录；下次启动再试一次', async () => {
    const create = vi.fn<Create>().mockRejectedValueOnce(new Error('network down')).mockResolvedValue({ code: 0 });
    const opts = { cfg: cfgWith({ ownerOpenId: OWNER }), channel: fakeChannel(create), platform: 'darwin', recordFile } as const;
    await expect(sendVonvonNoticeOnce(opts)).resolves.toBe('failed');
    expect(existsSync(recordFile)).toBe(false);
    await expect(sendVonvonNoticeOnce(opts)).resolves.toBe('sent');
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('SDK 对业务失败不抛错、只返回 code≠0：同样算失败，不记成已发', async () => {
    const create = vi.fn<Create>().mockResolvedValue({ code: 230013, msg: 'bot has no permission' });
    const r = await sendVonvonNoticeOnce({
      cfg: cfgWith({ ownerOpenId: OWNER }),
      channel: fakeChannel(create),
      platform: 'darwin',
      recordFile,
    });
    expect(r).toBe('failed');
    expect(existsSync(recordFile)).toBe(false);
  });

  it('私聊发出去了但记录写不下：仍返回 sent，不抛出', async () => {
    // 记录文件的上级路径是个普通文件，mkdir 必然失败。
    const blocker = join(dir, 'blocker');
    writeFileSync(blocker, '');
    const create = vi.fn<Create>().mockResolvedValue({ code: 0 });
    const r = await sendVonvonNoticeOnce({
      cfg: cfgWith({ ownerOpenId: OWNER }),
      channel: fakeChannel(create),
      platform: 'darwin',
      recordFile: join(blocker, 'vonvon-notice.json'),
    });
    expect(r).toBe('sent');
    expect(create).toHaveBeenCalledTimes(1);
  });
});
