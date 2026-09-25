import {it,expect,vi} from 'vitest';
import {installLatest} from '../src/service/update';
import {spawnProcess} from '../src/platform/spawn';
vi.mock('../src/service/distribution',()=>({runtimeDistribution:async()=>({kind:'bundled',cliPath:'/App/runtime/core/bin/bridge'})}));
vi.mock('../src/platform/spawn',()=>({spawnProcess:vi.fn()}));
it('bundled CLI and card update cannot install an unrelated global npm package',async()=>{
  expect((await installLatest()).ok).toBe(false);
  expect(spawnProcess).not.toHaveBeenCalled();
});
