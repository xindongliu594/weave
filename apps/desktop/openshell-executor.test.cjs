// Development fixtures exercise the real helper's file/CAS logic through a fake
// CLI. UID/cgroup/transport fixtures are NOT physical sandbox acceptance evidence.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {randomUUID}=require('node:crypto');
const {EventEmitter}=require('node:events');
const {OpenShellDeviceExecutor,OPENSHELL_CONSTANTS,POLICY_TEXT,canonicalConfigFingerprint,cliTransport,REMOTE_SCRIPT}=require('./openshell-executor.cjs');
const {manifest,revision}=require('./local-executor.cjs');

function executeFixtureScript(script,input,root,control={}){
 return new Promise((resolve,reject)=>{
  const stdin=new EventEmitter(),map=value=>typeof value==='string'&&(value==='/sandbox'||value.startsWith('/sandbox/'))?path.join(root,value.slice('/sandbox'.length)):typeof value==='string'&&(value==='/tmp'||value.startsWith('/tmp/'))?path.join(root,'..','temporary',value.slice('/tmp'.length)):value;
  const fixtures=new Proxy(fs,{get(target,name){
   if(name==='readFileSync')return(value,...args)=>value==='/sys/fs/cgroup/cpu.max'?(control.cpu??'100000 100000\n'):value==='/sys/fs/cgroup/memory.max'?(control.memory??'536870912\n'):fs.readFileSync(map(value),...args);
   if(name==='lstatSync')return(value,...args)=>{const info=fs.lstatSync(map(value),...args);if(control.hardlink&&value==='/sandbox/linked.txt')info.nlink=2;return info;};
   if(['existsSync','lstatSync','statSync','readdirSync','opendirSync','statfsSync','mkdirSync','openSync','unlinkSync'].includes(name))return(value,...args)=>target[name](map(value),...args);
   if(name==='renameSync')return(from,to)=>fs.renameSync(map(from),map(to));
   return typeof target[name]==='function'?target[name].bind(target):target[name];
  }});
  const fakeProcess={stdin,getuid:()=>control.uid??1000,getgid:()=>control.gid??1000,version:control.node??'v24.19.0',env:{},exit:code=>reject(Error('fixture helper exit '+code)),kill:(_pid,signal)=>{if(signal===0){if(control.backgroundAlive)return;throw Object.assign(Error('gone'),{code:'ESRCH'});}if(control.runningChild){const child=control.runningChild;control.runningChild=null;control.closedOn='kill';setImmediate(()=>child.emit('close',null));}}};
  const fixtureSpawn=()=>{const child=new EventEmitter();child.pid=123;child.stdout=new EventEmitter();child.stderr=new EventEmitter();if(control.commandTempGrowth){control.runningChild=child;const file=path.join(root,'..','temporary','growing'),fd=fs.openSync(file,'w');fs.ftruncateSync(fd,64*1024*1024+1);fs.closeSync(fd);setTimeout(()=>{if(control.runningChild){control.runningChild=null;control.closedOn='fallback';child.emit('close',0);}},700).unref();}else setImmediate(()=>{if(control.commandWriteFile)fs.writeFileSync(path.join(root,control.commandWriteFile),'command output');child.stdout.emit('data',Buffer.from('{"nonce":"forged-child-output","ok":true}\n'));child.stderr.emit('data',Buffer.from('fixture command failed\n'));child.emit('close',7);});return child;};
  const context={require:name=>name==='node:fs'?fixtures:name==='node:path'?path.posix:name==='node:child_process'?{spawn:fixtureSpawn}:require(name),process:fakeProcess,Buffer,console:{log:value=>resolve(JSON.parse(value))},setTimeout,clearTimeout,setInterval,clearInterval};
  try{vm.runInNewContext(script,context,{timeout:2000});stdin.emit('data',Buffer.from(input));stdin.emit('end');}catch(error){reject(error);}
 });
}
function fixture(){
 const base=path.join(__dirname,'.openshell-test-'+randomUUID());fs.mkdirSync(base,{mode:0o700});
 const grant={id:randomUUID(),root:path.join(base,'grant'),allowCommands:true},home=path.join(base,'home'),remote=path.join(base,'remote');
 for(const dir of [grant.root,home,remote,path.join(base,'temporary')])fs.mkdirSync(dir,{mode:0o700});
 const policyPath=path.join(base,'policy.yaml');fs.writeFileSync(policyPath,POLICY_TEXT);
 const config={version:OPENSHELL_CONSTANTS.version,cliPath:path.join(base,'fixture-cli'),cliSha256:OPENSHELL_CONSTANTS.cliSha256,home,gateway:OPENSHELL_CONSTANTS.gateway,image:OPENSHELL_CONSTANTS.image,policyPath,policyHash:OPENSHELL_CONSTANTS.policyHash,cpu:'1',memory:'512Mi'};
 const id=randomUUID(),calls=[],control={created:false,phase:'Ready',disconnect:false,policyHash:OPENSHELL_CONSTANTS.effectivePolicyHash};
 let name;const taskSandboxes=new Map();
 const transport=async(_cli,args,options)=>{
  calls.push({args:[...args],input:options.input});options.signal?.throwIfAborted();const command=args.slice(2);
  if(command[0]==='status')return {exitCode:0,stdout:JSON.stringify({status:'connected',version:'0.1.2',gateway:config.gateway,server:'https://127.0.0.1:18770',authentication:{status:'authenticated'}})};
  if(command[0]==='policy')return {exitCode:0,stdout:JSON.stringify({hash:control.policyHash,policy:{process:{run_as_user:'1000',run_as_group:'1000'},landlock:{compatibility:'hard_requirement'},network_policies:{},network_middlewares:{}}})};
  if(command[1]==='get'){
   if(control.failStoppedObservation&&control.phase==='Stopped')return {exitCode:1,stdout:'',stderr:'connection reset after stop'};
   const task=taskSandboxes.get(command[2]);if(task&&command[2]!==name)return {exitCode:0,stdout:JSON.stringify({name:command[2],id:task.id,phase:task.phase??'Ready',conditions:[{type:'Ready',status:'True'}],configuration_admission:{state:'accepted',policy_hash:control.policyHash}})};
   if(!task&&command[2]!==name&&command[2]!==id)return {exitCode:1,stdout:'',stderr:'sandbox not found'};
   if(!control.created)return {exitCode:1,stdout:'',stderr:'sandbox not found'};
   return {exitCode:0,stdout:JSON.stringify({name,id:control.replacedId??id,phase:control.phases?.shift()??control.phase,conditions:[{type:'Ready',status:'True'}],configuration_admission:{state:'accepted',policy_hash:control.policyHash}})};
  }
  if(command[1]==='delete'){assert.equal(command[2],id);if(!control.deleteStillPresent)control.created=false;if(control.deleteDisconnect)return {exitCode:1,stdout:'',stderr:'connection reset after delete'};return {exitCode:0,stdout:'deletion accepted'};}
  if(command[1]==='create'){const next=command[command.indexOf('--name')+1];assert.equal(taskSandboxes.has(next),false);if(!control.created){control.created=true;name=next;taskSandboxes.set(next,{id,root:remote});}else{const root=path.join(base,'remote-'+taskSandboxes.size);fs.mkdirSync(root);taskSandboxes.set(next,{id:randomUUID(),root});}return {exitCode:0,stdout:'{}'};}
  if(command[1]==='stop'){if(command[2]===name)control.phase='Stopped';else taskSandboxes.get(command[2]).phase='Stopped';if(control.stopDisconnect)return {exitCode:1,stdout:'',stderr:'connection reset after stop'};return {exitCode:0,stdout:''};}
  if(command[1]==='start'){assert.equal(control.phase,'Stopped');control.phase='Ready';if(control.startDisconnect)return {exitCode:1,stdout:'',stderr:'connection reset after start'};return {exitCode:0,stdout:''};}
  if(command[1]==='exec'){
   if(control.disconnect)return {exitCode:1,stdout:'',stderr:'connection reset'};
   if(control.failNextTaskInspect&&JSON.parse(options.input).name==='task_export_inspect'){control.failNextTaskInspect=false;return {exitCode:1,stdout:'',stderr:'connection reset after inspect'};}
   const receipt=await executeFixtureScript(command.at(-1),options.input,taskSandboxes.get(command[command.indexOf('--name')+1])?.root??remote,control);
   if(control.abortAfterExec){control.abortAfterExec.abort(Error('fixture shutdown after remote side effect'));throw Object.assign(Error('transport cancelled'),{code:'LOCAL_OUTCOME_UNKNOWN',notExecuted:false});}
   if(control.truncateReceipt)return {exitCode:0,stdout:JSON.stringify(receipt).slice(0,-1)};
   return {exitCode:0,stdout:JSON.stringify(receipt)};
  }
  throw Error('Unexpected fixture CLI request: '+command[0]+' '+command[1]);
 };
 const options={grant,config,journalRoot:path.join(base,'journal'),transport},executor=new OpenShellDeviceExecutor(options),runId=randomUUID();
 const job=(name,arguments_={},extra={})=>({id:randomUUID(),runId,grantId:grant.id,name,arguments:arguments_,...extra});
 return {base,grant,config,remote,control,calls,options,executor,runId,job,cleanup(){fs.rmSync(base,{recursive:true,force:true});}};
}

