import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

// Assignment while suspended closes the spawn-before-ownership race. The job
// retains descendants even when an intermediate npm/cmd wrapper has exited.
const jobSource = String.raw`
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.IO;
public static class CodexJob {
  [StructLayout(LayoutKind.Sequential)] struct IO { public ulong readOperations,writeOperations,otherOperations,readBytes,writeBytes,otherBytes; }
  [StructLayout(LayoutKind.Sequential)] struct Limits {
    public long processTime,jobTime; public uint flags; public UIntPtr minWorkingSet,maxWorkingSet; public uint active;
    public UIntPtr affinity; public uint priority,scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct Extended {
    public Limits basic; public IO io; public UIntPtr processMemory,jobMemory,peakProcess,peakJob;
  }
  [StructLayout(LayoutKind.Sequential)] struct Accounting {
    public long userTime,kernelTime,periodUserTime,periodKernelTime; public uint faults,total,active,terminated;
  }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Startup {
    public uint size; public string reserved,desktop,title; public uint x,y,xsize,ysize,xchars,ychars,fill,flags;
    public ushort show,reservedSize; public IntPtr reservedData,input,output,error;
  }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr process,thread; public uint pid,tid; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attrs,string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int kind,ref Extended info,uint size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int kind,out Accounting info,uint size,IntPtr returned);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint code);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string app,StringBuilder args,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref Startup startup,out ProcessInfo process);
  [DllImport("kernel32.dll")] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle,uint ms);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process,uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int id);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetHandleInformation(IntPtr handle,uint mask,uint flags);
  static void Check(bool ok) { if(!ok) throw new Win32Exception(Marshal.GetLastWin32Error()); }
  static bool Empty(IntPtr job) {
    Accounting info; Check(QueryInformationJobObject(job,1,out info,(uint)Marshal.SizeOf(typeof(Accounting)),IntPtr.Zero));
    return info.active == 0;
  }
  static void Drain(IntPtr job) {
    var deadline=DateTime.UtcNow.AddSeconds(2);
    while(!Empty(job)) { if(DateTime.UtcNow>=deadline) throw new Exception("Job termination timed out"); Thread.Sleep(10); }
  }
  public static int Run(string name,string executable,string command,string proof) {
    IntPtr job=IntPtr.Zero; ProcessInfo child=new ProcessInfo();
    try {
      if(File.Exists(proof+".stop")) { File.WriteAllText(proof,name); return 1; }
      job=CreateJobObject(IntPtr.Zero,name); Check(job!=IntPtr.Zero);
      var limits=new Extended(); limits.basic.flags=0x2000;
      Check(SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(typeof(Extended))));
      var startup=new Startup(); startup.size=(uint)Marshal.SizeOf(typeof(Startup)); startup.flags=0x100;
      startup.input=GetStdHandle(-10); startup.output=GetStdHandle(-11); startup.error=GetStdHandle(-12);
      Check(SetHandleInformation(startup.input,1,1)); Check(SetHandleInformation(startup.output,1,1)); Check(SetHandleInformation(startup.error,1,1));
      Check(CreateProcess(executable,new StringBuilder(command),IntPtr.Zero,IntPtr.Zero,true,4,IntPtr.Zero,null,ref startup,out child));
      Check(AssignProcessToJobObject(job,child.process));
      Check(ResumeThread(child.thread)!=0xffffffff);
      while(!Empty(job)) {
        if(File.Exists(proof+".stop")) { Check(TerminateJobObject(job,1)); Drain(job); break; }
        Thread.Sleep(10);
      }
      Check(WaitForSingleObject(child.process,1000)==0);
      uint code; Check(GetExitCodeProcess(child.process,out code));
      File.WriteAllText(proof,name);
      return unchecked((int)code);
    } catch {
      try {
        if(child.process!=IntPtr.Zero) { TerminateProcess(child.process,1); Check(WaitForSingleObject(child.process,1000)==0); }
        if(job!=IntPtr.Zero) { Check(TerminateJobObject(job,1)); Drain(job); }
        File.WriteAllText(proof,name);
      } catch { return 253; }
      return 254;
    } finally {
      if(child.thread!=IntPtr.Zero) CloseHandle(child.thread);
      if(child.process!=IntPtr.Zero) CloseHandle(child.process);
      if(job!=IntPtr.Zero) CloseHandle(job);
    }
  }
}`;
const encoded = (value: string): string => Buffer.from(value, 'utf16le').toString('base64');
const literal = (value: string): string => `'${value.replaceAll("'", "''")}'`;
const source = `$ErrorActionPreference='Stop'; Add-Type -TypeDefinition ${literal(jobSource)}; `;
const args = (script: string): string[] => ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded(source + script)];

export class WindowsCodexJob {
  readonly name = `Local\\vonvon-codex-${randomUUID()}`;
  private readonly directory = mkdtempSync(join(tmpdir(), 'vonvon-codex-job-'));
  private readonly proof = join(this.directory, 'empty');
  readonly executable = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

  launch(command: string, commandArgs: string[]): string[] {
    const crossSpawn = createRequire(import.meta.url).resolve('cross-spawn');
    const wrapper = `const spawn=require(${JSON.stringify(crossSpawn)});const c=spawn(${JSON.stringify(command)},${JSON.stringify(commandArgs)},{stdio:'inherit',windowsHide:true});c.on('error',()=>process.exit(1));c.on('exit',code=>process.exit(code??1));`;
    const bootstrap = `eval(Buffer.from('${Buffer.from(wrapper).toString('base64')}','base64').toString())`;
    const line = `"${process.execPath}" -e "${bootstrap}"`;
    return args(`exit ([CodexJob]::Run(${literal(this.name)},${literal(process.execPath)},${literal(line)},${literal(this.proof)}))`);
  }

  requestStop(): void { writeFileSync(this.proof + '.stop', this.name); }
  get verifiedEmpty(): boolean { try { return readFileSync(this.proof, 'utf8') === this.name; } catch { return false; } }
  dispose(): void { rmSync(this.directory, { recursive: true, force: true }); }
}
