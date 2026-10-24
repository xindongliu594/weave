import {before,after,beforeEach,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {once} from 'node:events';
import express from 'express';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import type pg from 'pg';
import {createArchiveWriterManager} from '../services/agent-runtime/archive-writer-scope.mjs';
import {effectDigest} from '../services/agent-runtime/tool-effects.mjs';
import type {EffectContract} from '../packages/contracts/tool-effects.ts';

assert.equal(process.env.SIMULATED_INTEGRATION,'pglite','Use the isolated integration runner');
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222';
const contract:EffectContract={schema:1,capabilityId:'team.status',namespace:'weiwu',toolName:'agent_teams_status',source:{kind:'builtin',reference:'fixture:release',version:'1',digest:'a'.repeat(64)},definitionSha256:'a'.repeat(64),effect:'workspace',isolationProfile:'runtime-v1',permissions:['team:status'],retry:'never',cost:{kind:'free'},reconciliation:{kind:'receipt'},compensation:{kind:'none',requiresApproval:true},evidenceRefs:['fixture:review']};
let db:pg.Pool,root:string,writers:ReturnType<typeof createArchiveWriterManager>,coordinator:import('../apps/api/src/run-coordinator.ts').RunCoordinator,service:import('../apps/api/src/tool-operations.ts').ToolOperationService;
const admin={kind:'human' as const,userId:'admin',sessionId:'expired-browser-session',issuer:'https://fixture.example',subject:'admin',orgRole:'admin' as const,sessionEpoch:0,authenticatedAt:new Date(0).toISOString()};
const modelData={name:'Fixture',gatewayId:'gateway',model:'fixture',inputRate:1,outputRate:1};
const prepare=()=>({contract,agentId:'agent-0',sessionId:'runtime-session',callId:randomUUID(),argumentsSha256:effectDigest({})});
async function run(departments=[A],kind:string|null='human',tools:string[]=[]){
 const id=randomUUID(),projectId=randomUUID(),agents=departments.map((department,index)=>({id:'agent-'+index,employeeId:'worker-'+index,name:'Fixture',role:index===0?'manager':'worker',modelId:'model',tools,knowledgeSpaceIds:[],sourceDepartmentId:department,sourceAgentId:'worker'}));
 const policy={maxBudget:10,maxAgents:2,maxConcurrentAgents:1,maxModelCalls:20,maxTaskModelCalls:20,deadlineSeconds:300,allowedModelIds:['model'],allowedTools:tools,allowedKnowledgeSpaceIds:[],allowedDepartmentIds:departments};
 const plan={agents,tasks:[]};
 const {routeFingerprint}=await import('../apps/api/src/model-capabilities.ts');
 const model=(await db.query("SELECT m.data,g.version FROM models m JOIN gateways g ON g.id=m.data->>'gatewayId' WHERE m.id='model'")).rows[0];
 const snapshot={projectId,planVersion:1,departmentId:A,departmentIds:departments,executionProfile:'legacy-run-v1',agents,tasks:[],policy,executionBudget:10,departmentBudgets:Object.fromEntries(departments.map(d=>[d,10])),effectContractVersion:1,effectContracts:[contract],modelRoutes:[{id:'model',...model.data,configurationHash:routeFingerprint(model.data,model.version)}]};
 await db.query("INSERT INTO projects(id,department_id,department_version,department_name,requirement,policy,plan,source) VALUES($1,$2,1,'Fixture','Current authority',$3,$4,'manual')",[projectId,A,policy,plan]);
 await db.query('INSERT INTO plan_versions(project_id,version,plan,policy) VALUES($1,1,$2,$3)',[projectId,plan,policy]);
 await db.query(`INSERT INTO project_runs(id,project_id,project_version,status,snapshot,lease_owner,lease_until,department_ids,authorized_by_user_id,authorized_epoch,authority_kind,authority_department_ids,source_bounds)
 VALUES($1,$2,1,'running',$3,$4,now()+interval '1 hour',$5,$6,$7,$8,$5,$9)`,[id,projectId,snapshot,coordinator.owner,departments,kind==='human'?'member':null,kind==='human'?0:null,kind,{requiredDepartmentIds:departments,adminOnly:false,private:false,refs:[]}]);
 return {id,projectId,ops:service.forRun(id,coordinator.owner)};
}
const reserve=(runId:string,id=randomUUID())=>coordinator.reserve(runId,{id,modelId:'model',agentId:'agent-0',reservation:.01}).then(()=>id);
test('static application import does not eagerly evaluate the provider through an authority class cycle',()=>{
 const result=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',"import './apps/api/src/backup-restore-state.ts'; import {createApp} from './apps/api/src/app.ts'; console.log(typeof createApp);"],{encoding:'utf8',timeout:20000});
 assert.equal(result.status,0,result.stderr);assert.equal(result.stdout.trim(),'function');
});
before(async()=>{
 root=await mkdtemp(join(tmpdir(),'weiwu-authority-fixture-'));process.env.DATA_DIR=root;process.env.TRACE_ROOT=join(root,'runs');process.env.OBSIDIAN_VAULT=join(root,'vault');
 const database=await import('../apps/api/src/db.ts');db=database.pool;await database.migrate();writers=createArchiveWriterManager({traceRoot:process.env.TRACE_ROOT});
 const {RunCoordinator}=await import('../apps/api/src/run-coordinator.ts');coordinator=new RunCoordinator(process.env.TRACE_ROOT,writers);await coordinator.close();
 const {ToolEffectContractService}=await import('../apps/api/src/tool-effect-contracts.ts'),{ToolOperationService}=await import('../apps/api/src/tool-operations.ts');
 const contracts=new ToolEffectContractService({db,resolveBinding:async()=>contract});service=new ToolOperationService({db,writers,contracts});
 await db.query("INSERT INTO human_users(id,issuer,subject,status,org_role) VALUES('admin','https://fixture.example','admin','active','admin')");await contracts.review({namespace:contract.namespace,toolName:contract.toolName},effectDigest(contract),admin);
});
after(async()=>{if(coordinator){coordinator.stopped=true;clearInterval(coordinator.timer);}await db?.end();if(root){assert.ok(root.startsWith(resolve(tmpdir())+sep+'weiwu-authority-fixture-'));await rm(root,{recursive:true,force:true});}});
beforeEach(async()=>{
 process.env.WEIWU_AUTH_MODE='legacy-local';
 await db.query('TRUNCATE departments,models,gateways CASCADE');await db.query("DELETE FROM human_users WHERE id='member'");
 await db.query("INSERT INTO human_users(id,issuer,subject,status,org_role) VALUES('member','https://fixture.example','member','active','member')");
 await db.query('INSERT INTO departments(id,data) VALUES($1,$2),($3,$4)',[A,{name:'A',dailyBudget:100,agents:[{id:'worker',tools:['knowledge_search','knowledge_read']}]},B,{name:'B',dailyBudget:100,agents:[{id:'worker',tools:['knowledge_search','knowledge_read']}]}]);
 await db.query("INSERT INTO department_memberships(user_id,department_id,role,can_approve) VALUES('member',$1,'operator',true),('member',$2,'operator',true)",[A,B]);
 await db.query('INSERT INTO gateways(id,data) VALUES($1,$2)',['gateway',{name:'Fixture',baseUrl:'http://127.0.0.1:1/v1'}]);await db.query("INSERT INTO models(id,data,status,capabilities) VALUES('model',$1,'available',$2)",[modelData,{tools:{status:'supported'}}]);
});

test('real reservation and C1 dispatch survive absent browser sessions, then epoch alone stops the next effects',async()=>{
 const r=await run([A,B]);assert.equal(Number((await db.query('SELECT count(*) n FROM human_sessions')).rows[0].n),0);
 const oldReceipt=await reserve(r.id),prepared=await r.ops.prepare(prepare());await r.ops.dispatch({operationId:prepared.operationId,expectedVersion:prepared.version,intentSha256:prepared.intentSha256});
 const waiting=await r.ops.prepare(prepare());await db.query("UPDATE human_users SET session_epoch=1 WHERE id='member'");
 await assert.rejects(reserve(r.id),{code:'RUN_AUTHORITY_REVOKED'});
 await assert.rejects(r.ops.prepare(prepare()),{code:'RUN_AUTHORITY_REVOKED'});
 await assert.rejects(r.ops.dispatch({operationId:waiting.operationId,expectedVersion:waiting.version,intentSha256:waiting.intentSha256}),{code:'RUN_AUTHORITY_REVOKED'});
 assert.equal(Number((await db.query('SELECT count(*) n FROM model_reservations WHERE run_id=$1',[r.id])).rows[0].n),1);
 assert.equal((await db.query('SELECT status FROM model_reservations WHERE id=$1',[oldReceipt])).rows[0].status,'pending');
 // Existing evidence remains admissible: this cannot admit another execution.
 await r.ops.markUnknown({operationId:prepared.operationId,intentSha256:prepared.intentSha256,reasonCode:'RECEIPT_DELAYED'});
 const evidence={evidenceId:randomUUID(),outcome:'confirmed' as const,receiptSha256:effectDigest({ok:true}),reasonCode:'ORIGINAL_RECEIPT'};
 await r.ops.recordEvidence({operationId:prepared.operationId,intentSha256:prepared.intentSha256,evidence});await r.ops.recordEvidence({operationId:prepared.operationId,intentSha256:prepared.intentSha256,evidence});
 assert.equal((await db.query('SELECT effect_state,jsonb_array_length(evidence_records) n FROM local_operations WHERE id=$1',[prepared.operationId])).rows[0].n,2);
 await r.ops.abortPrepared({operationId:waiting.operationId,expectedVersion:waiting.version,intentSha256:waiting.intentSha256});
 const denied=(await db.query("SELECT canonical_payload FROM human_audit_events WHERE run_id=$1 AND action='run.authority' AND outcome='denied'",[r.id])).rows;
 assert.deepEqual(denied.map(x=>x.canonical_payload.changes.effect).sort(),['model','tool','tool']);
 assert.ok(denied.every(x=>x.canonical_payload.actor.kind==='system'&&x.canonical_payload.changes.authorizedEpoch===0));
});

test('disabled authorizer and loss of a collaborating department stop C1 before creating an intent',async()=>{
 for(const sql of ["UPDATE human_users SET status='disabled' WHERE id='member'","DELETE FROM department_memberships WHERE user_id='member' AND department_id='"+B+"'"]){
  await db.query("UPDATE human_users SET status='active' WHERE id='member'");const r=await run([A,B]);await db.query(sql);
  await assert.rejects(r.ops.prepare(prepare()),{code:'RUN_AUTHORITY_REVOKED'});assert.equal(Number((await db.query('SELECT count(*) n FROM local_operations WHERE run_id=$1',[r.id])).rows[0].n),0);
 }
});

test('withdrawn employee tool grant blocks the next actual C1 admission without changing its fixed snapshot',async()=>{
 const r=await run([A,B],'human',['knowledge_search']);await r.ops.prepare(prepare());
 const before=(await db.query('SELECT snapshot FROM project_runs WHERE id=$1',[r.id])).rows[0].snapshot;
 await db.query("UPDATE departments SET data=jsonb_set(data,'{agents,0,tools}','[]'::jsonb) WHERE id=$1",[B]);
 await assert.rejects(r.ops.prepare(prepare()),{code:'RUN_AUTHORITY_REVOKED'});
 assert.deepEqual((await db.query('SELECT snapshot FROM project_runs WHERE id=$1',[r.id])).rows[0].snapshot,before);
 assert.equal(Number((await db.query('SELECT count(*) n FROM local_operations WHERE run_id=$1',[r.id])).rows[0].n),1);
});

test('enterprise rejects unbound old authority without backfill while legacy-local preserves its existing path',async()=>{
 const r=await run([A],null);process.env.WEIWU_AUTH_MODE='oidc';await assert.rejects(r.ops.prepare(prepare()),{code:'RUN_AUTHORITY_REVOKED'});
 assert.equal((await db.query('SELECT authorized_epoch FROM project_runs WHERE id=$1',[r.id])).rows[0].authorized_epoch,null);
 process.env.WEIWU_AUTH_MODE='legacy-local';assert.equal((await r.ops.prepare(prepare())).state,'prepared');
});

test('paused coordinator admits no background work until one explicit start and close prevents revival',async()=>{
 const original=db.query;let queries=0;
 db.query=function(...args:unknown[]){queries++;return (original as Function).apply(db,args);} as typeof db.query;
 const {RunCoordinator}=await import('../apps/api/src/run-coordinator.ts');let paused:InstanceType<typeof RunCoordinator>|undefined;
 try{
  paused=new RunCoordinator(process.env.TRACE_ROOT!,writers,undefined,{startPaused:true} as any);
  await new Promise(resolve=>setImmediate(resolve));assert.equal(queries,0,'paused construction must not start recovery, heartbeat or dispatch');
  paused.start();const timer=paused.timer;paused.start();assert.equal(paused.timer,timer,'start is idempotent');
  await paused.close();assert.ok(queries>0,'explicit start reaches the original worker SQL');
  const closedQueries=queries;paused.start();await new Promise(resolve=>setImmediate(resolve));assert.equal(queries,closedQueries,'closed workers never restart');assert.equal(paused.timer,undefined);
 }finally{await paused?.close();db.query=original;}
});

test('actual coordinator and independent employee Hosts await current authority before registered tool bodies',async()=>{
 const r=await run([A,B],'human',['knowledge_search']),runtimeRequire=createRequire(new URL('../services/agent-runtime/package.json',import.meta.url));
 const {LlmAdapter}=await import(pathToFileURL(runtimeRequire.resolve('@deepseek-ai/dsh-llm')).href),{createTeamHost}=await import(new URL('../services/agent-runtime/host.mjs',import.meta.url).href),{Semaphore}=await import(new URL('../services/agent-runtime/limits.mjs',import.meta.url).href),{createRunArchive}=await import('../services/agent-runtime/trace-store.mjs');
 const fixed=(await db.query('SELECT snapshot FROM project_runs WHERE id=$1',[r.id])).rows[0].snapshot;
 const snapshot={...fixed,effectContractVersion:undefined,effectContracts:undefined,knowledge:{'agent-0':[],'agent-1':[]}};let bodyReads=0,host:any;
 const adapter=new class extends LlmAdapter{providerInfo(){return {id:'fixture',name:'fixture'};}async resolveModel(){return {provider:'fixture',id:'test',name:'test'};}async *stream(){throw Error('No model calls permitted');}}();
 try{
  host=await createTeamHost({adapter,provider:'fixture',sessionRoot:join(root,r.id,'sessions'),archive:createRunArchive(join(root,'hosts'),snapshot,{id:r.id}),product:{snapshot,gate:new Semaphore(1),
   beforeTool:(signal?:AbortSignal)=>coordinator.authorizeEffect(r.id,'tool',signal),beforeKnowledge:(signal?:AbortSignal)=>coordinator.authorizeEffect(r.id,'knowledge',signal),queryKnowledge:async()=>{bodyReads++;return [];}}});
  const captain=await host.captain({cwd:root,model:'test'}),child=await host.ctx.agents.create({sessionId:randomUUID(),parentAgent:captain,meta:{cwd:root,parentSession:captain.id},agentOptions:{provider:'fixture',model:'test'},setup(_ctx:any,agent:any){agent.session.append('subagent/descriptor',{version:3,mode:'continuable',provider:'spawn',label:'fixture:agent-1',agentProvider:'fixture',agentModel:'test'});}});
  assert.equal((await host.ctx.tools.execute({name:'knowledge_search',arguments:{query:'baseline'},callId:randomUUID(),agent:captain,signal:AbortSignal.timeout(5000)})).isError,false);
  assert.equal((await child.agent.ctx.tools.execute({name:'capability_search',arguments:{query:'baseline'},callId:randomUUID(),agent:child.agent,signal:AbortSignal.timeout(5000)})).isError,false);assert.equal(bodyReads,2);
  await db.query("UPDATE human_users SET session_epoch=1 WHERE id='member'");
  for(const [ctx,agent,name] of [[host.ctx,captain,'knowledge_search'],[child.agent.ctx,child.agent,'capability_search']] as const){
   const result=await ctx.tools.execute({name,arguments:{query:'denied'},callId:randomUUID(),agent,signal:AbortSignal.timeout(5000)});assert.equal(result.isError,true);assert.match(result.error.message,/运行原批准/);
  }
  assert.equal(bodyReads,2,'neither main registry nor employee-local registered tool reaches the body after revocation');
 }finally{await host?.close();}
});

test('device start rejects a revoked authorizer while the original authenticated late receipt is preserved',async()=>{
 const r=await run(),device=randomUUID(),grant=randomUUID(),token='a'.repeat(64),first=randomUUID(),next=randomUUID();
 await db.query('INSERT INTO local_devices(id,token_hash,name,platform,grant_id,label) VALUES($1,$2,$3,$4,$5,$6)',[device,createHash('sha256').update(token).digest('hex'),'Fixture',process.platform,grant,'fixture']);
 const target={kind:'local',deviceId:device,grantId:grant},snapshot=(await db.query('SELECT snapshot FROM project_runs WHERE id=$1',[r.id])).rows[0].snapshot;
 snapshot.policy.executionTarget=target;snapshot.executionTarget={...target,platform:process.platform};
 await db.query('UPDATE project_runs SET snapshot=$2 WHERE id=$1',[r.id,snapshot]);await db.query('UPDATE projects SET policy=$2 WHERE id=$1',[r.projectId,snapshot.policy]);
 const insert=async(id:string)=>db.query("INSERT INTO local_operations(id,device_id,run_id,grant_id,lease_owner,payload) VALUES($1,$2,$3,$4,$5,$6)",[id,device,r.id,grant,coordinator.owner,{runId:r.id,deviceId:device,grantId:grant,name:'filesystem',arguments:{path:'fixture.txt'},context:{agentId:'agent-0'}}]);await insert(first);
 const {localDeviceRouter}=await import('../apps/api/src/local-execution.ts'),app=express();app.use(express.json());app.use(localDeviceRouter(process.env.TRACE_ROOT!,writers));app.use((error:any,_req:any,res:any,_next:any)=>res.status(error.status??500).json({code:error.code}));
 const server=app.listen(0,'127.0.0.1');await once(server,'listening');const url='http://127.0.0.1:'+(server.address() as any).port;
 const post=async(path:string,body:unknown)=>{const response=await fetch(url+'/local-devices/'+device+path,{method:'POST',headers:{'content-type':'application/json','x-local-device-key':token},body:JSON.stringify(body)});return {status:response.status,data:await response.json() as any};};
 try{
  const claim=await post('/poll',{});assert.equal(claim.status,200);assert.equal(claim.data.job.id,first);const proof={claimToken:claim.data.job.claimToken};
  assert.equal((await post('/operations/'+first+'/start',proof)).status,200);
  await insert(next);await db.query("UPDATE human_users SET session_epoch=1 WHERE id='member'");
  const late={...proof,ok:false,error:{code:'EXECUTION_INTERRUPTED',message:'original result',notExecuted:false}};
  assert.equal((await post('/operations/'+first+'/result',late)).status,200,'revocation must not discard original device evidence');
  const row=(await db.query('SELECT status,result,late_result,started FROM local_operations WHERE id=$1',[first])).rows[0];assert.equal(row.result,null);assert.deepEqual(row.late_result,late);assert.equal(row.started,true);
  const pending=await post('/poll',{});assert.equal(pending.status,200);assert.equal(pending.data.job,null);assert.equal((await db.query('SELECT status FROM local_operations WHERE id=$1',[next])).rows[0].status,'cancelled');
  assert.equal((await post('/operations/'+first+'/start',proof)).status,409,'completed/unknown original is never restarted');
  assert.ok(Number((await db.query("SELECT count(*) n FROM human_audit_events WHERE run_id=$1 AND action='run.authority' AND outcome='denied'",[r.id])).rows[0].n)>=1);
 }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test('worker tick durably pauses revoked queued work before claiming a running lease',async()=>{
 const r=await run();await db.query("UPDATE project_runs SET status='queued',lease_owner=NULL,lease_until=NULL WHERE id=$1",[r.id]);await db.query("UPDATE human_users SET session_epoch=1 WHERE id='member'");
 const {RunCoordinator}=await import('../apps/api/src/run-coordinator.ts'),worker=new RunCoordinator(process.env.TRACE_ROOT!,writers,undefined,{startPaused:true});
 try{await worker.tick();await worker.close();const row=(await db.query('SELECT status,lease_owner FROM project_runs WHERE id=$1',[r.id])).rows[0];assert.equal(row.status,'interrupted');assert.equal(row.lease_owner,null);
  assert.equal(Number((await db.query("SELECT count(*) n FROM human_audit_events WHERE run_id=$1 AND action='run.authority' AND outcome='denied'",[r.id])).rows[0].n),1);
 }finally{await worker.close();}
});

test('runtime approval callback cannot create a new request under revoked authority',async()=>{
 const r=await run(),{createRunArchive}=await import('../services/agent-runtime/trace-store.mjs');createRunArchive(process.env.TRACE_ROOT!,(await db.query('SELECT snapshot FROM project_runs WHERE id=$1',[r.id])).rows[0].snapshot,{id:r.id});await db.query("UPDATE human_users SET session_epoch=1 WHERE id='member'");
 const error=await writers.withWriter([r.id],async()=>{try{await coordinator.approveTool({runId:r.id,agentId:'agent-0',tool:'terminal',arguments:{command:'never'}},AbortSignal.timeout(500));return null;}catch(error){return error;}});
 assert.equal((error as any)?.code,'RUN_AUTHORITY_REVOKED');assert.equal(Number((await db.query('SELECT count(*) n FROM tool_approvals WHERE run_id=$1',[r.id])).rows[0].n),0);
});

test('retry HTTP rechecks original authority before its existing child and before a successful idempotency cache',async()=>{
 const r=await run(),child=randomUUID();await db.query("UPDATE project_runs SET status='interrupted' WHERE id=$1",[r.id]);
 await db.query("INSERT INTO project_runs(id,project_id,project_version,attempt,parent_run_id,status,snapshot,department_ids) SELECT $1,project_id,project_version,2,id,'interrupted',snapshot,department_ids FROM project_runs WHERE id=$2",[child,r.id]);
 const {runManagementRouter}=await import('../apps/api/src/run-management.ts'),{apiAccess}=await import('../apps/api/src/api-access.ts'),{idempotency}=await import('../apps/api/src/idempotency.ts');
 let revokeAfterAdmission=false;
 const app=express();app.use(express.json());app.use('/api',apiAccess({authenticate:async()=>admin,csrf:(_req:any,_res:any,next:any)=>next()} as any,{mode:'legacy-local'}),(_req,_res,next)=>{
  if(!revokeAfterAdmission){next();return;}
  void db.query("UPDATE human_users SET session_epoch=1 WHERE id='member'").then(()=>next(),next);
 },idempotency,runManagementRouter(process.env.TRACE_ROOT!,writers));app.use((error:any,_req:any,res:any,_next:any)=>res.status(error.status??500).json({code:error.code}));
 const server=app.listen(0,'127.0.0.1');await once(server,'listening');const url='http://127.0.0.1:'+(server.address() as any).port;
 const post=async(key:string)=>{const response=await fetch(url+'/api/runs/'+r.id+'/retry',{method:'POST',headers:{'content-type':'application/json','idempotency-key':key},body:JSON.stringify({resume:false})});return {status:response.status,data:await response.json() as any};};
 try{assert.equal((await post('current-retry-cache')).status,200);await db.query("UPDATE human_users SET session_epoch=1 WHERE id='member'");
  const cached=await post('current-retry-cache');assert.equal(cached.status,403);assert.equal(cached.data.code,'RUN_AUTHORITY_REVOKED');
  assert.equal((await post('current-retry-new')).status,403);assert.equal(Number((await db.query('SELECT count(*) n FROM project_runs WHERE project_id=$1',[r.projectId])).rows[0].n),2);
  assert.equal(Number((await db.query('SELECT authorized_epoch FROM project_runs WHERE id=$1',[r.id])).rows[0].authorized_epoch),0);
  await db.query("UPDATE human_users SET session_epoch=0 WHERE id='member'");revokeAfterAdmission=true;
  const raced=await post('current-retry-race');assert.equal(raced.status,403);assert.equal(raced.data.code,'RUN_AUTHORITY_REVOKED');
  assert.equal(Number((await db.query('SELECT count(*) n FROM project_runs WHERE project_id=$1',[r.projectId])).rows[0].n),2,'transaction rechecks revocation after middleware admission');
 }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
