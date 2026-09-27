import type { AdminService } from '../admin/service';
import { log } from '../core/logger';
import { clearWebConsole, publishWebConsole, stableWebConsoleToken } from './discovery';
import { createWebServer, DEFAULT_WEB_PORT } from './server';

/**
 * daemon（run / supervisor）进程内挂 Web 控制台。
 *
 *   - daemon 是控制台的**权威持有者**，始终占规范端口 51847——这样浏览器里那条
 *     `127.0.0.1:51847/?token=…` 的 URL 在「重启 / 预览→daemon 切换」后依然有效，
 *     不再被换端口甩成新页面。重启时老实例先 close() 释放端口（见 run/supervisor
 *     的 shutdown），这里短重试抢回同一端口；只读预览改用临时端口、绝不抢 51847。
 *   - token 也稳定（{@link stableWebConsoleToken} 持久化 0600），重启后旧 URL 的
 *     token 不再 401。
 *   - 51847 实在抢不到（极少：被外部进程长期占着）才退临时端口兜底——发现文件透出
 *     真实端口，`web` 子命令不靠猜。
 *   - 起不来只告警，**绝不拖垮 bot 主流程**（控制台是旁路，不是必需品）。
 *   - 成功后写发现文件（0600，{port, token, pid}），并挂 process exit 钩子
 *     兜底清理（正常路径走返回的 close()）。
 */
export interface MountedWebConsole {
  url: string;
  port: number;
  close: () => Promise<void>;
}

/** 抢规范端口：被占（典型＝重启时老实例还没完全释放）就短重试，约 5s 内拿不到才退临时端口。 */
async function listenCanonical(
  web: ReturnType<typeof createWebServer>,
  attempts = 25,
  gapMs = 200,
): Promise<{ port: number; url: string }> {
  for (let i = 0; i < attempts; i++) {
    try {
      return await web.listen(DEFAULT_WEB_PORT);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, gapMs));
    }
  }
  log.warn('web', 'console-port-busy-fallback', { preferred: DEFAULT_WEB_PORT });
  return web.listen(0); // 临时端口兜底
}

export async function mountWebConsole(service: AdminService): Promise<MountedWebConsole | undefined> {
  const web = createWebServer({ service, token: stableWebConsoleToken() });
  let port: number;
  let url: string;
  try {
    ({ port, url } = await listenCanonical(web));
  } catch (err) {
    log.fail('web', err, { phase: 'console-listen' });
    return undefined;
  }

  publishWebConsole({ port, token: web.token, pid: process.pid, startedAt: Date.now() });
  const exitCleanup = (): void => clearWebConsole();
  process.once('exit', exitCleanup);
  log.info('web', 'console-up', { port }); // 只记端口，token 绝不进日志

  return {
    url,
    port,
    close: async (): Promise<void> => {
      process.removeListener('exit', exitCleanup);
      await web.close();
      clearWebConsole();
    },
  };
}
