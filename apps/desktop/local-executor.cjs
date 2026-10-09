const fs = require('node:fs');
const path = require('node:path');
const {createHash,randomUUID} = require('node:crypto');
const {spawn} = require('node:child_process');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const compareArtifactPaths=(a,b)=>a.path<b.path?-1:a.path>b.path?1:0;
// Preserve the local executor's established hash basis across every host:
// fixed metadata fields and UTF-16 code-unit path order, never locale collation.
function canonicalManifest(files){return files.map(({path,size,sha256})=>({path,size,sha256})).sort(compareArtifactPaths);}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function denied(message,code='LOCAL_SCOPE_DENIED'){return Object.assign(Error(message),{code,notExecuted:true});}
function validPath(value){
 if(typeof value!=='string'||!value||value.length>240||/[\\:<>"|?*\x00-\x1f]/.test(value)||value.startsWith('/')||value.split('/').some(p=>!p||p==='.'||p==='..'||p.toLowerCase().startsWith('.agent')||/[. ]$/.test(p)||/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(p)))throw denied('非法本机工作区路径');
 return value;
}
function checkedPath(root,value){
 validPath(value);let at=path.resolve(root);
 if(!fs.lstatSync(at).isDirectory()||fs.lstatSync(at).isSymbolicLink())throw denied('工作区目录已被替换');
 for(const part of value.split('/')){
  at=path.join(at,part);
  try{const stat=fs.lstatSync(at);if(stat.isSymbolicLink()||stat.isFile()&&stat.nlink>1)throw denied('本机工作区不允许链接文件或链接目录');}catch(error){if(error.code!=='ENOENT')throw error;}
 }
 return at;
}
function decodeFiles(files){
 if(!Array.isArray(files)||files.length>128)throw denied('文件数量超过限制','LOCAL_FILE_LIMIT');
 let total=0;const names=new Set();
 return files.map(file=>{
  validPath(file?.path);
  const key=file.path.toLowerCase();
  if(names.has(key)||[...names].some(name=>name.startsWith(key+'/')||key.startsWith(name+'/'))||typeof file.content!=='string'||file.content.length>7*1024*1024||file.content.length%4!==0||! /^[A-Za-z0-9+/]*={0,2}$/.test(file.content))throw denied('回传文件格式不正确');
  // Avoid a repeated-group regex stack overflow at the supported 5 MiB limit.
  const bytes=Buffer.from(file.content,'base64');if(bytes.toString('base64')!==file.content)throw denied('回传文件格式不正确');
  names.add(key);total+=bytes.length;
  if(bytes.length>5*1024*1024||total>20*1024*1024)throw denied('文件大小超过限制','LOCAL_FILE_LIMIT');
  return {path:file.path,bytes};
 }).sort(compareArtifactPaths);
}
function exportFiles(root){
 const files=[];let total=0,entries=0;
 function walk(dir){for(const name of fs.readdirSync(dir).sort()){
  if(++entries>512)throw denied('工作区项目数量超过限制','LOCAL_FILE_LIMIT');
  const full=path.join(dir,name),stat=fs.lstatSync(full),relative=path.relative(root,full).split(path.sep).join('/');
  checkedPath(root,relative);
  if(stat.isDirectory())walk(full);
  else if(stat.isFile()){
   if(files.length>=128||stat.size>5*1024*1024||(total+=stat.size)>20*1024*1024)throw denied('工作区交付物超过限制','LOCAL_FILE_LIMIT');
   files.push({path:relative,content:fs.readFileSync(full).toString('base64')});
  }else throw denied('工作区中出现非普通文件');
 }}walk(root);return files;
}
function manifest(files){return canonicalManifest(decodeFiles(files).map(file=>({path:file.path,size:file.bytes.length,sha256:hash(file.bytes)})));}
function revision(files){return hash(JSON.stringify(manifest(files)));}
function writeVersion(root,value,bytes,expected){
 const file=checkedPath(root,value);
 const current=fs.existsSync(file)?hash(fs.readFileSync(file)):null;
 if(current!==(expected??null))throw denied('文件已变化，请重新读取并携带 sha256 写入','FILE_VERSION_CONFLICT');
 fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});checkedPath(root,value);
 const temporary=path.join(path.dirname(file),'.agent-write-'+randomUUID());
 try{
  fs.writeFileSync(temporary,bytes,{flag:'wx',mode:0o600});checkedPath(root,value);
  const latest=fs.existsSync(file)?hash(fs.readFileSync(file)):null;
  if(latest!==current)throw denied('写入期间文件已变化','FILE_VERSION_CONFLICT');
  fs.renameSync(temporary,file);
 }finally{if(fs.existsSync(temporary))fs.unlinkSync(temporary);}
}
// Used only for the backend's private artifact mirror, never for a selected user directory.
function mirrorFiles(root,files){
 const decoded=decodeFiles(files);fs.mkdirSync(root,{recursive:true,mode:0o700});
 for(const file of decoded){checkedPath(root,file.path);if(decoded.some(other=>other.path!==file.path&&other.path.startsWith(file.path+'/')))throw denied('文件和目录路径冲突');}
 const old=exportFiles(root),names=new Set(decoded.map(file=>file.path));
 for(const file of old)if(!names.has(file.path))fs.unlinkSync(checkedPath(root,file.path));
 for(const file of decoded){const target=checkedPath(root,file.path);writeVersion(root,file.path,file.bytes,fs.existsSync(target)?hash(fs.readFileSync(target)):null);}
 return {artifacts:manifest(files),workspaceRevision:revision(files)};
}
const windowsJob = String.raw`
using System; using System.Runtime.InteropServices; using System.ComponentModel;
public static class DepartmentCommandJob {
 [StructLayout(LayoutKind.Sequential)] struct BASIC { public long PerProcessUserTimeLimit,PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize,MaximumWorkingSetSize; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass,SchedulingClass; }
 [StructLayout(LayoutKind.Sequential)] struct IO { public ulong ReadOperationCount,WriteOperationCount,OtherOperationCount,ReadTransferCount,WriteTransferCount,OtherTransferCount; }
 [StructLayout(LayoutKind.Sequential)] struct EXTENDED { public BASIC BasicLimitInformation; public IO IoInfo; public UIntPtr ProcessMemoryLimit,JobMemoryLimit,PeakProcessMemoryUsed,PeakJobMemoryUsed; }
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes,string name);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int kind,IntPtr info,uint size);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
 [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
 static IntPtr ownedJob;
 public static void Initialize(){
  ownedJob=CreateJobObject(IntPtr.Zero,null); if(ownedJob==IntPtr.Zero)throw new Win32Exception();
  var limits=new EXTENDED(); limits.BasicLimitInformation.LimitFlags=0x2000;
  int size=Marshal.SizeOf(limits); IntPtr info=Marshal.AllocHGlobal(size);
  try{Marshal.StructureToPtr(limits,info,false);if(!SetInformationJobObject(ownedJob,9,info,(uint)size)||!AssignProcessToJobObject(ownedJob,GetCurrentProcess()))throw new Win32Exception();} finally{Marshal.FreeHGlobal(info);}
 }
}
`;
// Windows owns a kill-on-close Job Object before invoking any user command.
// https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects
async function runCommand(command,cwd,signal,{timeoutMs=60000}={}){
 signal?.throwIfAborted();
 if(typeof command!=='string'||!command||command.length>5000)throw denied('命令格式不正确');
 const abort=AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(timeoutMs)]);
 let program,args,env={...process.env};
 if(process.platform==='win32'){
  program=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  const script="$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); Add-Type -TypeDefinition ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:AGENT_LOCAL_JOB))); [DepartmentCommandJob]::Initialize(); $global:LASTEXITCODE=0; try { & ([ScriptBlock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:AGENT_LOCAL_COMMAND)))); exit $LASTEXITCODE } catch { [Console]::Error.WriteLine($_.ToString()); exit 1 }";
  args=['-NoLogo','-NoProfile','-NonInteractive','-OutputFormat','Text','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')];
  env.AGENT_LOCAL_JOB=Buffer.from(windowsJob).toString('base64');env.AGENT_LOCAL_COMMAND=Buffer.from(command).toString('base64');
 }else{program='/bin/sh';args=['-lc',command];}
 return await new Promise((resolve,reject)=>{
  const child=spawn(program,args,{cwd,env,stdio:['ignore','pipe','pipe'],windowsHide:true,detached:process.platform!=='win32'});
  let bytes=0,chunks=[],overflow=false;
  const kill=()=>{try{if(process.platform==='win32')child.kill('SIGKILL');else process.kill(-child.pid,'SIGKILL');}catch{}};
  const collect=chunk=>{bytes+=chunk.length;if(bytes>1024*1024){overflow=true;kill();}else chunks.push(chunk);};
  abort.addEventListener('abort',kill,{once:true});if(abort.aborted)kill();
  child.stdout.on('data',collect);child.stderr.on('data',collect);
  child.once('error',error=>{abort.removeEventListener('abort',kill);reject(Object.assign(error,{notExecuted:true}));});
  child.once('close',code=>{abort.removeEventListener('abort',kill);kill();if(abort.aborted)return reject(abort.reason);if(overflow)return reject(Object.assign(Error('命令输出超过限制'),{code:'LOCAL_OUTPUT_LIMIT'}));if(code===null)return reject(Error('本机命令未取得退出码'));resolve({exitCode:code,output:Buffer.concat(chunks).toString('utf8')});});
 });
}
class LocalExecutor {
 constructor(grant){
  if(!uuid.test(grant?.id)||typeof grant.root!=='string'||!fs.lstatSync(grant.root).isDirectory()||fs.lstatSync(grant.root).isSymbolicLink())throw denied('本机目录授权不正确');
  this.grant={...grant,root:fs.realpathSync(grant.root)};this.identity=fs.statSync(this.grant.root);
 }
 workspace(runId){
  if(!uuid.test(runId))throw denied('运行编号不正确');
  const current=fs.lstatSync(this.grant.root);
  if(current.isSymbolicLink()||current.dev!==this.identity.dev||current.ino!==this.identity.ino)throw denied('已授权目录被替换');
  return checkedPath(this.grant.root,runId);
 }
 async execute(job,signal){
  signal?.throwIfAborted();
  if(job.grantId!==this.grant.id)throw denied('目录授权已经变化');
  const root=this.workspace(job.runId),args=job.arguments??{};let changed=false;
  try{
  if(job.name==='prepare'){
   const files=decodeFiles(job.files??[]);
   if(fs.existsSync(root))throw denied('同一运行的本机工作区已存在，不能重复初始化','LOCAL_WORKSPACE_CONFLICT');
   fs.mkdirSync(root,{mode:0o700});changed=true;for(const file of files)writeVersion(root,file.path,file.bytes,null);
  }else{
   if(!fs.existsSync(root))throw denied('本机工作区尚未初始化');
   if(args.expectedWorkspaceRevision&&args.expectedWorkspaceRevision!==revision(exportFiles(root)))throw denied('批准后的本机工作区已变化','WORKSPACE_VERSION_CONFLICT');
   if(job.name==='filesystem'){
    const file=checkedPath(root,args.path),stat=fs.lstatSync(file);if(!stat.isFile()||stat.size>1024*1024)throw denied('读取文件超过限制','LOCAL_FILE_LIMIT');
    const bytes=fs.readFileSync(file),files=exportFiles(root);return {path:args.path,content:bytes.toString('utf8'),sha256:hash(bytes),files,...mirrorMetadata(files),localWorkspace:root};
   }
   if(job.name==='artifact_write'){
    if(typeof args.content!=='string'||Buffer.byteLength(args.content)>5*1024*1024)throw denied('写入文件超过限制','LOCAL_FILE_LIMIT');
    writeVersion(root,args.path,Buffer.from(args.content),args.expectedSha256);
    changed=true;
   }else if(job.name==='terminal'||job.name==='terminal_test'){
    if(!this.grant.allowCommands||!uuid.test(job.approvalId??''))throw denied('本机命令没有目录能力或逐次批准');
    const result=await runCommand(args.command,root,signal);changed=true;const files=exportFiles(root);return {...result,files,...mirrorMetadata(files),localWorkspace:root};
   }else throw denied('本机工具未开放');
  }
  const files=exportFiles(root);return {path:args.path,...(job.name==='artifact_write'?{sha256:hash(Buffer.from(args.content)),bytes:Buffer.byteLength(args.content)}:{}),files,...mirrorMetadata(files),localWorkspace:root};
  }catch(error){if(changed)error.notExecuted=false;throw error;}
 }
}
function mirrorMetadata(files){return {artifacts:manifest(files),workspaceRevision:revision(files)};}
module.exports={LocalExecutor,validPath,decodeFiles,exportFiles,canonicalManifest,manifest,revision,mirrorFiles,runCommand};
