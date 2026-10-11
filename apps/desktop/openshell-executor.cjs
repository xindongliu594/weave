const fs=require('node:fs');
const path=require('node:path');
const {createHash,randomUUID,randomBytes}=require('node:crypto');
const {spawn}=require('node:child_process');
const {validPath,canonicalManifest}=require('./local-executor.cjs');
const {SANDBOX_STORAGE_LIMITS,storageDenied,boundedStorage,checkSandboxStorage}=require('./sandbox-storage.cjs');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
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
const SANDBOX_STORAGE_LIMITS=${JSON.stringify(SANDBOX_STORAGE_LIMITS)};
${storageDenied.toString()}
${boundedStorage.toString()}
${checkSandboxStorage.toString()}
function checkedPath(root,value){validPath(value);let at=root;if(!fs.lstatSync(at).isDirectory()||fs.lstatSync(at).isSymbolicLink())throw denied('沙箱工作区目录已被替换');for(const part of value.split('/')){at=path.join(at,part);try{const stat=fs.lstatSync(at);if(stat.isSymbolicLink()||stat.isFile()&&stat.nlink>1)throw denied('沙箱工作区不允许链接');}catch(error){if(error.code!=='ENOENT')throw error;}}return at;}
function exportFiles(root){const files=[];let total=0,entries=0;function walk(dir){for(const name of fs.readdirSync(dir).sort()){if(++entries>512)throw denied('工作区项目数量超过限制','LOCAL_FILE_LIMIT');const full=path.join(dir,name),stat=fs.lstatSync(full),relative=path.relative(root,full).split(path.sep).join('/');checkedPath(root,relative);if(stat.isDirectory())walk(full);else if(stat.isFile()){if(files.length>=128||stat.size>5*1024*1024||(total+=stat.size)>20*1024*1024)throw denied('工作区文件超过限制','LOCAL_FILE_LIMIT');files.push({path:relative,content:fs.readFileSync(full).toString('base64')});}else throw denied('工作区出现非普通文件');}}walk(root);decodeFiles(files);return files;}
function manifest(files){return canonicalManifest(decodeFiles(files).map(file=>({path:file.path,size:file.bytes.length,sha256:hash(file.bytes)})));}
function revision(files){return hash(JSON.stringify(manifest(files)));}
function writeVersion(root,value,bytes,expected){const file=checkedPath(root,value),current=fs.existsSync(file)?hash(fs.readFileSync(file)):null;if(current!==(expected??null))throw denied('文件已变化，请携带正确 sha256','FILE_VERSION_CONFLICT');let temporary;try{fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});checkedPath(root,value);temporary=path.join(path.dirname(file),'.agent-write-'+crypto.randomUUID());const fd=fs.openSync(temporary,'wx',0o600);try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}checkedPath(root,value);if((fs.existsSync(file)?hash(fs.readFileSync(file)):null)!==current)throw denied('写入期间文件已变化','FILE_VERSION_CONFLICT');fs.renameSync(temporary,file);}catch(error){error.notExecuted=false;throw error;}finally{if(temporary&&fs.existsSync(temporary))fs.unlinkSync(temporary);}}
async function command(command,cwd){
 if(typeof command!=='string'||!command||command.length>5000)throw denied('命令格式不正确');
 return await new Promise((resolve,reject)=>{
  const child=spawn('/bin/sh',['-lc',command],{cwd,env:process.env,stdio:['ignore','pipe','pipe'],detached:true});let chunks=[],size=0,overflow=false,timedOut=false,storageError;
  const kill=()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}};
  const timer=setTimeout(()=>{timedOut=true;kill();},60000),monitor=setInterval(()=>{try{checkSandboxStorage();}catch(error){storageError=error;kill();}},250);
  const clear=()=>{clearTimeout(timer);clearInterval(monitor);};
  const collect=chunk=>{size+=chunk.length;if(size>1024*1024){overflow=true;kill();}else chunks.push(chunk);};child.stdout.on('data',collect);child.stderr.on('data',collect);
  child.once('error',error=>{clear();reject(Object.assign(error,{notExecuted:true}));});
  child.once('close',code=>{clear();kill();if(storageError)return reject(Object.assign(storageError,{notExecuted:false}));
   if(overflow||timedOut||code===null)return reject(Object.assign(Error(overflow?'命令输出超过限制':timedOut?'命令超过批准的执行时限':'命令退出结果不明确'),{code:overflow?'LOCAL_OUTPUT_LIMIT':'LOCAL_OUTCOME_UNKNOWN',notExecuted:false}));resolve({exitCode:code,output:Buffer.concat(chunks).toString('utf8')});
  });
 });
}
let buffers=[],length=0;
process.stdin.on('data',chunk=>{length+=chunk.length;if(length>29*1024*1024)process.exit(65);buffers.push(chunk);});
process.stdin.on('end',async()=>{let request,changed=false;try{
 request=JSON.parse(Buffer.concat(buffers).toString('utf8'));const root='/sandbox',args=request.arguments??{};
 const identity={uid:process.getuid(),gid:process.getgid(),node:process.version,cpu:fs.readFileSync('/sys/fs/cgroup/cpu.max','utf8').trim().split(/\s+/).map(Number),memory:fs.readFileSync('/sys/fs/cgroup/memory.max','utf8').trim()};
 if(identity.uid!==1000||identity.gid!==1000||identity.node!=='v24.19.0'||identity.cpu[0]/identity.cpu[1]!==1||Number(identity.memory)!==536870912)throw denied('实际沙箱身份或资源限制不匹配','OPENSHELL_IDENTITY_MISMATCH');
 checkSandboxStorage();let files=exportFiles(root),result={};if(request.expectedStoredRevision&&request.expectedStoredRevision!==revision(files))throw denied('沙箱文件与已保存的恢复版本不一致','WORKSPACE_VERSION_CONFLICT');if(args.expectedWorkspaceRevision&&args.expectedWorkspaceRevision!==revision(files))throw denied('批准后的工作区已变化','WORKSPACE_VERSION_CONFLICT');
 if(request.name==='prepare'){const inputs=decodeFiles(request.files??[]);if(files.length)throw denied('沙箱工作区已经存在文件，拒绝重复初始化','LOCAL_WORKSPACE_CONFLICT');for(const file of inputs){changed=true;writeVersion(root,file.path,file.bytes,null);}}
 else if(request.name==='filesystem'){const file=checkedPath(root,args.path),stat=fs.lstatSync(file);if(!stat.isFile()||stat.size>1024*1024)throw denied('读取文件超过限制','LOCAL_FILE_LIMIT');const bytes=fs.readFileSync(file);result={path:args.path,content:bytes.toString('utf8'),sha256:hash(bytes)};}
 else if(request.name==='artifact_write'){if(typeof args.content!=='string'||Buffer.byteLength(args.content)>5*1024*1024)throw denied('写入文件超过限制','LOCAL_FILE_LIMIT');validPath(args.path);decodeFiles([...files.filter(f=>f.path!==args.path),{path:args.path,content:Buffer.from(args.content).toString('base64')}]);writeVersion(root,args.path,Buffer.from(args.content),args.expectedSha256);changed=true;result={path:args.path,bytes:Buffer.byteLength(args.content),sha256:hash(Buffer.from(args.content))};}
 else if(request.name==='terminal'||request.name==='terminal_test'){changed=true;result=await command(args.command,root);}
 else if(request.name==='storage_inspect'){}
 else throw denied('沙箱工具未开放');
 const storage=checkSandboxStorage();files=exportFiles(root);console.log(JSON.stringify({nonce:request.nonce,ok:true,result:{...result,files,artifacts:manifest(files),workspaceRevision:revision(files),storage},identity}));
 }catch(error){console.log(JSON.stringify({nonce:request?.nonce,ok:false,error:{code:error.code??'LOCAL_OPERATION_FAILED',message:String(error.message).slice(0,500),notExecuted:!changed&&(error.notExecuted===true||request?.name==='filesystem')}}));}
});
`;

class OpenShellDeviceExecutor {
 constructor({grant,config,journalRoot,transport}={}){
  if(!uuid.test(grant?.id))throw denied('OpenShell 目录授权不正确');
  if(transport!==undefined&&typeof transport!=='function')throw denied('OpenShell transport 必须为显式函数依赖');
  this.grant={...grant,root:canonicalPath(grant.root,{directory:true})};this.identity=fs.statSync(this.grant.root);
  for(const key of ['version','gateway','cliSha256','image','policyHash','cpu','memory'])if(config?.[key]!==OPENSHELL_CONSTANTS[key])throw denied('OpenShell 固定配置不匹配','OPENSHELL_CONFIG_MISMATCH');
  this.config={...config};canonicalPath(config.home,{directory:true});canonicalPath(config.policyPath);
  if(hash(fs.readFileSync(config.policyPath))!==config.policyHash)throw denied('OpenShell 策略文件已经变化','OPENSHELL_CONFIG_MISMATCH');
  if(!transport){canonicalPath(config.cliPath);if(hash(fs.readFileSync(config.cliPath))!==config.cliSha256)throw denied('OpenShell CLI 文件已经变化','OPENSHELL_CONFIG_MISMATCH');}
  if(typeof journalRoot!=='string'||!path.isAbsolute(journalRoot))throw denied('OpenShell 私有回执目录不正确');
  this.stateRoot=path.join(journalRoot,'openshell-scopes');this.transport=transport??cliTransport;this.defaultTransport=transport===undefined;
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
  fs.mkdirSync(this.stateRoot,{recursive:true,mode:0o700});canonicalPath(this.stateRoot,{directory:true});return path.join(this.stateRoot,runId+'.json');
 }
 read(runId){
  const file=this.stateFile(runId);if(!fs.existsSync(file))return null;canonicalPath(file);if(fs.statSync(file).size>1024*1024)throw denied('OpenShell 映射文件超过限制');const scope=JSON.parse(fs.readFileSync(file,'utf8'));
  if(scope.runId!==runId||scope.grantId!==this.grant.id||scope.fingerprint!==this.backend.fingerprint)throw denied('OpenShell 持久映射授权已变化');
  if(scope.schema!==1||!/^wwe-[a-f0-9]{12}$/.test(scope.name)||!['creating','importing','ready','starting','stopping','stopped','unknown','retiring','retired'].includes(scope.phase)||!Array.isArray(scope.completedOperations)||scope.completedOperations.length>4096||scope.completedOperations.some(id=>!uuid.test(id))||new Set(scope.completedOperations).size!==scope.completedOperations.length||scope.activeOperation!=null&&!uuid.test(scope.activeOperation))throw denied('OpenShell 持久映射格式不正确');
  if(!['creating','unknown'].includes(scope.phase)&&!uuid.test(scope.sandboxId)||['ready','starting','stopping','stopped'].includes(scope.phase)&&! /^[a-f0-9]{64}$/.test(scope.workspaceRevision))throw denied('OpenShell 持久映射缺少已确认的沙箱或文件版本');
  return scope;
 }
 save(scope){atomicJson(this.stateFile(scope.runId),scope);this.scopes.set(scope.runId,scope);}
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
 execute(job,signal){if(this.closing||this.closed)return Promise.reject(denied('OpenShell 执行器已关闭'));const task=this.queue.then(()=>this.perform(job,signal));this.queue=task.catch(()=>{});return task;}
 async perform(job,signal){
  signal?.throwIfAborted();this.assertGrant(job);
  const args=job.arguments??{};if(!['prepare','filesystem','artifact_write','terminal','terminal_test'].includes(job.name))throw denied('OpenShell 工具未开放');
  if(['filesystem','artifact_write'].includes(job.name))validPath(args.path);
  if(['terminal','terminal_test'].includes(job.name)&&(!this.grant.allowCommands||!uuid.test(job.approvalId??'')))throw denied('沙箱命令缺少授权或逐次批准');
  if(job.name==='artifact_write'&&(typeof args.content!=='string'||Buffer.byteLength(args.content)>5*1024*1024))throw denied('写入文件超过限制','LOCAL_FILE_LIMIT');
  if(['terminal','terminal_test'].includes(job.name)&&(typeof args.command!=='string'||!args.command||args.command.length>5000))throw denied('命令格式不正确');
  let scope=this.read(job.runId),dispatched=false,lifecyclePending=false;
  if(scope?.phase==='unknown'||scope?.activeOperation)throw unknown('此沙箱存在结果未明操作，禁止自动续跑');
  if(scope?.completedOperations?.includes(job.id))throw denied('此操作已经完成，使用上层持久回执，禁止重复执行','OPENSHELL_ALREADY_COMPLETED');
  if((scope?.completedOperations?.length??0)>=4096)throw denied('此沙箱操作记录达到上限，请创建新运行','LOCAL_FILE_LIMIT');
  if(job.name==='prepare'){
   decodeFiles(job.files??[]);if(scope)throw denied('同一运行沙箱已经存在，拒绝重复初始化','LOCAL_WORKSPACE_CONFLICT');
   scope={schema:1,runId:job.runId,grantId:this.grant.id,fingerprint:this.backend.fingerprint,name:'wwe-'+randomBytes(6).toString('hex'),phase:'creating',sourceManifest:manifest(job.files??[]),sourceRevision:revision(job.files??[]),completedOperations:[]};
  }else if(!scope||!['ready','stopped'].includes(scope.phase))throw denied('OpenShell 工作区尚未初始化');
  scope.activeOperation=job.id;this.save(scope);
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
   const nonce=randomBytes(16).toString('hex');dispatched=true;
   const response=await this.cli(['sandbox','exec','--name',scope.name,'--workdir','/sandbox','--no-tty','--no-login-shell','--timeout','75','--','node','-e',REMOTE_SCRIPT],signal,{input:JSON.stringify({nonce,name:job.name,arguments:args,...(job.name==='prepare'?{files:job.files??[]}:{expectedStoredRevision:scope.workspaceRevision})}),timeoutMs:90000,mutation:true});
   let receipt;try{receipt=JSON.parse(response.stdout);}catch{throw unknown('OpenShell 操作回执不完整');}
   if(receipt.nonce!==nonce||typeof receipt.ok!=='boolean')throw unknown('OpenShell 操作回执不匹配');
   if(!receipt.ok)throw Object.assign(Error(receipt.error?.message??'OpenShell 工具失败'),{code:receipt.error?.code??'LOCAL_OPERATION_FAILED',notExecuted:receipt.error?.notExecuted===true,knownRemoteOutcome:true});
   const result=receipt.result,identity=receipt.identity;
   if(identity?.uid!==1000||identity.gid!==1000||identity.node!=='v24.19.0'||identity.cpu?.[0]/identity.cpu?.[1]!==1||Number(identity.memory)!==536870912)throw unknown('OpenShell 身份回执不匹配');
   decodeFiles(result.files);if(result.workspaceRevision!==revision(result.files)||JSON.stringify(result.artifacts)!==JSON.stringify(manifest(result.files)))throw unknown('OpenShell 文件回执与版本不一致');
   if(job.name==='prepare'&&result.workspaceRevision!==scope.sourceRevision)throw unknown('恢复文件与原始版本不一致');
   await this.admit(scope,signal);
   scope.phase='ready';scope.activeOperation=null;scope.completedOperations.push(job.id);scope.workspaceRevision=result.workspaceRevision;scope.identity=identity;scope.effectivePolicyHash=OPENSHELL_CONSTANTS.effectivePolicyHash;scope.storage=result.storage;this.save(scope);
   return {...result,localWorkspace:'openshell://'+this.config.gateway+'/'+scope.sandboxId+'/sandbox',execution:{...this.backend,sandboxId:scope.sandboxId,sandboxName:scope.name,...identity,effectivePolicyHash:scope.effectivePolicyHash}};
  }catch(error){
   if(lifecyclePending||dispatched&&(!error.knownRemoteOutcome||!error.notExecuted)){scope.phase='unknown';error.notExecuted=false;}else if(job.name==='prepare'&&dispatched){scope.phase='unknown';error.notExecuted=false;}
   if(error.knownRemoteOutcome)scope.completedOperations.push(job.id);
   scope.activeOperation=null;scope.lastError={code:error.code??'LOCAL_OPERATION_FAILED',message:String(error.message).slice(0,500),notExecuted:!!error.notExecuted};this.save(scope);throw error;
  }
 }
 storageScopes(){
  if(!fs.existsSync(this.stateRoot))return [];canonicalPath(this.stateRoot,{directory:true});const rows=[],dir=fs.opendirSync(this.stateRoot);let entries=0;
  try{let entry;while((entry=dir.readSync())){if(++entries>1000){rows.push({phase:'unverified',error:'映射条目超过 1000，剩余保留'});break;}if(!/^[a-f0-9-]{36}\.json$/.test(entry.name))continue;
   const runId=entry.name.slice(0,-5);try{const scope=this.read(runId);rows.push({runId,sandboxId:scope.sandboxId,name:scope.name,phase:scope.phase,workspaceRevision:scope.workspaceRevision,storage:scope.storage,retirement:scope.retirement});}catch{rows.push({runId,phase:'unverified',error:'映射授权或格式未核对'});}
  }}finally{dir.closeSync();}return rows;
 }
 maintenance(fn){if(this.closing||this.closed)return Promise.reject(denied('OpenShell 执行器已关闭'));const task=this.queue.then(fn);this.queue=task.catch(()=>{});return task;}
 inspectStorage(runId){return this.maintenance(()=>this.inspectStorageNow(runId));}
 async inspectStorageNow(runId){
  this.assertGrant({id:randomUUID(),runId,grantId:this.grant.id});let scope=this.read(runId);if(!scope||!['ready','stopped'].includes(scope.phase)||scope.activeOperation)throw unknown('沙箱当前状态或操作结果尚未核对');
  const signal=AbortSignal.timeout(120000);let started=false;
  try{
   if(scope.phase==='stopped'){const state=await this.get(scope,signal);if(state.phase!=='Stopped')throw denied('停止状态已变化','OPENSHELL_IDENTITY_MISMATCH');scope.phase='starting';this.save(scope);started=true;await this.cli(['sandbox','start',scope.name],signal,{timeoutMs:90000,mutation:true});await this.waitForPhase(scope,'Ready',signal);scope.phase='ready';this.save(scope);started=false;}
   await this.admit(scope,signal);const nonce=randomBytes(16).toString('hex');
   const response=await this.cli(['sandbox','exec','--name',scope.name,'--workdir','/sandbox','--no-tty','--no-login-shell','--timeout','75','--','node','-e',REMOTE_SCRIPT],signal,{input:JSON.stringify({nonce,name:'storage_inspect',expectedStoredRevision:scope.workspaceRevision}),timeoutMs:90000});
   let receipt;try{receipt=JSON.parse(response.stdout);}catch{throw unknown('磁盘核对回执不完整');}
   if(receipt.nonce!==nonce||typeof receipt.ok!=='boolean')throw unknown('磁盘核对回执不匹配');
   if(!receipt.ok)throw denied(receipt.error?.message??'磁盘核对失败',receipt.error?.code??'SANDBOX_STORAGE_LIMIT');
   const result=receipt.result,identity=receipt.identity;
   if(identity?.uid!==1000||identity.gid!==1000||identity.node!=='v24.19.0'||identity.cpu?.[0]/identity.cpu?.[1]!==1||Number(identity.memory)!==536870912)throw denied('核对身份不匹配','OPENSHELL_IDENTITY_MISMATCH');
   decodeFiles(result.files);if(result.workspaceRevision!==revision(result.files)||result.workspaceRevision!==scope.workspaceRevision||JSON.stringify(result.artifacts)!==JSON.stringify(manifest(result.files))||!result.storage)throw denied('当前文件版本未核对','WORKSPACE_VERSION_CONFLICT');
   await this.admit(scope,signal);scope.storage=result.storage;this.save(scope);return {runId,sandboxId:scope.sandboxId,workspaceRevision:scope.workspaceRevision,storage:result.storage};
  }catch(error){if(started){scope.phase='unknown';scope.lastError={code:error.code??'LOCAL_OUTCOME_UNKNOWN',message:'启动核对中断，禁止自动重放'};this.save(scope);throw unknown(scope.lastError.message);}throw error;}
 }
 retireStorage(runId,expected){return this.maintenance(async()=>{
  this.assertGrant({id:randomUUID(),runId,grantId:this.grant.id});let scope=this.read(runId);if(scope?.phase==='retired')return scope.retirement.result;
  if(!scope||scope.phase==='retiring'||scope.phase==='unknown'||scope.activeOperation)throw unknown('原回收结果未核对，禁止重发删除');
  if(expected?.sandboxId!==scope.sandboxId||expected?.workspaceRevision!==scope.workspaceRevision)throw denied('回收预览与沙箱版本不同','WORKSPACE_VERSION_CONFLICT');
  await this.inspectStorageNow(runId);scope=this.read(runId);const signal=AbortSignal.timeout(60000);
  scope.phase='retiring';scope.retirement={id:randomUUID(),sandboxId:scope.sandboxId,workspaceRevision:scope.workspaceRevision,startedAt:new Date().toISOString()};this.save(scope);
  try{await this.cli(['sandbox','delete',scope.sandboxId],signal,{mutation:true});const result=await this.confirmAbsent(scope,signal);if(result.state!=='retired')throw unknown('删除已受理但资源仍在');scope.phase='retired';scope.retirement.result=result;this.save(scope);return result;}
  catch(error){scope.phase='unknown';scope.lastError={code:'LOCAL_OUTCOME_UNKNOWN',message:'回收已发出但未取得最终回执，请只核对原沙箱'};this.save(scope);throw unknown(scope.lastError.message);}
 });}
 async confirmAbsent(scope,signal){
  for(let attempts=0;attempts<20;attempts++){const response=await this.transport(this.config.cliPath,['--gateway',this.config.gateway,'sandbox','get',scope.sandboxId,'--output','json'],{env:this.env,signal,timeoutMs:30000});
   if(response.exitCode===1&&response.stderr?.toLowerCase().includes('sandbox not found'))return {runId:scope.runId,sandboxId:scope.sandboxId,state:'retired',replayed:false};
   if(response.exitCode!==0)throw unknown('回收状态查询没有确定回执');const actual=JSON.parse(response.stdout);if(actual.id!==scope.sandboxId)throw unknown('回收沙箱 ID 不匹配');
   if(actual.phase!=='Deleting')return {runId:scope.runId,sandboxId:scope.sandboxId,state:'present',replayed:false};
   await new Promise(resolve=>setTimeout(resolve,250));
  }throw unknown('OpenShell 仍在处理回收，须稍后核对');
 }
 reconcileStorage(runId){return this.maintenance(async()=>{
  this.assertGrant({id:randomUUID(),runId,grantId:this.grant.id});const scope=this.read(runId);if(!scope?.retirement)throw denied('没有原回收意图，不能核对');
  if(scope.phase==='retired')return scope.retirement.result;const result=await this.confirmAbsent(scope,AbortSignal.timeout(60000));
  if(result.state==='retired'){scope.phase='retired';scope.retirement.result=result;this.save(scope);}return result;
 });}
 close(){return this.closing??=(async()=>{
  await this.queue;this.closed=true;const signal=AbortSignal.timeout(60000);
  for(const scope of this.scopes.values())if(scope.phase==='ready'&&!scope.activeOperation){
   if(signal.aborted)break; // Unattempted scopes retain their known ready state.
   let dispatched=false;
   try{await this.admit(scope,signal);scope.phase='stopping';this.save(scope);dispatched=true;await this.cli(['sandbox','stop',scope.name],signal,{mutation:true});await this.waitForPhase(scope,'Stopped',signal);scope.phase='stopped';this.save(scope);}
   catch(error){if(dispatched)scope.phase='unknown';scope.lastError={code:error.code??'LOCAL_OUTCOME_UNKNOWN',message:String(error.message).slice(0,500),notExecuted:!dispatched};this.save(scope);}
  }
 })();}
}
module.exports={OpenShellDeviceExecutor,OpenShellExecutor:OpenShellDeviceExecutor,OPENSHELL_CONSTANTS,POLICY_TEXT,canonicalConfigFingerprint,cliTransport,REMOTE_SCRIPT};