test('stdin restores exact source bytes; CAS/revisions/metadata match existing contract, no host workspace writes',async()=>{
 const f=fixture();try{
  const source=[{path:'nested/source.txt',content:Buffer.from('approved source version\n').toString('base64')}];
  const prepared=await f.executor.execute(f.job('prepare',{}, {files:source}));
  assert.equal(prepared.workspaceRevision,revision(source));assert.deepEqual(prepared.artifacts,manifest(source));
  assert.deepEqual(fs.readdirSync(f.grant.root),[]);assert.equal(prepared.execution.kind,'openshell');assert.equal(prepared.execution.uid,1000);assert.equal(prepared.execution.effectivePolicyHash,OPENSHELL_CONSTANTS.effectivePolicyHash);
  const read=await f.executor.execute(f.job('filesystem',{path:'nested/source.txt',expectedWorkspaceRevision:prepared.workspaceRevision}));
  assert.equal(read.content,'approved source version\n');
  await assert.rejects(f.executor.execute(f.job('artifact_write',{path:'nested/source.txt',content:'bad overwrite',expectedSha256:'wrong'})),{code:'FILE_VERSION_CONFLICT',notExecuted:true});
  assert.equal(fs.readFileSync(path.join(f.remote,'nested/source.txt'),'utf8'),read.content);
  const written=await f.executor.execute(f.job('artifact_write',{path:'nested/source.txt',content:'employee revision',expectedSha256:read.sha256,expectedWorkspaceRevision:read.workspaceRevision}));
  assert.equal(written.bytes,Buffer.byteLength('employee revision'));assert.equal(written.workspaceRevision,revision(written.files));
  await assert.rejects(f.executor.execute(f.job('filesystem',{path:'nested/source.txt',expectedWorkspaceRevision:prepared.workspaceRevision})),{code:'WORKSPACE_VERSION_CONFLICT',notExecuted:true});
 }finally{f.cleanup();}
});

test('grant, approval, hidden paths and file limits deny before any CLI dispatch',async()=>{
 const f=fixture();try{
  await assert.rejects(f.executor.execute({...f.job('prepare'),grantId:randomUUID()}),{code:'LOCAL_SCOPE_DENIED'});
  await assert.rejects(f.executor.execute(f.job('terminal_test',{command:'echo denied'})),{code:'LOCAL_SCOPE_DENIED'});
  for(const bad of ['../outside','.agent-policy.json','nested/.agent-seal','AUX.txt','C:/host'])await assert.rejects(f.executor.execute(f.job('filesystem',{path:bad})),{code:'LOCAL_SCOPE_DENIED'});
  await assert.rejects(f.executor.execute(f.job('prepare',{}, {files:[{path:'large.txt',content:Buffer.alloc(5*1024*1024+1).toString('base64')}]})),{code:'LOCAL_FILE_LIMIT'});
  assert.equal(f.calls.length,0);
 }finally{f.cleanup();}
});

test('large contents stay out of argv; duplicate completed jobs and cold mapping never repeat create/exec',async()=>{
 const f=fixture();try{
  const prepare=f.job('prepare',{}, {files:[{path:'large.txt',content:Buffer.alloc(1024*1024+7,65).toString('base64')}]});
  await f.executor.execute(prepare);const before=f.calls.length;
  await assert.rejects(f.executor.execute(prepare),{code:'OPENSHELL_ALREADY_COMPLETED'});assert.equal(f.calls.length,before);
  const reopened=new OpenShellDeviceExecutor(f.options);
  const result=await reopened.execute(f.job('filesystem',{path:'missing.txt'})).catch(error=>error);
  assert.equal(result.code,'ENOENT');assert.equal(f.calls.filter(call=>call.args[3]==='create').length,1);
  const exec=f.calls.find(call=>call.args[3]==='exec');assert.ok(exec.input.length>1024*1024);assert.ok(exec.args.join(' ').length<32768);assert.ok(!exec.args.some(arg=>arg.includes('QUFBQUFBQUFB')));
 }finally{f.cleanup();}
});

test('connection loss persists unknown across reopen; no repeated external operation and no host fallback',async()=>{
 const f=fixture();try{
  await f.executor.execute(f.job('prepare',{}, {files:[]}));f.control.disconnect=true;
  await assert.rejects(f.executor.execute(f.job('artifact_write',{path:'result.txt',content:'not confirmed'})),{code:'LOCAL_OUTCOME_UNKNOWN',notExecuted:false});
  const count=f.calls.length;const reopened=new OpenShellDeviceExecutor(f.options);
  await assert.rejects(reopened.execute(f.job('artifact_write',{path:'result.txt',content:'must not replay'})),{code:'LOCAL_OUTCOME_UNKNOWN',notExecuted:false});
  assert.equal(f.calls.length,count);assert.deepEqual(fs.readdirSync(f.grant.root),[]);
  await reopened.close();assert.equal(f.calls.length,count);
 }finally{f.cleanup();}
});

