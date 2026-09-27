import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {it,expect} from 'vitest';
import {classifyDistribution} from '../src/service/distribution';

it('distinguishes bundled service from the active global npm package',()=>{
  const dir=mkdtempSync(join(tmpdir(),'bridge-distribution-'));
  try {
    const globalRoot=join(dir,'node_modules');
    const globalPackage=join(globalRoot,'@modelzen','feishu-codex-bridge');
    const bundled=join(dir,'App','runtime','core');
    mkdirSync(globalPackage,{recursive:true});
    mkdirSync(bundled,{recursive:true});
    writeFileSync(join(bundled,'..','provenance.json'),'{}');
    expect(classifyDistribution(globalPackage,globalRoot).kind).toBe('global-npm');
    expect(classifyDistribution(bundled,globalRoot).kind).toBe('bundled');
    expect(classifyDistribution(join(dir,'unknown'),globalRoot).kind).toBe('unknown');
    mkdirSync(join(dir,'source','.git'),{recursive:true});
    expect(classifyDistribution(join(dir,'source'),globalRoot).kind).toBe('development');
  } finally {rmSync(dir,{recursive:true,force:true});}
});
