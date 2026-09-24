import { lstatSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';

export type DataRoot = {
  path: string;
  kind: 'fresh' | 'legacy' | 'canonical';
};

function inspectRoot(path: string): string | null {
  try {
    lstatSync(path);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw new Error(`Cannot inspect bridge data directory ${path}: ${String(error)}`, { cause: error });
  }

  try {
    const realPath = realpathSync(path);
    if (!statSync(path).isDirectory()) {
      throw new Error('path is not a directory');
    }
    return realPath;
  } catch (error) {
    throw new Error(`Invalid bridge data directory ${path}: ${String(error)}`, { cause: error });
  }
}

export function resolveDataRoot(home: string): DataRoot {
  const canonicalPath = join(home, '.vonvon-bridge');
  const legacyPath = join(home, '.feishu-codex-bridge');
  const canonical = inspectRoot(canonicalPath);
  const legacy = inspectRoot(legacyPath);

  if (canonical && legacy) {
    if (canonical !== legacy) {
      throw new Error(
        `Bridge data directories ${canonicalPath} and ${legacyPath} contain different stores. Resolve the conflict before starting Bridge.`,
      );
    }
    return { path: canonicalPath, kind: 'canonical' };
  }
  if (canonical) return { path: canonicalPath, kind: 'canonical' };
  if (legacy) return { path: legacyPath, kind: 'legacy' };
  return { path: canonicalPath, kind: 'fresh' };
}
