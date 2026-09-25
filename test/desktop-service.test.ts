import {describe,it,expect} from 'vitest';
import {controlDesktopService} from '../src/host/service';
import type {ServiceAdapter} from '../src/service/adapter';

const state={platformName:'fixture',installed:false,running:false,servicePath:'/isolated/service',stdoutPath:'/isolated/out',stderrPath:'/isolated/err',raw:'private manager output'};
function fixture() {
  const calls:string[]=[];
  const adapter:ServiceAdapter={status:async()=>({...state}),install:async()=>{calls.push('install');return state;},restart:async()=>{calls.push('start');return state;},uninstall:async()=>{calls.push('uninstall');},logs:async()=>{}};
  return {adapter,calls};
}
describe('desktop service boundary',()=>{
  it('status is read only and exposes log paths without raw manager output',async()=>{
    const {adapter,calls}=fixture();
    const result=await controlDesktopService('status',adapter,async()=>{throw new Error('should not inspect');});
    expect(result.stdoutPath).toBe('/isolated/out');
    expect(result.stderrPath).toBe('/isolated/err');
    expect(result).not.toHaveProperty('raw');
    expect(calls).toEqual([]);
  });
  it('does not replace a live or blocked host service registration',async()=>{
    for(const action of ['install','start']) {
      const {adapter,calls}=fixture();
      await expect(controlDesktopService(action,adapter,async()=>({kind:'attached',pid:123}))).rejects.toThrow('Stop the current Bridge');
      expect(calls).toEqual([]);
    }
  });
  it('maps fixed operations and rejects arbitrary commands',async()=>{
    const {adapter,calls}=fixture();
    for(const action of ['install','start','stop','uninstall']) await controlDesktopService(action,adapter,async()=>({kind:'absent'}));
    expect(calls).toEqual(['install','start','uninstall','uninstall']);
    await expect(controlDesktopService('restart; rm',adapter)).rejects.toThrow('Unknown');
    expect(calls).toHaveLength(4);
  });
});
