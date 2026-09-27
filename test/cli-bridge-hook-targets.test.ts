import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect, it} from 'vitest';
import {inspectCliBridgeHookTargets} from '../src/cli-bridge/hooks';

it('reads managed pins per tool without treating unrelated commands as Bridge configuration', async () => {
  const homeDir = await mkdtemp(join(tmpdir(), 'coffee-targets-'));
  try {
    await mkdir(join(homeDir, '.codex'));
    await mkdir(join(homeDir, '.claude'));
    const groups = (commands: string[]) => ({hooks: {Stop: [{hooks: commands.map(command => ({type: 'command', command}))}]}});
    await writeFile(join(homeDir, '.codex/hooks.json'), JSON.stringify(groups([
      'vonvon-bridge hook --bot "cli_a" --agent codex',
      "feishu-codex-bridge hook --bot 'cli_b' --agent codex",
      'another-tool hook --bot cli_unrelated --agent codex',
    ])));
    await writeFile(join(homeDir, '.claude/settings.json'), JSON.stringify(groups(['vonvon-bridge hook --agent claude'])));
    expect(await inspectCliBridgeHookTargets({homeDir})).toEqual({codex: ['cli_a', 'cli_b'], claude: [null]});
  } finally { await rm(homeDir, {recursive: true, force: true}); }
});
