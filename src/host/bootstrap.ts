import { homedir } from 'node:os';
import { acquireMutex, closeMutex } from '../config/data-access';
import { readHostEndpoint } from './discovery';
import { observeShutdown, type ShutdownControl } from './lifecycle';
import { assertKnownOwnersStopped, inspectInstallation } from '../service/control';

export async function runHostRuntime(options: { bot?: string; managed: boolean; control?: ShutdownControl }): Promise<void> {
  const control = options.control ?? observeShutdown(options.managed);
  let lock: Awaited<ReturnType<typeof acquireMutex>> | undefined;
  try {
    if (!process.send) {
      lock = await acquireMutex(homedir(), 'host');
      const existing = await readHostEndpoint(homedir());
      if (existing) throw new Error('kind' in existing ? existing.message : `Host ${existing.pid} is already running.`);
      if (options.managed) {
        const installation = inspectInstallation(homedir());
        if (installation.kind === 'registered') throw new Error(`An existing service is registered (${installation.detail}). Start it and attach, or explicitly stop it first.`);
        assertKnownOwnersStopped(homedir());
      }
    }
    if (control.requested) return;
    const { runRun } = await import('../cli/commands/run');
    await runRun(options.bot, { control, managed: options.managed });
  } finally {
    control.dispose();
    if (lock) await closeMutex(lock);
  }
}
