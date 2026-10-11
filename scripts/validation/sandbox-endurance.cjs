// Disposable, no-model instrument. Employee artifacts are copied unchanged and never counted as instrument output.
const fs=require('node:fs'),path=require('node:path'),{randomUUID,createHash}=require('node:crypto'),{spawn}=require('node:child_process'),{performance}=require('node:perf_hooks');
const BASE='/home/jj/.local/share/weiwu',RELEASE=BASE+'/releases/weiwu-lifecycle1-20261011',SOURCE='f86bfd4f-265d-43f4-ad30-5c5c1140dd92',UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/,sha=value=>createHash('sha256').update(value).digest('hex');
function validateCheckpoint(s,sourceRevision){
 if(s?.version!==1||!UUID.test(s.runId)||s.sourceRevision!==sourceRevision||!Number.isFinite(Date.parse(s.startedAt))||s.durationMs!==1800000||!Number.isFinite(s.activeMs)||s.activeMs<0||!Number.isSafeInteger(s.rounds)||s.rounds<0||!Number.isSafeInteger(s.workers)||s.workers<0||!['new','running','checkpoint'].includes(s.status)||s.startedOperation)throw Error('Checkpoint is unverified, failed, or has an in-flight operation; preserve it without replay');return true;
}
function completedEndurance(s){return s.durationMs===1800000&&Number.isFinite(Date.parse(s.startedAt))&&Number.isFinite(s.activeMs)&&s.activeMs>=s.durationMs&&s.rounds>=2&&s.workers>=2&&!s.startedOperation;}
function save(root,s){const file=path.join(root,'checkpoint.json'),temporary=file+'.'+randomUUID(),fd=fs.openSync(temporary,'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify(s,null,2));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(temporary,file);const dir=fs.openSync(root,'r');try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}}
function checkedRoot(root){const absolute=path.resolve(root);if(!absolute.startsWith(BASE+'/probes/endurance-'))throw Error('Not the dedicated probe directory');let at='/';for(const part of absolute.slice(1).split('/')){at=path.join(at,part);const stat=fs.lstatSync(at);if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('Probe directory contains an unverified link');}const file=path.join(absolute,'checkpoint.json'),stat=fs.lstatSync(file);if(!stat.isFile()||stat.nlink!==1||stat.size>65536)throw Error('Checkpoint file not ordinary or bounded');return absolute;}
async function worker(root){
 root=checkedRoot(root);const s=JSON.parse(fs.readFileSync(path.join(root,'checkpoint.json')));if(s.sourceRun!==SOURCE||s.grant?.root!==path.join(root,'grant')||!UUID.test(s.grant.id)||s.grant.allowCommands!==true)throw Error('Dedicated grant/source binding changed');
 const {OpenShellDeviceExecutor}=require(RELEASE+'/apps/desktop/openshell-executor.cjs'),{exportFiles,revision}=require(RELEASE+'/apps/desktop/local-executor.cjs');
 const source=exportFiles(BASE+'/data/pilot/runs/'+SOURCE+'/artifacts');validateCheckpoint(s,revision(source));
 const config=JSON.parse(fs.readFileSync(BASE+'/config/openshell-node-v012.json','utf8')),executor=new OpenShellDeviceExecutor({grant:s.grant,config,journalRoot:path.join(root,'journal')});
 const previousWorkers=s.workers,workerStarted=performance.now(),deadline=workerStarted+s.durationMs/2;s.workers++;s.workerPids.push(process.pid);s.status='running';save(root,s);
 function assertSource(files){for(const original of source){const found=files.find(f=>f.path===original.path);if(!found||found.content!==original.content)throw Error('Employee source artifact changed');}}
 async function operation(name,args={},files){
  const id=randomUUID(),approvalId=['terminal','terminal_test'].includes(name)?randomUUID():undefined;s.startedOperation={id,name,approvalId,argumentsHash:sha(JSON.stringify(args)),at:new Date().toISOString()};save(root,s);
  const result=await executor.execute({id,runId:s.runId,grantId:s.grant.id,name,arguments:args,...(files?{files}:{}),...(approvalId?{approvalId}: {})});
  assertSource(result.files);if(['terminal','terminal_test'].includes(name)&&result.exitCode!==0)throw Error('Command failed with exit '+result.exitCode);
  const receipt={...s.startedOperation,completedAt:new Date().toISOString(),workspaceRevision:result.workspaceRevision,...(result.exitCode!==undefined?{exitCode:result.exitCode,outputSha256:sha(result.output)}:{})},fd=fs.openSync(path.join(root,'operations.jsonl'),'a',0o600);try{fs.writeFileSync(fd,JSON.stringify(receipt)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  s.workspaceRevision=result.workspaceRevision;s.sandboxId=result.execution.sandboxId;s.completedOperations++;s.startedOperation=null;save(root,s);return result;
 }
 try{
  if(!s.sandboxId)await operation('prepare',{},source);
  else{const actual=await executor.inspectStorage(s.runId);if(actual.sandboxId!==s.sandboxId||actual.workspaceRevision!==s.workspaceRevision)throw Error('Recovery sandbox identity/version changed');s.restartVerified=true;save(root,s);}
  const tempCode='const fs=require("node:fs");const root=fs.mkdtempSync("/tmp/weiwu-endurance-");for(let n=0;n<64;n++)fs.writeFileSync(root+"/"+n,Buffer.alloc(1024));const peakTempBytes=64*1024;for(let n=0;n<64;n++)fs.unlinkSync(root+"/"+n);fs.rmdirSync(root);console.log(JSON.stringify({instrument:true,peakTempBytes,memoryCurrent:Number(fs.readFileSync("/sys/fs/cgroup/memory.current","utf8")),memoryPeak:Number(fs.readFileSync("/sys/fs/cgroup/memory.peak","utf8"))}));';
  while(performance.now()<deadline){
   await operation('filesystem',{path:'cli.mjs'});
   const content=JSON.stringify({instrument:'weiwu-endurance',round:s.rounds+1});await operation('artifact_write',{path:'.endurance.json',content,expectedSha256:s.instrumentSha??null});s.instrumentSha=sha(content);save(root,s);
   const tested=await operation('terminal_test',{command:'node --test cli.test.mjs',expectedWorkspaceRevision:s.workspaceRevision});
   const temp=await operation('terminal',{command:"node -e '"+tempCode+"'",expectedWorkspaceRevision:s.workspaceRevision}),metrics=JSON.parse(temp.output.trim());
   const inspected=await executor.inspectStorage(s.runId);s.rounds++;const sample={round:s.rounds,at:new Date().toISOString(),elapsedMs:s.activeMs+performance.now()-workerStarted,workerPid:process.pid,sandboxId:s.sandboxId,workspaceRevision:s.workspaceRevision,storage:inspected.storage,metrics,testExitCode:tested.exitCode,testOutputSha256:sha(tested.output),hostRss:process.memoryUsage().rss};
   const fd=fs.openSync(path.join(root,'samples.jsonl'),'a',0o600);try{fs.writeFileSync(fd,JSON.stringify(sample)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
   fs.writeFileSync(path.join(root,'last-test-output.txt'),tested.output,{mode:0o600});s.sampleBytes=fs.statSync(path.join(root,'samples.jsonl')).size;save(root,s);
   await new Promise(resolve=>setTimeout(resolve,Math.min(30000,Math.max(0,deadline-performance.now()))));
  }
  await executor.close();if(executor.read(s.runId).phase!=='stopped')throw Error('Stop did not obtain a known receipt');s.activeMs+=performance.now()-workerStarted;s.status='checkpoint';save(root,s);
  if(previousWorkers>0){
   if(!completedEndurance(s))throw Error('Thirty real minutes or process restart not proven');
   const reopened=new OpenShellDeviceExecutor({grant:s.grant,config,journalRoot:path.join(root,'journal')}),inspected=await reopened.inspectStorage(s.runId);if(inspected.sandboxId!==s.sandboxId||inspected.workspaceRevision!==s.workspaceRevision)throw Error('Final recovery identity mismatch');
   const record=reopened.read(s.runId);assertSource((await operationRead(reopened,s)).files);
   s.retirement=await reopened.retireStorage(s.runId,{sandboxId:s.sandboxId,workspaceRevision:s.workspaceRevision});await reopened.close();s.status='completed';s.finishedAt=new Date().toISOString();s.elapsedMs=Date.parse(s.finishedAt)-Date.parse(s.startedAt);s.sourceManifest=record.sourceManifest;save(root,s);
  }
 }catch(error){s.status='failed';s.error={code:error.code??'ENDURANCE_FAILED',message:String(error.message).slice(0,500)};save(root,s);throw error;}
}
async function operationRead(executor,s){return executor.execute({id:randomUUID(),runId:s.runId,grantId:s.grant.id,name:'filesystem',arguments:{path:'cli.mjs'}});}
async function controller(){
 const controllerStarted=performance.now();
 const root=fs.mkdtempSync(BASE+'/probes/endurance-'),{exportFiles,revision}=require(RELEASE+'/apps/desktop/local-executor.cjs');fs.chmodSync(root,0o700);const grant={id:randomUUID(),root:path.join(root,'grant'),allowCommands:true};fs.mkdirSync(grant.root,{mode:0o700});
 const s={version:1,runId:randomUUID(),sourceRun:SOURCE,sourceRevision:revision(exportFiles(BASE+'/data/pilot/runs/'+SOURCE+'/artifacts')),grant,startedAt:new Date().toISOString(),durationMs:1800000,activeMs:0,rounds:0,workers:0,workerPids:[],completedOperations:0,status:'new',startedOperation:null,modelCalls:0,employeeCalls:0};save(root,s);console.log(JSON.stringify({started:true,root,runId:s.runId,durationMs:s.durationMs,modelCalls:0}));
 for(let n=0;n<2;n++){await new Promise((resolve,reject)=>{const child=spawn(process.execPath,[__filename,'--worker',root],{stdio:'inherit'});child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(Error('Worker failed; no automatic replay')));});}
 const result=JSON.parse(fs.readFileSync(path.join(root,'checkpoint.json')));result.controllerElapsedMs=performance.now()-controllerStarted;if(result.status!=='completed'||!result.restartVerified||!completedEndurance(result)||result.controllerElapsedMs<result.durationMs)throw Error('Endurance final proof incomplete');save(root,result);console.log(JSON.stringify({passed:true,root,runId:result.runId,sandboxId:result.sandboxId,rounds:result.rounds,elapsedMs:result.elapsedMs,activeMs:result.activeMs,modelCalls:0}));
}
module.exports={validateCheckpoint,completedEndurance};
if(require.main===module){const args=process.argv.slice(2),task=args[0]==='--run'&&args.length===1?controller:args[0]==='--worker'&&args.length===2?()=>worker(args[1]):()=>{throw Error('Use --run on the preconfigured JJ host');};Promise.resolve().then(task).catch(error=>{console.error(JSON.stringify({passed:false,code:error.code??'ENDURANCE_FAILED',message:String(error.message).slice(0,500),modelCalls:0}));process.exitCode=1;});}
