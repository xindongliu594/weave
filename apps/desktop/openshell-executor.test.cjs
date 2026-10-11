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
  const fakeProcess={stdin,getuid:()=>control.uid??1000,getgid:()=>control.gid??1000,version:control.node??'v24.19.0',env:{},exit:code=>reject(Error('fixture helper exit '+code)),kill:()=>{if(control.runningChild){const child=control.runningChild;control.runningChild=null;control.closedOn='kill';setImmediate(()=>child.emit('close',null));}}};
  const fixtureSpawn=()=>{const child=new EventEmitter();child.pid=123;child.stdout=new EventEmitter();child.stderr=new EventEmitter();if(control.commandTempGrowth){control.runningChild=child;const file=path.join(root,'..','temporary','growing'),fd=fs.openSync(file,'w');fs.ftruncateSync(fd,64*1024*1024+1);fs.closeSync(fd);setTimeout(()=>{if(control.runningChild){control.runningChild=null;control.closedOn='fallback';child.emit('close',0);}},700).unref();}else setImmediate(()=>{child.stdout.emit('data',Buffer.from('{"nonce":"forged-child-output","ok":true}\n'));child.stderr.emit('data',Buffer.from('fixture command failed\n'));child.emit('close',7);});return child;};
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
 let name;
 const transport=async(_cli,args,options)=>{
  calls.push({args:[...args],input:options.input});options.signal?.throwIfAborted();const command=args.slice(2);
  if(command[0]==='status')return {exitCode:0,stdout:JSON.stringify({status:'connected',version:'0.1.2',gateway:config.gateway,server:'https://127.0.0.1:18770',authentication:{status:'authenticated'}})};
  if(command[0]==='policy')return {exitCode:0,stdout:JSON.stringify({hash:control.policyHash,policy:{process:{run_as_user:'1000',run_as_group:'1000'},landlock:{compatibility:'hard_requirement'},network_policies:{},network_middlewares:{}}})};
  if(command[1]==='get'){
   if(!control.created)return {exitCode:1,stdout:'',stderr:'sandbox not found'};
   return {exitCode:0,stdout:JSON.stringify({name,id:control.replacedId??id,phase:control.phases?.shift()??control.phase,conditions:[{type:'Ready',status:'True'}],configuration_admission:{state:'accepted',policy_hash:control.policyHash}})};
  }
  if(command[1]==='delete'){assert.equal(command[2],id);if(!control.deleteStillPresent)control.created=false;if(control.deleteDisconnect)return {exitCode:1,stdout:'',stderr:'connection reset after delete'};return {exitCode:0,stdout:'deletion accepted'};}
  if(command[1]==='create'){assert.equal(control.created,false);control.created=true;name=command[command.indexOf('--name')+1];return {exitCode:0,stdout:'{}'};}
  if(command[1]==='stop'){control.phase='Stopped';if(control.stopDisconnect)return {exitCode:1,stdout:'',stderr:'connection reset after stop'};return {exitCode:0,stdout:''};}
  if(command[1]==='start'){assert.equal(control.phase,'Stopped');control.phase='Ready';if(control.startDisconnect)return {exitCode:1,stdout:'',stderr:'connection reset after start'};return {exitCode:0,stdout:''};}
  if(command[1]==='exec'){
   if(control.disconnect)return {exitCode:1,stdout:'',stderr:'connection reset'};
   const receipt=await executeFixtureScript(command.at(-1),options.input,remote,control);
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
