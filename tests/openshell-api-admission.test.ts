import {before,after,beforeEach,afterEach,test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {randomUUID,randomBytes} from 'node:crypto';
import http from 'node:http';
import express from 'express';
import type pg from 'pg';
import {createRunArchive} from '../services/agent-runtime/trace-store.mjs';

// Engineering API integration only: an isolated in-memory PGlite database,
// real loopback HTTP/auth/SQL transitions, and declared sandbox receipt fixtures.
// No OpenShell process, sandbox isolation claim, real employee or model call.
const isolated=process.env.SIMULATED_INTEGRATION==='pglite';
const opts={skip:!isolated,timeout:30000};
const backend={kind:'openshell',version:'0.1.2',gateway:'weiwu-openshell-v012',
 image:'docker.io/library/node:24.19.0-bookworm-slim@sha256:'+'e'.repeat(64),policySha256:'a'.repeat(64),fingerprint:'b'.repeat(64)} as const;
const execution={...backend,sandboxId:'67e64e45-7302-4fb9-ac33-cb050825baef',sandboxName:'wwp-43170b8e3257',uid:1000,gid:1000,
 node:'v24.19.0',cpu:[100000,100000],memory:'536870912',effectivePolicyHash:'27ae8e91e5dd6b505e6a331bb5b24a7a2b47aced33257f4f7e7a7c892978e6b5'};
const departmentId='openshell-api-fixture';
const employee={id:'developer',name:'隔离 API 测试',title:'开发',role:'developer',modelId:'unused-fixture-model',tools:['artifact_write','terminal_test'],instructions:'Engineering fixture only'};
let pool:pg.Pool,directory:string,traceRoot:string,server:http.Server,url:string;
let local:typeof import('../apps/api/src/local-execution.ts');
type Fixture={device:any;runId:string;projectId:string;owner:string;policy:any;snapshot:any;service:InstanceType<typeof import('../apps/api/src/local-execution.ts').LocalOperationService>};
before(async()=>{
 if(!isolated)return;
 assert.match(process.env.DATABASE_URL??'',/^postgresql:\/\/postgres:postgres@127\.0\.0\.1:\d+\/postgres$/);
 directory=await mkdtemp(join(tmpdir(),'openshell-api-fixture-'));traceRoot=join(directory,'runs');
 process.env.DATA_DIR=directory;process.env.TRACE_ROOT=traceRoot;process.env.OBSIDIAN_VAULT=join(directory,'vault');
 const db=await import('../apps/api/src/db.ts');pool=db.pool;await db.migrate();
 await pool.query('INSERT INTO departments(id,data) VALUES($1,$2)',[departmentId,{name:'OpenShell API fixture',agents:[employee]}]);
 local=await import('../apps/api/src/local-execution.ts');
 const app=express();app.use(express.json({limit:'32mb'}));app.use('/api',local.localDeviceRouter(traceRoot));
 app.use((error:any,_request:any,response:any,_next:any)=>response.status(error.status??500).json({code:error.code,message:error.message}));
 server=app.listen(0,'127.0.0.1');await once(server,'listening');url='http://127.0.0.1:'+(server.address() as any).port+'/api';
});
beforeEach(async()=>{if(isolated)await pool.query('TRUNCATE local_operations,local_devices,project_runs,projects,usage,model_reservations,tool_approvals CASCADE');});
afterEach(async()=>{if(isolated){
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM usage')).rows[0].n,0);
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM model_reservations')).rows[0].n,0);
}});
after(async()=>{
 if(!isolated)return;
 if(server)await new Promise<void>(done=>{server.closeAllConnections();server.close(()=>done());});await pool?.end();
 if(directory){const inside=relative(resolve(tmpdir()),resolve(directory));assert.ok(inside.startsWith('openshell-api-fixture-')&&!inside.startsWith('..')&&!isAbsolute(inside));await rm(directory,{recursive:true,force:true});}
});
async function post(device:any,path:string,body:any,key=device.token){
 const response=await fetch(url+'/local-devices/'+path,{method:'POST',headers:{'content-type':'application/json','X-Local-Device-Key':key},body:JSON.stringify(body)});
 return {status:response.status,data:await response.json() as any};
}
const newDevice=()=>({id:randomUUID(),token:randomBytes(32).toString('hex'),name:'Isolated OpenShell',platform:'linux',grant:{id:randomUUID(),label:'isolated',allowCommands:true},backend});
const row=async(id:string)=>(await pool.query('SELECT * FROM local_operations WHERE id=$1',[id])).rows[0];
const context=()=>({agentId:employee.id,callId:randomUUID(),sessionId:randomUUID(),taskId:'development'});
async function fixture():Promise<Fixture>{
 const device=newDevice(),runId=randomUUID(),projectId=randomUUID(),owner=randomUUID();
 assert.equal((await post(device,'register',device)).status,200);
 const policy={maxBudget:1,maxAgents:1,maxConcurrentAgents:1,deadlineSeconds:180,executionTarget:{kind:'local',deviceId:device.id,grantId:device.grant.id,backend}};
 const tasks=[{id:'development',subject:'API fixture only',assignee:employee.id,assigneeId:employee.id,dependencies:[]}];
 const snapshot={projectId,planVersion:1,departmentId,policy,agents:[employee],tasks,executionTarget:{...policy.executionTarget,platform:'linux',label:'isolated',allowCommands:true}};
 await pool.query('INSERT INTO projects(id,department_id,department_version,department_name,requirement,policy,plan,source) VALUES($1,$2,1,$3,$4,$5,$6,$7)',[projectId,departmentId,'API fixture','No employee/model execution',policy,{agents:[employee],tasks},'manual']);
 await pool.query("INSERT INTO project_runs(id,project_id,project_version,status,snapshot,lease_owner,lease_until,started_at) VALUES($1,$2,1,'running',$3,$4,clock_timestamp()+interval '3 minutes',now())",[runId,projectId,snapshot,owner]);
 createRunArchive(traceRoot,snapshot,{id:runId});return {device,runId,projectId,owner,policy,snapshot,service:new local.LocalOperationService(traceRoot,owner)};
}
async function queue(f:Fixture){return f.service.enqueue(f.runId,'prepare',{}, {},[]);}

async function claim(f:Fixture,id:string){const r=await post(f.device,f.device.id+'/poll',{});assert.equal(r.status,200);assert.equal(r.data.job?.id,id);return r.data.job;}
const operation=(f:Fixture,job:any,action:string,body:any)=>post(f.device,f.device.id+'/operations/'+job.id+'/'+action,{claimToken:job.claimToken,...body});
const result=(executionProof:any=execution)=>({localWorkspace:'/sandbox',files:[],execution:executionProof});

test('legacy registration gets native default; OpenShell registration requires Linux and hides credentials',opts,async()=>{
 const native:any=newDevice();delete native.backend;native.platform=process.platform;
 assert.equal((await post(native,'register',native)).status,200);
 assert.deepEqual((await pool.query('SELECT backend FROM local_devices WHERE id=$1',[native.id])).rows[0].backend,{kind:'native'});
 const denied=newDevice();assert.equal((await post(denied,'register',{...denied,platform:'win32'})).data.code,'LOCAL_BACKEND_INVALID');
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM local_devices WHERE id=$1',[denied.id])).rows[0].n,0);
 const device=newDevice();assert.equal((await post(device,'register',device)).status,200);
 const devices:any[]=await (await fetch(url+'/local-devices')).json();assert.equal(devices.length,2);
 assert.deepEqual(devices.find(d=>d.id===device.id).backend,backend);
 for(const d of devices){assert.equal(d.token,undefined);assert.equal(d.token_hash,undefined);assert.equal(d.credential,undefined);}
});

test('existing device cannot change backend fingerprint, grant or platform or re-enable itself',opts,async()=>{
 const f=await fixture();assert.equal((await post(f.device,'register',f.device,randomBytes(32).toString('hex'))).status,403);
 for(const change of [{backend:{...backend,fingerprint:'c'.repeat(64)}},{backend:{kind:'native'}},{grant:{...f.device.grant,id:randomUUID()}},{platform:'darwin'}]){
  const response=await post(f.device,'register',{...f.device,...change});assert.ok([403,422].includes(response.status));
 }
 assert.equal((await post(f.device,'register',f.device)).status,200);
 assert.equal((await post(f.device,f.device.id+'/disable',{})).status,200);
 assert.equal((await post(f.device,'register',f.device)).data.code,'LOCAL_GRANT_CHANGED');
 assert.deepEqual((await pool.query('SELECT backend,enabled FROM local_devices WHERE id=$1',[f.device.id])).rows[0],{backend,enabled:false});
});

test('unbound or changed approved backend cannot enqueue; valid approved identity can',opts,async()=>{
 const f=await fixture();
 for(const approved of [undefined,{...backend,fingerprint:'c'.repeat(64)},{kind:'native'}]){
  const snapshot=structuredClone(f.snapshot);snapshot.policy.executionTarget.backend=approved;
  await pool.query('UPDATE project_runs SET snapshot=$1 WHERE id=$2',[snapshot,f.runId]);
  await assert.rejects(queue(f),{code:'LOCAL_BACKEND_CHANGED',notExecuted:true});
 }
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM local_operations')).rows[0].n,0);
 await pool.query('UPDATE project_runs SET snapshot=$1 WHERE id=$2',[f.snapshot,f.runId]);assert.ok(await queue(f));
});

test('employee permissions and exact per-command approvals still apply to OpenShell',opts,async()=>{
 const f=await fixture(),args={command:'node fixture.mjs',expectedWorkspaceRevision:'f'.repeat(64)},ctx={...context(),approvalId:randomUUID()};
 await assert.rejects(f.service.enqueue(f.runId,'terminal_test',args,ctx),{code:'LOCAL_APPROVAL_DENIED'});
 await assert.rejects(f.service.enqueue(f.runId,'artifact_write',{path:'a',content:'b'},{...context(),agentId:'other'}),{code:'LOCAL_EMPLOYEE_DENIED'});
 await pool.query("INSERT INTO tool_approvals(id,run_id,agent_id,tool,arguments,status) VALUES($1,$2,$3,'terminal_test',$4,'approved')",[ctx.approvalId,f.runId,employee.id,args]);
 await assert.rejects(f.service.enqueue(f.runId,'terminal_test',{...args,command:'node other.mjs'},ctx),{code:'LOCAL_APPROVAL_DENIED'});
 const id=await f.service.enqueue(f.runId,'terminal_test',args,ctx);assert.ok(id);
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM local_operations')).rows[0].n,1);
});

test('invalid sandbox receipt leaves started operation unresolved; valid receipt is durable and idempotent',opts,async()=>{
 const f=await fixture(),job=await claim(f,await queue(f));
 assert.equal((await operation(f,job,'result',{ok:true,result:result()})).status,409);
 assert.equal((await operation(f,job,'start',{})).status,200);
 assert.equal((await operation(f,job,'start',{})).status,409);
 for(const proof of [undefined,{...execution,uid:0},{...execution,fingerprint:'d'.repeat(64)},{...execution,cpu:undefined},
  {...execution,cpu:[200000,100000]},{...execution,cpu:['max','100000']},{...execution,memory:'max'},
  {...execution,memory:'1073741824'},{...execution,effectivePolicyHash:'c'.repeat(64)}]){
  const response=await operation(f,job,'result',{ok:true,result:result(proof===undefined?null:proof)});
  assert.equal(response.status,422);assert.equal(response.data.code,'LOCAL_BACKEND_PROOF_INVALID');
  assert.equal((await row(job.id)).status,'started');assert.equal((await row(job.id)).result,null);
 }
 const body={ok:true,result:result()};assert.equal((await operation(f,job,'result',body)).status,200);
 assert.deepEqual(await f.service.wait(job.id),body.result);
 assert.equal((await operation(f,job,'result',body)).status,200);
 assert.equal((await operation(f,job,'result',{ok:true,result:{...body.result,localWorkspace:'/changed'}})).status,409);
 assert.equal((await post(f.device,f.device.id+'/poll',{})).data.job,null);
 const exposed:any[]=await (await fetch(url+'/runs/'+f.runId+'/local-operations')).json();
 assert.deepEqual(exposed[0].result.execution,execution);assert.equal(exposed[0].result.files,undefined);assert.equal(exposed[0].claim_token,undefined);
});

test('lost unstarted claim is re-offered; started unknown outcome is never replayed',opts,async()=>{
 const f=await fixture(),job=await claim(f,await queue(f)),same=await claim(f,job.id);assert.equal(same.claimToken,job.claimToken);
 assert.equal((await operation(f,job,'start',{})).status,200);
 const second=await queue(f),polled=await post(f.device,f.device.id+'/poll',{});
 assert.deepEqual(polled.data.orphan,{id:job.id,claimToken:job.claimToken,started:true});assert.equal(polled.data.job,undefined);
 assert.equal((await row(second)).status,'queued');assert.equal((await row(job.id)).status,'started');
 assert.equal((await operation(f,job,'result',{ok:false,error:{code:'OPEN_SHELL_TRANSPORT',message:'Outcome unknown',notExecuted:false}})).status,200);
 await assert.rejects(f.service.wait(job.id),{code:'OPEN_SHELL_TRANSPORT',notExecuted:false});
 assert.equal((await post(f.device,f.device.id+'/poll',{})).data.job.id,second);
});

test('withdrawn grant preserves late receipt without completing or reactivating the device',opts,async()=>{
 const f=await fixture(),job=await claim(f,await queue(f));assert.equal((await operation(f,job,'start',{})).status,200);
 assert.equal((await post(f.device,f.device.id+'/disable',{})).status,200);
 assert.equal((await operation(f,job,'result',{ok:true,result:result()})).status,200);
 const saved=await row(job.id);assert.equal(saved.status,'cancelled');assert.equal(saved.result,null);assert.deepEqual(saved.late_result.result.execution,execution);
 await assert.rejects(f.service.wait(job.id),{code:'LOCAL_OPERATION_CANCELLED',notExecuted:false});
 assert.equal((await post(f.device,f.device.id+'/poll',{})).data.code,'LOCAL_DEVICE_DENIED');
 const exposed:any[]=await (await fetch(url+'/runs/'+f.runId+'/local-operations')).json();assert.deepEqual(exposed[0].lateResult.execution,execution);
});


test('only an approved task opt-in adds the trusted confinement profile to test operations',opts,async()=>{
 const f=await fixture(),args={command:'node --test unit.mjs',expectedWorkspaceRevision:'f'.repeat(64)},ctx={...context(),approvalId:randomUUID()};
 await pool.query("INSERT INTO tool_approvals(id,run_id,agent_id,tool,arguments,status) VALUES($1,$2,$3,'terminal_test',$4,'approved')",[ctx.approvalId,f.runId,employee.id,args]);
 let id=await f.service.enqueue(f.runId,'terminal_test',args,ctx);assert.equal((await row(id)).payload.verificationProfile,undefined);
 f.snapshot.tasks[0].verificationReuse='same-workspace';f.snapshot.tasks[0].verify=[args.command];
 await pool.query('UPDATE project_runs SET snapshot=$1 WHERE id=$2',[f.snapshot,f.runId]);
 ctx.approvalId=randomUUID();await pool.query("INSERT INTO tool_approvals(id,run_id,agent_id,tool,arguments,status) VALUES($1,$2,$3,'terminal_test',$4,'approved')",[ctx.approvalId,f.runId,employee.id,args]);
 id=await f.service.enqueue(f.runId,'terminal_test',args,ctx);assert.equal((await row(id)).payload.verificationProfile,'node-permission-workspace-v1');
 assert.deepEqual((await row(id)).payload.arguments,args);
});
