import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { acquireMutex, assertNoDataLeases, closeMutex } from '../config/data-access';
import { DataRootMigrationError, migrationJournalName, resolveDataRoot } from '../config/data-root';
import { relocateOfflineDataRoot } from '../config/data-root-migration';
import { preflightCompatibility, repairLinkedCompatibility, type BridgeRuntime } from '../config/data-compatibility';
import { assertKnownOwnersStopped, existingDataRoots, inspectInstallation } from '../service/control';

export type HostMigration =
  | { kind: 'unchanged'; path: string }
  | { kind: 'linked'; canonicalPath: string; legacyPath: string }
  | { kind: 'deferred'; message: string }
  | { kind: 'recovery-required'; message: string };

export async function migrateHostDataOffline(home: string, runtime: BridgeRuntime): Promise<HostMigration> {
  let mutationStarted = false;
  try {
    const lock = await acquireMutex(home, 'admission');
    try {
      let unchangedPath: string | undefined;
      try {
        const root = resolveDataRoot(home);
        if (root.kind !== 'legacy' || lstatSync(root.path).isSymbolicLink()) unchangedPath = root.path;
      } catch (error) {
        if (!(error instanceof DataRootMigrationError)) throw error;
        try { lstatSync(join(home, migrationJournalName)); }
        catch { return { kind: 'recovery-required', message: error.message }; }
      }
      assertNoDataLeases(home);
      const installation = inspectInstallation(home);
      if (installation.kind === 'registered') return { kind: 'deferred', message: `Stop and unregister the existing service before migrating (${installation.detail}).` };
      assertKnownOwnersStopped(home);
      for (const root of existingDataRoots(home)) preflightCompatibility(root, runtime);
      mutationStarted = true;
      if (unchangedPath) {
        repairLinkedCompatibility(home, unchangedPath, runtime);
        return { kind: 'unchanged', path: unchangedPath };
      }
      return await relocateOfflineDataRoot(home, ({ canonicalPath }) => repairLinkedCompatibility(home, canonicalPath, runtime));
    } finally { await closeMutex(lock); }
  } catch (error) {
    let pending = false;
    try { lstatSync(join(home, migrationJournalName)); pending = true; }
    catch (inspectionError) {
      if (!(inspectionError instanceof Error && 'code' in inspectionError && inspectionError.code === 'ENOENT')) {
        return { kind: 'recovery-required', message: `Cannot inspect the migration journal: ${inspectionError instanceof Error ? inspectionError.message : String(inspectionError)}` };
      }
    }
    return { kind: mutationStarted || pending || error instanceof DataRootMigrationError ? 'recovery-required' : 'deferred', message: error instanceof Error ? error.message : String(error) };
  }
}
