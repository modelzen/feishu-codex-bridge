import {homedir} from 'node:os';
import {getServiceAdapter, type ServiceAdapter} from '../service/adapter';
import {inspectHost, type HostInspection} from './client';

export async function controlDesktopService(
  action:string,
  adapter:ServiceAdapter = getServiceAdapter(),
  inspect:()=>Promise<HostInspection> = ()=>inspectHost(homedir()),
) {
  if (!['status','install','start','stop','uninstall'].includes(action)) throw new Error('Unknown service operation.');
  const before = await adapter.status();
  if (action === 'start' && (!before.installed || before.running)) throw new Error('Service must be installed and stopped before starting.');
  if (action === 'install' && before.installed) throw new Error('Service is already installed.');
  if (action === 'install' || action === 'start') {
    const host = await inspect();
    if (host.kind !== 'absent') throw new Error('Stop the current Bridge before changing its service registration.');
    if (action === 'install') await adapter.install();
    else await adapter.restart();
  } else if (action === 'stop' || action === 'uninstall') await adapter.uninstall();
  const {raw: _raw,...status} = await adapter.status();
  return status;
}
