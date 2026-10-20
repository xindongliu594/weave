import {before,after,beforeEach,afterEach,test,mock} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join,resolve,sep} from 'node:path';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import express from 'express';
import {ProductDshRuntime} from '../services/agent-runtime/product-runtime.mjs';
import {RunSandbox} from '../services/agent-runtime/sandbox.mjs';
import {readRun} from '../services/agent-runtime/trace-store.mjs';
import {readStepCheckpoint} from '../services/agent-runtime/step-checkpoints.mjs';
import {LocalOperationService,LocalRunExecutor,localDeviceRouter} from '../apps/api/src/local-execution.ts';
import {readCommittedCanonical} from '../apps/api/src/task-canonical.ts';
import {assertExecutionProfile} from '../apps/api/src/execution-policy.ts';
import {finishRun} from '../apps/api/src/run-state.ts';
import {acceptedWorkEvidence} from '../apps/api/src/work-records.ts';
import {pool,migrate} from '../apps/api/src/db.ts';
import {fixtureTaskContext} from './model-fixture.ts';
const require=createRequire(import.meta.url);
const {createProductDeviceFixture}=require('./helpers/task-openshell-product-fixture.cjs');
const {manifest,revision}=require('../apps/desktop/local-executor.cjs');
const isolated=process.env.SIMULATED_INTEGRATION==='pglite';
const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const file=(path:string,content:string)=>({path,content:Buffer.from(content).toString('base64')});
const pause=()=>new Promise<void>(done=>setTimeout(done,10));
const evidenceRoot=resolve('.superpowers/sdd/2026-10-20-task-checkpoint-v2-integration');
let directory:string,server:http.Server,url:string,sharedFallbacks=0;
before(async()=>{
 if(!isolated)return;assert.match(process.env.DATABASE_URL??'',/@127\.0\.0\.1:\d+\/postgres$/);
 mkdirSync(evidenceRoot,{recursive:true});directory=mkdtempSync(join(evidenceRoot,'product-stop-fixture-'));
 process.env.DATA_DIR=directory;process.env.TRACE_ROOT=directory;process.env.OBSIDIAN_VAULT=join(directory,'vault');process.env.LOCAL_WORKSPACE_ROOT=directory;
 await migrate();mock.method(RunSandbox,'assertReady',async()=>{sharedFallbacks++;throw Error('UNEXPECTED_SHARED_SANDBOX');});
 for(const name of ['start','file','sync','execute'] as const)mock.method(RunSandbox.prototype as any,name,async()=>{sharedFallbacks++;throw Error('UNEXPECTED_SHARED_SANDBOX');});
 const app=express();app.use(express.json({limit:'32mb'}));app.use(localDeviceRouter(directory));
 app.use((error:any,_request:any,response:any,_next:any)=>response.status(error.status??500).json({code:error.code,message:error.message}));
 server=app.listen(0,'127.0.0.1');await once(server,'listening');url='http://127.0.0.1:'+(server.address() as any).port;
});
beforeEach(async()=>{if(isolated)await pool.query('TRUNCATE local_operations,local_devices,task_attempt_workspaces,project_runs,projects,departments,usage,model_reservations,tool_approvals,native_capabilities CASCADE');});
afterEach(async()=>{if(isolated)for(const table of ['models','usage','model_reservations'])assert.equal((await pool.query('SELECT count(*)::int AS n FROM '+table)).rows[0].n,0,'no saved model, paid usage or reservation');});
after(async()=>{
 if(!isolated)return;if(server){server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));}await pool.end();mock.restoreAll();
 assert.ok(resolve(directory).startsWith(evidenceRoot+sep));rmSync(directory,{recursive:true,force:true});
});
function tool(name:string,args:any,id:string){return {content:null,tool_calls:[{id,type:'function',function:{name,arguments:JSON.stringify(args)}}]};}
async function until<T>(read:()=>T|Promise<T>,accept:(value:T)=>boolean,label:string,timeout=20000):Promise<T>{
 const deadline=Date.now()+timeout;let value:T;do{value=await read();if(accept(value))return value;await pause();}while(Date.now()<deadline);assert.fail(label+': '+JSON.stringify(value!));
}
type Mode='baseline'|'green'|'response-loss'|'interleave';
const taskFacts=(row:any)=>({key:{runId:row.run_id,taskId:row.task_id,attemptId:row.attempt_id,generation:row.generation},phase:row.phase,principal:row.principal,sessionId:row.session_id,runtimeTaskId:row.runtime_task_id,contract:row.contract,contractHash:row.contract_hash,permissionHash:row.permission_hash,capabilityHash:row.capability_hash,scope:row.scope,inputOrigins:row.input_origins,committedOutputs:row.committed_outputs,sandboxIdentity:row.sandbox_identity});
const operationFacts=(row:any)=>({id:row.id,deviceId:row.device_id,grantId:row.grant_id,owner:row.lease_owner,status:row.status,started:row.started,claimToken:row.claim_token,payload:row.payload,result:row.result,mergeState:row.merge_state,mergeRecord:row.merge_record});
async function fixture(mode:Mode){
 const runId=randomUUID(),projectId=randomUUID(),deviceId=randomUUID(),grantId=randomUUID(),owner=randomUUID(),token=randomBytes(32).toString('hex');
 const device=createProductDeviceFixture(join(directory,runId,'device'),grantId),backend=device.executor.backend;
 const agents=[
  {id:'manager',employeeId:'manager',name:'Manager',role:'manager',modelId:'fixture',rolePrompt:'Run assigned manager acceptance task C.',tools:['artifact_write','filesystem','terminal_test']},
  {id:'developer',employeeId:'developer',name:'Developer',role:'member',modelId:'fixture',rolePrompt:'Run development task A.',tools:['artifact_write','filesystem','terminal_test']},
  {id:'qa',employeeId:'qa',name:'QA',role:'member',modelId:'fixture',rolePrompt:'Run independent QA task B.',tools:['artifact_write','filesystem','terminal_test']},
 ];
 const outputs={a:['a.txt','check-a.mjs'],b:['qa.json','check-b.mjs'],c:['acceptance.json','check-c.mjs']};
 const common={kind:'work',maxModelCalls:20,maxBudget:.4,maxOutputTokens:1024,outOfScope:[],acceptanceCriteria:['Files and real Node test pass.']};
 const tasks=[
  {...common,id:'a',kind:mode==='interleave'?'work':'implementation',subject:'Develop A',objective:'Write A and an actual self test.',assignee:'developer',assigneeId:'developer',dependencies:[],inputs:[{path:'in.txt',sha256:hash('input')}],outputs:outputs.a.map(path=>({path,format:'text'})),inScope:outputs.a,verify:['node --test check-a.mjs'],acceptanceChecks:[{criterionIndex:0,command:'node --test check-a.mjs',minimumTests:1}]},
  {...common,id:'b',kind:mode==='interleave'?'work':'review',...(mode==='interleave'?{}:{reviewedTaskId:'a'}),subject:'Independent QA',objective:'Read authorized input, write independent QA and test it.',assignee:'qa',assigneeId:'qa',dependencies:mode==='interleave'?[]:['a'],inputs:mode==='interleave'?[{path:'in.txt',sha256:hash('input')}]:[{path:'a.txt',producerTaskId:'a'}],outputs:outputs.b.map(path=>({path,format:'text'})),inScope:outputs.b,verify:['node --test check-b.mjs'],acceptanceChecks:[{criterionIndex:0,command:'node --test check-b.mjs',minimumTests:1}]},
  {...common,id:'c',subject:'Manager acceptance',objective:'Read A and QA, write acceptance and test it.',assignee:'manager',assigneeId:'manager',dependencies:['a','b'],inputs:[{path:'a.txt',producerTaskId:'a'},{path:'qa.json',producerTaskId:'b'}],outputs:outputs.c.map(path=>({path,format:'text'})),inScope:outputs.c,verify:['node --test check-c.mjs'],acceptanceChecks:[{criterionIndex:0,command:'node --test check-c.mjs',minimumTests:1}]},
 ];
 const target={kind:'local',deviceId,grantId,backend},policy={maxBudget:2,maxAgents:3,maxConcurrentAgents:3,maxModelCalls:80,maxTaskModelCalls:25,deadlineSeconds:180,contextManagement:'prune',contextBytes:250000,executionTarget:target};
 let snapshot:any={projectId,planVersion:1,departmentId:'department',title:'Accepted-stop three task engineering fixture',requirement:'Verify three distinct prepared employee tasks with real journal and bounded CLI transport.',executionProfile:'task-attempt-openshell-v1',executionBudget:2,approval:{kind:'project',projectVersion:1},policy,agents,tasks,executionTarget:{...target,platform:'linux',allowCommands:true},importedFiles:[{path:'in.txt',content:'input',snapshotId:'input-snapshot',sha256:hash('input'),agentIds:mode==='interleave'?['developer','qa']:['developer']}]};
 await pool.query('INSERT INTO departments(id,data) VALUES($1,$2)',['department',{name:'Fixture',agents}]);
 await pool.query('INSERT INTO projects(id,department_id,department_version,department_name,requirement,policy,plan,source) VALUES($1,$2,1,$3,$3,$4,$5,$3)',[projectId,'department','fixture',policy,{agents,tasks}]);
 await pool.query("INSERT INTO project_runs(id,project_id,project_version,status,snapshot,lease_owner,lease_until) VALUES($1,$2,1,'running',$3,$4,now()+interval '1 hour')",[runId,projectId,snapshot,owner]);
 await pool.query('INSERT INTO local_devices(id,token_hash,name,platform,grant_id,label,allow_commands,backend) VALUES($1,$2,$3,$4,$5,$3,true,$6)',[deviceId,hash(token),'engineering device','linux',grantId,backend]);
 snapshot=(await pool.query('SELECT snapshot FROM project_runs WHERE id=$1',[runId])).rows[0].snapshot;
 const service=new LocalOperationService(directory,owner),jobs:any[]=[],checks:any[]=[],requests:any[]=[],steps=new Map<string,number>(),timeline:any[]=[];
 const canonical=new Map([['in.txt','input'],['private.txt','private']]);let archive:any,executor:LocalRunExecutor;
 const events=()=>readRun(directory,runId)?.events??[];
 const provider=http.createServer(async(request,response)=>{
  try{
   assert.equal(request.url,'/v1/chat/completions');assert.equal(request.headers.authorization,'Bearer local-engineering-fixture');
   let raw='';for await(const chunk of request)raw+=chunk;const body=JSON.parse(raw);requests.push(body);let message:any={content:'Engineering fixture complete.'};
   const context=fixtureTaskContext(body.messages);
   if(context){
    const id=context.task.id as 'a'|'b'|'c',key=context.runtimeTaskId+':'+context.attemptId,step=steps.get(key)??0;assert.ok(['a','b','c'].includes(id));
    if(mode==='interleave'&&id==='a'&&step===7)await until(()=>device.executor.storageScopes().some((scope:any)=>scope.key?.taskId==='b'),Boolean,'B has a real prepared scope before A accepts');
    const waitingForA=mode==='interleave'&&id==='b'&&step===3&&!events().some(event=>event.type==='handoff/accepted'&&event.data.taskId==='a');
    const update=(status:string,more:any={})=>['agent_teams_update_task',{task_id:context.runtimeTaskId,attempt_id:context.attemptId,status,...more}];
    const path=id==='a'?'a.txt':id==='b'?'qa.json':'acceptance.json',content=id==='a'?'A implemented':id==='b'?'{"verdict":"pass","a":"A implemented"}':'{"accepted":true,"qa":"pass"}';
    const testSource=`import {test} from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';test('actual ${id} file oracle',()=>{assert.equal(readFileSync('${path}','utf8'),${JSON.stringify(content)});${id!=='a'&&!(mode==='interleave'&&id==='b')?"assert.equal(readFileSync('a.txt','utf8'),'A implemented');":''}${id==='c'?"assert.equal(JSON.parse(readFileSync('qa.json','utf8')).verdict,'pass');":''}});`;
    const actions:any[]=[['agent_teams_claim_task',{task_id:context.runtimeTaskId}],update('in_progress')];
    for(const input of id==='a'?['in.txt']:id==='b'?[mode==='interleave'?'in.txt':'a.txt']:['a.txt','qa.json'])actions.push(['filesystem',{path:input}]);
    actions.push(['artifact_write',{path,content}],['artifact_write',{path:'check-'+id+'.mjs',content:testSource}],['filesystem',{path}],['terminal_test',{command:'node --test check-'+id+'.mjs'}]);
    actions.push(update('completed',{output:'Actual '+id+' output and Node test verified.',...(id==='a'?{changedPaths:outputs.a,acceptanceResults:[{criterion:common.acceptanceCriteria[0],status:'passed',evidence:'Actual Node test result.'}],commandsRun:[{command:'node --test check-a.mjs',status:'passed',exitCode:0,evidence:'Host observed result.'}]}:id==='b'?{verdict:'pass'}:{})}));
    if(waitingForA)message=tool('filesystem',{path:'in.txt'},key+':wait-for-A:'+requests.length);
    else {steps.set(key,step+1);if(step<actions.length)message=tool(actions[step][0],actions[step][1],key+':'+step);}
   }
   response.setHeader('content-type','application/json');response.end(JSON.stringify({choices:[{message,finish_reason:message.tool_calls?'tool_calls':'stop'}],usage:{prompt_tokens:50,completion_tokens:10,total_tokens:60}}));
  }catch(error){response.statusCode=500;response.end(JSON.stringify({error:{message:String(error)}}));}
 });
 provider.listen(0,'127.0.0.1');await once(provider,'listening');
 const maintenance=()=>({deviceId,grantId,fingerprint:backend.fingerprint,executor:device.executor});
 const runtime=new ProductDshRuntime({traceRoot:directory,createExecutor:(created:any,approved:any)=>{
  archive=created;mkdirSync(join(created.dir,'artifacts'),{recursive:true});for(const [path,content]of canonical)writeFileSync(join(created.dir,'artifacts',path),content);
  executor=mode==='baseline'?new LocalRunExecutor(created,approved,service):new LocalRunExecutor(created,approved,service,{sandboxMaintenance:maintenance} as any);return executor;
 },requestApproval:async(input:any)=>{const id=randomUUID();await pool.query("INSERT INTO tool_approvals(id,run_id,agent_id,tool,arguments,status) VALUES($1,$2,$3,$4,$5,'approved')",[id,runId,input.agentId,input.tool,input.arguments]);return id;}});
 device.control.onStatus=async(call:any)=>{
  const accepted=events().filter(event=>event.type==='handoff/accepted');if(accepted.every(event=>timeline.some(item=>item.kind==='sql-prepared'&&item.key.taskId===event.data.taskId)))return;
  for(const row of (await pool.query('SELECT task_id,accepted_stop FROM task_attempt_workspaces WHERE run_id=$1 AND accepted_stop IS NOT NULL',[runId])).rows){if(row.accepted_stop.state==='prepared'&&!timeline.some(item=>item.kind==='sql-prepared'&&item.key.taskId===row.task_id))timeline.push({kind:'sql-prepared',key:row.accepted_stop.identity.key,identity:row.accepted_stop.identity,digest:row.accepted_stop.digest,preparedAt:row.accepted_stop.preparedAt,call:call.index,eventSeq:events().at(-1)?.seq});}
 };
 device.control.onAcceptedStop=async(journal:any,call:any)=>{
  const row=(await pool.query('SELECT * FROM task_attempt_workspaces WHERE run_id=$1 AND task_id=$2',[runId,journal.key.taskId])).rows[0];
  const run=(await pool.query('SELECT * FROM project_runs WHERE id=$1',[runId])).rows[0],canonical=readCommittedCanonical(directory,run);
  timeline.push({kind:'stop-dispatch',key:journal.key,call:call.index,journal:structuredClone(journal),sql:row.accepted_stop,sqlFactsSha256:hash(JSON.stringify(taskFacts(row))),currentHead:canonical.ref,eventSeq:events().at(-1)?.seq});
  assert.equal(journal.acceptedStop.stage,'stop_intent');assert.equal(journal.phase,'stopping');assert.equal(row.accepted_stop.state,'dispatching');
 };
 if(mode==='response-loss')device.control.loseAcceptedStop=true;
 return {mode,runId,deviceId,token,backend,snapshot,runtime,provider,jobs,checks,requests,steps,device,canonical,service,events,timeline,maintenance,get archive(){return archive;},get executor(){return executor!;}};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
async function protocol(f:Fixture,endpoint:string,body:any){const response=await fetch(url+'/local-devices/'+f.deviceId+endpoint,{method:'POST',headers:{'content-type':'application/json','X-Local-Device-Key':f.token},body:JSON.stringify(body)});const result=await response.json() as any;assert.equal(response.status,200,endpoint+': '+JSON.stringify(result));return result;}
async function deliver(f:Fixture,job:any){
 assert.equal(JSON.stringify(job).includes('private.txt'),false);assert.equal(job.executionScope.profile,'task-attempt-openshell-v1');
 await protocol(f,'/operations/'+job.id+'/start',{claimToken:job.claimToken});
 if(job.name==='prepare')f.timeline.push({kind:'prepare',key:job.executionScope.key,eventSeq:f.events().at(-1)?.seq,call:f.device.calls.length});
 let result:any;try{result=await f.device.executor.execute(job);}catch(error:any){f.jobs.push({...job,error:{code:error.code,message:error.message}});await protocol(f,'/operations/'+job.id+'/result',{claimToken:job.claimToken,ok:false,error:{code:error.code,message:error.message,notExecuted:error.notExecuted}});throw error;}
 if(job.name==='artifact_write')f.canonical.set(job.arguments.path,job.arguments.content);
 if(job.name==='terminal_test'){assert.equal(result.exitCode,0,result.output);assert.match(result.output,/tests 1/);}
 await protocol(f,'/operations/'+job.id+'/result',{claimToken:job.claimToken,ok:true,result});f.jobs.push(job);
 const row=await until(async()=>(await pool.query('SELECT * FROM local_operations WHERE id=$1',[job.id])).rows[0],value=>value.merge_state==='committed','actual executor commits original result');
 const run=(await pool.query('SELECT * FROM project_runs WHERE id=$1',[f.runId])).rows[0],current=readCommittedCanonical(directory,run);
 assert.deepEqual(current.files,[...f.canonical].sort(([a],[b])=>a.localeCompare(b)).map(([path,content])=>file(path,content)));
 f.checks.push({operationId:job.id,key:job.executionScope.key,sandboxId:result.execution.sandboxId,operationFactsSha256:hash(JSON.stringify(operationFacts(row))),scope:row.payload.taskScope,receipt:row.merge_record.receipt,canonical:current.ref,files:result.files});
}
function saveEvidence(f:Fixture,label:string,extra:any={}){
 const events=f.events(),journal=(value:any)=>({schema:value.schema,key:value.key,sandboxId:value.sandboxId,name:value.name,phase:value.phase,workspaceRevision:value.workspaceRevision,acceptedStop:value.acceptedStop,workManifestSha256:hash(JSON.stringify(value.workManifest)),storageSha256:hash(JSON.stringify(value.storage)),completedOperations:value.completedOperations});
 const data={label,runId:f.runId,profileClosed:true,paidCalls:0,fixtureBoundary:'CLI transport/UID/cgroup/model selections; real executor/schema2 journal/REMOTE_SCRIPT/files/Node tests/Host/Handoff/HTTP/SQL CAS',jobs:f.jobs.map(job=>({id:job.id,name:job.name,key:job.executionScope.key,error:job.error})),checks:f.checks.map(check=>({operationId:check.operationId,key:check.key,sandboxId:check.sandboxId,operationFactsSha256:check.operationFactsSha256,scopeHash:check.scope.workspace.scopeHash,scopeSha256:hash(JSON.stringify(check.scope)),beforeRevision:check.receipt.beforeRevision,afterRevision:check.receipt.afterRevision,partialRevision:revision(check.files),filesSha256:hash(JSON.stringify(manifest(check.files)))})),finalFiles:manifest([...f.canonical].map(([path,content])=>file(path,content))),timeline:f.timeline.map(item=>({...item,...(item.journal?{journal:journal(item.journal)}:{})})),observations:f.device.observations.map((item:any)=>({...item,...(item.journal?{journal:journal(item.journal)}:{})})),callCounts:Object.fromEntries([...new Set<string>(f.device.calls.map((call:any)=>call.args[3]==='exec'?'exec:'+call.request.name:call.args[2]+':'+call.args[3]))].map(command=>[command,f.device.calls.filter((call:any)=>(call.args[3]==='exec'?'exec:'+call.request.name:call.args[2]+':'+call.args[3])===command).length])),calls:f.device.calls.filter((call:any)=>call.args[2]==='sandbox'&&call.args[3]!=='exec').map((call:any)=>({index:call.index,command:call.args.slice(2,5)})),eventsSha256:hash(JSON.stringify(events)),events:events.filter(event=>event.type==='handoff/accepted'||event.type==='run/finished'||event.type==='step/checkpoint'&&event.data.boundary?.trigger==='node-accepted').map(event=>({seq:event.seq,type:event.type,sha256:hash(JSON.stringify(event)),...(event.type==='handoff/accepted'?{taskId:event.data.taskId,key:event.data.taskExecution.key,workspaceRevision:event.data.workspaceRevision,partialRevision:event.data.sandboxWorkRevision}:event.type==='step/checkpoint'?{id:event.data.id,sha256:event.data.sha256,key:event.data.key,trigger:event.data.boundary?.trigger}:{status:event.data.status,message:event.data.message})})),scopes:f.device.executor.storageScopes(),...extra};
 const path=join(evidenceRoot,'product-stop-'+label+'-summary.json');writeFileSync(path,JSON.stringify(data,null,2));return path;
}
async function runFixture(f:Fixture){
 assert.throws(()=>assertExecutionProfile(f.snapshot),{code:'TASK_EXECUTION_UNAVAILABLE'});
 const started=await f.runtime.start({runId:f.runId,approvedSnapshot:f.snapshot,routes:[{id:'fixture',name:'local engineering fixture',wireModel:'fixture',baseUrl:'http://127.0.0.1:'+(f.provider.address() as any).port+'/v1',apiKey:'local-engineering-fixture',inputRate:0,outputRate:0,maxOutputTokens:1024,contextWindowTokens:100000}]});
 let finished=false,result:any;started.completion.then(value=>{finished=true;result=value;});
 try{const deadline=Date.now()+185000;while(!finished&&Date.now()<deadline){const polled=await protocol(f,'/poll',{});if(polled.job)await deliver(f,polled.job);else await pause();}assert.ok(finished,'runtime settles');return result;}
 finally{await f.runtime.cancel(f.runId);await started.completion;f.provider.closeAllConnections();await new Promise<void>(done=>f.provider.close(()=>done()));}
}
test('baseline third actual prepare hits unchanged two-running-slot gate',{skip:!isolated||process.env.PRODUCT_STOP_BASELINE!=='1',timeout:210000},async t=>{
 const f=await fixture('baseline');let failure:any,result:any;try{result=await runFixture(f);}catch(error){failure=error;}saveEvidence(f,'baseline-attempt',{result,failure:failure?{code:failure.code,message:failure.message}:null});assert.equal(failure?.code,'SANDBOX_STORAGE_LIMIT',JSON.stringify({result,steps:[...f.steps],tail:f.events().slice(-5)}));
 const prepares=f.jobs.filter(job=>job.name==='prepare');assert.equal(prepares.length,3);assert.deepEqual(prepares.map(job=>job.executionScope.key.taskId),['a','b','c']);assert.equal(prepares[2].error.code,'SANDBOX_STORAGE_LIMIT');
 assert.equal(f.device.executor.storageScopes().length,2);assert.equal(f.device.observations.filter((row:any)=>row.kind==='accepted-stop').length,0);assert.equal(f.events().filter(event=>event.type==='handoff/accepted').length,2);
 t.diagnostic(saveEvidence(f,'baseline-red',{expectedError:'SANDBOX_STORAGE_LIMIT'}));
});
async function assertSuccessful(f:Fixture,result:any){
 saveEvidence(f,f.mode+'-attempt',{status:result.status,message:result.message});assert.equal(result.status,'completed',JSON.stringify({message:result.message,failures:f.events().findLast(event=>event.type==='team/checkpoint')?.data.tasks.filter((task:any)=>task.status==='failed').map((task:any)=>({id:task.id,output:task.output})),steps:[...f.steps]}));
 assert.deepEqual(f.events().filter(event=>event.type==='handoff/accepted').map(event=>event.data.taskId),['a','b','c']);
 const prepares=f.checks.filter(check=>f.jobs.find(job=>job.id===check.operationId)?.name==='prepare');assert.equal(prepares.length,3);assert.equal(new Set(prepares.map(check=>check.sandboxId)).size,3);assert.equal(new Set(prepares.map(check=>JSON.stringify(check.key))).size,3);assert.equal(new Set(prepares.map(check=>check.key.attemptId)).size,3);
 for(const id of ['a','b']){
  const accepted=f.events().find(event=>event.type==='handoff/accepted'&&event.data.taskId===id)!,cpEvent=f.events().find(event=>event.type==='step/checkpoint'&&event.data.boundary.trigger==='node-accepted'&&event.data.boundary.taskId===id)!;
  assert.ok(cpEvent.seq>accepted.seq);const cp=readStepCheckpoint({root:directory,runId:f.runId,checkpointId:cpEvent.data.id});assert.equal(cp.version,2);
  const prepared=f.timeline.find(item=>item.kind==='sql-prepared'&&item.key.taskId===id),stop=f.timeline.find(item=>item.kind==='stop-dispatch'&&item.key.taskId===id);assert.ok(prepared);assert.ok(stop);assert.ok(prepared.eventSeq>=cpEvent.seq);assert.ok(prepared.call<stop.call);assert.deepEqual(prepared.identity,stop.sql.identity);assert.ok(stop.eventSeq>=cpEvent.seq);assert.equal(stop.sql.identity.workspaceRevision,hash(JSON.stringify(cp.workManifest)));assert.notEqual(stop.sql.identity.workspaceRevision,cp.canonical.revision);
  const next=f.timeline.find(item=>item.kind==='prepare'&&item.key.taskId===(id==='a'&&f.mode!=='interleave'?'b':'c'));assert.ok(next.call>stop.call);
  const originalGets=f.device.calls.slice(stop.call+1,next.call).filter((call:any)=>call.args[3]==='get');assert.ok(originalGets.some((call:any)=>call.args[4]===stop.sql.identity.sandboxId));
  const row=(await pool.query('SELECT * FROM task_attempt_workspaces WHERE run_id=$1 AND task_id=$2',[f.runId,id])).rows[0];assert.equal(row.accepted_stop.state,'stopped');assert.equal(hash(JSON.stringify(taskFacts(row))),stop.sqlFactsSha256,'stopping preserves SQL scope, outputs, binding and sandbox mapping');
  const retained=f.device.executor.read(stop.key);assert.equal(retained.acceptedStop.stage,'stopped_confirmed');assert.deepEqual(retained.workManifest,stop.journal.workManifest);assert.deepEqual(retained.storage,stop.journal.storage);
 }
 assert.equal(f.device.observations.filter((row:any)=>row.kind==='accepted-stop').length,2);assert.ok(f.device.observations.filter((row:any)=>row.kind==='create').every((row:any)=>row.running<=2));
 const scopes=f.device.executor.storageScopes();assert.equal(scopes.length,3);for(const scope of scopes){assert.ok(scope.storage);const remote=[...f.device.sandboxes.values()].find((row:any)=>row.id===scope.sandboxId) as any;assert.ok(remote);for(const item of f.device.executor.read(scope.key).workManifest)assert.equal(hash(readFileSync(join(remote.root,item.path))),item.sha256);}
 const operations=(await pool.query('SELECT * FROM local_operations WHERE run_id=$1',[f.runId])).rows;assert.equal(operations.length,f.jobs.length);assert.ok(operations.every(row=>row.started&&row.status==='completed'&&row.merge_state==='committed'));for(const row of operations)assert.equal(hash(JSON.stringify(operationFacts(row))),f.checks.find(check=>check.operationId===row.id).operationFactsSha256,'stopping preserves original SQL operation/claim/result/merge');assert.equal(sharedFallbacks,0);
 assert.equal(await finishRun(f.runId,f.service.owner,'completed'),true);assert.equal((await acceptedWorkEvidence(pool,directory,f.runId)).receipts.length,3);
}
test('three distinct product tasks stop accepted scopes through maintenance provider',{skip:!isolated||process.env.PRODUCT_STOP_BASELINE==='1',timeout:210000},async t=>{
 const f=await fixture('green'),result=await runFixture(f);await assertSuccessful(f,result);
 t.diagnostic(saveEvidence(f,'green',{sqlStops:(await pool.query('SELECT task_id,accepted_stop FROM task_attempt_workspaces WHERE run_id=$1',[f.runId])).rows}));
});
test('A historical partial stop preserves a later B complete canonical head',{skip:!isolated||process.env.PRODUCT_STOP_BASELINE==='1',timeout:210000},async t=>{
 const f=await fixture('interleave'),result=await runFixture(f);await assertSuccessful(f,result);
 const accepted=f.events().find(event=>event.type==='handoff/accepted'&&event.data.taskId==='a')!,stop=f.timeline.find(item=>item.kind==='stop-dispatch'&&item.key.taskId==='a');
 assert.notEqual(stop.currentHead.revision,accepted.data.workspaceRevision,'B advances the complete head after A accepted');
 assert.notEqual(stop.currentHead.revision,stop.sql.identity.workspaceRevision,'original A partial identity is independent of B complete head');
 assert.ok(stop.currentHead.manifest.some((entry:any)=>entry.path==='qa.json'&&entry.sha256===hash('{"verdict":"pass","a":"A implemented"}')));
 assert.equal(stop.sql.identity.workspaceRevision,accepted.data.sandboxWorkRevision);
 const bCommit=f.checks.find(check=>check.key.taskId==='b'&&f.jobs.find(job=>job.id===check.operationId)?.name==='artifact_write')!;
 assert.ok(f.events().find(event=>event.type==='local/operation-finished'&&event.data.operationId===bCommit.operationId)!.seq>accepted.seq);
 t.diagnostic(saveEvidence(f,'interleave',{sqlStops:(await pool.query('SELECT task_id,accepted_stop FROM task_attempt_workspaces WHERE run_id=$1',[f.runId])).rows}));
});
test('lost accepted stop response cold API bind only observes original ID and never repeats stop',{skip:!isolated||process.env.PRODUCT_STOP_BASELINE==='1',timeout:210000},async t=>{
 const f=await fixture('response-loss'),result=await runFixture(f);saveEvidence(f,'response-loss-attempt',{status:result.status,message:result.message});assert.equal(result.status,'failed');
 const original=(await pool.query("SELECT * FROM task_attempt_workspaces WHERE run_id=$1 AND task_id='a'",[f.runId])).rows[0],marker=original.accepted_stop;
 assert.ok(marker&&marker.state!=='stopped');assert.equal(f.device.executor.read(marker.identity.key).phase,'unknown');assert.equal(f.device.executor.read(marker.identity.key).acceptedStop.stage,'stop_intent');
 assert.equal(f.device.observations.filter((row:any)=>row.kind==='accepted-stop').length,1);
 const target=(await pool.query("SELECT * FROM task_attempt_workspaces WHERE run_id=$1 AND task_id='b'",[f.runId])).rows[0];assert.ok(target);
 const context={agentId:target.principal,sessionId:target.session_id,taskId:target.task_id,attemptId:target.attempt_id,generation:target.generation};
 await assert.rejects(f.executor.taskScope(context,new AbortController().signal),{code:'TASK_SCOPE_DENIED'});
 const before=f.device.calls.length,coldDevice=f.device.reopen(),cold=new LocalRunExecutor(f.archive,f.snapshot,new LocalOperationService(directory,f.service.owner),{sandboxMaintenance:f.maintenance} as any);
 // The next task has failed after the lost response. bind still performs its
 // existing-only reconciliation before the unchanged active assignment guard.
 await assert.rejects(cold.bindAttempt({...context,runId:f.runId,runtimeTaskId:target.runtime_task_id,contractHash:target.contract_hash},new AbortController().signal),{code:'TASK_SCOPE_DENIED'});
 const saved=(await pool.query("SELECT accepted_stop FROM task_attempt_workspaces WHERE run_id=$1 AND task_id='a'",[f.runId])).rows[0].accepted_stop;
 assert.equal(saved.state,'stopped');assert.deepEqual(saved.identity,marker.identity);assert.equal(coldDevice.read(marker.identity.key).phase,'stopped');
 const observed=f.device.calls.slice(before);assert.ok(observed.some((call:any)=>call.args[3]==='get'));assert.ok(observed.every((call:any)=>!['stop','start','create','exec','delete'].includes(call.args[3])));assert.ok(observed.filter((call:any)=>call.args[3]==='get').every((call:any)=>call.args[4]===marker.identity.sandboxId));
 assert.equal(f.device.observations.filter((row:any)=>row.kind==='accepted-stop').length,1);assert.equal(f.jobs.filter(job=>job.name==='prepare').length,1,'unknown stop never dispatches the next prepare');
 t.diagnostic(saveEvidence(f,'response-loss',{reconciliation:{firstCall:before,identity:saved.identity,state:saved.state,onlyObservation:true}}));
});
