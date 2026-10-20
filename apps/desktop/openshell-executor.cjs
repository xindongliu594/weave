const fs=require('node:fs');
const path=require('node:path');
const {createHash,randomUUID,randomBytes}=require('node:crypto');
const {isDeepStrictEqual}=require('node:util');
const {spawn}=require('node:child_process');
const {validPath,canonicalManifest}=require('./local-executor.cjs');
const {SANDBOX_STORAGE_LIMITS,storageDenied,boundedStorage,checkSandboxStorage}=require('./sandbox-storage.cjs');
const {runNativeTool}=require('./native-plugin-worker.cjs');
const {checkpointTestInvocation}=require('./checkpoint-test-profile.cjs');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const MAX_TASK_EXEC_STDIN_BYTES=3*1024*1024;
const taskProfile='task-attempt-openshell-v1';
const digest=/^[a-f0-9]{64}$/;
function taskKey(value){
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!=='attemptId,generation,runId,taskId'||
  !uuid.test(value.runId)||!['taskId','attemptId'].every(k=>typeof value[k]==='string'&&value[k].length>0&&value[k].length<=240&&value[k].trim()===value[k]&&!/[\x00-\x1f\x7f]/.test(value[k]))||
  !Number.isSafeInteger(value.generation)||value.generation<1)throw denied('任务执行身份不正确');
 return value;
}
function taskScope(value,files){
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!=='binding,expectedWorkRevision,inputManifest,key,profile,readPaths,scopeHash,writePaths'||value.profile!==taskProfile)throw denied('任务执行 profile 不正确');
 const key=taskKey(value.key),binding=value.binding;
 if(!binding||typeof binding!=='object'||binding.runId!==key.runId||binding.taskId!==key.taskId||binding.attemptId!==key.attemptId||binding.generation!==key.generation||
  binding.backend?.kind!=='openshell'||binding.backend.version!==OPENSHELL_CONSTANTS.version||binding.backend.image!==OPENSHELL_CONSTANTS.image||binding.backend.policyHash!==OPENSHELL_CONSTANTS.policyHash||
  !digest.test(value.scopeHash)||!digest.test(value.expectedWorkRevision))throw denied('任务执行绑定不正确');
 const reads=decodeFiles((value.readPaths??[]).map(path=>({path,content:''}))).map(item=>item.path);
 const writes=decodeFiles((value.writePaths??[]).map(path=>({path,content:''}))).map(item=>item.path);
 decodeFiles([...new Set([...reads,...writes])].map(path=>({path,content:''})));
 if(!Array.isArray(value.inputManifest)||JSON.stringify(value.inputManifest.map(({path,size,sha256})=>({path,size,sha256})))!==JSON.stringify(manifest(files))||
  JSON.stringify(reads)!==JSON.stringify(manifest(files).map(item=>item.path))||value.expectedWorkRevision!==revision(files))throw denied('任务导入与批准清单不一致');
 return value;
}
function advanceTaskScope(scope,next){
 if(!next||typeof next!=='object'||Array.isArray(next)||Object.keys(next).sort().join(',')!=='binding,expectedWorkRevision,inputManifest,key,profile,readPaths,scopeHash,writePaths'||next.profile!==taskProfile||
  !isDeepStrictEqual(next.key,scope.key)||!isDeepStrictEqual(next.binding,scope.binding)||!isDeepStrictEqual(next.writePaths,scope.writePaths)||!digest.test(next.scopeHash)||next.expectedWorkRevision!==scope.workspaceRevision)throw denied('任务执行绑定或版本已变化');
 const reads=decodeFiles((next.readPaths??[]).map(path=>({path,content:''}))).map(item=>item.path),old=new Set(scope.readPaths),writes=new Set(scope.writePaths);
 if(!isDeepStrictEqual(reads,next.readPaths)||scope.readPaths.some(name=>!reads.includes(name))||reads.some(name=>!old.has(name)&&!writes.has(name)))throw denied('任务读取范围未获批准');
 const current=scope.workManifest??scope.sourceManifest,expected=current.filter(item=>reads.includes(item.path));
  if(!Array.isArray(next.inputManifest)||!isDeepStrictEqual(next.inputManifest.map(({path,size,sha256})=>({path,size,sha256})),expected))throw denied('任务输入清单与当前沙箱版本不一致');
 if(next.scopeHash!==scope.scopeHash&&next.expectedWorkRevision===scope.expectedWorkRevision)throw denied('任务 scopeHash 未绑定新工作版本');
 scope.scopeHash=next.scopeHash;scope.expectedWorkRevision=next.expectedWorkRevision;scope.readPaths=next.readPaths;scope.inputManifest=next.inputManifest;scope.inputWorkManifest=current;
}
function taskFileName(key){return hash(JSON.stringify([key.runId,key.taskId,key.attemptId,key.generation]))+'.json';}
function taskEnvelope(value){const input=JSON.stringify(value);if(Buffer.byteLength(input,'utf8')>MAX_TASK_EXEC_STDIN_BYTES)throw denied('任务执行 stdin envelope 超过 3 MiB','LOCAL_FILE_LIMIT');return input;}
const POLICY_TEXT='version: 1\nfilesystem_policy:\n  include_workdir: false\n  read_only: [/bin, /usr, /lib, /lib64, /etc, /proc, /dev/urandom, /var/tmp, /sys/fs/cgroup]\n  read_write: [/sandbox, /tmp, /dev/null]\nlandlock:\n  compatibility: hard_requirement\nprocess:\n  run_as_user: "1000"\n  run_as_group: "1000"\nnetwork_policies: {}\nnetwork_middlewares: {}\n';
const OPENSHELL_CONSTANTS=Object.freeze({version:'0.1.2',gateway:'weiwu-openshell-v012',cliSha256:'f334da80f867776dde9034e0ca3c2406d48ba77b0d0abe64b5aa610490a34fca',image:'docker.io/library/node:24.19.0-bookworm-slim@sha256:e5a8dee7bc1e6a215d224a7ef8206f7e77271bc3cabd5febf2beafac0674f174',policyHash:hash(POLICY_TEXT),effectivePolicyHash:'27ae8e91e5dd6b505e6a331bb5b24a7a2b47aced33257f4f7e7a7c892978e6b5',cpu:'1',memory:'512Mi'});
function canonicalConfigFingerprint(config){return hash(JSON.stringify({version:config.version,cliPath:config.cliPath,cliSha256:config.cliSha256,home:config.home,gateway:config.gateway,image:config.image,policyPath:config.policyPath,policyHash:config.policyHash,cpu:config.cpu,memory:config.memory}));}
function denied(message,code='LOCAL_SCOPE_DENIED'){return Object.assign(Error(message),{code,notExecuted:true});}
function unknown(message){return Object.assign(Error(message),{code:'LOCAL_OUTCOME_UNKNOWN',notExecuted:false});}
// Avoid a repeated-group Base64 regexp on multi-MiB files: V8 can overflow its
// regexp stack. Decode once and require an exact canonical Base64 round trip.
function decodeFiles(files){
 if(!Array.isArray(files)||files.length>128)throw denied('文件数量超过限制','LOCAL_FILE_LIMIT');
 const names=new Set();let total=0;return files.map(file=>{
  validPath(file?.path);const key=file.path.toLowerCase();
  if(names.has(key)||[...names].some(name=>name.startsWith(key+'/')||key.startsWith(name+'/'))||typeof file.content!=='string'||file.content.length>7*1024*1024||/[^A-Za-z0-9+/=]/.test(file.content))throw denied('回传文件格式不正确');
  const bytes=Buffer.from(file.content,'base64');if(bytes.toString('base64')!==file.content)throw denied('回传文件编码不正确');names.add(key);total+=bytes.length;
  if(bytes.length>5*1024*1024||total>20*1024*1024)throw denied('文件大小超过限制','LOCAL_FILE_LIMIT');return {path:file.path,bytes};
 }).sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
}
function manifest(files){return canonicalManifest(decodeFiles(files).map(file=>({path:file.path,size:file.bytes.length,sha256:hash(file.bytes)})));}
function revision(files){return hash(JSON.stringify(manifest(files)));}
function validateTaskFiles(scope,files){
 const actual=manifest(files),inputs=new Map(scope.inputManifest.map(entry=>[entry.path,entry])),outputs=new Set(scope.writePaths);
 if(actual.some(entry=>!inputs.has(entry.path)&&!outputs.has(entry.path)))throw denied('任务导出包含未授权文件');
 for(const [name,expected] of inputs){const item=actual.find(entry=>entry.path===name);if(!item||!outputs.has(name)&&(item.sha256!==expected.sha256||item.size!==expected.size))throw denied('任务只读输入已变化');}
}
function checkedManifestRows(rows){
 if(!Array.isArray(rows)||rows.length>128)throw denied('任务持久清单不正确');
 const paths=decodeFiles(rows.map(item=>({path:item?.path,content:''}))).map(item=>item.path);
 if(!isDeepStrictEqual(paths,rows.map(item=>item.path))||rows.some(item=>!Number.isSafeInteger(item.size)||item.size<0||item.size>5*1024*1024||!digest.test(item.sha256))||rows.reduce((sum,item)=>sum+item.size,0)>20*1024*1024)throw denied('任务持久清单不正确');
 return rows;
}
function canonicalPath(value,{directory=false}={}){
 if(typeof value!=='string'||!path.isAbsolute(value))throw denied('OpenShell 路径必须为绝对路径');
 const absolute=path.resolve(value),parts=absolute.slice(path.parse(absolute).root.length).split(path.sep).filter(Boolean);let current=path.parse(absolute).root;
 for(const part of parts){current=path.join(current,part);const stat=fs.lstatSync(current);if(stat.isSymbolicLink()||stat.isFile()&&stat.nlink>1)throw denied('OpenShell 路径不能包含链接');}
 const stat=fs.lstatSync(absolute);if(directory?!stat.isDirectory():!stat.isFile())throw denied('OpenShell 路径类型不正确');
 if(fs.realpathSync(absolute)!==absolute)throw denied('OpenShell 路径必须为规范路径');return absolute;
}
function atomicJson(file,value){
 if(fs.existsSync(file)&&(!fs.lstatSync(file).isFile()||fs.lstatSync(file).isSymbolicLink()||fs.statSync(file).nlink>1))throw denied('OpenShell 映射文件不能是链接');
 const temporary=file+'.'+randomUUID();let fd;
 try{fd=fs.openSync(temporary,'wx',0o600);fs.writeFileSync(fd,JSON.stringify(value));fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;fs.renameSync(temporary,file);if(process.platform!=='win32'){const directory=fs.openSync(path.dirname(file),'r');try{fs.fsyncSync(directory);}finally{fs.closeSync(directory);}}}
 finally{if(fd!==undefined)fs.closeSync(fd);if(fs.existsSync(temporary))fs.unlinkSync(temporary);}
}

