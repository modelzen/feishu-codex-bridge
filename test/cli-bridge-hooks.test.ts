import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildEmbeddedBridgeHookCommand,
  inspectCliBridgeHooks,
  installCliBridgeHooks,
  resolveBridgeHookCommand,
  resolveBridgeRepairHookCommand,
  transformLegacyBridgeHookCommands,
  uninstallCliBridgeHooks,
} from '../src/cli-bridge/hooks';
import { configurePathRoots } from '../src/config/paths';
import { configureEmbeddedRuntimeHost } from '../src/core/runtime-context';

async function home(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'fcb-hooks-'));
}

describe('cli bridge hook installer', () => {
  it('exports the pure desktop command and legacy transform seams publicly', async () => {
    const api = await import('../src/runtime/index');

    expect(api.buildEmbeddedBridgeHookCommand).toBe(buildEmbeddedBridgeHookCommand);
    expect(api.transformLegacyBridgeHookCommands).toBe(transformLegacyBridgeHookCommands);
  });

  it('installs Claude PermissionRequest and Stop hooks', async () => {
    const h = await home();
    await writeFile(join(h, '.claude', 'settings.json'), JSON.stringify({ hooks: {} }), { flag: 'w' }).catch(async () => {
      await import('node:fs/promises').then((fs) => fs.mkdir(join(h, '.claude'), { recursive: true }));
      await writeFile(join(h, '.claude', 'settings.json'), JSON.stringify({ hooks: {} }));
    });

    await installCliBridgeHooks({ homeDir: h, agents: { claude: true, codex: false }, command: 'feishu-codex-bridge hook' });
    const settings = JSON.parse(await readFile(join(h, '.claude', 'settings.json'), 'utf8'));
    expect(settings.hooks.PermissionRequest[0].hooks[0].command).toContain('--agent claude');
    expect(settings.hooks.Stop[0].hooks[0].command).toContain('--agent claude');
    // long timeout so the CLI doesn't kill the hook before a human approves
    expect(settings.hooks.PermissionRequest[0].hooks[0].timeout).toBe(86400);
  });

  it('detects an installed hook written in the absolute node+script command form', async () => {
    const h = await home();
    const { resolveBridgeHookCommand } = await import('../src/cli-bridge/hooks');
    await installCliBridgeHooks({ homeDir: h, agents: { claude: true, codex: false }, command: resolveBridgeHookCommand() });
    const settings = JSON.parse(await readFile(join(h, '.claude', 'settings.json'), 'utf8'));
    const command = settings.hooks.PermissionRequest[0].hooks[0].command;
    // No bare `feishu-codex-bridge` on PATH required — runs node against this CLI's script.
    expect(command).toContain('hook --agent claude');
    expect(command).toContain(process.execPath);
    expect((await inspectCliBridgeHooks({ homeDir: h })).claude.status).toBe('installed');
  });

  it('detects an installed hook with an explicit bot selector', async () => {
    const h = await home();
    const { resolveBridgeHookCommand } = await import('../src/cli-bridge/hooks');
    await installCliBridgeHooks({ homeDir: h, agents: { claude: true, codex: false }, command: resolveBridgeHookCommand('app_beta') });
    const settings = JSON.parse(await readFile(join(h, '.claude', 'settings.json'), 'utf8'));
    const command = settings.hooks.PermissionRequest[0].hooks[0].command;
    expect(command).toContain('hook --bot "app_beta" --agent claude');
    expect((await inspectCliBridgeHooks({ homeDir: h })).claude.status).toBe('installed');
  });

  it('keeps standalone repair pinned while embedded repair uses the global router', () => {
    const standalone = resolveBridgeRepairHookCommand('app_alpha');
    expect(standalone).toContain(' hook --bot "app_alpha"');

    configurePathRoots({
      dataDir: '/tmp/vonvon-bot/app_alpha',
      hostDataDir: '/tmp/vonvon-host',
      legacyAssetsDir: '/tmp/legacy-assets',
      writableAssetsDir: '/tmp/vonvon-host/compat-assets',
    });
    const revoke = configureEmbeddedRuntimeHost({ requestRestart() {} });
    try {
      const embedded = resolveBridgeRepairHookCommand('app_alpha');
      expect(embedded).not.toContain(' --bot ');
      expect(embedded).toContain('--bridge-data-dir "/tmp/vonvon-host"');
    } finally {
      revoke();
    }
  });

  it('generates a host-root desktop command and only adds a bot selector when explicit', () => {
    configurePathRoots({
      dataDir: '/tmp/vonvon-bot/app_alpha',
      hostDataDir: '/tmp/vonvon-host',
      legacyAssetsDir: '/tmp/legacy-assets',
      writableAssetsDir: '/tmp/vonvon-host/compat-assets',
    });
    const revoke = configureEmbeddedRuntimeHost({ requestRestart() {} });
    try {
      const globalCommand = resolveBridgeHookCommand();
      expect(globalCommand).toContain(process.execPath);
      expect(globalCommand).not.toContain(' --bot ');
      expect(globalCommand).toContain('--bridge-data-dir "/tmp/vonvon-host"');
      expect(globalCommand).toContain('--bridge-writable-assets-dir "/tmp/vonvon-host/compat-assets"');
      expect(globalCommand).toContain('--bridge-legacy-assets-dir "/tmp/legacy-assets"');
      expect(globalCommand).not.toContain('feishu-codex-bridge hook');

      const selectedCommand = resolveBridgeHookCommand('app embedded');
      expect(selectedCommand).toContain(' hook --bot "app embedded"');
      expect(selectedCommand).toContain('--bridge-data-dir "/tmp/vonvon-host"');
    } finally {
      revoke();
    }
  });

  it('strictly reports a legacy command as needing repair against the desktop command', async () => {
    const h = await home();
    const expectedCommand = '"/Applications/Vonvon Bridge.app/Contents/MacOS/vonvon-runtime" hook'
      + ' --bridge-data-dir "/tmp/vonvon"'
      + ' --bridge-writable-assets-dir "/tmp/vonvon/compat-assets"'
      + ' --bridge-legacy-assets-dir "/tmp/legacy"';
    await installCliBridgeHooks({
      homeDir: h,
      agents: { claude: true, codex: false },
      command: 'feishu-codex-bridge hook',
    });

    expect((await inspectCliBridgeHooks({
      homeDir: h,
      expectedCommand,
    })).claude.status).toBe('needs_repair');

    await installCliBridgeHooks({
      homeDir: h,
      agents: { claude: true, codex: false },
      command: expectedCommand,
    });
    expect((await inspectCliBridgeHooks({
      homeDir: h,
      expectedCommand,
    })).claude.status).toBe('installed');

    const explicitCommand = buildEmbeddedBridgeHookCommand({
      executable: '/Applications/Vonvon Bridge.app/Contents/MacOS/vonvon-runtime',
      hostDataDir: '/tmp/vonvon',
      writableAssetsDir: '/tmp/vonvon/compat-assets',
      legacyAssetsDir: '/tmp/legacy',
      botAppId: 'app_beta',
      platform: 'darwin',
    });
    await installCliBridgeHooks({
      homeDir: h,
      agents: { claude: true, codex: false },
      command: explicitCommand,
    });
    expect((await inspectCliBridgeHooks({
      homeDir: h,
      expectedCommand,
    })).claude.status).toBe('installed');
  });

  it('purely rewrites recognized legacy bridge commands and preserves explicit bot routing', () => {
    const original = {
      futureSetting: { keep: true },
      hooks: {
        PermissionRequest: [{
          matcher: '*',
          futureGroupField: 'keep',
          hooks: [
            {
              type: 'command',
              command: '"/opt/homebrew/bin/node" "/opt/homebrew/lib/node_modules/@modelzen/feishu-codex-bridge/dist/cli.js" hook --bot "app_beta" --agent claude',
              timeout: 86400,
            },
            { type: 'command', command: '/usr/local/bin/my-own-hook' },
          ],
        }],
        Stop: [{
          hooks: [{
            type: 'command',
            command: '/tmp/agent2lark-hook --source claude',
          }],
        }],
      },
    };
    const snapshot = structuredClone(original);
    const expectedCommand = '"/Applications/Vonvon Bridge.app/Contents/MacOS/vonvon-runtime" hook'
      + ' --bridge-data-dir "/tmp/vonvon"'
      + ' --bridge-writable-assets-dir "/tmp/vonvon/compat-assets"'
      + ' --bridge-legacy-assets-dir "/tmp/legacy"';
    const buildCommand = (botAppId?: string) => buildEmbeddedBridgeHookCommand({
      executable: '/Applications/Vonvon Bridge.app/Contents/MacOS/vonvon-runtime',
      hostDataDir: '/tmp/vonvon',
      writableAssetsDir: '/tmp/vonvon/compat-assets',
      legacyAssetsDir: '/tmp/legacy',
      ...(botAppId === undefined ? {} : { botAppId }),
      platform: 'darwin',
    });

    const transformed = transformLegacyBridgeHookCommands(original, { buildCommand });

    expect(original).toEqual(snapshot);
    expect(transformed.rewrittenCount).toBe(1);
    expect(transformed.value.futureSetting).toEqual({ keep: true });
    expect(transformed.value.hooks?.PermissionRequest?.[0]?.futureGroupField).toBe('keep');
    expect(transformed.value.hooks?.PermissionRequest?.[0]?.hooks?.[0]?.command).toBe(
      '"/Applications/Vonvon Bridge.app/Contents/MacOS/vonvon-runtime" hook'
      + ' --bot "app_beta"'
      + ' --bridge-data-dir "/tmp/vonvon"'
      + ' --bridge-writable-assets-dir "/tmp/vonvon/compat-assets"'
      + ' --bridge-legacy-assets-dir "/tmp/legacy"'
      + ' --agent claude',
    );
    expect(transformed.value.hooks?.PermissionRequest?.[0]?.hooks?.[1]?.command).toBe(
      '/usr/local/bin/my-own-hook',
    );
    expect(transformed.value.hooks?.Stop?.[0]?.hooks?.[0]?.command).toContain(
      'agent2lark-hook',
    );

    const repeated = transformLegacyBridgeHookCommands(transformed.value, { buildCommand });
    expect(repeated.rewrittenCount).toBe(0);
    expect(repeated.value).toEqual(transformed.value);
  });

  it('uses the packaged sidecar executable directly for embedded hooks', () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, 'pkg');
    Object.defineProperty(process, 'pkg', {
      configurable: true,
      value: {},
    });
    const revoke = configureEmbeddedRuntimeHost({ requestRestart() {} });
    try {
      const command = resolveBridgeHookCommand('app_packaged');
      expect(command).toContain(process.execPath);
      expect(command).toContain(' hook --bot ');
      expect(command).toContain('--bridge-data-dir');
      expect(command).not.toContain(process.argv[1] ?? '__missing_entry__');
    } finally {
      revoke();
      if (descriptor) Object.defineProperty(process, 'pkg', descriptor);
      else Reflect.deleteProperty(process, 'pkg');
    }
  });

  it('installs Codex hooks and feature flag', async () => {
    const h = await home();
    await installCliBridgeHooks({ homeDir: h, agents: { claude: false, codex: true }, command: 'feishu-codex-bridge hook' });
    const hooks = JSON.parse(await readFile(join(h, '.codex', 'hooks.json'), 'utf8'));
    const toml = await readFile(join(h, '.codex', 'config.toml'), 'utf8');
    expect(hooks.hooks.PermissionRequest[0].hooks[0].command).toContain('--agent codex');
    expect(hooks.hooks.Stop[0].hooks[0].command).toContain('--agent codex');
    expect(hooks.hooks.Stop[0].hooks[0].timeout).toBe(86400);
    expect(toml).toContain('hooks = true');
  });

  it('reports and replaces old agent2lark hook entries', async () => {
    const h = await home();
    await import('node:fs/promises').then((fs) => fs.mkdir(join(h, '.codex'), { recursive: true }));
    await writeFile(join(h, '.codex', 'hooks.json'), JSON.stringify({
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: '/tmp/agent2lark-hook --source codex' }] }],
        PreToolUse: [{ hooks: [{ type: 'command', command: '/tmp/agent2lark-hook --source codex' }] }],
        PostToolUse: [{ hooks: [{ type: 'command', command: '/tmp/agent2lark-hook --source codex' }] }],
      },
    }));
    expect((await inspectCliBridgeHooks({ homeDir: h })).codex.status).toBe('conflict_agent2lark');
    await installCliBridgeHooks({ homeDir: h, agents: { claude: false, codex: true }, command: 'feishu-codex-bridge hook' });
    const text = await readFile(join(h, '.codex', 'hooks.json'), 'utf8');
    expect(text).not.toContain('agent2lark-hook');
    expect(text).toContain('feishu-codex-bridge hook');
    expect((await inspectCliBridgeHooks({ homeDir: h })).codex.status).toBe('installed');
  });

  it('removes old Claude agent2lark PostToolUse hooks during repair', async () => {
    const h = await home();
    await import('node:fs/promises').then((fs) => fs.mkdir(join(h, '.claude'), { recursive: true }));
    await writeFile(join(h, '.claude', 'settings.json'), JSON.stringify({
      hooks: {
        PermissionRequest: [{ matcher: '*', hooks: [{ type: 'command', command: '/tmp/agent2lark-hook --source claude' }] }],
        PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: '/tmp/agent2lark-hook --source claude' }] }],
      },
    }));

    expect((await inspectCliBridgeHooks({ homeDir: h })).claude.status).toBe('conflict_agent2lark');
    await installCliBridgeHooks({ homeDir: h, agents: { claude: true, codex: false }, command: 'feishu-codex-bridge hook' });

    const text = await readFile(join(h, '.claude', 'settings.json'), 'utf8');
    expect(text).not.toContain('agent2lark-hook');
    expect((await inspectCliBridgeHooks({ homeDir: h })).claude.status).toBe('installed');
  });

  it('reports needs_repair when codex hooks.json is installed but config.toml lacks the feature flag', async () => {
    const h = await home();
    await installCliBridgeHooks({ homeDir: h, agents: { claude: false, codex: true }, command: 'feishu-codex-bridge hook' });
    expect((await inspectCliBridgeHooks({ homeDir: h })).codex.status).toBe('installed');
    // strip the [features] hooks=true flag the installer wrote — hooks.json stays intact
    const fs = await import('node:fs/promises');
    await fs.writeFile(join(h, '.codex', 'config.toml'), '[features]\nweb_search = true\n');
    expect((await inspectCliBridgeHooks({ homeDir: h })).codex.status).toBe('needs_repair');
  });

  it('uninstalls bridge hooks while preserving unrelated user hooks', async () => {
    const h = await home();
    await import('node:fs/promises').then((fs) => fs.mkdir(join(h, '.claude'), { recursive: true }));
    await writeFile(join(h, '.claude', 'settings.json'), JSON.stringify({
      hooks: {
        PermissionRequest: [{ matcher: '*', hooks: [{ type: 'command', command: '/usr/local/bin/my-own-hook' }] }],
      },
    }));
    await installCliBridgeHooks({ homeDir: h, agents: { claude: true, codex: false }, command: 'feishu-codex-bridge hook' });
    const afterInstall = JSON.parse(await readFile(join(h, '.claude', 'settings.json'), 'utf8'));
    // unrelated hook survives install
    expect(JSON.stringify(afterInstall)).toContain('my-own-hook');
    expect((await inspectCliBridgeHooks({ homeDir: h })).claude.status).toBe('installed');

    await uninstallCliBridgeHooks({ homeDir: h });
    const afterUninstall = JSON.parse(await readFile(join(h, '.claude', 'settings.json'), 'utf8'));
    expect(JSON.stringify(afterUninstall)).not.toContain('feishu-codex-bridge hook');
    expect(JSON.stringify(afterUninstall)).toContain('my-own-hook');
  });

  it('uninstalls only matching hooks inside a mixed hook group', async () => {
    const h = await home();
    await import('node:fs/promises').then((fs) => fs.mkdir(join(h, '.claude'), { recursive: true }));
    await writeFile(join(h, '.claude', 'settings.json'), JSON.stringify({
      hooks: {
        PermissionRequest: [{
          matcher: '*',
          hooks: [
            { type: 'command', command: '/usr/local/bin/my-own-hook' },
            { type: 'command', command: 'feishu-codex-bridge hook --agent claude' },
          ],
        }],
      },
    }));

    await uninstallCliBridgeHooks({ homeDir: h });

    const afterUninstall = JSON.parse(await readFile(join(h, '.claude', 'settings.json'), 'utf8'));
    expect(afterUninstall.hooks.PermissionRequest[0].hooks).toEqual([
      { type: 'command', command: '/usr/local/bin/my-own-hook' },
    ]);
  });

  it('clears the codex hooks feature flag on uninstall, keeping unrelated features', async () => {
    const h = await home();
    await import('node:fs/promises').then((fs) => fs.mkdir(join(h, '.codex'), { recursive: true }));
    await writeFile(join(h, '.codex', 'config.toml'), '[features]\nweb_search = true\n');
    await installCliBridgeHooks({ homeDir: h, agents: { claude: false, codex: true }, command: 'feishu-codex-bridge hook' });
    expect(await readFile(join(h, '.codex', 'config.toml'), 'utf8')).toContain('hooks = true');

    await uninstallCliBridgeHooks({ homeDir: h });
    const toml = await readFile(join(h, '.codex', 'config.toml'), 'utf8');
    expect(toml).not.toMatch(/hooks\s*=\s*true/);
    // an unrelated feature flag in the same section survives
    expect(toml).toContain('web_search = true');
  });
});
