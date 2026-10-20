import {before,after,beforeEach,test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import http from 'node:http';
import type pg from 'pg';
import {recoveryModel} from './model-fixture.ts';
import {withProjectStatusFailure} from './run-transaction-fixture.ts';
import {createRunArchive,readRun} from '../services/agent-runtime/trace-store.mjs';
import {OpenAiCompatibleAdapter} from '../services/agent-runtime/openai-compatible.mjs';

// Actual coordinator/state/admission modules, fresh PGlite and FIFO pool max1.
// No production fallback or real provider. Expiry is injected at a precise
// maintenance barrier instead of sleeping30s or weakening production TTL.
const isolated=process.env.SIMULATED_INTEGRATION==='pglite';
let pool:pg.Pool,worker:InstanceType<typeof import('../apps/api/src/run-coordinator.ts').RunCoordinator>,state:typeof import('../apps/api/src/run-state.ts'),root:string,server:http.Server,baseUrl:string;
let modelCalls=0;const pause=(ms:number)=>new Promise(done=>setTimeout(done,ms));
before(async()=>{
 if(!isolated)return;assert.match(process.env.DATABASE_URL??'',/^postgresql:\/\/postgres:postgres@127\.0\.0\.1:\d+\/postgres$/);
 root=await mkdtemp(join(tmpdir(),'run-live-lease-'));process.env.DATA_DIR=root;process.env.TRACE_ROOT=join(root,'runs');process.env.OBSIDIAN_VAULT=join(root,'vault');
 const db=await import('../apps/api/src/db.ts');pool=db.pool;await db.migrate();assert.equal((pool as any).options.max,1);
 server=http.createServer((_req,res)=>{modelCalls++;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:{role:'assistant',content:'isolated lease fixture'},finish_reason:'stop'}],usage:{prompt_tokens:4,completion_tokens:2}}));});server.listen(0,'127.0.0.1');await once(server,'listening');baseUrl='http://127.0.0.1:'+(server.address() as any).port+'/v1';
 const {RunCoordinator}=await import('../apps/api/src/run-coordinator.ts');worker=new RunCoordinator(join(root,'runs'));await worker.close();state=await import('../apps/api/src/run-state.ts');
});
beforeEach(async()=>{if(!isolated)return;worker.stopped=false;worker.closing=undefined;worker.active.clear();await pool.query('TRUNCATE local_operations,local_devices,project_runs,projects,usage,model_reservations,departments,tool_approvals CASCADE');modelCalls=0;});
after(async()=>{if(!isolated)return;worker.active.clear();await worker.close();server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));await pool.end();});
async function fixture(owner:string=worker.owner){
 const models=await recoveryModel(pool),departmentId=randomUUID(),projectId=randomUUID(),runId=randomUUID();
 const policy={maxBudget:1,maxAgents:1,maxConcurrentAgents:1,maxModelCalls:20,deadlineSeconds:180,allowedModelIds:['recovery-model'],allowedTools:[],allowedKnowledgeSpaceIds:[],allowedDepartmentIds:[departmentId]};
 const snapshot={title:'Isolated live lease',...models,projectId,departmentId,departmentIds:[departmentId],planVersion:1,executionBudget:1,policy,tasks:[{id:'work',dependencies:[],maxBudget:1}],modelRoutes:models.modelRoutes.map(route=>({...route,name:'Lease fixture',apiKey:'',inputRate:0,outputRate:0,baseUrl,wireModel:'fixture',maxOutputTokens:128}))};
 await pool.query('INSERT INTO departments(id,data) VALUES($1,$2)',[departmentId,{name:'Isolated',agents:snapshot.agents}]);await pool.query('INSERT INTO projects(id,department_id,department_version,department_name,requirement,policy,plan,source,status) VALUES($1,$2,1,$3,$3,$4,$5,$6,$7)',[projectId,departmentId,'Lease fixture',policy,{agents:snapshot.agents,tasks:[]},'manual','RUNNING']);
 await pool.query("INSERT INTO project_runs(id,project_id,project_version,status,snapshot,lease_owner,lease_until,started_at) VALUES($1,$2,1,'running',$3,$4,clock_timestamp()+interval '30 seconds',now())",[runId,projectId,snapshot,owner]);createRunArchive(join(root,'runs'),snapshot,{id:runId});return {runId,projectId,departmentId,snapshot};
}
const stored=async(id:string)=>(await pool.query('SELECT * FROM project_runs WHERE id=$1',[id])).rows[0];
const expire=async(id:string)=>pool.query("UPDATE project_runs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",[id]);