// One trusted transport adapter; no user command ever executes on the host.
// JSON request bytes go through stdin, not argv (files can be several MiB).
function cliTransport(cliPath,args,{env,input,signal,timeoutMs=30000,maxOutput=32*1024*1024}={}){
 signal?.throwIfAborted();return new Promise((resolve,reject)=>{
  const child=spawn(cliPath,args,{env,stdio:['pipe','pipe','pipe'],windowsHide:true});
  let stdout=[],stderr=[],bytes=0,spawned=false,settled=false;
  const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);error?reject(error):resolve(value);};
  const abort=()=>{child.kill('SIGKILL');finish(Object.assign(Error('OpenShell 连接中断；远端结果待核对'),{code:'LOCAL_OUTCOME_UNKNOWN',notExecuted:!spawned}));};
  const timer=setTimeout(abort,timeoutMs);signal?.addEventListener('abort',abort,{once:true});
  const collect=list=>chunk=>{bytes+=chunk.length;if(bytes>maxOutput){abort();}else list.push(chunk);};
  child.stdout.on('data',collect(stdout));child.stderr.on('data',collect(stderr));
  child.once('spawn',()=>{spawned=true;if(signal?.aborted)abort();else child.stdin.end(input??'');});
  child.stdin.on('error',()=>{}); // Close/error is classified by the retained CLI result.
  child.once('error',error=>finish(Object.assign(error,{notExecuted:!spawned})));
  child.once('close',code=>{if(code===null)return finish(unknown('OpenShell CLI 未取得确定退出码'));finish(null,{exitCode:code,stdout:Buffer.concat(stdout).toString('utf8'),stderr:Buffer.concat(stderr).toString('utf8')});});
 });
}

