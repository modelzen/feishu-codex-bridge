import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { paths } from '../../config/paths';
import { resolveCodexBin, codexVersion } from '../../agent/codex-appserver/locate';

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

/**
 * `feishu-codex-bridge doctor` — local self-check.
 * M0 scope: codex CLI + login, lark-cli, config presence. Connection/session
 * checks come online once the bridge runs (M1+).
 */
export async function runDoctor(): Promise<void> {
  const checks: Check[] = [];

  // codex CLI
  const codexBin = resolveCodexBin();
  if (codexBin) {
    const v = codexVersion(codexBin) ?? 'unknown';
    checks.push({ name: 'codex CLI', ok: true, detail: `${v} (${codexBin})` });
  } else {
    checks.push({
      name: 'codex CLI',
      ok: false,
      detail: '未找到。设置 CODEX_BIN，或安装 @openai/codex，或装 Codex.app',
    });
  }

  // codex login (auth file presence — heuristic)
  const codexAuth = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'auth.json');
  checks.push(
    existsSync(codexAuth)
      ? { name: 'codex 登录', ok: true, detail: codexAuth }
      : { name: 'codex 登录', ok: false, detail: '未登录，运行 `codex login`' },
  );

  // lark-cli
  const larkVer = tryExec('lark-cli', ['--version']);
  checks.push(
    larkVer
      ? { name: 'lark-cli', ok: true, detail: larkVer }
      : { name: 'lark-cli', ok: false, detail: '未找到（onboarding 会装到私有目录）' },
  );

  // bridge config
  checks.push(
    existsSync(paths.configFile)
      ? { name: 'bridge 配置', ok: true, detail: paths.configFile }
      : { name: 'bridge 配置', ok: false, detail: '未配置，运行 `feishu-codex-bridge start` 完成 onboarding' },
  );

  // render
  console.log('\n🩺 feishu-codex-bridge 自检\n');
  for (const c of checks) {
    console.log(`  ${c.ok ? '✅' : '❌'} ${c.name.padEnd(12)} ${c.detail}`);
  }
  const failed = checks.filter((c) => !c.ok).length;
  console.log(`\n${failed === 0 ? '全部通过 ✓' : `${failed} 项需处理`}\n`);
  process.exitCode = failed === 0 ? 0 : 1;
}

function tryExec(cmd: string, args: string[]): string | null {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}
