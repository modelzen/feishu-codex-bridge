import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** A real executable fixture, including the npm-style .cmd launch path on Windows. */
export function writeNodeExecutable(
  dir: string,
  name: string,
  source: string,
): { bin: string; script: string } {
  const script = join(dir, `${name}.cjs`);
  const bin = join(dir, process.platform === 'win32' ? `${name}.cmd` : name);
  writeFileSync(script, source.replace(/^#![^\n]*\n/, ''), 'utf8');

  if (process.platform === 'win32') {
    // Quoted batch literals still expand %. Disable ! expansion and escape %
    // in paths; %* intentionally forwards the launcher's arguments unchanged.
    const quote = (value: string): string => `"${value.replace(/%/g, '%%')}"`;
    writeFileSync(bin, [
      '@echo off',
      'setlocal DisableDelayedExpansion',
      `${quote(process.execPath)} ${quote(script)} %*`,
      'exit /b %errorlevel%',
      '',
    ].join('\r\n'));
  } else {
    const quote = (value: string): string => `'${value.replace(/'/g, `'"'"'`)}'`;
    // exec keeps the fixture's PID and signals identical to a native binary.
    writeFileSync(bin, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} "$@"\n`, { mode: 0o755 });
  }
  return { bin, script };
}
