import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Explicit opt-in: the ordinary unit suite never registers an OS service.
const result = spawnSync(process.execPath, [
  fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url)),
  'run',
  'test/service-smoke.test.ts',
  ...process.argv.slice(2),
], {
  stdio: 'inherit',
  env: { ...process.env, FEISHU_BRIDGE_NATIVE_SERVICE_TEST: '1' },
});
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