// Harness file/CAS/export operations run entirely inside the admitted boundary.
// The terminal child's output is captured as data, never parsed as a receipt.
const REMOTE_SCRIPT=String.raw`
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{spawn}=require('node:child_process');
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const compareArtifactPaths=(a,b)=>a.path<b.path?-1:a.path>b.path?1:0;
${denied.toString()}
${validPath.toString()}
${decodeFiles.toString()}
${canonicalManifest.toString()}
${validateTaskFiles.toString()}
const MAX_TASK_EXEC_STDIN_BYTES=${MAX_TASK_EXEC_STDIN_BYTES};
const SANDBOX_STORAGE_LIMITS=${JSON.stringify(SANDBOX_STORAGE_LIMITS)};
${storageDenied.toString()}
${boundedStorage.toString()}
${checkSandboxStorage.toString()}
${runNativeTool.toString()}
${checkpointTestInvocation.toString()}
function checkedPath(root,value){validPath(value);let at=root;if(!fs.lstatSync(at).isDirectory()||fs.lstatSync(at).isSymbolicLink())throw denied('沙箱工作区目录已被替换');for(const part of value.split('/')){at=path.join(at,part);try{const stat=fs.lstatSync(at);if(stat.isSymbolicLink()||stat.isFile()&&stat.nlink>1)throw denied('沙箱工作区不允许链接');}catch(error){if(error.code!=='ENOENT')throw error;}}return at;}
function exportFiles(root){const files=[];let total=0,entries=0;function walk(dir){for(const name of fs.readdirSync(dir).sort()){if(++entries>512)throw denied('工作区项目数量超过限制','LOCAL_FILE_LIMIT');const full=path.join(dir,name),stat=fs.lstatSync(full),relative=path.relative(root,full).split(path.sep).join('/');checkedPath(root,relative);if(stat.isDirectory())walk(full);else if(stat.isFile()){if(stat.nlink!==1||files.length>=128||stat.size>5*1024*1024||(total+=stat.size)>20*1024*1024)throw denied('工作区文件超过限制或包含硬链接','LOCAL_FILE_LIMIT');const fd=fs.openSync(full,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{const opened=fs.fstatSync(fd);if(!opened.isFile()||opened.nlink!==1||opened.dev!==stat.dev||opened.ino!==stat.ino||opened.size!==stat.size)throw denied('导出文件读取期间变化');const bytes=fs.readFileSync(fd),after=fs.lstatSync(full);if(after.dev!==opened.dev||after.ino!==opened.ino||after.size!==opened.size)throw denied('导出文件读取期间变化');files.push({path:relative,content:bytes.toString('base64')});}finally{fs.closeSync(fd);}}else throw denied('工作区出现非普通文件');}}walk(root);decodeFiles(files);return files;}
function manifest(files){return canonicalManifest(decodeFiles(files).map(file=>({path:file.path,size:file.bytes.length,sha256:hash(file.bytes)})));}
function revision(files){return hash(JSON.stringify(manifest(files)));}
function writeVersion(root,value,bytes,expected){const file=checkedPath(root,value),current=fs.existsSync(file)?hash(fs.readFileSync(file)):null;if(current!==(expected??null))throw denied('文件已变化，请携带正确 sha256','FILE_VERSION_CONFLICT');let temporary;try{fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});checkedPath(root,value);temporary=path.join(path.dirname(file),'.agent-write-'+crypto.randomUUID());const fd=fs.openSync(temporary,'wx',0o600);try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}checkedPath(root,value);if((fs.existsSync(file)?hash(fs.readFileSync(file)):null)!==current)throw denied('写入期间文件已变化','FILE_VERSION_CONFLICT');fs.renameSync(temporary,file);}catch(error){error.notExecuted=false;throw error;}finally{if(temporary&&fs.existsSync(temporary))fs.unlinkSync(temporary);}}
async function command(command,cwd,profile){
 if(typeof command!=='string'||!command||command.length>5000)throw denied('命令格式不正确');
 const confined=profile==='node-permission-workspace-v1'?checkpointTestInvocation(command,cwd):null;
 return await new Promise((resolve,reject)=>{
  const child=spawn(confined?process.execPath:'/bin/sh',confined?confined.args:['-lc',command],{cwd,env:confined?confined.env:process.env,stdio:['ignore','pipe','pipe'],detached:true});let chunks=[],size=0,overflow=false,timedOut=false,storageError;
  const kill=()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}};
  const timer=setTimeout(()=>{timedOut=true;kill();},60000),monitor=setInterval(()=>{try{checkSandboxStorage();}catch(error){storageError=error;kill();}},250);
  const clear=()=>{clearTimeout(timer);clearInterval(monitor);};
  const collect=chunk=>{size+=chunk.length;if(size>1024*1024){overflow=true;kill();}else chunks.push(chunk);};child.stdout.on('data',collect);child.stderr.on('data',collect);
  child.once('error',error=>{clear();reject(Object.assign(error,{notExecuted:true}));});
  child.once('close',async code=>{clear();kill();let gone=false;for(let attempt=0;attempt<5;attempt++){try{process.kill(-child.pid,0);}catch(error){if(error.code==='ESRCH'){gone=true;break;}return reject(Object.assign(error,{code:'LOCAL_OUTCOME_UNKNOWN',notExecuted:false}));}await new Promise(done=>setTimeout(done,25));}
   if(!gone)return reject(Object.assign(Error('命令进程组仍存在，导出结果待核对'),{code:'LOCAL_OUTCOME_UNKNOWN',notExecuted:false}));
   if(storageError)return reject(Object.assign(storageError,{notExecuted:false}));
   if(overflow||timedOut||code===null)return reject(Object.assign(Error(overflow?'命令输出超过限制':timedOut?'命令超过批准的执行时限':'命令退出结果不明确'),{code:overflow?'LOCAL_OUTPUT_LIMIT':'LOCAL_OUTCOME_UNKNOWN',notExecuted:false}));resolve({exitCode:code,output:Buffer.concat(chunks).toString('utf8'),...(confined?{verificationProfile:confined.profile}: {})});
  });
 });
}
let buffers=[],length=0;
process.stdin.on('data',chunk=>{length+=chunk.length;if(length>29*1024*1024)process.exit(65);buffers.push(chunk);});
process.stdin.on('end',async()=>{let request,changed=false;try{
 request=JSON.parse(Buffer.concat(buffers).toString('utf8'));if(request.profile==='task-attempt-openshell-v1'&&length>MAX_TASK_EXEC_STDIN_BYTES)throw denied('任务执行 stdin envelope 超过 3 MiB','LOCAL_FILE_LIMIT');const root='/sandbox',args=request.arguments??{};
 const identity={uid:process.getuid(),gid:process.getgid(),node:process.version,cpu:fs.readFileSync('/sys/fs/cgroup/cpu.max','utf8').trim().split(/\s+/).map(Number),memory:fs.readFileSync('/sys/fs/cgroup/memory.max','utf8').trim()};
 if(identity.uid!==1000||identity.gid!==1000||identity.node!=='v24.19.0'||identity.cpu[0]/identity.cpu[1]!==1||Number(identity.memory)!==536870912)throw denied('实际沙箱身份或资源限制不匹配','OPENSHELL_IDENTITY_MISMATCH');
 checkSandboxStorage();let files=exportFiles(root),result={};if(request.expectedStoredRevision&&request.expectedStoredRevision!==revision(files))throw denied('沙箱文件与已保存的恢复版本不一致','WORKSPACE_VERSION_CONFLICT');if(args.expectedWorkspaceRevision&&args.expectedWorkspaceRevision!==revision(files))throw denied('批准后的工作区已变化','WORKSPACE_VERSION_CONFLICT');
 if(request.name==='prepare'){const inputs=decodeFiles(request.files??[]);if(files.length)throw denied('沙箱工作区已经存在文件，拒绝重复初始化','LOCAL_WORKSPACE_CONFLICT');for(const file of inputs){changed=true;writeVersion(root,file.path,file.bytes,null);}}
 else if(request.name==='filesystem'){const file=checkedPath(root,args.path),stat=fs.lstatSync(file);if(!stat.isFile()||stat.size>1024*1024)throw denied('读取文件超过限制','LOCAL_FILE_LIMIT');const bytes=fs.readFileSync(file);result={path:args.path,content:bytes.toString('utf8'),sha256:hash(bytes)};}
 else if(request.name==='artifact_write'){if(typeof args.content!=='string'||Buffer.byteLength(args.content)>5*1024*1024)throw denied('写入文件超过限制','LOCAL_FILE_LIMIT');validPath(args.path);decodeFiles([...files.filter(f=>f.path!==args.path),{path:args.path,content:Buffer.from(args.content).toString('base64')}]);writeVersion(root,args.path,Buffer.from(args.content),args.expectedSha256);changed=true;result={path:args.path,bytes:Buffer.byteLength(args.content),sha256:hash(Buffer.from(args.content))};}
 else if(request.name==='terminal'||request.name==='terminal_test'){changed=true;result=await command(args.command,root,request.name==='terminal_test'?request.verificationProfile:undefined);}
 else if(request.name==='native_plugin'){changed=true;const nativeResult=await runNativeTool({root,tempRoot:'/tmp',bundle:request.bundle,originalName:args.originalName,args:args.arguments,callId:request.callId,readPaths:args.readPaths,writePaths:args.writePaths},{checkStorage:checkSandboxStorage});result={nativeResult,pluginId:args.pluginId,toolName:args.toolName};}
 else if(request.name==='storage_inspect'){}
 else if(request.name==='task_export_inspect'){if(request.profile!=='task-attempt-openshell-v1'||typeof request.operationId!=='string'||!/^[a-f0-9-]{36}$/.test(request.operationId))throw denied('任务导出查询身份不正确');}
 else throw denied('沙箱工具未开放');
 const storage=checkSandboxStorage();
 if(request.profile==='task-attempt-openshell-v1'&&['terminal','terminal_test','native_plugin'].includes(request.name)){
  // The host must stop this workload before a separate read-only export.
  console.log(JSON.stringify({nonce:request.nonce,ok:true,result:{...result,deferredExport:true},identity}));return;
 }
 files=exportFiles(root);if(request.profile==='task-attempt-openshell-v1')validateTaskFiles({inputManifest:request.inputManifest,writePaths:request.writePaths},files);console.log(JSON.stringify({nonce:request.nonce,ok:true,result:{...result,files,artifacts:manifest(files),workspaceRevision:revision(files),storage},identity}));
 }catch(error){console.log(JSON.stringify({nonce:request?.nonce,ok:false,error:{code:error.code??'LOCAL_OPERATION_FAILED',message:String(error.message).slice(0,500),notExecuted:!changed&&(error.notExecuted===true||request?.name==='filesystem')}}));}
});
`;

