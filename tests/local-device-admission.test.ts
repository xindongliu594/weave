import {createArchiveWriterManager} from '../services/agent-runtime/archive-writer-scope.mjs';
import {before,after,beforeEach,test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {randomUUID,randomBytes} from 'node:crypto';
import {createRequire} from 'node:module';
import http from 'node:http';
import express from 'express';
import type pg from 'pg';
import {createRunArchive,openRunArchive,readRun} from '../services/agent-runtime/trace-store.mjs';
import {OpenAiCompatibleAdapter} from '../services/agent-runtime/openai-compatible.mjs';
import {toolEvidence} from './model-fixture.ts';

// Fresh in-memory PGlite only; authenticated loopback device protocol, native
// Node command in a test-owned temporary workspace, and a loopback model double.
// Never use the application database, credentials, API or employee artifacts.
let writers:ReturnType<typeof createArchiveWriterManager>;
const isolated=process.env.SIMULATED_INTEGRATION==='pglite';
const {LocalExecutor,exportFiles,revision}=createRequire(import.meta.url)('../apps/desktop/local-executor.cjs');
const departmentId='admission-fixture-department',modelId='admission-fixture-model';
const employee={id:'native',employeeId:'manager',name:'隔离准入',title:'经理',role:'manager',modelId,tools:['artifact_write','terminal_test'],instructions:'Isolated fixture only'};
const script="import {appendFile} from 'node:fs/promises';await appendFile(new URL('./executions.txt',import.meta.url),'once\\n');\n";
let pool:pg.Pool,directory:string,traceRoot:string,server:http.Server,url:string,route:any,wireCalls=0;
let local:typeof import('../apps/api/src/local-execution.ts'),cost:typeof import('../apps/api/src/cost-control.ts');
let worker:InstanceType<typeof import('../apps/api/src/run-coordinator.ts').RunCoordinator>;
const pause=(ms:number)=>new Promise(done=>setTimeout(done,ms));
type Fixture={device:any;runId:string;projectId:string;workspace:string;executor:any;service:InstanceType<typeof import('../apps/api/src/local-execution.ts').LocalOperationService>};
before(async()=>{
 if(!isolated)return;
 assert.match(process.env.DATABASE_URL??'',/^postgresql:\/\/postgres:postgres@127\.0\.0\.1:\d+\/postgres$/);
 directory=await mkdtemp(join(tmpdir(),'local-device-admission-'));traceRoot=join(directory,'runs');
 process.env.DATA_DIR=directory;process.env.TRACE_ROOT=traceRoot;writers=createArchiveWriterManager({traceRoot:traceRoot});process.env.OBSIDIAN_VAULT=join(directory,'vault');
 const db=await import('../apps/api/src/db.ts');pool=db.pool;await db.migrate();
 local=await import('../apps/api/src/local-execution.ts');cost=await import('../apps/api/src/cost-control.ts');
 const app=express();app.use(express.json({limit:'32mb'}));app.use('/api',local.localDeviceRouter(traceRoot,writers));
 app.post('/v1/chat/completions',(_req,res)=>{wireCalls++;res.json({choices:[{message:{role:'assistant',content:'isolated fixture reply'},finish_reason:'stop'}],usage:{prompt_tokens:4,completion_tokens:2}});});
 app.use((error:any,_req:any,res:any,_next:any)=>res.status(error.status??500).json({code:error.code,message:error.message}));
 server=app.listen(0,'127.0.0.1');await once(server,'listening');url='http://127.0.0.1:'+(server.address() as any).port;
 await pool.query('INSERT INTO departments(id,data) VALUES($1,$2)',[departmentId,{name:'Isolated admission',agents:[employee]}]);
 await pool.query('INSERT INTO gateways(id,data) VALUES($1,$2)',['admission-fixture-gateway',{name:'Loopback only',baseUrl:url+'/v1'}]);
 const model={name:'Loopback fixture',gatewayId:'admission-fixture-gateway',model:'fixture',inputRate:1,outputRate:1};
 await pool.query("INSERT INTO models(id,data,status,capabilities) VALUES($1,$2,'available',$3)",[modelId,model,toolEvidence]);
 const {routeFingerprint}=await import('../apps/api/src/model-capabilities.ts');
 route={id:modelId,name:model.name,gatewayId:model.gatewayId,wireModel:model.model,baseUrl:url+'/v1',inputRate:1,outputRate:1,maxOutputTokens:128,
  configurationHash:routeFingerprint((await pool.query('SELECT data FROM models WHERE id=$1',[modelId])).rows[0].data,1)};
 const {RunCoordinator}=await import('../apps/api/src/run-coordinator.ts');worker=new RunCoordinator(traceRoot,writers);await worker.close();
});
beforeEach(async()=>{if(isolated){await pool.query('TRUNCATE local_operations,local_devices,project_runs,projects,usage,model_reservations,request_keys,tool_approvals CASCADE');wireCalls=0;await pool.query('UPDATE departments SET deleted_at=NULL WHERE id=$1',[departmentId]);}});
after(async()=>{
 if(!isolated)return;
 await worker?.close();if(server)await new Promise<void>(done=>{server.closeAllConnections();server.close(()=>done());});await pool?.end();
 const within=relative(resolve(tmpdir()),resolve(directory));assert.ok(within.startsWith('local-device-admission-')&&!within.startsWith('..')&&!isAbsolute(within));await rm(directory,{recursive:true,force:true});
});
async function protocol(f:Fixture,path:string,body:unknown,key=f.device.token){
 const response=await fetch(url+'/api/local-devices/'+path,{method:'POST',headers:{'content-type':'application/json','X-Local-Device-Key':key},body:JSON.stringify(body)});
 return {status:response.status,data:await response.json() as any};
}
async function fixture():Promise<Fixture>{
 await pool.query('UPDATE departments SET deleted_at=NULL WHERE id=$1',[departmentId]);
 const root=join(directory,'device-'+randomUUID());await mkdir(root);
 const device={id:randomUUID(),token:randomBytes(32).toString('hex'),grant:{id:randomUUID(),root,allowCommands:true}};
 const projectId=randomUUID(),runId=randomUUID();
 const policy={maxBudget:1,maxAgents:1,maxConcurrentAgents:1,maxModelCalls:10,maxTaskModelCalls:5,deadlineSeconds:180,
  executionTarget:{kind:'local',deviceId:device.id,grantId:device.grant.id}};
 const snapshot={projectId,planVersion:1,departmentId,departmentIds:[departmentId],executionBudget:1,policy,agents:[employee],
  tasks:[{id:'review',subject:'Isolated admission',assigneeId:employee.employeeId,assignee:employee.id,dependencies:[],maxBudget:1}],modelRoutes:[route],
  executionTarget:{...policy.executionTarget,platform:process.platform,label:'isolated',allowCommands:true}};
 const service=new local.LocalOperationService(traceRoot,worker.owner,writers),f={device,projectId,runId,service,executor:new LocalExecutor(device.grant),workspace:join(root,runId)};
 assert.equal((await protocol(f,'register',{id:device.id,token:device.token,name:'Isolated device',platform:process.platform,grant:{id:device.grant.id,label:'isolated',allowCommands:true}})).status,200);
 await pool.query('INSERT INTO projects(id,department_id,department_version,department_name,requirement,policy,plan,source) VALUES($1,$2,1,$3,$4,$5,$6,$7)',
  [projectId,departmentId,'Isolated admission','Isolated heartbeat admission',policy,{agents:[employee],tasks:snapshot.tasks},'manual']);
 await pool.query("INSERT INTO project_runs(id,project_id,project_version,status,snapshot,lease_owner,lease_until,started_at,department_ids) VALUES($1,$2,1,'running',$3,$4,clock_timestamp()+interval '3 minutes',now(),$5)",[runId,projectId,snapshot,worker.owner,[departmentId]]);
 createRunArchive(traceRoot,snapshot,{id:runId});return f;
}
const age=(f:Fixture)=>pool.query("UPDATE local_devices SET last_seen=clock_timestamp()-interval '20 seconds' WHERE id=$1",[f.device.id]);
const context=()=>({agentId:employee.id,employeeId:employee.employeeId,callId:randomUUID(),sessionId:randomUUID(),taskId:'review'});
const enqueue=(f:Fixture,signal?:AbortSignal)=>f.service.enqueue(f.runId,'artifact_write',{path:'denied.txt',content:'fixture'},context(),undefined,signal);
async function counts(f:Fixture){
 return {operations:(await pool.query('SELECT count(*)::int AS n FROM local_operations WHERE run_id=$1',[f.runId])).rows[0].n,
  reservations:(await pool.query('SELECT count(*)::int AS n FROM model_reservations WHERE run_id=$1',[f.runId])).rows[0].n,
  usages:(await pool.query('SELECT count(*)::int AS n FROM usage WHERE run_id=$1',[f.runId])).rows[0].n,wire:wireCalls};
}
function modelRequest(f:Fixture,signal?:AbortSignal){
 const failures:any[]=[],requests:any[]=[];let admittedSignal:AbortSignal|undefined;
 const adapter:any=new OpenAiCompatibleAdapter({routes:[route],maxBudget:1,signal,tasks:[{id:'review',maxBudget:1,assigneeId:employee.employeeId}],
  beforeRequest:async(data:any,requestSignal?:AbortSignal)=>{admittedSignal=requestSignal;await worker.reserve(f.runId,data,requestSignal);},
  onUsage:async(usage:any)=>{await cost.settleCall(usage.id,usage.inputTokens,usage.outputTokens,usage);},
  onRequest:(event:any)=>{requests.push(event);},onCallError:(event:any)=>{failures.push(event);}});
 adapter.attribution=()=>({agentId:employee.id,employeeId:employee.employeeId,sessionId:'isolated-session',taskId:'review'});
 const done=(async()=>{const result=[];for await(const event of adapter.stream({model:route.id,messages:[{id:'m',role:'user',source:{kind:'user'},content:[{type:'text',text:'Only loopback fixture reply'}]}]}))result.push(event);return result;})();
 return {done,adapter,failures,requests,signal:()=>admittedSignal};
}
async function claimStartExecute(f:Fixture,id:string){
 const claim=await protocol(f,f.device.id+'/poll',{});assert.equal(claim.status,200);assert.equal(claim.data.job?.id,id);const job=claim.data.job;
 assert.equal((await protocol(f,f.device.id+'/operations/'+id+'/start',{claimToken:job.claimToken})).status,200);
 assert.equal((await protocol(f,f.device.id+'/operations/'+id+'/start',{claimToken:job.claimToken})).status,409,'one start only');
 const inherited=process.env.NODE_TEST_CONTEXT;let actual:any;
 try{delete process.env.NODE_TEST_CONTEXT;actual=await f.executor.execute(job,new AbortController().signal);}finally{if(inherited!==undefined)process.env.NODE_TEST_CONTEXT=inherited;}
 assert.equal((await protocol(f,f.device.id+'/operations/'+id+'/result',{claimToken:job.claimToken,ok:true,result:actual})).status,200);
 return f.service.wait(id);
}

test('authenticated heartbeat recovery queues and starts one real native command', {skip:!isolated,timeout:30000},async()=>{
 const f=await fixture();const prepared=await f.service.enqueue(f.runId,'prepare',{}, {},[{path:'fixture.mjs',content:Buffer.from(script).toString('base64')}]);await claimStartExecute(f,prepared);
 const args={command:'node fixture.mjs',expectedWorkspaceRevision:revision(exportFiles(f.workspace))},approvalId=randomUUID();
 await pool.query("INSERT INTO tool_approvals(id,run_id,agent_id,tool,arguments,status) VALUES($1,$2,$3,'terminal_test',$4,'approved')",[approvalId,f.runId,employee.id,args]);
 await age(f);const pending=f.service.enqueue(f.runId,'terminal_test',args,{...context(),approvalId});
 await pause(350);assert.equal((await counts(f)).operations,1,'no enqueue while heartbeat is stale');
 assert.equal((await protocol(f,f.device.id+'/poll',{},randomBytes(32).toString('hex'))).status,403);await pause(300);
 assert.equal((await counts(f)).operations,1,'an unauthenticated poll cannot reopen admission');
 const recovered=await protocol(f,f.device.id+'/poll',{});assert.equal(recovered.status,200);assert.equal(recovered.data.job,null);
 const id=await pending;const actual=await claimStartExecute(f,id);assert.equal(actual.exitCode,0);assert.equal(readFileSync(join(f.workspace,'executions.txt'),'utf8'),'once\n');
 const rows=(await pool.query("SELECT status,started,late_result FROM local_operations WHERE run_id=$1 AND payload->>'name'='terminal_test'",[f.runId])).rows;
 assert.deepEqual(rows,[{status:'completed',started:true,late_result:null}]);assert.deepEqual(await counts(f),{operations:2,reservations:0,usages:0,wire:0});
});

test('model admission waits for authenticated recovery and emits one reservation and one loopback wire', {skip:!isolated,timeout:30000},async()=>{
 const f=await fixture();await age(f);const m=modelRequest(f);await pause(350);assert.deepEqual(await counts(f),{operations:0,reservations:0,usages:0,wire:0});
 assert.ok(m.signal() instanceof AbortSignal,'the original fused request signal reaches durable admission');
 assert.equal((await protocol(f,f.device.id+'/poll',{},randomBytes(32).toString('hex'))).status,403);await pause(300);assert.equal(wireCalls,0);
 assert.equal((await protocol(f,f.device.id+'/poll',{})).status,200);await m.done;
 assert.deepEqual(await counts(f),{operations:0,reservations:1,usages:1,wire:1});assert.equal(m.requests.length,1);assert.equal(m.failures.length,0);assert.equal(m.adapter.calls,1);assert.equal(m.adapter.reserved,0);
 assert.equal((await pool.query('SELECT status FROM model_reservations WHERE run_id=$1',[f.runId])).rows[0].status,'settled');
});

test('offline to the bounded deadline leaves both local and model dispatch at zero', {skip:!isolated,timeout:30000},async()=>{
 const f=await fixture();await age(f);const started=Date.now(),m=modelRequest(f);
 const result=await Promise.allSettled([enqueue(f),m.done]);assert.ok(Date.now()-started>=10000);assert.ok(Date.now()-started<15000);
 for(const item of result){assert.equal(item.status,'rejected');if(item.status==='rejected')assert.equal(item.reason.code,'LOCAL_DEVICE_OFFLINE');}
 assert.equal((result[0] as PromiseRejectedResult).reason.notExecuted,true);assert.deepEqual(await counts(f),{operations:0,reservations:0,usages:0,wire:0});
 assert.equal(m.adapter.calls,1,'heartbeat polling cannot count another model attempt');assert.equal(m.requests.length,0);assert.equal(m.failures.length,0);assert.equal(m.adapter.reserved,0);
});

test('caller cancellation and original deadline abort waiting before any dispatch', {skip:!isolated,timeout:30000},async()=>{
 for(const reason of ['caller','deadline']){
  const f=await fixture();await age(f);const controller=new AbortController(),signal=reason==='deadline'?AbortSignal.timeout(600):controller.signal;
  const started=Date.now(),m=modelRequest(f,signal),outcome=Promise.allSettled([enqueue(f,signal),m.done]);await pause(350);
  if(reason==='caller')controller.abort(Object.assign(Error('fixture caller stop'),{code:'FIXTURE_CALLER_ABORT'}));
  const result=await outcome;assert.ok(Date.now()-started<2000);for(const item of result){assert.equal(item.status,'rejected');if(item.status==='rejected')assert.equal(item.reason,signal.reason);}
  assert.equal((result[0] as PromiseRejectedResult).reason.notExecuted,true);assert.equal(m.signal()?.aborted,true);assert.deepEqual(await counts(f),{operations:0,reservations:0,usages:0,wire:0});
 }
});

test('LocalRunExecutor prepare and execute preserve caller abort while heartbeat admission waits', {skip:!isolated,timeout:30000},async()=>{
 for(const mode of ['prepare','execute']){
  const f=await fixture(),snapshot=(await pool.query('SELECT snapshot FROM project_runs WHERE id=$1',[f.runId])).rows[0].snapshot;
  const executor=new local.LocalRunExecutor(openRunArchive(traceRoot,f.runId),snapshot,f.service);
  if(mode==='execute'){
   const preparing=executor.prepare(new AbortController().signal);await pause(150);
   const queued=(await pool.query("SELECT id FROM local_operations WHERE run_id=$1 AND status='queued'",[f.runId])).rows[0];assert.ok(queued);
   await claimStartExecute(f,queued.id);await preparing;
  }
  await age(f);const signal=AbortSignal.timeout(600),pending=mode==='prepare'?executor.prepare(signal):executor.execute('artifact_write',{path:'denied.txt',content:'fixture'},signal,context());
  await assert.rejects(pending,error=>error===signal.reason&&(error as any).notExecuted===true);
  assert.deepEqual(await counts(f),{operations:mode==='prepare'?0:1,reservations:0,usages:0,wire:0});
  assert.equal(readRun(traceRoot,f.runId)?.events.filter((event:any)=>event.type==='runtime/outcome-unknown').length,0);
 }
});

test('current hard withdrawal, version, cancel, lease and snapshot failures stop stale admissions promptly', {skip:!isolated,timeout:30000},async()=>{
 for(const reason of ['disabled','grant','commands','version','cancel','finished','lease','owner','department','knowledge','snapshot']){
  if(reason==='knowledge'){
   const f=await fixture(),spaceId=randomUUID();
   await pool.query("INSERT INTO knowledge_spaces(id,name,scope) VALUES($1,'Isolated grant','company')",[spaceId]);
   await pool.query("UPDATE project_runs SET snapshot=jsonb_set(snapshot,'{agents,0,knowledgeSpaceIds}',$1::jsonb) WHERE id=$2",[JSON.stringify([spaceId]),f.runId]);
   await age(f);const m=modelRequest(f),outcome=Promise.allSettled([enqueue(f),m.done]);await pause(350);const changed=Date.now();
   await pool.query('UPDATE knowledge_spaces SET deleted_at=now() WHERE id=$1',[spaceId]);
   const result=await outcome;assert.ok(Date.now()-changed<1500);for(const item of result){assert.equal(item.status,'rejected');if(item.status==='rejected')assert.equal(item.reason.code,'KNOWLEDGE_GRANT_INVALID');}
   assert.deepEqual(await counts(f),{operations:0,reservations:0,usages:0,wire:0});continue;
  }
  const f=await fixture();await age(f);const m=modelRequest(f),outcome=Promise.allSettled([enqueue(f),m.done]);await pause(350);const changed=Date.now();
  if(reason==='disabled')await pool.query('UPDATE local_devices SET enabled=false WHERE id=$1',[f.device.id]);
  else if(reason==='grant')await pool.query('UPDATE local_devices SET grant_id=$1 WHERE id=$2',[randomUUID(),f.device.id]);
  else if(reason==='commands')await pool.query('UPDATE local_devices SET allow_commands=false WHERE id=$1',[f.device.id]);
  else if(reason==='version')await pool.query('UPDATE projects SET version=version+1 WHERE id=$1',[f.projectId]);
  else if(reason==='cancel')await pool.query('UPDATE project_runs SET cancel_requested=true WHERE id=$1',[f.runId]);
  else if(reason==='finished')await pool.query("UPDATE project_runs SET status='failed' WHERE id=$1",[f.runId]);
  else if(reason==='lease')await pool.query("UPDATE project_runs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",[f.runId]);
  else if(reason==='owner')await pool.query('UPDATE project_runs SET lease_owner=$1 WHERE id=$2',[randomUUID(),f.runId]);
  else if(reason==='department')await pool.query('UPDATE departments SET deleted_at=now() WHERE id=$1',[departmentId]);
  else await pool.query("UPDATE project_runs SET snapshot=jsonb_set(snapshot,'{executionTarget,platform}',to_jsonb('wrong'::text)) WHERE id=$1",[f.runId]);
  const result=await outcome;assert.ok(Date.now()-changed<1500,reason+' should not wait for the offline deadline');
  const localCode:Record<string,string>={disabled:'LOCAL_GRANT_CHANGED',grant:'LOCAL_GRANT_CHANGED',commands:'LOCAL_COMMAND_DENIED',version:'RUN_REAPPROVAL_REQUIRED',cancel:'LOCAL_LEASE_DENIED',finished:'LOCAL_LEASE_DENIED',lease:'LOCAL_LEASE_DENIED',owner:'LOCAL_LEASE_DENIED',department:'DEPARTMENT_ARCHIVED',snapshot:'LOCAL_GRANT_CHANGED'};
  for(const [index,item] of result.entries()){
   assert.equal(item.status,'rejected',reason);if(item.status==='rejected'){
    if(index===0)assert.equal(item.reason.code,localCode[reason],reason);
    else assert.notEqual(item.reason.code,'LOCAL_DEVICE_OFFLINE',reason+' hard denial outranks heartbeat');
   }
  }
  assert.deepEqual(await counts(f),{operations:0,reservations:0,usages:0,wire:0});
 }
});

test('current model configuration and remaining budget denial outrank a stale heartbeat', {skip:!isolated,timeout:30000},async()=>{
 for(const reason of ['model','budget']){
  const f=await fixture();await age(f);const m=modelRequest(f),outcome=m.done.then(()=>({ok:true,error:undefined}),error=>({ok:false,error}));await pause(350);const changed=Date.now();
  if(reason==='model')await pool.query("UPDATE models SET status='untested' WHERE id=$1",[modelId]);
  else await pool.query("UPDATE project_runs SET snapshot=jsonb_set(snapshot,'{executionBudget}','0'::jsonb) WHERE id=$1",[f.runId]);
  const result=await outcome;assert.equal(result.ok,false);assert.equal(result.error?.code,reason==='model'?'MODEL_CAPABILITY_REQUIRED':'BUDGET_EXCEEDED');assert.ok(Date.now()-changed<1500);
  assert.deepEqual(await counts(f),{operations:0,reservations:0,usages:0,wire:0});await pool.query("UPDATE models SET status='available' WHERE id=$1",[modelId]);
 }
});
