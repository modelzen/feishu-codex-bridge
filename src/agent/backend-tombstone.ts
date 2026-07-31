import { createHash } from 'node:crypto';
import { join } from 'node:path';

export const LEGACY_BACKEND_TOMBSTONE_DIRECTORY =
  '.legacy-backend-tombstones-v1';

/**
 * Package names never appear in the marker path or contents. A per-package
 * marker avoids a shared JSON read/modify/write race across the desktop host
 * and isolated bot processes.
 */
export function legacyBackendTombstonePath(
  managedRoot: string,
  packageName: string,
): string {
  const digest = createHash('sha256').update(packageName).digest('hex');
  return join(
    managedRoot,
    LEGACY_BACKEND_TOMBSTONE_DIRECTORY,
    `${digest}.disabled`,
  );
}