test('changed effective policy blocks before employee operation; clean close stops same scope once',async()=>{
 const f=fixture();try{
  const prepared=await f.executor.execute(f.job('prepare',{}, {files:[]}));const count=f.calls.filter(call=>call.args[3]==='exec').length;
  f.control.policyHash='0'.repeat(64);
  await assert.rejects(f.executor.execute(f.job('artifact_write',{path:'result.txt',content:'denied'})),{code:'OPENSHELL_ADMISSION_DENIED',notExecuted:true});
  assert.equal(f.calls.filter(call=>call.args[3]==='exec').length,count);
  f.control.policyHash=OPENSHELL_CONSTANTS.effectivePolicyHash;await f.executor.close();await f.executor.close();
  const stops=f.calls.filter(call=>call.args[3]==='stop');assert.equal(stops.length,1);assert.equal(stops[0].args[4],prepared.execution.sandboxName);
 }finally{f.cleanup();}
});

test('configuration fingerprint is field-order invariant and every fixed field changes its identity',()=>{
 const f=fixture();try{
  assert.equal(canonicalConfigFingerprint(f.config),canonicalConfigFingerprint(Object.fromEntries(Object.entries(f.config).reverse())));
  for(const key of ['cliPath','home','policyPath','policyHash','gateway','image','cpu','memory'])assert.notEqual(canonicalConfigFingerprint(f.config),canonicalConfigFingerprint({...f.config,[key]:f.config[key]+'-changed'}));
  assert.ok(REMOTE_SCRIPT.includes("checkedPath(root,args.path)"));
 }finally{f.cleanup();}
});

test('approved remote command nonzero exit is a known result; child output cannot forge transport receipt',async()=>{
 const f=fixture();try{
  const prepared=await f.executor.execute(f.job('prepare',{}, {files:[]}));
  const reply=await f.executor.execute(f.job('terminal_test',{command:'fixture command',expectedWorkspaceRevision:prepared.workspaceRevision},{approvalId:randomUUID()}));
  assert.equal(reply.exitCode,7);assert.match(reply.output,/forged-child-output/);assert.match(reply.output,/fixture command failed/);
  assert.equal(reply.execution.sandboxId,prepared.execution.sandboxId);assert.equal(reply.workspaceRevision,prepared.workspaceRevision);
  assert.equal(reply.execution.uid,1000);assert.deepEqual(fs.readdirSync(f.grant.root),[]);
 }finally{f.cleanup();}
});

test('remote workspace governance files and hard links are refused before returning any artifacts',async()=>{
 const f=fixture();try{
  await f.executor.execute(f.job('prepare',{}, {files:[{path:'source.txt',content:Buffer.from('source').toString('base64')}]}));
  // Native links are denied by this Windows tool sandbox. Fixture metadata
  // exercises exactly the hard-link rejection branch without new privileges.
  fs.writeFileSync(path.join(f.remote,'linked.txt'),'link fixture');f.control.hardlink=true;
  await assert.rejects(f.executor.execute(f.job('filesystem',{path:'source.txt'})),{code:'LOCAL_SCOPE_DENIED',notExecuted:true});
  fs.unlinkSync(path.join(f.remote,'linked.txt'));f.control.hardlink=false;fs.writeFileSync(path.join(f.remote,'.agent-shadow'),'untrusted governance file');
  await assert.rejects(f.executor.execute(f.job('filesystem',{path:'source.txt'})),{code:'LOCAL_SCOPE_DENIED',notExecuted:true});
  assert.deepEqual(fs.readdirSync(f.grant.root),[]);
 }finally{f.cleanup();}
});

test('clean shutdown and cold reopen start the same sandbox once, retain files and never replay completed operations',async()=>{
 const f=fixture();try{
  const prepare=f.job('prepare',{}, {files:[{path:'source.txt',content:Buffer.from('approved source').toString('base64')}]});
  const original=await f.executor.execute(prepare);
  await f.executor.close();assert.equal(f.control.phase,'Stopped');
  const reopened=new OpenShellDeviceExecutor(f.options),before=f.calls.length;
  await assert.rejects(reopened.execute(prepare),{code:'OPENSHELL_ALREADY_COMPLETED'});assert.equal(f.calls.length,before);
  const read=await reopened.execute(f.job('filesystem',{path:'source.txt'}));
  assert.equal(read.content,'approved source');assert.equal(read.execution.sandboxId,original.execution.sandboxId);assert.equal(read.workspaceRevision,original.workspaceRevision);
  const write=await reopened.execute(f.job('artifact_write',{path:'next.txt',content:'continued task'}));
  assert.equal(write.execution.sandboxId,original.execution.sandboxId);
  assert.equal(f.calls.filter(call=>call.args[3]==='create').length,1);assert.equal(f.calls.filter(call=>call.args[3]==='start').length,1);
  await reopened.close();assert.equal(f.control.phase,'Stopped');
 }finally{f.cleanup();}
});

test('cold recovery checks saved revision before a new write even without caller-supplied workspace revision',async()=>{
 const f=fixture();try{
  await f.executor.execute(f.job('prepare',{}, {files:[{path:'source.txt',content:Buffer.from('known version').toString('base64')}]}));
  await f.executor.close();fs.writeFileSync(path.join(f.remote,'source.txt'),'unexpected external change');
  const reopened=new OpenShellDeviceExecutor(f.options);
  await assert.rejects(reopened.execute(f.job('artifact_write',{path:'new.txt',content:'must not run'})),{code:'WORKSPACE_VERSION_CONFLICT',notExecuted:true});
  assert.equal(fs.existsSync(path.join(f.remote,'new.txt')),false);assert.equal(f.calls.filter(call=>call.args[3]==='start').length,1);
 }finally{f.cleanup();}
});

test('ambiguous start or stop is retained across reopen and never repeated',async()=>{
 for(const kind of ['start','stop']){
  const f=fixture();try{
   await f.executor.execute(f.job('prepare',{}, {files:[]}));
   if(kind==='stop'){f.control.stopDisconnect=true;await f.executor.close();}
   else{await f.executor.close();f.control.startDisconnect=true;const resumed=new OpenShellDeviceExecutor(f.options);await assert.rejects(resumed.execute(f.job('artifact_write',{path:'a.txt',content:'never written'})),{code:'LOCAL_OUTCOME_UNKNOWN',notExecuted:false});}
   const count=f.calls.length,reopened=new OpenShellDeviceExecutor(f.options);
   await assert.rejects(reopened.execute(f.job('artifact_write',{path:'a.txt',content:'do not replay'})),{code:'LOCAL_OUTCOME_UNKNOWN',notExecuted:false});
   await reopened.close();assert.equal(f.calls.length,count);assert.equal(fs.existsSync(path.join(f.remote,'a.txt')),false);
  }finally{f.cleanup();}
 }
});

