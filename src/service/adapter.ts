import {
  installLaunchd,
  restartLaunchd,
  statusLaunchd,
  tailLaunchdLogs,
  uninstallLaunchd,
  type LaunchdStatus,
} from './launchd';

export type ServiceStatus = LaunchdStatus;

export interface ServiceAdapter {
  install(): Promise<ServiceStatus>;
  uninstall(): Promise<void>;
  status(): Promise<ServiceStatus>;
  restart(): Promise<ServiceStatus>;
  logs(follow: boolean): Promise<void>;
}

export function getServiceAdapter(): ServiceAdapter {
  if (process.platform !== 'darwin') {
    throw new Error('service：当前平台暂不支持，后续会支持 Windows/systemd。');
  }

  return {
    install: installLaunchd,
    uninstall: uninstallLaunchd,
    status: async () => statusLaunchd(),
    restart: restartLaunchd,
    logs: tailLaunchdLogs,
  };
}