test('own-active run survives expiry inside maintenance after a successful heartbeat; unknown receipts remain unchanged',{skip:!isolated},async()=>{
 const f=await fixture();worker.active.set(f.runId,{projectId:f.projectId});
 await pool.query("INSERT INTO model_reservations(id,model_id,project_id,run_id,purpose,amount,input_rate,output_rate,status,context) VALUES('lease-unknown','recovery-model',$1,$2,'fixture',.096526,0,0,'uncertain','{}')",[f.projectId,f.runId]);const receipt=(await pool.query("SELECT * FROM model_reservations WHERE id='lease-unknown'")).rows[0];
 const native=pool.query.bind(pool);let injected=false,heartbeatCount=0;
 (pool as any).query=async(text:any,...args:any[])=>{
  if(typeof text==='string'&&/UPDATE project_runs SET lease_until=/.test(text))heartbeatCount++;
  if(!injected&&typeof text==='string'&&text.startsWith('UPDATE model_capability_tests')){injected=true;await native("UPDATE project_runs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",[f.runId]);await worker.tick();}
  return (native as any)(text,...args);
 };
 try{await worker.tick();}finally{(pool as any).query=native;}
 assert.equal(injected,true);assert.equal(heartbeatCount,1,'nested scheduler tick is busy; its heartbeat cannot repair the injected gap');assert.equal((await stored(f.runId)).status,'running','a live own-active run must not be adopted as a dead worker');assert.equal((await stored(f.runId)).lease_owner,worker.owner);assert.ok(worker.active.has(f.runId));assert.ok(!readRun(join(root,'runs'),f.runId)!.events.some(event=>event.type==='run/finished'));
 assert.deepEqual((await pool.query("SELECT * FROM model_reservations WHERE id='lease-unknown'")).rows[0],receipt);assert.equal(modelCalls,0);
});

test('standalone heartbeat clocks do not inherit a previous released transaction snapshot',{skip:!isolated},async()=>{
 const client=await pool.connect();let snapshot:string|undefined;
 try{await client.query('BEGIN');snapshot=(await client.query('SELECT now()::text AS t')).rows[0].t;await pause(30);const fixed=(await client.query('SELECT now()::text AS t,clock_timestamp()::text AS wall')).rows[0];assert.equal(fixed.t,snapshot);assert.notEqual(fixed.wall,snapshot);await client.query('COMMIT');}finally{client.release();}
 assert.notEqual((await pool.query('SELECT now()::text AS t')).rows[0].t,snapshot);
});

test('dead or foreign expired owners remain recoverable and atomic terminal state still closes pending approvals',{skip:!isolated},async()=>{
 const f=await fixture('foreign-dead-worker');await expire(f.runId);await pool.query("INSERT INTO tool_approvals(id,run_id,agent_id,tool,arguments) VALUES($1,$2,'employee-1','terminal','{}')",[randomUUID(),f.runId]);await worker.recover();
 const row=await stored(f.runId);assert.equal(row.status,'interrupted');assert.equal(row.lease_owner,null);assert.equal((await pool.query('SELECT status FROM projects WHERE id=$1',[f.projectId])).rows[0].status,'INTERRUPTED');assert.equal((await pool.query('SELECT status FROM tool_approvals WHERE run_id=$1',[f.runId])).rows[0].status,'cancelled');assert.equal(modelCalls,0);
});

test('beforeRequest renews only the live active same-owner lease before full native model admission and one fixture wire',{skip:!isolated},async()=>{
 const f=await fixture();worker.active.set(f.runId,{projectId:f.projectId});await expire(f.runId);
 const adapter:any=new OpenAiCompatibleAdapter({routes:f.snapshot.modelRoutes,maxBudget:1,beforeRequest:(data:any,signal?:AbortSignal)=>worker.reserve(f.runId,data,signal)});
 adapter.attribution=()=>({agentId:'employee-1',employeeId:'employee',sessionId:'lease-fixture',taskId:'work'});
 for await(const _event of adapter.stream({model:'recovery-model',messages:[{id:'fixture',role:'user',source:{kind:'user'},content:[{type:'text',text:'Isolated single lease fixture'}]}]})){}
 assert.equal(modelCalls,1);assert.equal((await pool.query('SELECT count(*)::int AS n FROM model_reservations WHERE run_id=$1',[f.runId])).rows[0].n,1);assert.equal((await stored(f.runId)).lease_owner,worker.owner);
});

test('fresh heartbeat cannot bypass cancelled run, withdrawn department, changed version, foreign owner or original caller abort',{skip:!isolated},async()=>{
 for(const reason of ['cancel','department','version','owner','abort']){
  const f=await fixture();worker.active.set(f.runId,{projectId:f.projectId});await expire(f.runId);const controller=new AbortController();
  if(reason==='cancel')await pool.query('UPDATE project_runs SET cancel_requested=true WHERE id=$1',[f.runId]);else if(reason==='department')await pool.query('UPDATE departments SET deleted_at=now() WHERE id=$1',[f.departmentId]);else if(reason==='version')await pool.query('UPDATE projects SET version=2 WHERE id=$1',[f.projectId]);else if(reason==='owner')await pool.query("UPDATE project_runs SET lease_owner='replacement' WHERE id=$1",[f.runId]);else controller.abort(Error('original request cancelled'));
  const pending=worker.reserve(f.runId,{id:randomUUID(),modelId:'recovery-model',reservation:0,agentId:'employee-1',employeeId:'employee',taskId:'work'},controller.signal);
  if(reason==='abort')await assert.rejects(pending,(error:unknown)=>error===controller.signal.reason);else await assert.rejects(pending);assert.equal((await pool.query('SELECT count(*)::int AS n FROM model_reservations WHERE run_id=$1',[f.runId])).rows[0].n,0);worker.active.delete(f.runId);
 }
 assert.equal(modelCalls,0);
});