test('service shutdown refuses new work immediately and concurrent close stops the sandbox only once',async()=>{
 const f=fixture();try{
  await f.executor.execute(f.job('prepare',{}, {files:[]}));const count=f.calls.filter(call=>call.args[3]==='exec').length;
  const first=f.executor.close(),second=f.executor.close();assert.equal(first,second);
  await assert.rejects(f.executor.execute(f.job('artifact_write',{path:'late.txt',content:'late'})),{code:'LOCAL_SCOPE_DENIED',notExecuted:true});
  await first;assert.equal(f.calls.filter(call=>call.args[3]==='stop').length,1);assert.equal(f.calls.filter(call=>call.args[3]==='exec').length,count);
 }finally{f.cleanup();}
});

test('cancellation or truncated receipt after a remote write preserves the unknown outcome without replay',async()=>{
 for(const kind of ['cancel','truncate']){
  const f=fixture();try{
   await f.executor.execute(f.job('prepare',{}, {files:[]}));const controller=new AbortController();
   if(kind==='cancel')f.control.abortAfterExec=controller;else f.control.truncateReceipt=true;
   await assert.rejects(f.executor.execute(f.job('artifact_write',{path:'maybe.txt',content:'operation happened'}),controller.signal),{code:'LOCAL_OUTCOME_UNKNOWN',notExecuted:false});
   assert.equal(fs.readFileSync(path.join(f.remote,'maybe.txt'),'utf8'),'operation happened');
   const count=f.calls.length,reopened=new OpenShellDeviceExecutor(f.options);
   await assert.rejects(reopened.execute(f.job('artifact_write',{path:'maybe.txt',content:'must not repeat'})),{code:'LOCAL_OUTCOME_UNKNOWN',notExecuted:false});
   await reopened.close();assert.equal(f.calls.length,count);
  }finally{f.cleanup();}
 }
});

test('actual helper checks UID, GID, Node and cgroup values before an employee write',async()=>{
 for(const change of [{uid:0},{gid:0},{node:'v24.18.0'},{cpu:'200000 100000\n'},{memory:'max\n'}]){
  const f=fixture();try{
   await f.executor.execute(f.job('prepare',{}, {files:[]}));Object.assign(f.control,change);
   await assert.rejects(f.executor.execute(f.job('artifact_write',{path:'forbidden.txt',content:'never written'})),{code:'OPENSHELL_IDENTITY_MISMATCH',notExecuted:true});
   assert.equal(fs.existsSync(path.join(f.remote,'forbidden.txt')),false);
  }finally{f.cleanup();}
 }
});

test('sandbox ID replacement blocks cold start before any new external mutation',async()=>{
 const f=fixture();try{
  await f.executor.execute(f.job('prepare',{}, {files:[]}));await f.executor.close();f.control.replacedId=randomUUID();
  const reopened=new OpenShellDeviceExecutor(f.options);
  await assert.rejects(reopened.execute(f.job('artifact_write',{path:'a.txt',content:'never written'})),{code:'OPENSHELL_IDENTITY_MISMATCH',notExecuted:true});
  assert.equal(f.calls.filter(call=>call.args[3]==='start').length,0);
 }finally{f.cleanup();}
});

test('prepare accepts an exact 5 MiB file and 20 MiB workspace through stdin',async()=>{
 const f=fixture();try{
  const source=Array.from({length:4},(_,i)=>({path:'file-'+i+'.bin',content:Buffer.alloc(5*1024*1024,i).toString('base64')}));
  const result=await f.executor.execute(f.job('prepare',{}, {files:source}));
  assert.equal(result.workspaceRevision,revision(source));assert.equal(result.artifacts.reduce((sum,file)=>sum+file.size,0),20*1024*1024);
  const exec=f.calls.find(call=>call.args[3]==='exec');assert.ok(exec.input.length<29*1024*1024);assert.ok(exec.args.join(' ').length<32768);
 }finally{f.cleanup();}
});

test('damaged persistent mappings cannot omit recovery versions or redirect a sandbox name',async()=>{
 for(const patch of [{workspaceRevision:undefined},{name:'another-sandbox'},{sandboxId:randomUUID().slice(0,20)}]){
  const f=fixture();try{
   await f.executor.execute(f.job('prepare',{}, {files:[]}));await f.executor.close();
   const file=path.join(f.options.journalRoot,'openshell-scopes',f.runId+'.json');fs.writeFileSync(file,JSON.stringify({...JSON.parse(fs.readFileSync(file,'utf8')),...patch}));
   const count=f.calls.length,reopened=new OpenShellDeviceExecutor(f.options);
   await assert.rejects(reopened.execute(f.job('artifact_write',{path:'a.txt',content:'never written'})),{code:'LOCAL_SCOPE_DENIED',notExecuted:true});assert.equal(f.calls.length,count);
  }finally{f.cleanup();}
 }
});

test('real local transport forwards large stdin, bounds output, and classifies cancellation after spawn as unknown',async()=>{
 const echo=await cliTransport(process.execPath,['-e',"let n=0;process.stdin.on('data',b=>n+=b.length);process.stdin.on('end',()=>console.log(n))"],{input:'A'.repeat(2*1024*1024),timeoutMs:5000});
 assert.equal(echo.exitCode,0);assert.equal(Number(echo.stdout),2*1024*1024);
 const stopped=new AbortController();stopped.abort(Error('before spawn'));
 assert.throws(()=>cliTransport(process.execPath,['-e','process.exit(99)'],{signal:stopped.signal}),/before spawn/);
 await assert.rejects(cliTransport(process.execPath,['-e','setInterval(()=>{},1000)'],{timeoutMs:250}),{code:'LOCAL_OUTCOME_UNKNOWN',notExecuted:false});
 await assert.rejects(cliTransport(process.execPath,['-e',"process.stdout.write('x'.repeat(10000))"],{timeoutMs:5000,maxOutput:128}),{code:'LOCAL_OUTCOME_UNKNOWN',notExecuted:false});
});

