import {before,after,beforeEach,afterEach,test,mock} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {join,resolve,sep} from 'node:path';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {gzipSync} from 'node:zlib';
import express from 'express';
import {ProductDshRuntime} from '../services/agent-runtime/product-runtime.mjs';
import {RunSandbox} from '../services/agent-runtime/sandbox.mjs';
import {readRun} from '../services/agent-runtime/trace-store.mjs';
import {readStepCheckpoint} from '../services/agent-runtime/step-checkpoints.mjs';
import {nativeManifestId} from '../services/agent-runtime/native-capabilities.mjs';
import {setNativeCapability} from '../apps/api/src/native-capabilities.ts';
import {LocalOperationService,LocalRunExecutor,localDeviceRouter} from '../apps/api/src/local-execution.ts';
import {readCommittedCanonical} from '../apps/api/src/task-canonical.ts';
import {assertExecutionProfile} from '../apps/api/src/execution-policy.ts';
import {finishRun} from '../apps/api/src/run-state.ts';
import {acceptedWorkEvidence} from '../apps/api/src/work-records.ts';
import {pool,migrate} from '../apps/api/src/db.ts';
import {fixtureTaskContext} from './model-fixture.ts';

const {manifest,revision}=createRequire(import.meta.url)('../apps/desktop/local-executor.cjs');
const isolated=process.env.SIMULATED_INTEGRATION==='pglite';
const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const file=(path:string,content:string)=>({path,content:Buffer.from(content).toString('base64')});
const pause=()=>new Promise<void>(done=>setTimeout(done,10));
const nativeName='plugin__office__write';
type Mode='accepted-dependency'|'interleave'|'approval';
let directory:string,server:http.Server,url:string,sharedFallbacks=0;

before(async()=>{
 if(!isolated)return;
 assert.match(process.env.DATABASE_URL??'',/@127\.0\.0\.1:\d+\/postgres$/);
 const scratch=join(process.cwd(),'.superpowers','sdd','2026-10-20-task-sandbox-integration');
 mkdirSync(scratch,{recursive:true});directory=mkdtempSync(join(scratch,'task-full-flow-'));
 process.env.DATA_DIR=directory;process.env.TRACE_ROOT=directory;process.env.OBSIDIAN_VAULT=join(directory,'vault');process.env.LOCAL_WORKSPACE_ROOT=directory;
 await migrate();
 mock.method(RunSandbox,'assertReady',async()=>{sharedFallbacks++;throw Error('UNEXPECTED_SHARED_SANDBOX');});
 for(const name of ['start','file','sync','execute'] as const)mock.method(RunSandbox.prototype as any,name,async()=>{sharedFallbacks++;throw Error('UNEXPECTED_SHARED_SANDBOX');});
 const app=express();app.use(express.json({limit:'32mb'}));app.use(localDeviceRouter(directory));
 app.use((error:any,_request:any,response:any,_next:any)=>response.status(error.status??500).json({code:error.code,message:error.message}));
 server=app.listen(0,'127.0.0.1');await once(server,'listening');url='http://127.0.0.1:'+(server.address() as any).port;
});
beforeEach(async()=>{if(isolated)await pool.query('TRUNCATE local_operations,local_devices,task_attempt_workspaces,project_runs,projects,departments,usage,model_reservations,tool_approvals,native_capabilities CASCADE');});
afterEach(async()=>{
 if(!isolated)return;
 for(const table of ['models','usage','model_reservations'])assert.equal((await pool.query('SELECT count(*)::int AS n FROM '+table)).rows[0].n,0,'engineering fixture must never use a saved model or paid reservation');
});
after(async()=>{
 if(!isolated)return;
 if(server){server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));}
 await pool.end();
 mock.restoreAll();
 assert.ok(resolve(directory).startsWith(resolve(process.cwd(),'.superpowers','sdd','2026-10-20-task-sandbox-integration')+sep));
 rmSync(directory,{recursive:true,force:true});
});

function tool(name:string,args:any,id:string){return {content:null,tool_calls:[{id,type:'function',function:{name,arguments:JSON.stringify(args)}}]};}
async function until<T>(read:()=>T|Promise<T>,accept:(value:T)=>boolean,label:string,timeout=20000):Promise<T>{
 const deadline=Date.now()+timeout;let value:T;
 do{value=await read();if(accept(value))return value;await pause();}while(Date.now()<deadline);
 assert.fail(label+': '+JSON.stringify(value!));
}
function values(messages:any[]){return messages.filter(message=>message.role==='tool').map(message=>{try{return JSON.parse(message.content);}catch{return message.content;}});}