test('the real heartbeat timer renews its own fenced lease even while the scheduler remains busy',{skip:!isolated},async()=>{
 const {RunCoordinator}=await import('../apps/api/src/run-coordinator.ts'),other=new RunCoordinator(join(root,'runs'));
 try{
  while(other.ticking)await pause(5);const f=await fixture(other.owner);other.active.set(f.runId,{projectId:f.projectId});other.ticking=true;await expire(f.runId);
  let renewed=false;for(let i=0;i<100;i++){const row=await stored(f.runId);if(new Date(row.lease_until).getTime()>Date.now()+20000){renewed=true;break;}await pause(20);}
  assert.equal(renewed,true,'a busy scheduler must not suppress the timer heartbeat');assert.equal(other.ticking,true);assert.equal(modelCalls,0);
 }finally{other.active.clear();other.ticking=false;await other.close();}
});

test('caller abort exits immediately while the shared heartbeat waits for the single pool connection',{skip:!isolated},async()=>{
 const f=await fixture();worker.active.set(f.runId,{projectId:f.projectId});await expire(f.runId);const gate=await pool.connect(),controller=new AbortController();let pending:Promise<any>|undefined;
 try{
  await gate.query('BEGIN');pending=worker.reserve(f.runId,{id:randomUUID(),modelId:'recovery-model',reservation:0,agentId:'employee-1',employeeId:'employee',taskId:'work'},controller.signal);await pause(20);const abortAt=Date.now();controller.abort(Error('caller abandoned queued heartbeat'));
  await assert.rejects(pending,error=>error===controller.signal.reason);assert.ok(Date.now()-abortAt<500);assert.equal(modelCalls,0);
 }finally{await gate.query('ROLLBACK');gate.release();if(pending)await pending.catch(()=>{});await worker.heartbeatWork;}
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM model_reservations WHERE run_id=$1',[f.runId])).rows[0].n,0);
});

test('a new active run joining a queued heartbeat gets one covering renewal instead of a false lost-lease result',{skip:!isolated},async()=>{
 const old=await fixture(),fresh=await fixture();worker.active.set(old.runId,{projectId:old.projectId});await expire(fresh.runId);const gate=await pool.connect();let initial:ReturnType<typeof worker.heartbeat>|undefined,pending:Promise<any>|undefined;
 const native=pool.query.bind(pool);let heartbeats=0;(pool as any).query=(text:any,...args:any[])=>{if(typeof text==='string'&&text.startsWith('UPDATE project_runs SET lease_until='))heartbeats++;return (native as any)(text,...args);};
 try{
  await gate.query('BEGIN');initial=worker.heartbeat();worker.active.set(fresh.runId,{projectId:fresh.projectId});pending=worker.reserve(fresh.runId,{id:randomUUID(),modelId:'recovery-model',reservation:0,agentId:'employee-1',employeeId:'employee',taskId:'work'});await gate.query('COMMIT');
 }finally{gate.release();}
 try{assert.deepEqual((await initial!).ids,[old.runId]);await pending;assert.equal(heartbeats,2,'one initial snapshot and exactly one renewal covering the new run');assert.equal((await stored(fresh.runId)).lease_owner,worker.owner);assert.equal((await pool.query('SELECT count(*)::int AS n FROM model_reservations WHERE run_id=$1',[fresh.runId])).rows[0].n,1);assert.equal(modelCalls,0);}finally{(pool as any).query=native;}
});

test('terminal persistence rollback is atomic and a recorded completion is reconciled under a fresh recovery owner',{skip:!isolated},async()=>{
 const f=await fixture();await pool.query("INSERT INTO tool_approvals(id,run_id,agent_id,tool,arguments) VALUES($1,$2,'employee-1','terminal','{}')",[randomUUID(),f.runId]);
 await withProjectStatusFailure(pool,()=>assert.rejects(state.finishRun(f.runId,worker.owner,'completed'),/injected project status persistence failure/));assert.equal((await stored(f.runId)).status,'running');assert.equal((await pool.query('SELECT status FROM projects WHERE id=$1',[f.projectId])).rows[0].status,'RUNNING');assert.equal((await pool.query('SELECT status FROM tool_approvals WHERE run_id=$1',[f.runId])).rows[0].status,'pending');
 const {openRunArchive}=await import('../services/agent-runtime/trace-store.mjs');openRunArchive(join(root,'runs'),f.runId).append('run/finished',{status:'completed',message:'actual fixture persisted before recovery'});await expire(f.runId);await worker.recover();assert.equal((await stored(f.runId)).status,'completed');assert.equal((await pool.query('SELECT status FROM tool_approvals WHERE run_id=$1',[f.runId])).rows[0].status,'cancelled');assert.equal(modelCalls,0);
});
