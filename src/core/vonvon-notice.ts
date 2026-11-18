import type { LarkChannel } from '@larksuiteoapi/node-sdk';
import { lstat, mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { paths } from '../config/paths';
import { resolveOwner, type AppConfig } from '../config/schema';
import { log } from './logger';

/**
 * 0.6.15 起，macOS 上的 bridge 向用户推荐 Vonvon Bot：`start` / `status` 的终端各多一行，
 * 第一次成功启动时给每个 bot 的主人私聊一次。只提示，不改行为。Windows、Linux 上
 * 一律不提示——Vonvon Bot 目前只有 Mac 版，没有可推荐的。
 */

export const VONVON_SITE = 'https://vonvon.bot';

export const VONVON_RECOMMENDATION = `Mac 用户推荐改用 Vonvon Bot（免费）：${VONVON_SITE} ，可以一键导入现有的 bot、群和会话。`;

/** 私聊正文：同一句推荐，再说明这只是通知，免得被当成「bridge 要停了」。 */
const VONVON_DM_TEXT = `ℹ️ ${VONVON_RECOMMENDATION}\n这只是一条通知，bridge 照常运行，不用现在决定。`;

/** 终端推荐行（`start` / `status`）。非 macOS 什么都不打。 */
export function printVonvonRecommendation(platform: NodeJS.Platform = process.platform): void {
  if (platform === 'darwin') console.log(VONVON_RECOMMENDATION);
}

export type VonvonNoticeResult = 'sent' | 'skipped' | 'failed';

export interface VonvonNoticeOptions {
  cfg: AppConfig;
  channel: Pick<LarkChannel, 'rawClient'>;
  /** 仅测试注入；生产固定 process.platform。 */
  platform?: NodeJS.Platform;
  /** 「已发」记录文件；生产固定当前 bot 目录下的 {@link paths.vonvonNoticeFile}。 */
  recordFile?: string;
  now?: () => number;
}

/** 记录文件在，或者看不清它在不在，都算「已发过」：宁可少发，不重复打扰。 */
async function alreadySent(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code !== 'ENOENT' && code !== 'ENOTDIR';
  }
}

/**
 * 给这个 bot 的主人私聊一次 Vonvon Bot 推荐。只发给主人（`resolveOwner`），不进任何群；
 * 发成功后在 bot 的数据目录里记下，以后不再发。绝不抛出：失败只记日志，下次启动再试
 * （记录只在发成功后才写），不影响 bot 启动。
 */
export async function sendVonvonNoticeOnce(opts: VonvonNoticeOptions): Promise<VonvonNoticeResult> {
  try {
    if ((opts.platform ?? process.platform) !== 'darwin') return 'skipped';
    const recordFile = opts.recordFile ?? paths.vonvonNoticeFile;
    if (await alreadySent(recordFile)) return 'skipped';
    const owner = resolveOwner(opts.cfg);
    if (!owner) {
      log.info('notice', 'vonvon-no-owner');
      return 'skipped';
    }

    // SDK 把 HTTP 200 的业务失败（{code: 99991672, msg}）当成功 resolve，不检查就会
    // 把没发出去的私聊记成已发，永远补不上。
    const res = (await opts.channel.rawClient.im.v1.message.create({
      params: { receive_id_type: 'open_id' },
      data: { receive_id: owner, msg_type: 'text', content: JSON.stringify({ text: VONVON_DM_TEXT }) },
    })) as { code?: number; msg?: string } | undefined;
    if (typeof res?.code === 'number' && res.code !== 0) {
      throw Object.assign(new Error(res.msg ?? `feishu error ${res.code}`), { code: res.code });
    }

    try {
      await mkdir(dirname(recordFile), { recursive: true });
      await writeFile(
        recordFile,
        `${JSON.stringify({ version: 1, sentAt: new Date((opts.now ?? Date.now)()).toISOString() })}\n`,
      );
    } catch (err) {
      // 私聊已经发出去了；记录写不下，下次启动会再发一次，只能记一笔。
      log.fail('notice', err, { phase: 'vonvon-record' });
    }
    log.info('notice', 'vonvon-sent', { to: owner.slice(-6) });
    return 'sent';
  } catch (err) {
    log.fail('notice', err, { phase: 'vonvon-send' });
    return 'failed';
  }
}
