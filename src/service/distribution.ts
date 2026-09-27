import {existsSync, realpathSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnProcess} from '../platform/spawn';

export type Distribution = {kind:'global-npm'|'bundled'|'development'|'unknown';cliPath:string};

export function classifyDistribution(root:string, globalRoot?:string):Distribution {
  const cliPath = join(root,'bin','feishu-codex-bridge.mjs');
  if (existsSync(join(root,'.git'))) return {kind:'development',cliPath};
  if (existsSync(join(root,'..','provenance.json')) && /[\\/]runtime[\\/]core$/.test(root)) return {kind:'bundled',cliPath};
  try {
    if (globalRoot && realpathSync(root) === realpathSync(join(globalRoot,'@modelzen','feishu-codex-bridge'))) return {kind:'global-npm',cliPath};
  } catch {}
  return {kind:'unknown',cliPath};
}

export async function runtimeDistribution():Promise<Distribution> {
  const root = resolve(dirname(fileURLToPath(import.meta.url)),'..');
  const local = classifyDistribution(root);
  if (local.kind !== 'unknown') return local;
  const globalRoot = await new Promise<string|undefined>(resolveRoot=>{
    const child = spawnProcess('npm',['root','-g'],{stdio:['ignore','pipe','ignore']});
    let output = '';
    const timer = setTimeout(()=>{child.kill();resolveRoot(undefined);},5000);
    child.stdout?.on('data',(chunk:Buffer)=>{output += chunk.toString();if(output.length>8192) child.kill();});
    child.once('error',()=>{clearTimeout(timer);resolveRoot(undefined);});
    child.once('close',code=>{clearTimeout(timer);resolveRoot(code===0 && output.length<=8192 ? output.trim():undefined);});
  });
  return classifyDistribution(root,globalRoot);
}