class OpenShellDeviceExecutor {
 constructor({grant,config,journalRoot,transport,loadNativeBundle}={}){
  if(!uuid.test(grant?.id))throw denied('OpenShell 目录授权不正确');
  if(transport!==undefined&&typeof transport!=='function')throw denied('OpenShell transport 必须为显式函数依赖');
  this.grant={...grant,root:canonicalPath(grant.root,{directory:true})};this.identity=fs.statSync(this.grant.root);
  for(const key of ['version','gateway','cliSha256','image','policyHash','cpu','memory'])if(config?.[key]!==OPENSHELL_CONSTANTS[key])throw denied('OpenShell 固定配置不匹配','OPENSHELL_CONFIG_MISMATCH');
  this.config={...config};canonicalPath(config.home,{directory:true});canonicalPath(config.policyPath);
  if(hash(fs.readFileSync(config.policyPath))!==config.policyHash)throw denied('OpenShell 策略文件已经变化','OPENSHELL_CONFIG_MISMATCH');
  if(!transport){canonicalPath(config.cliPath);if(hash(fs.readFileSync(config.cliPath))!==config.cliSha256)throw denied('OpenShell CLI 文件已经变化','OPENSHELL_CONFIG_MISMATCH');}
  if(typeof journalRoot!=='string'||!path.isAbsolute(journalRoot))throw denied('OpenShell 私有回执目录不正确');
  this.stateRoot=path.join(journalRoot,'openshell-scopes');this.taskStateRoot=path.join(journalRoot,'openshell-task-scopes');this.transport=transport??cliTransport;this.defaultTransport=transport===undefined;
  this.loadNativeBundle=loadNativeBundle;
  this.backend={kind:'openshell',version:config.version,gateway:config.gateway,image:config.image,policySha256:config.policyHash,fingerprint:canonicalConfigFingerprint(config)};
  this.env={PATH:'/usr/local/bin:/usr/bin:/bin',HOME:config.home,XDG_CONFIG_HOME:path.join(config.home,'.config'),OPENSHELL_COLOR:'never',LANG:'C.UTF-8'};
  this.queue=Promise.resolve();this.scopes=new Map();this.closed=false;this.closing=null;
 }
 assertGrant(job){
  if(this.closed)throw denied('OpenShell 执行器已关闭');
  if(job?.grantId!==this.grant.id||!uuid.test(job?.runId)||!uuid.test(job?.id))throw denied('OpenShell 运行或操作授权不正确');
  const stat=fs.lstatSync(this.grant.root);if(stat.isSymbolicLink()||stat.dev!==this.identity.dev||stat.ino!==this.identity.ino)throw denied('已授权目录被替换');
  canonicalPath(this.config.home,{directory:true});canonicalPath(this.config.policyPath);if(hash(fs.readFileSync(this.config.policyPath))!==this.config.policyHash)throw denied('OpenShell 策略文件已变化');
  if(this.defaultTransport){canonicalPath(this.config.cliPath);if(hash(fs.readFileSync(this.config.cliPath))!==this.config.cliSha256)throw denied('OpenShell CLI 文件已变化');}
 }
 stateFile(runId){
  if(typeof runId!=='string'||!uuid.test(runId))throw denied('旧运行映射仅接受 runId');
  fs.mkdirSync(this.stateRoot,{recursive:true,mode:0o700});canonicalPath(this.stateRoot,{directory:true});return path.join(this.stateRoot,runId+'.json');
 }
 taskStateFile(key){taskKey(key);fs.mkdirSync(this.taskStateRoot,{recursive:true,mode:0o700});canonicalPath(this.taskStateRoot,{directory:true});return path.join(this.taskStateRoot,taskFileName(key));}
 read(key){
  const task=typeof key!=='string',file=task?this.taskStateFile(key):this.stateFile(key);if(!fs.existsSync(file))return null;canonicalPath(file);if(fs.statSync(file).size>1024*1024)throw denied('OpenShell 映射文件超过限制');const scope=JSON.parse(fs.readFileSync(file,'utf8'));
  if(scope.runId!==(task?key.runId:key)||scope.grantId!==this.grant.id||scope.fingerprint!==this.backend.fingerprint)throw denied('OpenShell 持久映射授权已变化');
  if(task&&(scope.schema!==2||!isDeepStrictEqual(scope.key,key)||scope.profile!==taskProfile||!digest.test(scope.scopeHash)||!digest.test(scope.expectedWorkRevision)||!scope.binding||!Array.isArray(scope.readPaths)||!Array.isArray(scope.writePaths)||!Array.isArray(scope.inputManifest)))throw denied('任务持久映射格式或身份不正确');
  if(task){
   if(scope.binding.runId!==key.runId||scope.binding.taskId!==key.taskId||scope.binding.attemptId!==key.attemptId||scope.binding.generation!==key.generation||scope.binding.backend?.kind!=='openshell'||scope.binding.backend.version!==OPENSHELL_CONSTANTS.version||scope.binding.backend.image!==OPENSHELL_CONSTANTS.image||scope.binding.backend.policyHash!==OPENSHELL_CONSTANTS.policyHash)throw denied('任务持久绑定不正确');
   checkedManifestRows(scope.sourceManifest);if(hash(JSON.stringify(scope.sourceManifest))!==scope.sourceRevision)throw denied('任务初始清单版本不正确');
   if(scope.workManifest){checkedManifestRows(scope.workManifest);if(hash(JSON.stringify(scope.workManifest))!==scope.workspaceRevision)throw denied('任务工作清单版本不正确');}
   else if(['ready','stopped'].includes(scope.phase))throw denied('任务工作清单缺失');
   const reads=decodeFiles(scope.readPaths.map(path=>({path,content:''}))).map(item=>item.path);decodeFiles(scope.writePaths.map(path=>({path,content:''})));
   checkedManifestRows(scope.inputWorkManifest);
   if(hash(JSON.stringify(scope.inputWorkManifest))!==scope.expectedWorkRevision)throw denied('任务操作前工作版本不正确');
   if(!isDeepStrictEqual(reads,scope.readPaths)||!isDeepStrictEqual(scope.inputManifest.map(({path,size,sha256})=>({path,size,sha256})),scope.inputWorkManifest.filter(item=>reads.includes(item.path))))throw denied('任务读取清单与操作前版本不一致');
   if(scope.workManifest)for(const entry of scope.sourceManifest)if(!scope.writePaths.includes(entry.path)&&!isDeepStrictEqual(scope.workManifest.find(item=>item.path===entry.path),entry))throw denied('原始只读输入已变化');
   if(scope.commandFence){
    if(!uuid.test(scope.commandFence.operationId)||scope.commandFence.operationId!==scope.lastOperationId||!['command_confirmed','stop_intent','stopped_confirmed','start_intent','inspect_intent'].includes(scope.commandFence.stage)||!scope.commandFence.result||!scope.commandFence.identity||Buffer.byteLength(JSON.stringify(scope.commandFence))>768*1024)throw denied('任务命令栅栏记录不正确');
   }else if(scope.phase.startsWith('fencing_'))throw denied('任务命令栅栏记录缺失');
   const fenceStages={fencing_stopping:'stop_intent',fencing_stopped:'stopped_confirmed',fencing_starting:'start_intent',fencing_inspecting:'inspect_intent'};
   if(fenceStages[scope.phase]&&(scope.activeOperation!==scope.commandFence.operationId||scope.commandFence.stage!==fenceStages[scope.phase]))throw denied('任务命令栅栏阶段不正确');
  }
  const phases=['creating','importing','ready','starting','stopping','stopped','unknown','retiring','retired',...(task?['fencing_stopping','fencing_stopped','fencing_starting','fencing_inspecting']:[])];
  if(!task&&scope.schema!==1||!/^wwe-[a-f0-9]{12}$/.test(scope.name)||!phases.includes(scope.phase)||!Array.isArray(scope.completedOperations)||scope.completedOperations.length>4096||scope.completedOperations.some(id=>!uuid.test(id))||new Set(scope.completedOperations).size!==scope.completedOperations.length||scope.activeOperation!=null&&!uuid.test(scope.activeOperation))throw denied('OpenShell 持久映射格式不正确');
  if(!['creating','unknown'].includes(scope.phase)&&!uuid.test(scope.sandboxId)||['ready','starting','stopping','stopped'].includes(scope.phase)&&! /^[a-f0-9]{64}$/.test(scope.workspaceRevision))throw denied('OpenShell 持久映射缺少已确认的沙箱或文件版本');
  return scope;
 }
 save(scope){const key=scope.schema===2?scope.key:scope.runId;atomicJson(scope.schema===2?this.taskStateFile(key):this.stateFile(key),scope);this.scopes.set(scope.schema===2?taskFileName(key):scope.runId,scope);}
 async cli(args,signal,{input,timeoutMs=30000,mutation=false}={}){
  signal?.throwIfAborted();const response=await this.transport(this.config.cliPath,['--gateway',this.config.gateway,...args],{env:this.env,input,signal,timeoutMs});
  if(response.exitCode!==0)throw mutation?unknown('OpenShell 外部操作没有完整成功回执，拒绝自动重放'):denied('OpenShell 状态查询失败','OPENSHELL_STATUS_UNAVAILABLE');return response;
 }
 async get(scope,signal){const value=JSON.parse((await this.cli(['sandbox','get',scope.name,'--output','json'],signal)).stdout);if(value.name!==scope.name||scope.sandboxId&&value.id!==scope.sandboxId||!uuid.test(value.id))throw denied('OpenShell 沙箱身份已变化','OPENSHELL_IDENTITY_MISMATCH');return value;}
 async waitForPhase(scope,phase,signal){
  const deadline=Date.now()+30000;
  for(;;){
   const state=await this.get(scope,signal);if(state.phase===phase)return state;
   if(!['Pending','Provisioning','Starting','Stopping'].includes(state.phase)||Date.now()>=deadline)throw unknown('OpenShell 生命周期状态未确认：'+state.phase);
   await new Promise((resolve,reject)=>{const abort=()=>{clearTimeout(timer);reject(signal.reason);};const timer=setTimeout(()=>{signal?.removeEventListener('abort',abort);resolve();},250);signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();});
  }
 }
 async admit(scope,signal){
  const status=JSON.parse((await this.cli(['status','--output','json'],signal)).stdout);
  if(status.status!=='connected'||status.version!==this.config.version||status.gateway!==this.config.gateway||status.server!=='https://127.0.0.1:18770'||status.authentication?.status!=='authenticated')throw denied('OpenShell mTLS 网关身份不匹配','OPENSHELL_IDENTITY_MISMATCH');
  const state=await this.get(scope,signal);
  if(state.phase!=='Ready'||!state.conditions?.some(c=>c.type==='Ready'&&c.status==='True')||state.configuration_admission?.state!=='accepted'||state.configuration_admission.policy_hash!==OPENSHELL_CONSTANTS.effectivePolicyHash)throw denied('OpenShell 沙箱未就绪或策略准入不匹配','OPENSHELL_ADMISSION_DENIED');
  const policy=JSON.parse((await this.cli(['policy','get',scope.name,'--full','--output','json'],signal)).stdout);
  if(policy.hash!==OPENSHELL_CONSTANTS.effectivePolicyHash||policy.policy?.process?.run_as_user!=='1000'||policy.policy?.process?.run_as_group!=='1000'||policy.policy?.landlock?.compatibility!=='hard_requirement'||Object.keys(policy.policy.network_policies??{}).length||Object.keys(policy.policy.network_middlewares??{}).length)throw denied('OpenShell 实际策略已变化','OPENSHELL_ADMISSION_DENIED');
  return state;
 }
 taskScopeRows(){
  if(!fs.existsSync(this.taskStateRoot))return [];
  canonicalPath(this.taskStateRoot,{directory:true});const rows=[];
  const entries=fs.readdirSync(this.taskStateRoot,{withFileTypes:true});
  if(entries.length>1000)throw denied('任务映射条目过多，容量不可确认','SANDBOX_STORAGE_LIMIT');
  for(const entry of entries){
   if(!/^[a-f0-9]{64}\.json$/.test(entry.name)){rows.push({phase:'unverified',error:'未知任务映射条目保留容量'});continue;}
   try{const file=path.join(this.taskStateRoot,entry.name);canonicalPath(file);if(fs.statSync(file).size>1024*1024)throw denied('映射过大');
    const raw=JSON.parse(fs.readFileSync(file,'utf8'));if(taskFileName(taskKey(raw.key))!==entry.name)throw denied('映射文件身份不匹配');
    const scope=this.read(raw.key);rows.push({key:scope.key,runId:scope.runId,sandboxId:scope.sandboxId,name:scope.name,phase:scope.phase,workspaceRevision:scope.workspaceRevision,storage:scope.storage,retirement:scope.retirement});
   }catch{rows.push({phase:'unverified',error:'任务映射授权或格式未核对'});}
  }
  return rows;
 }
 admitTaskCapacity(creating){
  const scopes=this.taskScopeRows();
  if(creating&&scopes.filter(scope=>scope.phase!=='retired').length>=128)throw denied('任务沙箱范围已达 128 个','SANDBOX_STORAGE_LIMIT');
  if(scopes.filter(scope=>!['retired','stopped'].includes(scope.phase)).length>=2)throw denied('任务沙箱运行资源已占满','SANDBOX_STORAGE_LIMIT');
  const reserved=scopes.filter(scope=>scope.phase!=='retired').reduce((sum,scope)=>sum+(scope.storage?.workspace?.bytes??SANDBOX_STORAGE_LIMITS.workspaceBytes)+(scope.storage?.temp?.bytes??SANDBOX_STORAGE_LIMITS.tempBytes),0);
  const free=fs.statfsSync(this.config.home);if(free.bavail*free.bsize-reserved<SANDBOX_STORAGE_LIMITS.minFreeBytes)throw denied('OpenShell 工作区及临时文件磁盘余量不足','SANDBOX_STORAGE_LIMIT');
 }
 execute(job,signal){if(this.closing||this.closed)return Promise.reject(denied('OpenShell 执行器已关闭'));const task=this.queue.then(()=>this.perform(job,signal));this.queue=task.catch(()=>{});return task;}
 async perform(job,signal){
  signal?.throwIfAborted();this.assertGrant(job);
  const args=job.arguments??{};if(!['prepare','filesystem','artifact_write','terminal','terminal_test','native_plugin'].includes(job.name))throw denied('OpenShell 工具未开放');
  let bundle;
  if(job.name==='native_plugin'){
   if(!this.loadNativeBundle||!/^[a-f0-9]{64}$/.test(args.pluginId)||!/^plugin__[a-z][a-z0-9_]{0,19}__[a-z][a-z0-9_]{0,31}$/.test(args.toolName))throw denied('原生插件安装或工具绑定不可用','NATIVE_BUNDLE_UNAVAILABLE');
   const installed=await this.loadNativeBundle(args.pluginId),tool=installed.manifest.tools.find(item=>item.name===args.toolName);
   if(!tool||tool.originalName!==args.originalName)throw denied('原生插件注册定义不匹配','NATIVE_VERSION_MISMATCH');
   bundle={...installed.manifest.bundle,compressed:installed.compressed.toString('base64'),metadata:installed.metadata.toString('base64')};
  }
  if(['filesystem','artifact_write'].includes(job.name))validPath(args.path);
  if(['terminal','terminal_test'].includes(job.name)&&(!this.grant.allowCommands||!uuid.test(job.approvalId??'')))throw denied('沙箱命令缺少授权或逐次批准');
  if(job.name==='artifact_write'&&(typeof args.content!=='string'||Buffer.byteLength(args.content)>5*1024*1024))throw denied('写入文件超过限制','LOCAL_FILE_LIMIT');
  if(['terminal','terminal_test'].includes(job.name)&&(typeof args.command!=='string'||!args.command||args.command.length>5000))throw denied('命令格式不正确');
  const taskMode=job.executionScope!==undefined;
  if(taskMode&&(job.executionScope?.key?.runId!==job.runId||job.executionScope?.profile!==taskProfile))throw denied('任务身份与执行 profile 不匹配');
  if(taskMode&&job.name==='prepare')taskScope(job.executionScope,job.files??[]);
  else if(taskMode)taskKey(job.executionScope?.key);
  let scope=this.read(taskMode?job.executionScope.key:job.runId),dispatched=false,lifecyclePending=false;
  if(taskMode&&scope&&job.name!=='prepare')advanceTaskScope(scope,job.executionScope);
  if(taskMode&&job.name!=='prepare'&&!scope)throw denied('任务沙箱尚未初始化');
  if(scope?.phase==='unknown'||scope?.activeOperation)throw unknown('此沙箱存在结果未明操作，禁止自动续跑');
  if(scope?.completedOperations?.includes(job.id))throw denied('此操作已经完成，使用上层持久回执，禁止重复执行','OPENSHELL_ALREADY_COMPLETED');
  if((scope?.completedOperations?.length??0)>=4096)throw denied('此沙箱操作记录达到上限，请创建新运行','LOCAL_FILE_LIMIT');
  if(job.name==='prepare'){
   decodeFiles(job.files??[]);if(scope)throw denied('同一运行沙箱已经存在，拒绝重复初始化','LOCAL_WORKSPACE_CONFLICT');
   if(taskMode)this.admitTaskCapacity(true);
   scope={schema:taskMode?2:1,runId:job.runId,grantId:this.grant.id,fingerprint:this.backend.fingerprint,name:'wwe-'+randomBytes(6).toString('hex'),phase:'creating',sourceManifest:manifest(job.files??[]),sourceRevision:revision(job.files??[]),completedOperations:[],...(taskMode?{...job.executionScope,inputWorkManifest:manifest(job.files??[])}:{})};
  }else if(!scope||!['ready','stopped'].includes(scope.phase))throw denied('OpenShell 工作区尚未初始化');
  if(taskMode&&scope.phase==='stopped')this.admitTaskCapacity(false);
  if(taskMode&&job.name==='filesystem'&&!scope.readPaths.includes(args.path))throw denied('任务读取路径未授权');
  if(taskMode&&job.name==='artifact_write'&&!scope.writePaths.includes(args.path))throw denied('任务输出路径未授权');
  const nonce=randomBytes(16).toString('hex');
  const request={nonce,name:job.name,arguments:args,...(job.name==='terminal_test'&&job.verificationProfile==='node-permission-workspace-v1'?{verificationProfile:job.verificationProfile}:{}),...(bundle?{bundle,callId:job.context?.callId}:{}),...(job.name==='prepare'?{files:job.files??[]}:{expectedStoredRevision:scope.workspaceRevision}),...(taskMode?{profile:taskProfile,readPaths:scope.readPaths,writePaths:scope.writePaths,inputManifest:scope.inputManifest,operationId:job.id}:{})};
  const input=taskMode?taskEnvelope(request):JSON.stringify(request);
  scope.activeOperation=job.id;scope.lastOperationId=job.id;if(taskMode)scope.lastOperationName=job.name;this.save(scope);
  try{
   if(job.name==='prepare'){
    // Persist the unique name before ONE create; no retries after any dispatch.
    const absent=await this.transport(this.config.cliPath,['--gateway',this.config.gateway,'sandbox','get',scope.name,'--output','json'],{env:this.env,signal,timeoutMs:30000});
    if(absent.exitCode!==1||!absent.stderr?.toLowerCase().includes('sandbox not found'))throw denied('不能确认新沙箱名称不存在，拒绝创建','LOCAL_WORKSPACE_CONFLICT');
    dispatched=true;lifecyclePending=true;
    await this.cli(['sandbox','create','--name',scope.name,'--from',this.config.image,'--policy',this.config.policyPath,'--cpu',this.config.cpu,'--memory',this.config.memory,'--no-auto-providers','--approval-mode','manual','--detach','--no-tty','--output','json','--','/bin/sleep','infinity'],signal,{timeoutMs:120000,mutation:true});
    const actual=await this.get(scope,signal);scope.sandboxId=actual.id;scope.phase='importing';this.save(scope);
   }else if(scope.phase==='stopped'){
    // Only a previously confirmed stop may be started. Persist intent before
    // ONE start; any crash/transport ambiguity remains blocked across reopen.
    const stopped=await this.get(scope,signal);if(stopped.phase!=='Stopped')throw denied('已停止沙箱的外部状态已变化','OPENSHELL_IDENTITY_MISMATCH');
    scope.phase='starting';this.save(scope);lifecyclePending=true;
    await this.cli(['sandbox','start',scope.name],signal,{timeoutMs:120000,mutation:true});
    await this.waitForPhase(scope,'Ready',signal);await this.admit(scope,signal);
    scope.phase='ready';this.save(scope);lifecyclePending=false;
   }
   await this.admit(scope,signal);
   dispatched=true;
   const response=await this.cli(['sandbox','exec','--name',scope.name,'--workdir','/sandbox','--no-tty','--no-login-shell','--timeout','75','--','node','-e',REMOTE_SCRIPT],signal,{input,timeoutMs:90000,mutation:true});
   let receipt;try{receipt=JSON.parse(response.stdout);}catch{throw unknown('OpenShell 操作回执不完整');}
   if(receipt.nonce!==nonce||typeof receipt.ok!=='boolean')throw unknown('OpenShell 操作回执不匹配');
   if(!receipt.ok)throw Object.assign(Error(receipt.error?.message??'OpenShell 工具失败'),{code:receipt.error?.code??'LOCAL_OPERATION_FAILED',notExecuted:receipt.error?.notExecuted===true,knownRemoteOutcome:true});
   let result=receipt.result;const identity=receipt.identity;
   if(identity?.uid!==1000||identity.gid!==1000||identity.node!=='v24.19.0'||identity.cpu?.[0]/identity.cpu?.[1]!==1||Number(identity.memory)!==536870912)throw unknown('OpenShell 身份回执不匹配');
   if(taskMode&&['terminal','terminal_test','native_plugin'].includes(job.name)){
    if(result?.deferredExport!==true||result.files!==undefined||result.workspaceRevision!==undefined)throw unknown('任务命令缺少延迟导出回执');
    if(Buffer.byteLength(JSON.stringify(result))>512*1024)throw unknown('任务命令回执过大，无法持久封存');
    // Save the command result before any lifecycle transition. A lost stop,
    // start, or inspection response must never cause the command to run again.
    scope.commandFence={operationId:job.id,stage:'command_confirmed',result,identity};this.save(scope);
    scope.phase='fencing_stopping';scope.commandFence.stage='stop_intent';this.save(scope);lifecyclePending=true;
    await this.cli(['sandbox','stop',scope.name],signal,{mutation:true,timeoutMs:90000});
    await this.waitForPhase(scope,'Stopped',signal);
    scope.phase='fencing_stopped';scope.commandFence.stage='stopped_confirmed';this.save(scope);
    scope.phase='fencing_starting';scope.commandFence.stage='start_intent';this.save(scope);
    await this.cli(['sandbox','start',scope.name],signal,{mutation:true,timeoutMs:120000});
    await this.waitForPhase(scope,'Ready',signal);await this.admit(scope,signal);
    scope.phase='fencing_inspecting';scope.commandFence.stage='inspect_intent';this.save(scope);
    const inspected=await this.inspectTaskExportNow(scope,job.id,signal);
    result={...result,...inspected};delete result.deferredExport;
   }else if(taskMode&&result?.deferredExport)throw unknown('非命令操作收到延迟导出回执');
   decodeFiles(result.files);if(result.workspaceRevision!==revision(result.files)||JSON.stringify(result.artifacts)!==JSON.stringify(manifest(result.files)))throw unknown('OpenShell 文件回执与版本不一致');
   if(taskMode)try{validateTaskFiles(scope,result.files);}catch{throw unknown('任务导出包含未授权或变化的文件');}
   if(job.name==='prepare'&&result.workspaceRevision!==scope.sourceRevision)throw unknown('恢复文件与原始版本不一致');
   await this.admit(scope,signal);
   scope.phase='ready';scope.activeOperation=null;scope.completedOperations.push(job.id);scope.workspaceRevision=result.workspaceRevision;scope.workManifest=result.artifacts;scope.identity=identity;scope.effectivePolicyHash=OPENSHELL_CONSTANTS.effectivePolicyHash;scope.storage=result.storage;delete scope.commandFence;this.save(scope);
   return {...result,localWorkspace:'openshell://'+this.config.gateway+'/'+scope.sandboxId+'/sandbox',execution:{...this.backend,sandboxId:scope.sandboxId,sandboxName:scope.name,...identity,effectivePolicyHash:scope.effectivePolicyHash},...(taskMode?{taskExecution:{profile:taskProfile,key:scope.key,scopeHash:scope.scopeHash,operationId:job.id,beforeWorkRevision:job.name==='prepare'?scope.sourceRevision:request.expectedStoredRevision,afterWorkRevision:result.workspaceRevision}}:{})};
  }catch(error){
   if(lifecyclePending||dispatched&&(!error.knownRemoteOutcome||!error.notExecuted)){scope.phase='unknown';error.notExecuted=false;}else if(job.name==='prepare'&&dispatched){scope.phase='unknown';error.notExecuted=false;}
   if(error.knownRemoteOutcome)scope.completedOperations.push(job.id);
   const fenceUnknown=!!scope.commandFence;
   scope.activeOperation=null;scope.lastError={code:fenceUnknown?'LOCAL_OUTCOME_UNKNOWN':error.code??'LOCAL_OPERATION_FAILED',message:String(error.message).slice(0,500),notExecuted:fenceUnknown?false:!!error.notExecuted};this.save(scope);
   if(fenceUnknown)throw unknown('任务命令生命周期或导出未确认，原操作不可重放');
   throw error;
  }
 }
 storageScopes(){
  if(!fs.existsSync(this.stateRoot))return this.taskScopeRows();canonicalPath(this.stateRoot,{directory:true});const rows=[],dir=fs.opendirSync(this.stateRoot);let entries=0;
  try{let entry;while((entry=dir.readSync())){if(++entries>1000){rows.push({phase:'unverified',error:'映射条目超过 1000，剩余保留'});break;}if(!/^[a-f0-9-]{36}\.json$/.test(entry.name))continue;
   const runId=entry.name.slice(0,-5);try{const scope=this.read(runId);rows.push({runId,sandboxId:scope.sandboxId,name:scope.name,phase:scope.phase,workspaceRevision:scope.workspaceRevision,storage:scope.storage,retirement:scope.retirement});}catch{rows.push({runId,phase:'unverified',error:'映射授权或格式未核对'});}
  }}finally{dir.closeSync();}return [...rows,...this.taskScopeRows()];
 }
 maintenance(fn){if(this.closing||this.closed)return Promise.reject(denied('OpenShell 执行器已关闭'));const task=this.queue.then(fn);this.queue=task.catch(()=>{});return task;}
 async inspectTaskExportNow(scope,operationId,signal){
  await this.admit(scope,signal);
  const nonce=randomBytes(16).toString('hex');
  const request={nonce,name:'task_export_inspect',profile:taskProfile,operationId,readPaths:scope.readPaths,writePaths:scope.writePaths,inputManifest:scope.inputManifest};
  const input=taskEnvelope(request);
  const response=await this.cli(['sandbox','exec','--name',scope.name,'--workdir','/sandbox','--no-tty','--no-login-shell','--timeout','75','--','node','-e',REMOTE_SCRIPT],signal,{input,timeoutMs:90000,mutation:true});
  let receipt;try{receipt=JSON.parse(response.stdout);}catch{throw unknown('任务导出查询回执不完整');}
  if(receipt.nonce!==nonce||receipt.ok!==true||receipt.identity?.uid!==1000||receipt.identity?.gid!==1000||receipt.identity?.node!=='v24.19.0'||receipt.identity?.cpu?.[0]/receipt.identity?.cpu?.[1]!==1||Number(receipt.identity?.memory)!==536870912)throw unknown('任务导出查询回执或身份不匹配');
  const result=receipt.result;try{decodeFiles(result.files);if(result.workspaceRevision!==revision(result.files)||JSON.stringify(result.artifacts)!==JSON.stringify(manifest(result.files)))throw Error('manifest');validateTaskFiles(scope,result.files);}catch{throw unknown('任务导出查询文件未通过核对');}
  await this.admit(scope,signal);return result;
 }
 inspectTaskExport(key,operationId){return this.maintenance(async()=>{
  taskKey(key);if(!uuid.test(operationId))throw denied('任务操作编号不正确');
  const scope=this.read(key);if(!scope||!scope.sandboxId||scope.lastOperationId!==operationId)throw denied('原任务沙箱或最新操作引用不存在');
  if(scope.activeOperation||scope.commandFence||scope.phase==='unknown'&&(!scope.lastOperationName||['terminal','terminal_test','native_plugin'].includes(scope.lastOperationName))||['terminal','terminal_test','native_plugin'].includes(scope.lastOperationName)&&!scope.completedOperations.includes(operationId))throw unknown('命令生命周期未完成，禁止导出');
  if(!['ready','unknown'].includes(scope.phase))throw denied('原任务沙箱或最新操作引用不存在');
  const result=await this.inspectTaskExportNow(scope,operationId,AbortSignal.timeout(120000));return {key,operationId,sandboxId:scope.sandboxId,...result};
 });}
 stopAcceptedTask(key,expected){return this.maintenance(async()=>{
  taskKey(key);const scope=this.read(key);
  if(!scope||scope.phase!=='ready'||scope.activeOperation)throw unknown('任务沙箱状态未核对，不能停止');
  if(expected?.accepted!==true||expected.checkpointResolved!==true||expected.operationsResolved!==true||expected.workspaceRevision!==scope.workspaceRevision)throw denied('任务尚未完成验收与操作核对');
  const signal=AbortSignal.timeout(120000);await this.admit(scope,signal);
  scope.phase='stopping';this.save(scope);
  try{await this.cli(['sandbox','stop',scope.name],signal,{mutation:true,timeoutMs:90000});await this.waitForPhase(scope,'Stopped',signal);scope.phase='stopped';scope.accepted=true;this.save(scope);return {key,sandboxId:scope.sandboxId,phase:'stopped'};}
  catch(error){scope.phase='unknown';scope.lastError={code:error.code??'LOCAL_OUTCOME_UNKNOWN',message:'任务停止结果待核对',notExecuted:false};this.save(scope);throw unknown(scope.lastError.message);}
 });}
 inspectStorage(runId){return this.maintenance(()=>this.inspectStorageNow(runId));}
 async inspectStorageNow(runId){
  this.assertGrant({id:randomUUID(),runId:typeof runId==='string'?runId:taskKey(runId).runId,grantId:this.grant.id});let scope=this.read(runId);if(!scope||!['ready','stopped'].includes(scope.phase)||scope.activeOperation)throw unknown('沙箱当前状态或操作结果尚未核对');
  const signal=AbortSignal.timeout(120000);let started=false;
  try{
   if(scope.phase==='stopped'){if(scope.schema===2)this.admitTaskCapacity(false);const state=await this.get(scope,signal);if(state.phase!=='Stopped')throw denied('停止状态已变化','OPENSHELL_IDENTITY_MISMATCH');scope.phase='starting';this.save(scope);started=true;await this.cli(['sandbox','start',scope.name],signal,{timeoutMs:90000,mutation:true});await this.waitForPhase(scope,'Ready',signal);scope.phase='ready';this.save(scope);started=false;}
   await this.admit(scope,signal);const nonce=randomBytes(16).toString('hex');
   const request={nonce,name:'storage_inspect',expectedStoredRevision:scope.workspaceRevision,...(scope.schema===2?{profile:taskProfile,readPaths:scope.readPaths,writePaths:scope.writePaths,inputManifest:scope.inputManifest}:{})};
   const response=await this.cli(['sandbox','exec','--name',scope.name,'--workdir','/sandbox','--no-tty','--no-login-shell','--timeout','75','--','node','-e',REMOTE_SCRIPT],signal,{input:scope.schema===2?taskEnvelope(request):JSON.stringify(request),timeoutMs:90000});
   let receipt;try{receipt=JSON.parse(response.stdout);}catch{throw unknown('磁盘核对回执不完整');}
   if(receipt.nonce!==nonce||typeof receipt.ok!=='boolean')throw unknown('磁盘核对回执不匹配');
   if(!receipt.ok)throw denied(receipt.error?.message??'磁盘核对失败',receipt.error?.code??'SANDBOX_STORAGE_LIMIT');
   const result=receipt.result,identity=receipt.identity;
   if(identity?.uid!==1000||identity.gid!==1000||identity.node!=='v24.19.0'||identity.cpu?.[0]/identity.cpu?.[1]!==1||Number(identity.memory)!==536870912)throw denied('核对身份不匹配','OPENSHELL_IDENTITY_MISMATCH');
   decodeFiles(result.files);if(result.workspaceRevision!==revision(result.files)||result.workspaceRevision!==scope.workspaceRevision||JSON.stringify(result.artifacts)!==JSON.stringify(manifest(result.files))||!result.storage)throw denied('当前文件版本未核对','WORKSPACE_VERSION_CONFLICT');if(scope.schema===2)validateTaskFiles(scope,result.files);
   await this.admit(scope,signal);scope.storage=result.storage;this.save(scope);return {runId:scope.runId,...(scope.schema===2?{key:scope.key}:{}),sandboxId:scope.sandboxId,workspaceRevision:scope.workspaceRevision,storage:result.storage};
  }catch(error){if(started){scope.phase='unknown';scope.lastError={code:error.code??'LOCAL_OUTCOME_UNKNOWN',message:'启动核对中断，禁止自动重放'};this.save(scope);throw unknown(scope.lastError.message);}throw error;}
 }
 retireStorage(runId,expected){return this.maintenance(async()=>{
  this.assertGrant({id:randomUUID(),runId:typeof runId==='string'?runId:taskKey(runId).runId,grantId:this.grant.id});let scope=this.read(runId);if(scope?.phase==='retired')return scope.retirement.result;
  if(!scope||scope.phase==='retiring'||scope.phase==='unknown'||scope.activeOperation)throw unknown('原回收结果未核对，禁止重发删除');
  if(expected?.sandboxId!==scope.sandboxId||expected?.workspaceRevision!==scope.workspaceRevision)throw denied('回收预览与沙箱版本不同','WORKSPACE_VERSION_CONFLICT');
  await this.inspectStorageNow(runId);scope=this.read(runId);const signal=AbortSignal.timeout(60000);
  scope.phase='retiring';scope.retirement={id:randomUUID(),sandboxId:scope.sandboxId,workspaceRevision:scope.workspaceRevision,startedAt:new Date().toISOString()};this.save(scope);
  try{await this.cli(['sandbox','delete',scope.sandboxId],signal,{mutation:true});const result=await this.confirmAbsent(scope,signal);if(result.state!=='retired')throw unknown('删除已受理但资源仍在');scope.phase='retired';scope.retirement.result=result;this.save(scope);return result;}
  catch(error){scope.phase='unknown';scope.lastError={code:'LOCAL_OUTCOME_UNKNOWN',message:'回收已发出但未取得最终回执，请只核对原沙箱'};this.save(scope);throw unknown(scope.lastError.message);}
 });}
 async confirmAbsent(scope,signal){
  for(let attempts=0;attempts<20;attempts++){const response=await this.transport(this.config.cliPath,['--gateway',this.config.gateway,'sandbox','get',scope.sandboxId,'--output','json'],{env:this.env,signal,timeoutMs:30000});
   if(response.exitCode===1&&response.stderr?.toLowerCase().includes('sandbox not found'))return {runId:scope.runId,...(scope.schema===2?{key:scope.key}:{}),sandboxId:scope.sandboxId,state:'retired',replayed:false};
   if(response.exitCode!==0)throw unknown('回收状态查询没有确定回执');const actual=JSON.parse(response.stdout);if(actual.id!==scope.sandboxId)throw unknown('回收沙箱 ID 不匹配');
   if(actual.phase!=='Deleting')return {runId:scope.runId,...(scope.schema===2?{key:scope.key}:{}),sandboxId:scope.sandboxId,state:'present',replayed:false};
   await new Promise(resolve=>setTimeout(resolve,250));
  }throw unknown('OpenShell 仍在处理回收，须稍后核对');
 }
 reconcileStorage(runId){return this.maintenance(async()=>{
  this.assertGrant({id:randomUUID(),runId:typeof runId==='string'?runId:taskKey(runId).runId,grantId:this.grant.id});const scope=this.read(runId);if(!scope?.retirement)throw denied('没有原回收意图，不能核对');
  if(scope.phase==='retired')return scope.retirement.result;const result=await this.confirmAbsent(scope,AbortSignal.timeout(60000));
  if(result.state==='retired'){scope.phase='retired';scope.retirement.result=result;this.save(scope);}return result;
 });}
 close(){return this.closing??=(async()=>{
  await this.queue;this.closed=true;const signal=AbortSignal.timeout(60000);
  for(const scope of this.scopes.values())if(scope.schema===1&&scope.phase==='ready'&&!scope.activeOperation){
   if(signal.aborted)break; // Unattempted scopes retain their known ready state.
   let dispatched=false;
   try{await this.admit(scope,signal);scope.phase='stopping';this.save(scope);dispatched=true;await this.cli(['sandbox','stop',scope.name],signal,{mutation:true});await this.waitForPhase(scope,'Stopped',signal);scope.phase='stopped';this.save(scope);}
   catch(error){if(dispatched)scope.phase='unknown';scope.lastError={code:error.code??'LOCAL_OUTCOME_UNKNOWN',message:String(error.message).slice(0,500),notExecuted:!dispatched};this.save(scope);}
  }
 })();}
}
module.exports={OpenShellDeviceExecutor,OpenShellExecutor:OpenShellDeviceExecutor,OPENSHELL_CONSTANTS,POLICY_TEXT,canonicalConfigFingerprint,cliTransport,REMOTE_SCRIPT,MAX_TASK_EXEC_STDIN_BYTES,taskEnvelope};