test('maintenance inspects exact bytes then retires only the matching sandbox once',async()=>{
 const f=fixture();try{assert.equal(typeof f.executor.inspectStorage,'function');const original=await f.executor.execute(f.job('prepare',{}, {files:[{path:'delivery.txt',content:Buffer.from('employee delivery').toString('base64')}]}));
 const inspected=await f.executor.inspectStorage(f.runId);assert.equal(inspected.storage.workspace.bytes,17);assert.equal(inspected.workspaceRevision,original.workspaceRevision);
 const result=await f.executor.retireStorage(f.runId,{sandboxId:original.execution.sandboxId,workspaceRevision:original.workspaceRevision});assert.equal(result.state,'retired');
 const again=await f.executor.retireStorage(f.runId,{sandboxId:original.execution.sandboxId,workspaceRevision:original.workspaceRevision});assert.deepEqual(again,result);assert.equal(f.calls.filter(c=>c.args[3]==='delete').length,1);
 }finally{f.cleanup();}
});
test('maintenance refuses changed versions and does not send delete',async()=>{
 const f=fixture();try{assert.equal(typeof f.executor.retireStorage,'function');const original=await f.executor.execute(f.job('prepare'));
 await assert.rejects(f.executor.retireStorage(f.runId,{sandboxId:original.execution.sandboxId,workspaceRevision:'0'.repeat(64)}),{code:'WORKSPACE_VERSION_CONFLICT'});assert.equal(f.calls.filter(c=>c.args[3]==='delete').length,0);
 }finally{f.cleanup();}
});
test('delete disconnect survives executor recreation and reconciles absence without replay',async()=>{
 const f=fixture();try{assert.equal(typeof f.executor.reconcileStorage,'function');const original=await f.executor.execute(f.job('prepare'));f.control.deleteDisconnect=true;
 await assert.rejects(f.executor.retireStorage(f.runId,{sandboxId:original.execution.sandboxId,workspaceRevision:original.workspaceRevision}),{code:'LOCAL_OUTCOME_UNKNOWN'});
 const reopened=new OpenShellDeviceExecutor(f.options);await assert.rejects(reopened.retireStorage(f.runId,{sandboxId:original.execution.sandboxId,workspaceRevision:original.workspaceRevision}),{code:'LOCAL_OUTCOME_UNKNOWN'});
 const checked=await reopened.reconcileStorage(f.runId);assert.equal(checked.state,'retired');assert.equal(f.calls.filter(c=>c.args[3]==='delete').length,1);
 }finally{f.cleanup();}
});

test('deletion accepted with a still-present sandbox is not reported as reclaimed',async()=>{
 const f=fixture();try{const prepared=await f.executor.execute(f.job('prepare'));f.control.deleteStillPresent=true;await assert.rejects(f.executor.retireStorage(f.runId,{sandboxId:prepared.execution.sandboxId,workspaceRevision:prepared.workspaceRevision}),{code:'LOCAL_OUTCOME_UNKNOWN'});assert.equal(f.executor.read(f.runId).phase,'unknown');}finally{f.cleanup();}
});
test('running command is killed when temporary storage exceeds limits before its normal exit',async()=>{
 const f=fixture();try{await f.executor.execute(f.job('prepare'));f.control.commandTempGrowth=true;await assert.rejects(f.executor.execute(f.job('terminal_test',{command:'fixture grows temp'},{approvalId:randomUUID()})),{code:'SANDBOX_STORAGE_LIMIT',notExecuted:false});assert.equal(f.control.closedOn,'kill');assert.equal(f.executor.read(f.runId).phase,'unknown');}finally{f.cleanup();}
});

test('task export remains unknown when a command background process survives group kill',async()=>{
 const f=fixture();try{
  const key={runId:f.runId,taskId:'A',attemptId:'a1',generation:1},binding={projectId:'p',planVersion:1,...key,assigneeId:'e',contractHash:'a'.repeat(64),permissionHash:'b'.repeat(64),backend:{kind:'openshell',version:'0.1.2',image:OPENSHELL_CONSTANTS.image,policyHash:OPENSHELL_CONSTANTS.policyHash}};
  const executionScope={profile:'task-attempt-openshell-v1',key,binding,scopeHash:'c'.repeat(64),readPaths:[],writePaths:[],inputManifest:[],expectedWorkRevision:revision([])};
  await f.executor.execute(f.job('prepare',{}, {files:[],executionScope}));f.control.backgroundAlive=true;
  await assert.rejects(f.executor.execute(f.job('terminal',{command:'background remains'},{approvalId:randomUUID(),executionScope})),{code:'LOCAL_OUTCOME_UNKNOWN',notExecuted:false});
  assert.equal(f.executor.read(key).phase,'unknown');
 }finally{f.cleanup();}
});

test('task command exports only after confirmed stop, restart and read-only inspect',async()=>{
 const f=fixture();try{
  const key={runId:f.runId,taskId:'A',attemptId:'a1',generation:1},binding={projectId:'p',planVersion:1,...key,assigneeId:'e',contractHash:'a'.repeat(64),permissionHash:'b'.repeat(64),backend:{kind:'openshell',version:'0.1.2',image:OPENSHELL_CONSTANTS.image,policyHash:OPENSHELL_CONSTANTS.policyHash}};
  const executionScope={profile:'task-attempt-openshell-v1',key,binding,scopeHash:'c'.repeat(64),readPaths:[],writePaths:['out.txt'],inputManifest:[],expectedWorkRevision:revision([])};
  await f.executor.execute(f.job('prepare',{}, {files:[],executionScope}));
  f.control.commandWriteFile='out.txt';
  const commandJob=f.job('terminal',{command:'fixture command'},{approvalId:randomUUID(),executionScope});
  const reply=await f.executor.execute(commandJob);
  assert.equal(reply.exitCode,7);
  assert.equal(reply.files[0].content,Buffer.from('command output').toString('base64'));
  const sequence=f.calls.map(call=>call.args[3]).filter(item=>['exec','stop','start'].includes(item));
  assert.deepEqual(sequence.slice(-4),['exec','stop','start','exec']);
  assert.equal(f.executor.read(key).commandFence,undefined);
  assert.equal(f.executor.read(key).completedOperations.includes(commandJob.id),true);
 }finally{f.cleanup();}
});

test('task command stop, start or export uncertainty retains the original operation without replay',async()=>{
 for(const failure of ['stop','stopped-before-start','start','inspect']){
  const f=fixture();try{
   const key={runId:f.runId,taskId:'A',attemptId:'a1',generation:1},binding={projectId:'p',planVersion:1,...key,assigneeId:'e',contractHash:'a'.repeat(64),permissionHash:'b'.repeat(64),backend:{kind:'openshell',version:'0.1.2',image:OPENSHELL_CONSTANTS.image,policyHash:OPENSHELL_CONSTANTS.policyHash}};
   const executionScope={profile:'task-attempt-openshell-v1',key,binding,scopeHash:'c'.repeat(64),readPaths:[],writePaths:[],inputManifest:[],expectedWorkRevision:revision([])};
   await f.executor.execute(f.job('prepare',{}, {files:[],executionScope}));
   if(failure==='stop')f.control.stopDisconnect=true;
   if(failure==='stopped-before-start')f.control.failStoppedObservation=true;
   if(failure==='start')f.control.startDisconnect=true;
   if(failure==='inspect')f.control.failNextTaskInspect=true;
   const commandJob=f.job('terminal',{command:'fixture command'},{approvalId:randomUUID(),executionScope});
   await assert.rejects(f.executor.execute(commandJob),{code:'LOCAL_OUTCOME_UNKNOWN',notExecuted:false});
   const saved=f.executor.read(key),before=f.calls.length;
   assert.equal(saved.phase,'unknown');assert.equal(saved.commandFence.operationId,commandJob.id);
   if(failure==='stopped-before-start')assert.equal(f.calls.filter(call=>call.args[3]==='start').length,0);
   const reopened=new OpenShellDeviceExecutor(f.options);
   await assert.rejects(reopened.execute(commandJob),{code:'LOCAL_OUTCOME_UNKNOWN',notExecuted:false});
   await assert.rejects(reopened.inspectTaskExport(key,commandJob.id),{code:'LOCAL_OUTCOME_UNKNOWN'});
   assert.equal(f.calls.length,before);
  }finally{f.cleanup();}
 }
});

