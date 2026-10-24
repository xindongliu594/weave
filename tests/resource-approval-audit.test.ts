import {after,before,beforeEach,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {join,resolve,sep} from 'node:path';
import {tmpdir} from 'node:os';
import express from 'express';
import type pg from 'pg';
import {createRunArchive,readRun} from '../services/agent-runtime/trace-store.mjs';
import {createArchiveWriterManager} from '../services/agent-runtime/archive-writer-scope.mjs';
import type {Principal} from '../apps/api/src/identity-types.ts';

const native=process.env.SIMULATED_INTEGRATION==='resource-postgres';
if(native)(await import('../scripts/test-support/resource-postgres.mjs')).resourcePostgresEnvironment();else assert.equal(process.env.SIMULATED_INTEGRATION,'pglite','Use the isolated integration runner');
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222';
let db:pg.Pool,server:any,gatedServer:any,gatedUrl:string,url:string,temporary:string,traceRoot:string,writers:ReturnType<typeof createArchiveWriterManager>;
const principal=(id:string):Principal=>id==='local'?{kind:'local-owner'}:{kind:'human',userId:id,issuer:'https://fixture.example',subject:id,sessionId:id,orgRole:id==='admin'?'admin':'member',sessionEpoch:0,authenticatedAt:new Date().toISOString()};
async function call(path:string,actor='member',body?:unknown){const r=await fetch(url+path,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json','x-actor':actor},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,data:await r.json() as any};}
async function grant(departmentId:string,role='operator',approve=true){await db.query("INSERT INTO department_memberships(user_id,department_id,role,can_approve) VALUES('member',$1,$2,$3) ON CONFLICT(user_id,department_id) DO UPDATE SET role=$2,can_approve=$3,version=department_memberships.version+1",[departmentId,role,approve]);}
async function run(departments=[A],status='running'){
 const projectId=randomUUID(),id=randomUUID(),approvalId=randomUUID(),agents=departments.map((departmentId,index)=>({id:'agent-'+index,sourceDepartmentId:departmentId,sourceAgentId:'worker'}));
 const policy={allowedDepartmentIds:departments},plan={agents},snapshot={mode:'product',projectId,planVersion:1,departmentId:departments[0],executionBudget:1,departmentBudgets:Object.fromEntries(departments.map(d=>[d,1])),agents};
 await db.query("INSERT INTO projects(id,department_id,department_version,department_name,requirement,policy,plan,source) VALUES($1,$2,1,'Fixture','Synthetic approval',$3,$4,'manual')",[projectId,departments[0],policy,plan]);
 await db.query('INSERT INTO plan_versions(project_id,version,plan,policy) VALUES($1,1,$2,$3)',[projectId,plan,policy]);
 await db.query("INSERT INTO project_runs(id,project_id,project_version,status,snapshot,department_ids,authority_kind,source_bounds) VALUES($1,$2,1,$3,$4,$5,'human',$6)",[id,projectId,status,snapshot,departments,{requiredDepartmentIds:departments,adminOnly:false,private:false,refs:[]}]);
 await db.query("INSERT INTO tool_approvals(id,run_id,agent_id,tool,arguments) VALUES($1,$2,'agent-0','fixture-tool',$3)",[approvalId,id,{privateArgument:'NEVER_IN_AUDIT'}]);
 createRunArchive(traceRoot,snapshot,{id});return {id,projectId,approvalId};
}
async function receipt(r:Awaited<ReturnType<typeof run>>,departmentId:string|null,cost:number,extra:{projectId?:string|null;runId?:string|null;pair?:boolean}={}){
 const id=randomUUID(),projectId=Object.hasOwn(extra,'projectId')?extra.projectId:r.projectId,runId=Object.hasOwn(extra,'runId')?extra.runId:r.id;
 await db.query("INSERT INTO usage(id,model_id,project_id,run_id,department_id,input_tokens,output_tokens,cost,purpose) VALUES($1,'model',$2,$3,$4,0,0,$5,'fixture')",[id,projectId,runId,departmentId,cost]);
 if(extra.pair)await db.query("INSERT INTO model_reservations(id,model_id,project_id,run_id,department_id,purpose,amount,input_rate,output_rate,status,context) VALUES($1,'model',$2,$3,$4,'fixture',$5,1,1,'settled',$6)",[id,projectId,runId,departmentId,cost,{providerRequestId:'SECRET_UPSTREAM'}]);return id;
}
function interceptQueries(intercept:(sql:string,values:any[],phase:'before'|'after')=>void|Promise<void>,onRelease?:(discard:boolean)=>void){
 const connect=db.connect;
 (db as any).connect=function(callback?:unknown){if(callback)return (connect as any).call(db,callback);return (async()=>{const client=await (connect as ()=>Promise<pg.PoolClient>).call(db),query=client.query,release=client.release;
  client.query=async function(sql:any,values?:any){await intercept(String(sql),values??[],'before');const result=await (query as any).call(client,sql,values);await intercept(String(sql),values??[],'after');return result;} as any;
  client.release=function(...args:any[]){onRelease?.(!!args[0]);client.query=query;client.release=release;return (release as any).apply(client,args);};return client;})();};return ()=>{db.connect=connect;};
}
before(async()=>{
 temporary=await mkdtemp(join(tmpdir(),'weiwu-approval-fixture-'));traceRoot=join(temporary,'runs');process.env.DATA_DIR=temporary;process.env.TRACE_ROOT=traceRoot;process.env.OBSIDIAN_VAULT=join(temporary,'vault');
 const database=await import('../apps/api/src/db.ts');db=database.pool;if(native)await (await import('./fixtures/resource-database.ts')).migrateResourceFixture(db);else await database.migrate();
 // During RED the additive migration does not exist; observable decision/audit assertions still run.
 if(existsSync(resolve('apps/api/src/human-audit.ts')))await (await import('../apps/api/src/human-audit.ts')).migrateHumanApprovals(db);
 const {runManagementRouter}=await import('../apps/api/src/run-management.ts'),{costRouter}=await import('../apps/api/src/cost-router.ts');
 writers=createArchiveWriterManager({traceRoot});const app=express();app.use(express.json());app.use((req,res,next)=>{res.locals.principal=principal(req.get('x-actor')??'member');next();});
 app.use('/api',runManagementRouter(traceRoot,writers));app.use('/api',costRouter());
 app.use((error:any,_req:any,res:any,_next:any)=>res.status(error.name==='ZodError'?422:error.status??500).json({code:error.code??'FAILED'}));
 const {apiAccess}=await import('../apps/api/src/api-access.ts'),{idempotency}=await import('../apps/api/src/idempotency.ts');
 const gated=express();gated.use(express.json());gated.use('/api',apiAccess({authenticate:async(req:any)=>principal(req.get('x-actor')??'member'),csrf:(_req:any,_res:any,next:any)=>next()} as any,{mode:'legacy-local'}),idempotency,runManagementRouter(traceRoot,writers),costRouter());
 gated.use((error:any,_req:any,res:any,_next:any)=>res.status(error.name==='ZodError'?422:error.status??500).json({code:error.code??'FAILED'}));
 gatedServer=gated.listen(0,'127.0.0.1');await once(gatedServer,'listening');gatedUrl=`http://127.0.0.1:${gatedServer.address().port}/api`;
 server=app.listen(0,'127.0.0.1');await once(server,'listening');url=`http://127.0.0.1:${server.address().port}/api`;
});
after(async()=>{gatedServer?.closeAllConnections();if(gatedServer)await new Promise<void>(r=>gatedServer.close(r));server?.closeAllConnections();if(server)await new Promise<void>(r=>server.close(r));await db?.end();if(temporary){assert.ok(temporary.startsWith(resolve(tmpdir())+sep+'weiwu-approval-fixture-'));await rm(temporary,{recursive:true,force:true});}});
beforeEach(async()=>{
 await db.query('TRUNCATE departments,human_users,models,gateways CASCADE');
 await db.query("INSERT INTO gateways(id,data) VALUES('gateway','{}'); INSERT INTO models(id,data) VALUES('model','{}')");
 await db.query('INSERT INTO departments(id,data) VALUES($1,$2),($3,$4)',[A,{name:'A',dailyBudget:10},B,{name:'B',dailyBudget:20}]);
 for(const user of ['member','admin'])await db.query("INSERT INTO human_users(id,issuer,subject,status,org_role) VALUES($1,'https://fixture.example',$1,'active',$2)",[user,user==='admin'?'admin':'member']);await grant(A);
});

test('approval requires operator or manager with approval permission in every fixed department',async()=>{
 await grant(B,'operator',false);let r=await run([A,B]);assert.equal((await call('/approvals/'+r.approvalId,'member',{decision:'approved'})).status,404);
 await grant(B,'viewer',true);r=await run([A,B]);assert.equal((await call('/approvals/'+r.approvalId,'member',{decision:'approved'})).status,404);
 await grant(B,'manager',true);r=await run([A,B]);assert.equal((await call('/approvals/'+r.approvalId,'member',{decision:'approved'})).status,200);
 const row=(await db.query('SELECT to_jsonb(a) data FROM tool_approvals a WHERE id=$1',[r.approvalId])).rows[0].data;
 assert.equal(row.decided_by_user_id,'member');assert.equal(Number(row.decided_epoch),0);assert.equal(row.decision_actor_kind,'human');
 const audit=(await db.query("SELECT * FROM human_audit_events WHERE id=$1",[row.decision_audit_id])).rows[0];assert.equal(audit.actor_user_id,'member');assert.equal(audit.run_id,r.id);assert.deepEqual(audit.authority_evidence.departmentIds,[A,B]);assert.equal(audit.canonical_payload.correlation.requestId,row.decision_request_id);
 assert.equal(JSON.stringify(audit).includes('NEVER_IN_AUDIT'),false);assert.equal(Number((await db.query('SELECT count(*) n FROM audit_run_projection WHERE audit_event_id=$1',[audit.id])).rows[0].n),1);
});
test('revoked epoch, inactive run and repeated decisions do not commit another approval',async()=>{
 let r=await run();await db.query("UPDATE human_users SET session_epoch=1 WHERE id='member'");assert.equal((await call('/approvals/'+r.approvalId,'member',{decision:'approved'})).status,404);
 await db.query("UPDATE human_users SET session_epoch=0 WHERE id='member'");await db.query('UPDATE project_runs SET cancel_requested=true WHERE id=$1',[r.id]);assert.equal((await call('/approvals/'+r.approvalId,'member',{decision:'approved'})).status,409);
 r=await run();assert.equal((await call('/approvals/'+r.approvalId,'member',{decision:'denied'})).status,200);assert.equal((await call('/approvals/'+r.approvalId,'member',{decision:'approved'})).status,409);
 assert.equal(Number((await db.query("SELECT count(*) n FROM human_audit_events WHERE resource_id=$1 AND outcome='success'",[r.approvalId])).rows[0].n),1);
});
test('forged body identity is rejected; legacy NULL is unchanged and local-owner is explicit',async()=>{
 const r=await run();assert.equal((await call('/approvals/'+r.approvalId,'member',{decision:'approved',actor:'admin',sessionEpoch:999})).status,422);
 const legacy=randomUUID();await db.query("INSERT INTO tool_approvals(id,run_id,agent_id,tool,arguments,status) VALUES($1,$2,'a','t','{}','approved')",[legacy,r.id]);
 assert.equal((await call('/approvals/'+r.approvalId,'local',{decision:'denied'})).status,200);
 const rows=(await db.query('SELECT id,to_jsonb(a) data FROM tool_approvals a WHERE id=ANY($1::text[])',[[legacy,r.approvalId]])).rows;
 assert.equal(rows.find(v=>v.id===legacy).data.decided_by_user_id??null,null);assert.equal(rows.find(v=>v.id===r.approvalId).data.decision_actor_kind,'local-owner');assert.equal(rows.find(v=>v.id===r.approvalId).data.decided_by_user_id,null);
});
test('audit insert failure rolls back approval and separately records failure without writing active JSONL',async()=>{
 const r=await run(),before=JSON.stringify(readRun(traceRoot,r.id));let failed=false;
 const restore=interceptQueries(sql=>{if(!failed&&sql.includes('INSERT INTO human_audit_events')){failed=true;throw Error('synthetic audit unavailable');}});
 try{assert.equal((await call('/approvals/'+r.approvalId,'member',{decision:'approved'})).status,500);}finally{restore();}
 assert.equal((await db.query('SELECT status FROM tool_approvals WHERE id=$1',[r.approvalId])).rows[0].status,'pending');assert.equal(JSON.stringify(readRun(traceRoot,r.id)),before);
 assert.equal(Number((await db.query("SELECT count(*) n FROM human_audit_events WHERE resource_id=$1 AND outcome='failure'",[r.approvalId])).rows[0].n),1);
});
test('failed projection leaves a committed decision and retryable outbox; retry does not reapprove or touch JSONL',async()=>{
 const r=await run(),before=JSON.stringify(readRun(traceRoot,r.id));const restore=interceptQueries(sql=>{if(sql.startsWith('INSERT INTO audit_run_projection'))throw Error('synthetic projection failure');});
 try{assert.equal((await call('/approvals/'+r.approvalId,'member',{decision:'approved'})).status,200);}finally{restore();}
 const event=(await db.query("SELECT id FROM human_audit_events WHERE resource_id=$1 AND outcome='success'",[r.approvalId])).rows[0];assert.ok(event);
 assert.equal((await db.query('SELECT published_at FROM audit_outbox WHERE audit_event_id=$1',[event.id])).rows[0].published_at,null);
 await (await import('../apps/api/src/audit-outbox.ts')).projectAuditOutbox(db,{limit:10,now:new Date(Date.now()+60000)});
 assert.equal(Number((await db.query('SELECT count(*) n FROM audit_run_projection WHERE audit_event_id=$1',[event.id])).rows[0].n),1);assert.equal(JSON.stringify(readRun(traceRoot,r.id)),before);
 assert.equal((await call('/approvals/'+r.approvalId,'member',{decision:'denied'})).status,409);
});
test('member costs aggregate only explicit authorized chains and reveal no billing metadata',async()=>{
 const own=await run([A],'completed'),cross=await run([A,B],'completed'),foreign=await run([B],'completed');
 await receipt(own,A,0.2,{pair:true});await receipt(cross,A,3);await receipt(foreign,B,5);await receipt(own,null,7);await receipt(own,A,11,{projectId:foreign.projectId});await receipt(own,A,13,{projectId:null});
 const c=randomUUID();await db.query("INSERT INTO model_reservations(id,model_id,project_id,run_id,department_id,purpose,amount,input_rate,output_rate,status,expires_at) VALUES($1,'model',$2,$3,$4,'fixture',0.4,99,99,'pending',now()-interval '1 day')",[c,own.projectId,own.id,A]);
 const response=await call('/costs');assert.equal(response.status,200);assert.deepEqual(response.data,{timezone:'UTC',departments:[{id:A,spent:0.2,retained:0.4,limit:10}]});
 assert.equal((await db.query('SELECT status FROM model_reservations WHERE id=$1',[c])).rows[0].status,'pending','member read must not run expiry maintenance');
 await grant(B,'viewer');const both=await call('/costs');assert.deepEqual(both.data.departments,[{id:A,spent:3.2,retained:0.4,limit:10},{id:B,spent:5,retained:0,limit:20}]);
});
test('member retained budget respects active visible runs and current identity revocation',async()=>{
 const own=await run(),hidden=await run([A,B]);await receipt(own,A,0.25);await receipt(hidden,A,0.1);
 assert.deepEqual((await call('/costs')).data,{timezone:'UTC',departments:[{id:A,spent:0.25,retained:0.75,limit:10}]});
 await db.query("UPDATE human_users SET session_epoch=1 WHERE id='member'");assert.equal((await call('/costs')).status,404);
});


test('approval SQL enters the shared writer scope and a known authorization rollback leaves it usable',async()=>{
 const r=await run();let first=true;
 const restore=interceptQueries(sql=>{if(first&&sql==='BEGIN'){first=false;writers.assertWriter(r.id);}});
 try{assert.equal((await call('/approvals/'+r.approvalId,'member',{decision:'approved'})).status,200);}finally{restore();}
 const rejected=await run();await grant(A,'viewer',true);
 assert.equal((await call('/approvals/'+rejected.approvalId,'member',{decision:'approved'})).status,404);
 await writers.withWriter([rejected.id],async()=>{writers.assertWriter(rejected.id);assert.equal((await db.query('SELECT status FROM tool_approvals WHERE id=$1',[rejected.approvalId])).rows[0].status,'pending');});
 await writers.withMaintenance([rejected.id],async()=>{writers.assertMaintenance(rejected.id);});
 await grant(A);assert.equal((await call('/approvals/'+rejected.approvalId,'member',{decision:'approved'})).status,200);
});


test('the actual API gate rechecks revoked authority before a cached approval and audits the rejection',async()=>{
 const r=await run(),request=()=>fetch(gatedUrl+'/approvals/'+r.approvalId,{method:'POST',headers:{'content-type':'application/json','idempotency-key':'approval-gate-key','x-actor':'member'},body:JSON.stringify({decision:'approved'})});
 assert.equal((await request()).status,200);await db.query("UPDATE human_users SET session_epoch=1 WHERE id='member'");assert.equal((await request()).status,404);
 assert.equal(Number((await db.query("SELECT count(*) n FROM human_audit_events WHERE resource_id=$1 AND outcome='success'",[r.approvalId])).rows[0].n),1);
 assert.equal(Number((await db.query("SELECT count(*) n FROM human_audit_events WHERE resource_id=$1 AND outcome='denied'",[r.approvalId])).rows[0].n),1);
 assert.equal((await fetch(gatedUrl+'/approvals',{headers:{'x-actor':'member'}})).status,403,'approval discovery remains admin-only in this slice');
});

async function waitForBlocked(pid:number,count:number){
 const deadline=Date.now()+3000;let rows:any[]=[];
 do{const waiting=(await db.query("SELECT pid,pg_blocking_pids(pid) blockers FROM pg_stat_activity WHERE datname=current_database() AND cardinality(pg_blocking_pids(pid))>0")).rows;const reached=new Set([pid]);
  for(let round=0;round<waiting.length;round++)for(const row of waiting)if(row.blockers.some((blocker:number)=>reached.has(blocker)))reached.add(row.pid);
  rows=waiting.filter(row=>reached.has(row.pid));if(rows.length>=count)return rows;await new Promise(r=>setTimeout(r,10));}while(Date.now()<deadline);
 assert.fail(`Expected ${count} blocked independent backends, observed ${rows.length}`);
}
test('native approval waits for revocation and rejects the committed missing collaboration membership',{skip:!native},async()=>{
 await grant(B);const r=await run([A,B]),revoker=await db.connect();let response:Promise<Awaited<ReturnType<typeof call>>>|undefined;
 try{
  await revoker.query('BEGIN');const pid=(await revoker.query('SELECT pg_backend_pid() pid')).rows[0].pid;
  await revoker.query("SELECT id FROM human_users WHERE id='member' FOR UPDATE");await revoker.query("DELETE FROM department_memberships WHERE user_id='member' AND department_id=$1",[B]);
  response=call('/approvals/'+r.approvalId,'member',{decision:'approved'});const blocked=await waitForBlocked(pid,1);assert.ok(blocked.every(row=>row.pid!==pid));
  await revoker.query('COMMIT');assert.equal((await response).status,404);assert.equal((await db.query('SELECT status FROM tool_approvals WHERE id=$1',[r.approvalId])).rows[0].status,'pending');
  assert.equal(Number((await db.query("SELECT count(*) n FROM human_audit_events WHERE resource_id=$1 AND outcome='success'",[r.approvalId])).rows[0].n),0);
  console.log(JSON.stringify({scenario:'approval-revocation',revoker:pid,blocked}));
 }finally{await revoker.query('ROLLBACK').catch(()=>{});revoker.release(true);await response?.catch(()=>{});}
});
test('native simultaneous opposite decisions serialize on the project and commit only one success audit',{skip:!native},async()=>{
 const r=await run(),blocker=await db.connect();let responses:Promise<Awaited<ReturnType<typeof call>>[]>|undefined;
 try{
  await blocker.query('BEGIN');const pid=(await blocker.query('SELECT pg_backend_pid() pid')).rows[0].pid;await blocker.query('SELECT id FROM projects WHERE id=$1 FOR UPDATE',[r.projectId]);
  responses=Promise.all([call('/approvals/'+r.approvalId,'member',{decision:'approved'}),call('/approvals/'+r.approvalId,'member',{decision:'denied'})]);
  const blocked=await waitForBlocked(pid,2);assert.equal(new Set(blocked.map(row=>row.pid)).size,2);await blocker.query('COMMIT');
  assert.deepEqual((await responses).map(r=>r.status).sort(),[200,409]);const audit=(await db.query("SELECT canonical_payload FROM human_audit_events WHERE resource_id=$1 AND outcome='success'",[r.approvalId])).rows;assert.equal(audit.length,1);
  assert.equal((await db.query('SELECT status FROM tool_approvals WHERE id=$1',[r.approvalId])).rows[0].status,audit[0].canonical_payload.changes.decision);
  console.log(JSON.stringify({scenario:'opposite-decisions',blocker:pid,blocked}));
 }finally{await blocker.query('ROLLBACK').catch(()=>{});blocker.release(true);await responses?.catch(()=>{});}
});


for(const fault of ['commit-ack','rollback-ack'] as const)test(`approval ${fault} preserves the first error, discards the client and retains the writer failure fence`,async()=>{
 const r=await run();let injected=false;const releases:boolean[]=[];
 const restore=interceptQueries((sql,_values,phase)=>{
  if(fault==='commit-ack'&&!injected&&sql==='COMMIT'&&phase==='after'){injected=true;throw Object.assign(Error('First commit acknowledgement lost'),{code:'FIRST_ERROR'});}
  if(fault==='rollback-ack'&&!injected&&sql.includes('INSERT INTO human_audit_events')&&phase==='before'){injected=true;throw Object.assign(Error('First audit failure'),{code:'FIRST_ERROR'});}
  if(fault==='rollback-ack'&&sql==='ROLLBACK'&&phase==='after')throw Object.assign(Error('Secondary rollback acknowledgement lost'),{code:'SECOND_ERROR'});
 },discard=>releases.push(discard));
 try{const response=await call('/approvals/'+r.approvalId,'member',{decision:'approved'});assert.equal(response.status,500);assert.equal(response.data.code,'FIRST_ERROR');}finally{restore();}
 assert.ok(releases.includes(true));assert.equal((await db.query('SELECT status FROM tool_approvals WHERE id=$1',[r.approvalId])).rows[0].status,fault==='commit-ack'?'approved':'pending');
 await assert.rejects(writers.withMaintenance([r.id],async()=>{}, {timeoutMs:50}));
});