async function fixture(mode:Mode){
 const runId=randomUUID(),projectId=randomUUID(),deviceId=randomUUID(),grantId=randomUUID(),owner=randomUUID(),token=randomBytes(32).toString('hex');
 const backend={kind:'openshell',version:'0.1.2',gateway:'engineering-fixture',image:'node@sha256:'+hash('image'),policySha256:hash('policy'),fingerprint:hash('backend')};
 const agents=[
  {id:'manager',employeeId:'manager',name:'Manager',role:'manager',modelId:'fixture',rolePrompt:'Coordinate the approved engineering fixture.',tools:[]},
  {id:'producer',employeeId:'producer',name:'Producer',role:'member',modelId:'fixture',rolePrompt:'Run task A only.',tools:['artifact_write','filesystem','terminal_test']},
  {id:'consumer',employeeId:'consumer',name:'Consumer',role:'member',modelId:'fixture',rolePrompt:'Run task B only.',tools:['artifact_write','filesystem','terminal_test',nativeName]},
 ];
 const common={kind:'work',maxModelCalls:20,maxBudget:.4,maxOutputTokens:1024,outOfScope:[],acceptanceCriteria:['Fixture files and observed command are correct.']};
 const tasks=[
  {...common,id:'a',kind:mode==='accepted-dependency'?'implementation':'work',subject:'Engineering task A',objective:'Create two outputs, revise one, and verify.',assignee:'producer',assigneeId:'producer',dependencies:[],inputs:[{path:'in.txt',sha256:hash('input')}],outputs:[{path:'a.txt',format:'text'},{path:'a-extra.txt',format:'text'}],inScope:['a.txt','a-extra.txt'],verify:['check-a'],acceptanceChecks:[{criterionIndex:0,command:'check-a',expectedOutput:'engineering fixture file oracle passed'}]},
  {...common,id:'b',kind:mode==='accepted-dependency'?'review':'work',...(mode==='accepted-dependency'?{reviewedTaskId:'a'}:{}),subject:'Engineering task B',objective:'Use the exact authorized input and produce B.',assignee:'consumer',assigneeId:'consumer',dependencies:mode==='accepted-dependency'?['a']:[],inputs:mode==='accepted-dependency'?[{path:'a.txt',producerTaskId:'a'}]:[{path:'in.txt',sha256:hash('input')}],outputs:[{path:'b.txt',format:'text'}],inScope:['b.txt'],verify:['check-b'],acceptanceChecks:[{criterionIndex:0,command:'check-b',expectedOutput:'engineering fixture file oracle passed'}]},
 ];
 const code=Buffer.from('engineering device fixture; no native host execution'),compressed=gzipSync(code),metadata=Buffer.from('{}');
 const native={format:'dsh-native-tools-v1',namespace:'office',package:'@company/office',version:'1.0.0',source:{kind:'company',reference:'isolated engineering fixture'},dshVersion:'0.1.5-rc.1',config:{},lockSha256:hash('lock'),bundle:{sha256:hash(compressed),codeSha256:hash(code),metadataSha256:hash(metadata),bytes:compressed.length},tools:[{name:nativeName,originalName:'write',description:'Write the fixture output through the device transport.',parameters:{type:'object',properties:{path:{type:'string'},content:{type:'string'}},required:['path','content']},files:{read:[],write:['path']}}]};
 const pluginId=nativeManifestId(native),nativeRoot=join(directory,'native-plugins',pluginId);mkdirSync(nativeRoot,{recursive:true});
 writeFileSync(join(nativeRoot,'manifest.json'),JSON.stringify(native));writeFileSync(join(nativeRoot,'bundle.gz'),compressed);writeFileSync(join(nativeRoot,'package.json'),metadata);await setNativeCapability(pluginId,true,pool);
 const target={kind:'local',deviceId,grantId,backend},policy={maxBudget:1,maxAgents:3,maxConcurrentAgents:3,maxModelCalls:70,maxTaskModelCalls:25,deadlineSeconds:90,contextManagement:'prune',contextBytes:250000,executionTarget:target};
 let snapshot:any={projectId,planVersion:1,departmentId:'department',title:'Task sandbox full engineering flow',requirement:'Verify actual runtime, device operation and Handoff integration using local scripted responses.',executionProfile:'task-attempt-openshell-v1',executionBudget:1,approval:{kind:'project',projectVersion:1},policy,agents,tasks,nativeCapabilities:[{id:pluginId,manifest:native}],executionTarget:{...target,platform:'linux',allowCommands:true},importedFiles:[{path:'in.txt',content:'input',snapshotId:'input-snapshot',sha256:hash('input'),agentIds:['producer','consumer']}]};
 await pool.query('INSERT INTO departments(id,data) VALUES($1,$2)',['department',{name:'Fixture',agents}]);
 await pool.query('INSERT INTO projects(id,department_id,department_version,department_name,requirement,policy,plan,source) VALUES($1,$2,1,$3,$3,$4,$5,$3)',[projectId,'department','fixture',policy,{agents,tasks}]);
 await pool.query("INSERT INTO project_runs(id,project_id,project_version,status,snapshot,lease_owner,lease_until) VALUES($1,$2,1,'running',$3,$4,now()+interval '1 hour')",[runId,projectId,snapshot,owner]);
 await pool.query('INSERT INTO local_devices(id,token_hash,name,platform,grant_id,label,allow_commands,backend) VALUES($1,$2,$3,$4,$5,$3,true,$6)',[deviceId,hash(token),'engineering device','linux',grantId,backend]);
 // Runtime consumes the persisted approved snapshot, as the real coordinator does.
 snapshot=(await pool.query('SELECT snapshot FROM project_runs WHERE id=$1',[runId])).rows[0].snapshot;
 const service=new LocalOperationService(directory,owner),jobs:any[]=[],canonicalChecks:any[]=[],approvals:any[]=[],requests:any[]=[],steps=new Map<string,number>(),workspaces=new Map<string,any>();
 const canonical=new Map([['in.txt','input'],['private.txt','private']]);
 let archive:any,executor:LocalRunExecutor,aCommitted=false,approvalEntered=false;
 const events=()=>readRun(directory,runId)?.events??[];
 const accepted=(taskId:string)=>events().some(event=>event.type==='handoff/accepted'&&event.data.taskId===taskId);
 const provider=http.createServer(async(request,response)=>{
  try{
   assert.equal(request.url,'/v1/chat/completions');assert.equal(request.headers.authorization,'Bearer local-engineering-fixture');
   let raw='';for await(const chunk of request)raw+=chunk;const body=JSON.parse(raw);requests.push(body);
   let message:any={content:'Engineering fixture complete.'};
   const context=fixtureTaskContext(body.messages);
   if(context){
    const id=context.task.id,key=context.runtimeTaskId+':'+context.attemptId,step=steps.get(key)??0;
    assert.ok(['a','b'].includes(id),'the real host must supply the approved task context');
    if(id==='a'&&step===3&&mode==='interleave')await until(()=>accepted('b'),Boolean,'B accepts while A provider request waits',40000);
    if(id==='b'&&step===2&&mode!=='accepted-dependency')await until(()=>mode==='approval'?approvalEntered:aCommitted,Boolean,'B waits for the intended A boundary');
    const seen=values(body.messages),prior=(path:string)=>seen.findLast((value:any)=>value?.path===path&&value.sha256)?.sha256;
    const update=(status:string,more:any={})=>['agent_teams_update_task',{task_id:context.runtimeTaskId,attempt_id:context.attemptId,status,...more}];
    const actions:any[]=[['agent_teams_claim_task',{task_id:context.runtimeTaskId}],update('in_progress')];
    if(id==='a'){
     actions.push(['artifact_write',{path:'a.txt',content:'A one'}],['artifact_write',{path:'a-extra.txt',content:'A extra'}],['filesystem',{path:'a.txt'}],['artifact_write',{path:'a.txt',content:'A final',expectedSha256:prior('a.txt')}],['terminal_test',{command:'check-a'}]);
     if(mode==='approval')actions.push(['terminal_test',{command:'check-a'}]);
     actions.push(update('completed',{output:'A files and fixture command verified.',changedPaths:['a.txt','a-extra.txt'],acceptanceResults:[{criterion:common.acceptanceCriteria[0],status:'passed',evidence:'Observed fixture device results.'}],commandsRun:[{command:'check-a',status:'passed',exitCode:0,evidence:'Host observation is authoritative.'}]}));
    }else{
     actions.push(['filesystem',{path:mode==='accepted-dependency'?'a.txt':'in.txt'}],[nativeName,{path:'b.txt',content:'B one'}],['filesystem',{path:'b.txt'}],['artifact_write',{path:'b.txt',content:'B final',expectedSha256:prior('b.txt')}],['terminal_test',{command:'check-b'}],update('completed',{output:'B imported its authorized input and verified its own output.',verdict:'pass'}));
    }
    steps.set(key,step+1);
    if(step<actions.length)message=tool(actions[step][0],actions[step][1],key+':'+step);
   }
   response.setHeader('content-type','application/json');response.end(JSON.stringify({choices:[{message,finish_reason:message.tool_calls?'tool_calls':'stop'}],usage:{prompt_tokens:50,completion_tokens:10,total_tokens:60}}));
  }catch(error){response.statusCode=500;response.end(JSON.stringify({error:{message:String(error)}}));}
 });
 provider.listen(0,'127.0.0.1');await once(provider,'listening');
 const runtime=new ProductDshRuntime({traceRoot:directory,
  createExecutor:(created:any,approved:any)=>{
   archive=created;mkdirSync(join(created.dir,'artifacts'),{recursive:true});for(const [path,content]of canonical)writeFileSync(join(created.dir,'artifacts',path),content);
   executor=new LocalRunExecutor(created,approved,service);return executor;
  },
  requestApproval:async(input:any)=>{
   const id=randomUUID();await pool.query("INSERT INTO tool_approvals(id,run_id,agent_id,tool,arguments,status) VALUES($1,$2,$3,$4,$5,'approved')",[id,runId,input.agentId,input.tool,input.arguments]);
   approvals.push({id,...input});
   if(mode==='approval'&&input.agentId==='producer'&&!approvalEntered){approvalEntered=true;await until(()=>accepted('b'),Boolean,'B commits after the old A approval is approved',40000);}
   return id;
  },
 });
 return {mode,runId,deviceId,token,backend,snapshot,pluginId,runtime,provider,jobs,canonicalChecks,approvals,requests,steps,workspaces,canonical,service,events,get archive(){return archive;},get executor(){return executor!;},markACommitted(){aCommitted=true;}};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
function evidence(f:Fixture){return {runId:f.runId,operationIds:f.jobs.map(job=>job.id),approvalIds:f.approvals.map(approval=>approval.id),scopes:f.canonicalChecks.map(check=>({operationId:check.operationId,key:check.scope.key,sandboxId:check.sandboxId,scopeHash:check.scope.workspace.scopeHash,beforeRevision:check.receipt.beforeRevision,afterRevision:check.receipt.afterRevision}))};}
async function protocol(f:Fixture,endpoint:string,body:any){
 const response=await fetch(url+'/local-devices/'+f.deviceId+endpoint,{method:'POST',headers:{'content-type':'application/json','X-Local-Device-Key':f.token},body:JSON.stringify(body)});
 const result=await response.json() as any;assert.equal(response.status,200,endpoint+': '+JSON.stringify(result));return result;
}

// Only the model response and physical device are engineering fixtures. This
// drives the real HTTP claim/start/result, canonical CAS and employee adapters.
async function deliver(f:Fixture,job:any){
 assert.equal(JSON.stringify(job).includes('private.txt'),false,'device poll must never reveal a private canonical filename');assert.equal(job.taskScope,undefined);assert.equal(job.deviceArguments,undefined);
 assert.equal(job.executionScope.profile,'task-attempt-openshell-v1');assert.equal(job.executionScope.key.runId,f.runId);assert.ok(job.executionScope.key.attemptId);assert.ok(job.executionScope.key.generation>0);
 await protocol(f,'/operations/'+job.id+'/start',{claimToken:job.claimToken});
 const key=JSON.stringify(job.executionScope.key);let work=f.workspaces.get(key);
 if(job.name==='prepare'){
  assert.equal(work,undefined,'a task workspace is imported once');work={files:job.files,sandboxId:randomUUID()};f.workspaces.set(key,work);
  assert.deepEqual(job.files.map((item:any)=>item.path),[f.mode==='accepted-dependency'&&job.executionScope.key.taskId==='b'?'a.txt':'in.txt']);
  if(job.executionScope.key.taskId==='b'&&f.mode==='accepted-dependency')assert.ok(f.events().some(event=>event.type==='handoff/accepted'&&event.data.taskId==='a'),'B imports only after real A acceptance');
 }else assert.ok(work,'a real prepared task must precede each employee operation');
 assert.equal(revision(work.files),job.executionScope.expectedWorkRevision);
 const args=job.arguments;
 if(args.expectedWorkspaceRevision)assert.equal(args.expectedWorkspaceRevision,revision(work.files),'transport receives task-local work revision');
 const put=(path:string,content:string)=>{work.files=[...work.files.filter((item:any)=>item.path!==path),file(path,content)];f.canonical.set(path,content);};
 if(job.name==='artifact_write'){
  const old=work.files.find((item:any)=>item.path===args.path);assert.equal(old?hash(Buffer.from(old.content,'base64')):undefined,args.expectedSha256);put(args.path,args.content);
 }
 if(job.name==='native_plugin'){assert.equal(args.pluginId,f.pluginId);assert.equal(args.toolName,nativeName);assert.deepEqual(args.writePaths,['b.txt']);put(args.arguments.path,args.arguments.content);}
 const files=work.files,result:any={localWorkspace:'openshell://engineering-fixture/'+work.sandboxId+'/sandbox',files,artifacts:manifest(files),workspaceRevision:revision(files),execution:{...f.backend,sandboxId:work.sandboxId,sandboxName:'engineering-fixture',uid:1000,gid:1000,node:'v24.19.0',cpu:[100000,100000],memory:'536870912',effectivePolicyHash:'27ae8e91e5dd6b505e6a331bb5b24a7a2b47aced33257f4f7e7a7c892978e6b5'},taskExecution:{profile:job.executionScope.profile,key:job.executionScope.key,scopeHash:job.executionScope.scopeHash,operationId:job.id,beforeWorkRevision:job.executionScope.expectedWorkRevision,afterWorkRevision:revision(files)}};
 if(job.name==='artifact_write')Object.assign(result,{path:args.path,bytes:Buffer.byteLength(args.content),sha256:hash(args.content)});
 if(job.name==='filesystem'){const found=files.find((item:any)=>item.path===args.path);assert.ok(found);Object.assign(result,{path:args.path,content:Buffer.from(found.content,'base64').toString(),sha256:hash(Buffer.from(found.content,'base64'))});}
 if(job.name==='terminal_test'){
  const text=(path:string)=>Buffer.from(files.find((item:any)=>item.path===path)?.content??'','base64').toString();
  assert.equal(args.command,job.executionScope.key.taskId==='a'?'check-a':'check-b');
  if(args.command==='check-a'){assert.equal(text('a.txt'),'A final');assert.equal(text('a-extra.txt'),'A extra');}else assert.equal(text('b.txt'),'B final');
  Object.assign(result,{exitCode:0,output:'engineering fixture file oracle passed'});
 }
 if(job.name==='native_plugin')Object.assign(result,{pluginId:args.pluginId,toolName:args.toolName,nativeResult:{isError:false,value:{written:true}}});
 await protocol(f,'/operations/'+job.id+'/result',{claimToken:job.claimToken,ok:true,result});f.jobs.push(job);
 const row=await until(async()=>(await pool.query('SELECT * FROM local_operations WHERE id=$1',[job.id])).rows[0],value=>value.merge_state==='committed','the actual executor commits the device result');
 const run=(await pool.query('SELECT * FROM project_runs WHERE id=$1',[f.runId])).rows[0],current=readCommittedCanonical(directory,run);
 assert.deepEqual(current.files,[...f.canonical].sort(([a],[b])=>a.localeCompare(b)).map(([path,content])=>file(path,content)),'every completed operation publishes the complete canonical file set');
 f.canonicalChecks.push({operationId:job.id,canonical:current.ref,scope:row.payload.taskScope,receipt:row.merge_record.receipt,sandboxId:work.sandboxId});
 if(job.executionScope.key.taskId==='a'&&job.name==='artifact_write')f.markACommitted();
}
async function runFixture(f:Fixture){
 // The production entry point intentionally remains closed. Only this owned
 // isolated fixture constructs ProductDshRuntime directly for integration QA.
 assert.throws(()=>assertExecutionProfile(f.snapshot),{code:'TASK_EXECUTION_UNAVAILABLE'});
 const started=await f.runtime.start({runId:f.runId,approvedSnapshot:f.snapshot,routes:[{id:'fixture',name:'local engineering fixture',wireModel:'fixture',baseUrl:'http://127.0.0.1:'+(f.provider.address() as any).port+'/v1',apiKey:'local-engineering-fixture',inputRate:0,outputRate:0,maxOutputTokens:1024,contextWindowTokens:100000}]});
 let finished=false,result:any;started.completion.then(value=>{finished=true;result=value;});
 try{
  const deadline=Date.now()+95000;
  while(!finished&&Date.now()<deadline){const polled=await protocol(f,'/poll',{});if(polled.job)await deliver(f,polled.job);else await pause();}
  assert.ok(finished,'full runtime settles before its deadline');
  assert.equal(result.status,'completed',JSON.stringify({message:result.message,events:f.events().filter(event=>/failed|error|blocked/.test(event.type)||event.type==='run/finished').slice(-8),tasks:f.events().findLast(event=>event.type==='team/checkpoint')?.data.tasks.map((task:any)=>({id:task.id,status:task.status,output:task.output})),requests:f.requests.length,steps:[...f.steps]}));
  assert.deepEqual(f.events().filter(event=>event.type==='handoff/accepted').map(event=>event.data.taskId).sort(),['a','b']);
  assert.equal(f.jobs.filter(job=>job.name==='prepare').length,2,'no run-wide or repeated prepare occurs');
  assert.equal(sharedFallbacks,0,'no host/shared-run execution fallback occurs');
  for(const accepted of f.events().filter(event=>event.type==='handoff/accepted')){
   const event=f.events().find(item=>item.type==='step/checkpoint'&&item.data.boundary.trigger==='node-accepted'&&item.data.boundary.taskId===accepted.data.taskId&&item.data.boundary.attemptId===accepted.data.attemptId);
   assert.ok(event,'every accepted task has a durable checkpoint');
   const checkpoint=readStepCheckpoint({root:directory,runId:f.runId,checkpointId:event.data.id});
   assert.equal(checkpoint.version,2);assert.deepEqual(checkpoint.key,accepted.data.taskExecution.key);
   assert.deepEqual(checkpoint.files,checkpoint.workManifest);assert.equal(hash(JSON.stringify(checkpoint.files)),accepted.data.sandboxWorkRevision);
   assert.ok(checkpoint.canonical.manifest.some((entry:any)=>entry.path==='private.txt'));
   assert.equal(checkpoint.workManifest.some((entry:any)=>entry.path==='private.txt'),false);
  }
  for(const body of f.requests)for(const message of body.messages.filter((value:any)=>value.role==='tool')){
   assert.equal(String(message.content).includes('private.txt'),false,'an employee result never reveals other canonical filenames');
   assert.equal(/"(?:workManifest|inputOrigins|canonical)"\s*:/.test(String(message.content)),false,'private checkpoint references never become tool results');
   if(fixtureTaskContext(body.messages)?.task.id==='b'&&f.mode==='accepted-dependency')assert.equal(String(message.content).includes('a-extra.txt'),false,'B result never reveals the other A output');
  }
  const operations=(await pool.query('SELECT * FROM local_operations WHERE run_id=$1',[f.runId])).rows;
  assert.equal(operations.length,f.jobs.length);assert.ok(operations.every(row=>row.started&&row.status==='completed'&&row.merge_state==='committed'));
  assert.equal(await finishRun(f.runId,f.service.owner,'completed'),true,'the real coordinator finalization makes work evidence eligible');
  const evidence=await acceptedWorkEvidence(pool,directory,f.runId);
  assert.equal(evidence.receipts.length,2,'both accepted task-local command proofs remain usable by the work/knowledge consumer');
  return result;
 }finally{
  await f.runtime.cancel(f.runId);await started.completion;f.provider.closeAllConnections();await new Promise<void>(done=>f.provider.close(()=>done()));
 }
}

test('two consecutive task writes roll scope and preserve original input lineage',{skip:!isolated,timeout:110000},async t=>{
 const f=await fixture('accepted-dependency');await runFixture(f);
 const writes=f.canonicalChecks.filter(value=>f.jobs.find(job=>job.id===value.operationId)?.name!=='prepare'&&value.scope.key.taskId==='b'&&['native_plugin','artifact_write'].includes(f.jobs.find(job=>job.id===value.operationId).name));
 assert.equal(writes.length,2);const [one,two]=writes;
 assert.notEqual(one.scope.workspace.scopeHash,two.scope.workspace.scopeHash);assert.equal(one.sandboxId,two.sandboxId);assert.equal(two.receipt.beforeRevision,one.receipt.afterRevision);
 assert.deepEqual(one.scope.inputOrigins,two.scope.inputOrigins);
 const accepted=f.events().find(event=>event.type==='handoff/accepted'&&event.data.taskId==='a')!.data;
 assert.equal(one.scope.inputOrigins[0].origin.acceptedRevision,accepted.workspaceRevision);assert.equal(two.scope.inputOrigins[0].source.kind,'accepted');
 assert.equal(two.scope.workspace.inputManifest.find((input:any)=>input.path==='b.txt').origin.acceptedRevision,one.receipt.afterRevision,'own output origin comes from its prior committed merge');
 const a=f.canonicalChecks.filter(value=>value.scope.key.taskId==='a'),b=f.canonicalChecks.filter(value=>value.scope.key.taskId==='b');
 assert.notEqual(a[0].sandboxId,b[0].sandboxId);assert.equal(new Set(a.map(value=>value.sandboxId)).size,1);
 assert.equal(f.jobs.filter(job=>job.name==='artifact_write'&&job.executionScope.key.taskId==='a').length,3,'A writes two outputs and revises one');
 const command=f.events().find(event=>event.type==='handoff/command-observed'&&event.data.taskId==='a')!.data;
 assert.ok(command.mergeId);assert.equal(command.taskExecution.key.taskId,'a');assert.equal(command.exitCode,0);
 t.diagnostic(JSON.stringify(evidence(f)));
});

test('unrelated task commit rebuilds next scope without rebinding inputs',{skip:!isolated,timeout:110000},async t=>{
 const f=await fixture('interleave');await runFixture(f);
 const writes=f.canonicalChecks.filter(value=>value.scope.key.taskId==='a'&&f.jobs.find(job=>job.id===value.operationId)?.name==='artifact_write');
 assert.equal(writes.length,3);assert.deepEqual(writes[0].scope.inputOrigins,writes[1].scope.inputOrigins);assert.notEqual(writes[0].scope.workspace.scopeHash,writes[1].scope.workspace.scopeHash);
 const bAccepted=f.events().find(event=>event.type==='handoff/accepted'&&event.data.taskId==='b')!;
 const aNext=f.events().find(event=>event.type==='local/operation-finished'&&event.data.operationId===writes[1].operationId)!;
 assert.ok(aNext.seq>bAccepted.seq,'the successful A renewed scope follows B acceptance');
 assert.ok(writes[1].canonical.manifest.some((item:any)=>item.path==='b.txt'&&item.sha256===hash('B final')),'the next A merge preserves B');
 assert.deepEqual(writes[0].scope.inputOrigins,writes[2].scope.inputOrigins);
 t.diagnostic(JSON.stringify(evidence(f)));
});

test('approval cannot authorize a renewed scope',{skip:!isolated,timeout:110000},async t=>{
 const f=await fixture('approval');await runFixture(f);
 const approvals=f.approvals.filter(value=>value.agentId==='producer');assert.equal(approvals.length,2);
 assert.notEqual(approvals[0].arguments.executionScope.scopeHash,approvals[1].arguments.executionScope.scopeHash);assert.notEqual(approvals[0].arguments.expectedWorkspaceRevision,approvals[1].arguments.expectedWorkspaceRevision);
 const commands=f.jobs.filter(job=>job.name==='terminal_test'&&job.executionScope.key.taskId==='a');assert.equal(commands.length,1,'only the renewed explicit approval reaches exec transport');
 const stale=(await pool.query('SELECT id FROM local_operations WHERE approval_id=$1',[approvals[0].id])).rows;assert.equal(stale.length,0,'an approved old scope never creates a device operation');
 const row=(await pool.query('SELECT * FROM local_operations WHERE approval_id=$1',[approvals[1].id])).rows[0];assert.ok(row);assert.deepEqual(row.payload.arguments,approvals[1].arguments);
 assert.ok(f.requests.some(body=>values(body.messages).some(value=>JSON.stringify(value).includes('TASK_SCOPE_CHANGED'))),'the real employee receives the stale-scope rejection before asking again');
 t.diagnostic(JSON.stringify(evidence(f)));
});