test('task command transport loss before receipt cannot be inspected as a safe export',async()=>{
 const f=fixture();try{
  const key={runId:f.runId,taskId:'A',attemptId:'a1',generation:1},binding={projectId:'p',planVersion:1,...key,assigneeId:'e',contractHash:'a'.repeat(64),permissionHash:'b'.repeat(64),backend:{kind:'openshell',version:'0.1.2',image:OPENSHELL_CONSTANTS.image,policyHash:OPENSHELL_CONSTANTS.policyHash}};
  const executionScope={profile:'task-attempt-openshell-v1',key,binding,scopeHash:'c'.repeat(64),readPaths:[],writePaths:[],inputManifest:[],expectedWorkRevision:revision([])};
  await f.executor.execute(f.job('prepare',{}, {files:[],executionScope}));f.control.disconnect=true;
  const commandJob=f.job('terminal',{command:'receipt lost'},{approvalId:randomUUID(),executionScope});
  await assert.rejects(f.executor.execute(commandJob),{code:'LOCAL_OUTCOME_UNKNOWN',notExecuted:false});
  const before=f.calls.length,reopened=new OpenShellDeviceExecutor(f.options);
  await assert.rejects(reopened.inspectTaskExport(key,commandJob.id),{code:'LOCAL_OUTCOME_UNKNOWN'});
  assert.equal(f.calls.length,before);
 }finally{f.cleanup();}
});

test('cold pre-receipt command dispatch snapshot cannot export, including snapshots without operation kind',async()=>{
 const f=fixture();try{
  const key={runId:f.runId,taskId:'A',attemptId:'a1',generation:1},binding={projectId:'p',planVersion:1,...key,assigneeId:'e',contractHash:'a'.repeat(64),permissionHash:'b'.repeat(64),backend:{kind:'openshell',version:'0.1.2',image:OPENSHELL_CONSTANTS.image,policyHash:OPENSHELL_CONSTANTS.policyHash}};
  const executionScope={profile:'task-attempt-openshell-v1',key,binding,scopeHash:'c'.repeat(64),readPaths:[],writePaths:['out.txt'],inputManifest:[],expectedWorkRevision:revision([])};
  await f.executor.execute(f.job('prepare',{}, {files:[],executionScope}));f.control.commandWriteFile='out.txt';
  const operation=f.job('terminal',{command:'fixture writes'},{approvalId:randomUUID(),executionScope});
  const save=f.executor.save.bind(f.executor);let dispatchSnapshot;
  f.executor.save=scope=>{save(scope);if(scope.activeOperation===operation.id&&scope.phase==='ready'&&!scope.commandFence)dispatchSnapshot=fs.readFileSync(f.executor.taskStateFile(key),'utf8');};
  await f.executor.execute(operation);assert.ok(dispatchSnapshot);assert.equal(JSON.parse(dispatchSnapshot).activeOperation,operation.id);
  const file=f.executor.taskStateFile(key);
  for(const historical of [false,true]){
   const snapshot=JSON.parse(dispatchSnapshot);if(historical)delete snapshot.lastOperationName;
   fs.writeFileSync(file,JSON.stringify(snapshot));const reopened=new OpenShellDeviceExecutor(f.options),before=f.calls.length;
   await assert.rejects(reopened.inspectTaskExport(key,operation.id),{code:'LOCAL_OUTCOME_UNKNOWN'});
   assert.equal(f.calls.length,before);
   await assert.rejects(reopened.execute(operation),{code:'LOCAL_OUTCOME_UNKNOWN'});
   assert.equal(f.calls.length,before);
  }
 }finally{f.cleanup();}
});

test('cold fence-stage snapshots retain identity and capacity but cannot execute or export',async()=>{
 const f=fixture();try{
  const key={runId:f.runId,taskId:'A',attemptId:'a1',generation:1},binding={projectId:'p',planVersion:1,...key,assigneeId:'e',contractHash:'a'.repeat(64),permissionHash:'b'.repeat(64),backend:{kind:'openshell',version:'0.1.2',image:OPENSHELL_CONSTANTS.image,policyHash:OPENSHELL_CONSTANTS.policyHash}};
  const executionScope={profile:'task-attempt-openshell-v1',key,binding,scopeHash:'c'.repeat(64),readPaths:[],writePaths:[],inputManifest:[],expectedWorkRevision:revision([])};
  await f.executor.execute(f.job('prepare',{}, {files:[],executionScope}));
  const operation=f.job('terminal',{command:'fixture command'},{approvalId:randomUUID(),executionScope});
  const save=f.executor.save.bind(f.executor),snapshots=new Map();
  f.executor.save=scope=>{save(scope);if(scope.phase.startsWith('fencing_'))snapshots.set(scope.phase,fs.readFileSync(f.executor.taskStateFile(key),'utf8'));};
  await f.executor.execute(operation);
  assert.deepEqual([...snapshots.keys()],['fencing_stopping','fencing_stopped','fencing_starting','fencing_inspecting']);
  for(const [phase,snapshot] of snapshots){
   fs.writeFileSync(f.executor.taskStateFile(key),snapshot);const reopened=new OpenShellDeviceExecutor(f.options),before=f.calls.length;
   const saved=reopened.read(key);assert.equal(saved.phase,phase);assert.equal(saved.activeOperation,operation.id);assert.equal(saved.commandFence.operationId,operation.id);
   assert.deepEqual(reopened.storageScopes().find(row=>row.key?.taskId==='A').key,key);
   await assert.rejects(reopened.execute(operation),{code:'LOCAL_OUTCOME_UNKNOWN'});
   await assert.rejects(reopened.inspectTaskExport(key,operation.id),{code:'LOCAL_OUTCOME_UNKNOWN'});
   assert.equal(f.calls.length,before);
  }
 }finally{f.cleanup();}
});

