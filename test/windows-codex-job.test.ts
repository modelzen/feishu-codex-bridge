import { expect, it } from 'vitest';
import { WindowsCodexJob } from '../src/agent/codex-appserver/windows-job';

it('uses exactly one Win32 job namespace separator in the runtime name', () => {
  const job = new WindowsCodexJob();
  try {
    const parts = job.name.split(String.fromCharCode(92));
    expect(parts).toHaveLength(2);
    expect(parts[0]).toBe('Local');
    expect(parts[1]).toMatch(/^vonvon-codex-[a-f0-9-]+$/);
  } finally { job.dispose(); }
});
