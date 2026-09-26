import {it,expect,vi} from 'vitest';
import {installLatest} from '../src/service/update';
import {runUpdate} from '../src/cli/commands/update';
import {spawnProcess} from '../src/platform/spawn';
vi.mock('../src/service/distribution',()=>({runtimeDistribution:async()=>({kind:'bundled',cliPath:'/App/runtime/core/bin/bridge'})}));
vi.mock('../src/platform/spawn',()=>({spawnProcess:vi.fn()}));
it('bundled CLI and card update cannot install an unrelated global npm package',async()=>{
  expect((await installLatest()).ok).toBe(false);
  expect(spawnProcess).not.toHaveBeenCalled();
});

it('bundled CLI update points to its desktop owner before querying npm',async()=>{
  const output = vi.spyOn(console,'log').mockImplementation(()=>{});
  try {
    await runUpdate();
    expect(output).toHaveBeenCalledWith('此 CLI 随 Vonvon Bridge 桌面应用提供，请在桌面应用中更新。');
    expect(spawnProcess).not.toHaveBeenCalled();
  } finally { output.mockRestore(); }
});
