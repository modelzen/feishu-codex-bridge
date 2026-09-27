import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { cliBridgeRouteRevision, readCliBridgeRoute, saveCliBridgeRoute } from '../src/cli-bridge/route';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

it('reading legacy route never creates a file; first explicit selection is revision checked', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'coffee-route-'));
  dirs.push(dir);
  const legacy = readCliBridgeRoute(dir);
  expect(legacy).toEqual({ kind: 'legacy' });
  await expect(readFile(join(dir, 'cli-bridge-route.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(saveCliBridgeRoute('cli_recipient', cliBridgeRouteRevision(legacy), dir)).toEqual({ kind: 'agent', botId: 'cli_recipient' });
  expect(saveCliBridgeRoute(null, cliBridgeRouteRevision(legacy), dir)).toBeNull();
  expect(readCliBridgeRoute(dir)).toEqual({ kind: 'agent', botId: 'cli_recipient' });
});

it('explicit no-recipient persists and invalid file fails closed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'coffee-route-'));
  dirs.push(dir);
  expect(saveCliBridgeRoute(null, cliBridgeRouteRevision({ kind: 'legacy' }), dir)).toEqual({ kind: 'none' });
  expect(readCliBridgeRoute(dir)).toEqual({ kind: 'none' });
  await writeFile(join(dir, 'cli-bridge-route.json'), '{"botId":"invalid"}');
  expect(readCliBridgeRoute(dir)).toEqual({ kind: 'none' });
});