test('task-attempt keys isolate sandboxes and persisted scope changes are rejected',async()=>{
 const f=fixture();try{
  const files=[{path:'input.txt',content:Buffer.from('authorized').toString('base64')}];
  const key={runId:f.runId,taskId:'A',attemptId:'attempt-1',generation:1};
  const binding={projectId:'project',planVersion:1,...key,assigneeId:'worker',contractHash:'a'.repeat(64),permissionHash:'b'.repeat(64),backend:{kind:'openshell',version:'0.1.2',image:OPENSHELL_CONSTANTS.image,policyHash:OPENSHELL_CONSTANTS.policyHash}};
  const scope={profile:'task-attempt-openshell-v1',key,binding,scopeHash:'c'.repeat(64),readPaths:['input.txt'],writePaths:['out.txt'],inputManifest:manifest(files),expectedWorkRevision:revision(files)};
  const make=(nextKey,nextScope=scope)=>f.job('prepare',{}, {runId:nextKey.runId,files,executionScope:{...nextScope,key:nextKey,binding:{...nextScope.binding,...nextKey}}});
  const first=await f.executor.execute(make(key));
  assert.deepEqual(first.taskExecution.key,key);assert.equal(first.taskExecution.operationId,f.executor.read(key).completedOperations[0]);
  const inspected=await f.executor.inspectTaskExport(key,first.taskExecution.operationId);
  assert.deepEqual(inspected.files,first.files);
  const written=await f.executor.execute(f.job('artifact_write',{path:'out.txt',content:'draft'},{executionScope:scope}));
  await assert.rejects(f.executor.inspectTaskExport(key,first.taskExecution.operationId),{code:'LOCAL_SCOPE_DENIED'});
  const rolled={...scope,scopeHash:'e'.repeat(64),readPaths:['input.txt','out.txt'],inputManifest:manifest(written.files),expectedWorkRevision:written.workspaceRevision};
  const nextRead=await f.executor.execute(f.job('filesystem',{path:'input.txt'},{executionScope:rolled}));
  assert.equal(nextRead.taskExecution.beforeWorkRevision,written.workspaceRevision);assert.equal(nextRead.taskExecution.scopeHash,rolled.scopeHash);
  const storage=await f.executor.inspectStorage(key);assert.equal(storage.sandboxId,first.execution.sandboxId);
  assert.deepEqual(f.executor.storageScopes().find(item=>item.key?.taskId==='A').key,key);
  await assert.rejects(f.executor.inspectTaskExport(key,randomUUID()),{code:'LOCAL_SCOPE_DENIED'});
  const other={...key,taskId:'B'},attempt={...key,attemptId:'attempt-2'},generation={...key,generation:2};
  const ids=[first.execution.sandboxId];
  ids.push((await f.executor.execute(make(other))).execution.sandboxId);
  await assert.rejects(f.executor.execute(make(attempt)),{code:'SANDBOX_STORAGE_LIMIT',notExecuted:true});
  await f.executor.stopAcceptedTask(key,{accepted:true,checkpointResolved:true,operationsResolved:true,workspaceRevision:f.executor.read(key).workspaceRevision});
  ids.push((await f.executor.execute(make(attempt))).execution.sandboxId);
  await f.executor.stopAcceptedTask(other,{accepted:true,checkpointResolved:true,operationsResolved:true,workspaceRevision:f.executor.read(other).workspaceRevision});
  ids.push((await f.executor.execute(make(generation))).execution.sandboxId);
  assert.equal(new Set(ids).size,4);
  const reopened=new OpenShellDeviceExecutor(f.options);assert.equal(reopened.read(key).sandboxId,first.execution.sandboxId);
  const mapping=f.executor.taskStateFile(key),saved=fs.readFileSync(mapping,'utf8');
  fs.writeFileSync(mapping,JSON.stringify({...JSON.parse(saved),workManifest:[{path:'out.txt',size:1,sha256:'0'.repeat(64)}]}));
  assert.throws(()=>reopened.read(key),{code:'LOCAL_SCOPE_DENIED'});fs.writeFileSync(mapping,saved);
  for(const patch of [{scopeHash:'d'.repeat(64)},{profile:'wrong'},{binding:{...binding,permissionHash:'d'.repeat(64)}},{expectedWorkRevision:'d'.repeat(64)}]){
   const before=f.calls.length;
   await assert.rejects(reopened.execute(f.job('filesystem',{path:'input.txt'},{executionScope:{...rolled,...patch}})),{code:'LOCAL_SCOPE_DENIED'});
   assert.equal(f.calls.length,before);
  }
  assert.throws(()=>f.executor.stateFile(key),{code:'LOCAL_SCOPE_DENIED'});
 }finally{f.cleanup();}
});

test('same attempt reads its newly committed output after a bounded scope advance',async()=>{
 const f=fixture();try{
  const key={runId:f.runId,taskId:'A',attemptId:'a1',generation:1},binding={projectId:'p',planVersion:1,...key,assigneeId:'e',contractHash:'a'.repeat(64),permissionHash:'b'.repeat(64),backend:{kind:'openshell',version:'0.1.2',image:OPENSHELL_CONSTANTS.image,policyHash:OPENSHELL_CONSTANTS.policyHash}};
  const scope={profile:'task-attempt-openshell-v1',key,binding,scopeHash:'c'.repeat(64),readPaths:[],writePaths:['out.txt'],inputManifest:[],expectedWorkRevision:revision([])};
  await f.executor.execute(f.job('prepare',{}, {files:[],executionScope:scope}));
  const written=await f.executor.execute(f.job('artifact_write',{path:'out.txt',content:'committed output'},{executionScope:scope}));
  await assert.rejects(f.executor.execute(f.job('filesystem',{path:'out.txt'},{executionScope:scope})),{code:'LOCAL_SCOPE_DENIED',notExecuted:true});
  const advanced={...scope,scopeHash:'d'.repeat(64),readPaths:['out.txt'],inputManifest:manifest(written.files),expectedWorkRevision:written.workspaceRevision};
  const read=await f.executor.execute(f.job('filesystem',{path:'out.txt'},{executionScope:advanced}));
  assert.equal(read.content,'committed output');assert.equal(read.taskExecution.beforeWorkRevision,written.workspaceRevision);assert.equal(read.taskExecution.scopeHash,advanced.scopeHash);
  assert.deepEqual(f.executor.read(key).readPaths,['out.txt']);
  const rewritten=await f.executor.execute(f.job('artifact_write',{path:'out.txt',content:'second version',expectedSha256:read.sha256},{executionScope:advanced}));
  assert.equal(f.executor.read(key).workspaceRevision,rewritten.workspaceRevision);
  const reopened=new OpenShellDeviceExecutor(f.options),checked=await reopened.inspectTaskExport(key,rewritten.taskExecution.operationId);
  assert.equal(checked.files[0].content,Buffer.from('second version').toString('base64'));
  const advancedAgain={...advanced,scopeHash:'e'.repeat(64),inputManifest:manifest(rewritten.files),expectedWorkRevision:rewritten.workspaceRevision};
  const reread=await reopened.execute(f.job('filesystem',{path:'out.txt'},{executionScope:advancedAgain}));assert.equal(reread.content,'second version');
 }finally{f.cleanup();}
});

