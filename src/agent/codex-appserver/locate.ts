import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from '../../config/paths';

/**
 * Resolve the codex CLI binary, in priority order:
 *   1. $CODEX_BIN (explicit override)
 *   2. PATH (`codex`)
 *   3. bridge private install (~/.feishu-codex-bridge/codex-cli/node_modules/.bin/codex)
 *   4. macOS Codex.app bundled binary
 * Returns null if none found.
 */
export function resolveCodexBin(): string | null {
  const env = process.env.CODEX_BIN;
  if (env && existsSync(env)) return env;

  const onPath = which('codex');
  if (onPath) return onPath;

  const priv = join(paths.codexCliBinDir, 'codex');
  if (existsSync(priv)) return priv;

  const appBundle = '/Applications/Codex.app/Contents/Resources/codex';
  if (process.platform === 'darwin' && existsSync(appBundle)) return appBundle;

  return null;
}

function which(cmd: string): string | null {
  try {
    const out = execFileSync(process.platform === 'win32' ? 'where' : 'which', [cmd], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const first = out.split('\n').map((l) => l.trim()).find(Boolean);
    return first && existsSync(first) ? first : null;
  } catch {
    return null;
  }
}

/** Best-effort version string of the resolved codex binary. */
export function codexVersion(bin: string): string | null {
  try {
    return execFileSync(bin, ['--version'], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}
