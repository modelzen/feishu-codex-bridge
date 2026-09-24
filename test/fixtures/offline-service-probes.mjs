import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const original = childProcess.spawnSync;
childProcess.spawnSync = function (command, args, options) {
  const query = command === 'launchctl' && args[0] === 'list'
    || command === 'systemctl' && (args.includes('list-units') || args.includes('daemon-reload'))
    || command === 'schtasks' && args[0] === '/query'
    || command === 'powershell.exe' && (args.at(-1).includes('Get-ItemProperty') || args.at(-1).includes('Get-CimInstance'))
    || command === 'ps' && args[0] === '-axo';
  if (query) return { pid: 0, output: [null, '', ''], stdout: '', stderr: '', status: 0, signal: null };
  return original.call(this, command, args, options);
};
syncBuiltinESMExports();