test('original readable output retains ancestry and permits write, cold reopen, then write again',async()=>{
 const f=fixture();try{
  const key={runId:f.runId,taskId:'A',attemptId:'a1',generation:1},binding={projectId:'p',planVersion:1,...key,assigneeId:'e',contractHash:'a'.repeat(64),permissionHash:'b'.repeat(64),backend:{kind:'openshell',version:'0.1.2',image:OPENSHELL_CONSTANTS.image,policyHash:OPENSHELL_CONSTANTS.policyHash}};
  const files=[{path:'out.txt',content:Buffer.from('old').toString('base64')}];
  const scope={profile:'task-attempt-openshell-v1',key,binding,scopeHash:'c'.repeat(64),readPaths:['out.txt'],writePaths:['out.txt'],inputManifest:manifest(files),expectedWorkRevision:revision(files)};
  await f.executor.execute(f.job('prepare',{}, {files,executionScope:scope}));
  const first=await f.executor.execute(f.job('artifact_write',{path:'out.txt',content:'new',expectedSha256:manifest(files)[0].sha256},{executionScope:scope}));
  assert.equal(f.executor.read(key).workspaceRevision,first.workspaceRevision);
  const reopened=new OpenShellDeviceExecutor(f.options),advanced={...scope,scopeHash:'d'.repeat(64),inputManifest:manifest(first.files),expectedWorkRevision:first.workspaceRevision};
  const read=await reopened.execute(f.job('filesystem',{path:'out.txt'},{executionScope:advanced}));assert.equal(read.content,'new');
  const second=await reopened.execute(f.job('artifact_write',{path:'out.txt',content:'final',expectedSha256:read.sha256},{executionScope:advanced}));
  assert.equal(reopened.read(key).sourceManifest[0].sha256,manifest(files)[0].sha256);
  const last={...advanced,scopeHash:'e'.repeat(64),inputManifest:manifest(second.files),expectedWorkRevision:second.workspaceRevision};
  assert.equal((await reopened.execute(f.job('filesystem',{path:'out.txt'},{executionScope:last}))).content,'final');
 }finally{f.cleanup();}
});

test('task prepare rejects a full envelope above 3 MiB before create',async()=>{
 const f=fixture();try{
  const bytes=Buffer.alloc(2359296,65),files=[{path:'input.bin',content:bytes.toString('base64')}],key={runId:f.runId,taskId:'A',attemptId:'a1',generation:1};
  const binding={projectId:'p',planVersion:1,...key,assigneeId:'e',contractHash:'a'.repeat(64),permissionHash:'b'.repeat(64),backend:{kind:'openshell',version:'0.1.2',image:OPENSHELL_CONSTANTS.image,policyHash:OPENSHELL_CONSTANTS.policyHash}};
  const executionScope={profile:'task-attempt-openshell-v1',key,binding,scopeHash:'c'.repeat(64),readPaths:['input.bin'],writePaths:[],inputManifest:manifest(files),expectedWorkRevision:revision(files)};
  await assert.rejects(f.executor.execute(f.job('prepare',{}, {files,executionScope})),{code:'LOCAL_FILE_LIMIT',notExecuted:true});
  assert.equal(f.calls.length,0);
 }finally{f.cleanup();}
});

test('unknown task scopes retain resource slots and stopped scopes count toward the 128 scope limit',async()=>{
 const f=fixture();try{
  const files=[],key={runId:f.runId,taskId:'A',attemptId:'a1',generation:1};
  const binding={projectId:'p',planVersion:1,...key,assigneeId:'e',contractHash:'a'.repeat(64),permissionHash:'b'.repeat(64),backend:{kind:'openshell',version:'0.1.2',image:OPENSHELL_CONSTANTS.image,policyHash:OPENSHELL_CONSTANTS.policyHash}};
  const executionScope={profile:'task-attempt-openshell-v1',key,binding,scopeHash:'c'.repeat(64),readPaths:[],writePaths:[],inputManifest:[],expectedWorkRevision:revision(files)};
  const job=next=>f.job('prepare',{}, {files,executionScope:{...executionScope,key:next,binding:{...binding,...next}}});
  await f.executor.execute(job(key));const original=f.executor.read(key),file=f.executor.taskStateFile(key);
  fs.writeFileSync(file,JSON.stringify({...original,phase:'unknown'}));
  const second={...key,taskId:'B'};await f.executor.execute(job(second));
  const third={...key,taskId:'C'},before=f.calls.length;
  await assert.rejects(f.executor.execute(job(third)),{code:'SANDBOX_STORAGE_LIMIT',notExecuted:true});assert.equal(f.calls.length,before);
  fs.writeFileSync(file,JSON.stringify({...original,phase:'stopped'}));
  const stopped=f.executor.read(key);
  for(let i=2;i<127;i++){const next={...key,taskId:'stopped-'+i};fs.writeFileSync(f.executor.taskStateFile(next),JSON.stringify({...stopped,key:next,binding:{...binding,...next},name:'wwe-'+i.toString(16).padStart(12,'0')}));}
  fs.writeFileSync(path.join(f.options.journalRoot,'openshell-task-scopes','unverified.json'),'{}');
  await assert.rejects(f.executor.execute(job(third)),{code:'SANDBOX_STORAGE_LIMIT',notExecuted:true});
  assert.equal(f.executor.storageScopes().filter(item=>item.key).length,127);
  assert.equal(f.executor.storageScopes().filter(item=>item.phase==='unverified').length,1);
 }finally{f.cleanup();}
});

test('task capacity includes retained workspace and temp occupancy in disk admission',async()=>{
 const f=fixture();try{
  const key={runId:f.runId,taskId:'A',attemptId:'a1',generation:1};
  const binding={projectId:'p',planVersion:1,...key,assigneeId:'e',contractHash:'a'.repeat(64),permissionHash:'b'.repeat(64),backend:{kind:'openshell',version:'0.1.2',image:OPENSHELL_CONSTANTS.image,policyHash:OPENSHELL_CONSTANTS.policyHash}};
  const executionScope={profile:'task-attempt-openshell-v1',key,binding,scopeHash:'c'.repeat(64),readPaths:[],writePaths:[],inputManifest:[],expectedWorkRevision:revision([])};
  const prepared=await f.executor.execute(f.job('prepare',{}, {files:[],executionScope}));
  await f.executor.stopAcceptedTask(key,{accepted:true,checkpointResolved:true,operationsResolved:true,workspaceRevision:prepared.workspaceRevision});
  const file=f.executor.taskStateFile(key),saved=f.executor.read(key);saved.storage={workspace:{bytes:20*1024*1024},temp:{bytes:64*1024*1024}};fs.writeFileSync(file,JSON.stringify(saved));
  const statfs=fs.statfsSync;fs.statfsSync=value=>value===f.config.home?{bavail:256*1024*1024+80*1024*1024,bsize:1}:statfs(value);
  try{const next={...key,taskId:'B'},before=f.calls.length;await assert.rejects(f.executor.execute(f.job('prepare',{}, {files:[],executionScope:{...executionScope,key:next,binding:{...binding,...next}}})),{code:'SANDBOX_STORAGE_LIMIT',notExecuted:true});assert.equal(f.calls.length,before);}finally{fs.statfsSync=statfs;}
 }finally{f.cleanup();}
});
