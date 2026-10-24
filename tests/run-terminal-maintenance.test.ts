import express from 'express';
import {before,after,beforeEach,test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {existsSync,readFileSync,appendFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import type pg from 'pg';
import {recoveryModel} from './model-fixture.ts';
import {createRunArchive,readRun} from '../services/agent-runtime/trace-store.mjs';
import {createArchiveWriteFence} from '../services/agent-runtime/archive-write-fence.mjs';
import {createArchiveWriterManager} from '../services/agent-runtime/archive-writer-scope.mjs';

// Actual coordinator/state and isolated SQL; trusted runtime completion/readiness
// fixtures exercise consumption only, not native Host teardown or task acceptance.
const isolated=process.env.SIMULATED_INTEGRATION==='pglite';
let pool:pg.Pool,worker:InstanceType<typeof import('../apps/api/src/run-coordinator.ts').RunCoordinator>,root:string,traceRoot:string;
const completed=(recording:'complete'|'incomplete'='complete',usages:any[]=[])=>({status:'completed',recording,usages,
  ...(recording==='incomplete'?{message:'业务已验收，终态记录尚待核对',maintenance:{version:1,state:'pending',reasonCode:'TASK_TERMINAL_RECORDING_INCOMPLETE'}}:{})});
const pending=()=>Object.assign(Error('PRIVATE_QUARANTINE_DETAIL'),{code:'RUNTIME_TEARDOWN_PENDING'});
const wait=()=>new Promise<void>(done=>setImmediate(done));
before(async()=>{
 if(!isolated)return;
 assert.match(process.env.DATABASE_URL??'',/^postgresql:\/\/postgres:postgres@127\.0\.0\.1:\d+\/postgres$/);
 root=await mkdtemp(join(tmpdir(),'run-terminal-maintenance-'));traceRoot=join(root,'runs');
 console.log('ARCHIVE_WRITER_FIXTURE_CREATED='+JSON.stringify({root,pid:process.pid,traceRoot}));
 process.env.DATA_DIR=root;process.env.TRACE_ROOT=traceRoot;process.env.OBSIDIAN_VAULT=join(root,'vault');
 const db=await import('../apps/api/src/db.ts');pool=db.pool;await db.migrate();
 const {RunCoordinator}=await import('../apps/api/src/run-coordinator.ts');worker=new RunCoordinator(traceRoot,createArchiveWriterManager({traceRoot:traceRoot}));await worker.close();
});
beforeEach(async()=>{
 if(!isolated)return;
 worker.stopped=false;worker.closing=undefined;worker.active.clear();
 await pool.query('TRUNCATE local_operations,local_devices,project_runs,projects,usage,model_reservations,departments,tool_approvals CASCADE');
 runtime();
});
after(async()=>{
 if(!isolated)return;
 worker.active.clear();await worker.close();await pool.end();
 const within=relative(resolve(tmpdir()),resolve(root));assert.ok(within.startsWith('run-terminal-maintenance-')&&!within.startsWith('..')&&!isAbsolute(within));
 // Failed-drain tests deliberately keep native guards. The parent test runner
 // cleans this synthetic fixture only after this process has actually exited.
 console.log('ARCHIVE_WRITER_EXIT_CLEANUP='+root);
});
function runtime(options:{ready?:()=>boolean;start?:(input:any)=>Promise<any>}={}){
 let starts=0;
 const fixture={inspect:async()=>({ready:options.ready?.()??true,reason:'isolated readiness fixture'}),cancel:async()=>false,
  start:async(input:any)=>{
   starts++;
   const accepted=options.start?await options.start(input):{runtimeRunId:input.runId,writerDrained:Promise.resolve(),completion:Promise.resolve(completed())};
   input.prepareWorkspace?.();
   return accepted;
  }};
 worker.runtime=fixture as any;
 return {fixture,get starts(){return starts;}};
}

for(const fail of [false,true])test('SQL terminal retains active actual drain and shutdown observes its original: '+fail,{skip:!isolated,timeout:10000},async()=>{
 const f=await fixture(),receipt=await unknownReceipt(f);
 let release!:()=>void,reject!:(error:Error)=>void,cancels=0;
 const writerDrained=new Promise<void>((yes,no)=>{release=yes;reject=no;});
 const r=runtime({start:async input=>({runtimeRunId:input.runId,completion:Promise.resolve(completed()),writerDrained})});
 r.fixture.cancel=async()=>{cancels++;return false;};
 worker.active.set(f.id,{projectId:f.projectId,writer:await worker.writers.acquireOwner([f.id])});
 const launching=worker.launch(f.row,worker.active.get(f.id)?.writer);let ended=false;launching.then(()=>{ended=true;});
 try{
  const deadline=Date.now()+4000;while((await stored(f.id)).status!=='completed'&&Date.now()<deadline)await wait();
  assert.equal((await stored(f.id)).status,'completed');
  await wait();assert.equal(ended,false);assert.equal(worker.active.has(f.id),true);
  assert.deepEqual(await worker.heartbeat(),{ids:[],held:[]});assert.equal(cancels,0);
  const closing=worker.close(),observed=closing.catch(error=>error);let closed=false;closing.then(()=>{closed=true;},()=>{closed=true;});
  await wait();assert.equal(closed,false);
  if(fail)reject(Object.assign(Error('RUNTIME_WRITER_DRAIN_FAILED'),{code:'RUNTIME_WRITER_DRAIN_FAILED'}));else release();
  await launching;const result=await observed;
  if(fail){assert.equal(result.code,'RUNTIME_WRITER_DRAIN_FAILED');assert.equal(worker.active.has(f.id),true);await assert.rejects(worker.close(),/RUNTIME_WRITER_DRAIN_FAILED/);}
  else {assert.equal(result,undefined);assert.equal(worker.active.has(f.id),false);}
  assert.equal(cancels,0,'business terminal never resends cancellation');
  assert.deepEqual((await pool.query('SELECT * FROM model_reservations WHERE id=$1',[receipt.id])).rows[0],receipt);
  assert.equal((await stored(f.id)).status,'completed');
 }finally{release();await launching;worker.active.clear();worker.stopped=false;(worker as any).closing=undefined;}
});

test('shutdown joins an in-flight original heartbeat after SQL terminal without recancelling the released run',{skip:!isolated,timeout:10000},async()=>{
 const f=await fixture();let release!:()=>void,entered!:()=>void,cancels=0;
 const held=new Promise<void>(yes=>{release=yes;}),started=new Promise<void>(yes=>{entered=yes;});
 const query=pool.query;
 (pool as any).query=async(text:any,...args:any[])=>{
  if(typeof text==='string'&&text.startsWith('UPDATE project_runs SET lease_until=')){entered();await held;}
  return (query as any).call(pool,text,...args);
 };
 const r=runtime();r.fixture.cancel=async()=>{cancels++;return false;};
 worker.active.set(f.id,{projectId:f.projectId,writer:await worker.writers.acquireOwner([f.id])});
 try{
  const heartbeat=worker.heartbeat();await started;
  const launching=worker.launch(f.row,worker.active.get(f.id)?.writer);
  const deadline=Date.now()+3000;while((await stored(f.id)).status!=='completed'&&Date.now()<deadline)await wait();
  assert.equal((await stored(f.id)).status,'completed');assert.equal(worker.active.has(f.id),true);
  const closing=worker.close();let closed=false;closing.then(()=>{closed=true;});await wait();assert.equal(closed,false);
  release();await heartbeat;await launching;await closing;assert.equal(cancels,0);assert.equal(worker.active.has(f.id),false);
 }finally{release();pool.query=query;worker.active.clear();worker.closing=undefined;worker.stopped=false;}
});

test('missing runtime writer contract preserves business completion but latches shutdown unproven',{skip:!isolated},async()=>{
 const f=await fixture();runtime({start:async input=>({runtimeRunId:input.runId,completion:Promise.resolve(completed())})});
 await launch(f.row);assert.equal((await stored(f.id)).status,'completed');assert.equal(worker.active.get(f.id)?.phase,'drain-failed');
 await assert.rejects(worker.close(),error=>(error as any).code==='RUNTIME_WRITER_DRAIN_UNPROVEN');
 worker.active.clear();worker.closing=undefined;worker.stopped=false;
});
async function fixture(status:'queued'|'running'='running',imported=true){
 const models=await recoveryModel(pool),departmentId=randomUUID(),projectId=randomUUID(),id=randomUUID();
 const policy={maxBudget:1,maxAgents:1,maxConcurrentAgents:1,maxModelCalls:20,deadlineSeconds:180,allowedModelIds:['recovery-model'],allowedTools:[],allowedKnowledgeSpaceIds:[],allowedDepartmentIds:[departmentId]};
 const content='Preserve this exact approved input.\n',file={path:'approved.txt',content,sha256:createHash('sha256').update(content).digest('hex')};
 const snapshot={...models,title:'Terminal caller fixture',projectId,departmentId,departmentIds:[departmentId],planVersion:1,executionBudget:1,policy,tasks:[],importedFiles:imported?[file]:[],
  modelRoutes:models.modelRoutes.map(route=>({...route,gatewayId:'recovery-gateway',name:'No transport fixture',baseUrl:'http://127.0.0.1:1/v1',wireModel:'fixture',inputRate:0,outputRate:0,maxOutputTokens:64}))};
 await pool.query('INSERT INTO departments(id,data) VALUES($1,$2)',[departmentId,{name:'Isolated terminal caller',agents:snapshot.agents}]);
 await pool.query('INSERT INTO projects(id,department_id,department_version,department_name,requirement,policy,plan,source,status) VALUES($1,$2,1,$3,$3,$4,$5,$6,$7)',[projectId,departmentId,'Terminal fixture',policy,{agents:snapshot.agents,tasks:[]},'manual',status.toUpperCase()]);
 const row=(await pool.query(`INSERT INTO project_runs(id,project_id,project_version,status,snapshot,lease_owner,lease_until,started_at,attempt,department_ids)
  VALUES($1,$2,1,$3,$4,$5,CASE WHEN $3='running' THEN clock_timestamp()+interval '1 minute' ELSE NULL END,CASE WHEN $3='running' THEN now() ELSE NULL END,1,$6) RETURNING *`,
  [id,projectId,status,snapshot,status==='running'?worker.owner:null,[departmentId]])).rows[0];
 createRunArchive(traceRoot,snapshot,{id});
 return {row,id,projectId,snapshot,file,path:join(traceRoot,id,'artifacts',file.path)};
}
const stored=async(id:string)=>(await pool.query('SELECT * FROM project_runs WHERE id=$1',[id])).rows[0];
// Real native source in another process; its first attempt must be blocked,
// then the second attempt reports actual acquisition after the writer drains.
async function sourceProbe(id:string){
 const child=spawn(process.execPath,[fileURLToPath(new URL('../services/agent-runtime/test-helpers/archive-writer-source-child.mjs',import.meta.url))],{
  windowsHide:true,stdio:['ignore','inherit','inherit','ipc'],env:{...process.env,ARCHIVE_WRITER_TEST:JSON.stringify({traceRoot,lockRoot:join(root,'.archive-write-locks'),runId:id})}});
 const exited=once(child,'exit');
 async function message(){let timer:NodeJS.Timeout|undefined;
  try{return await Promise.race([once(child,'message').then(([value])=>value),exited.then(([code,signal])=>{throw Error('Source probe exited: '+code+'/'+signal);}),new Promise<never>((_yes,no)=>{timer=setTimeout(()=>no(Error('Source probe deadline')),10000);})]);}
  finally{clearTimeout(timer);}
 }
 const first=message();
 const stop=async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill();await exited;};
 try{assert.deepEqual(await first,{blocked:true});}catch(error){await stop();throw error;}
 return {stop,async acquire(){const acquired=message();child.send('retry');assert.deepEqual(await acquired,{acquired:true});assert.deepEqual(await exited,[0,null]);}};
}
for(const denied of ['missing','missing-locked','completed','failed','cancelled','interrupted'])test('known cancellation denial drains before outward error: '+denied,{skip:!isolated,timeout:15000},async()=>{
 const f=denied==='missing'?{id:randomUUID()}:await fixture();
 if(!denied.startsWith('missing'))await pool.query('UPDATE project_runs SET status=$1 WHERE id=$2',[denied,f.id]);
 const temporary=await worker.writers.acquireOwner([f.id]),probe=await sourceProbe(f.id);
 temporary.finish();await temporary.writerDrained;
 const connect=pool.connect;let rollbacks=0;
 (pool as any).connect=function(callback?:unknown){
  if(typeof callback==='function')return (connect as any).call(pool,callback);
  return (connect as ()=>Promise<pg.PoolClient>).call(pool).then(client=>{const query=client.query,release=client.release;
  (client as any).query=async function(text:any,...args:any[]){
   if(denied==='missing-locked'&&text==='SELECT * FROM project_runs WHERE id=$1 FOR UPDATE')await (query as any).call(client,'DELETE FROM project_runs WHERE id=$1',[f.id]);
   const result=await (query as any).call(client,text,...args);if(text==='ROLLBACK')rollbacks++;return result;
  };
  client.release=function(error?:Error|boolean){client.query=query;client.release=release;release.call(client,error);};return client;
  });
 };
 try{
  await assert.rejects(worker.cancel(f.id),(error:any)=>{assert.equal(rollbacks,1,'original transaction rollback acknowledged');assert.equal(error.status,denied.startsWith('missing')?404:409);assert.equal(error.message,denied.startsWith('missing')?'运行不存在':'运行已结束');assert.equal(error.code,'REQUEST_FAILED');return true;});
  pool.connect=connect;
  await probe.acquire();
  if(denied!=='missing')assert.equal((await stored(f.id)).status,denied==='missing-locked'?'running':denied);
 }finally{pool.connect=connect;await probe.stop();}
});
for(const failure of ['sql-4xx','rollback-before','rollback-after','commit-before','commit-after'])test('uncertain cancellation keeps source blocked: '+failure,{skip:!isolated,timeout:15000},async()=>{
 const f=await fixture(),rollback=failure.startsWith('rollback');
 if(rollback)await pool.query("UPDATE project_runs SET status='completed' WHERE id=$1",[f.id]);
 const {AppError}=await import('../apps/api/src/provider.ts'),original=new AppError(409,'injected cancellation '+failure),connect=pool.connect;let injected=0;
 (pool as any).connect=function(callback?:unknown){
  if(typeof callback==='function')return (connect as any).call(pool,callback);
  return (connect as ()=>Promise<pg.PoolClient>).call(pool).then(client=>{const query=client.query,release=client.release;
  (client as any).query=async function(text:any,...args:any[]){
   const target=failure==='sql-4xx'?'SELECT project_id FROM project_runs WHERE id=$1':rollback?'ROLLBACK':'COMMIT';
   if(text===target&&injected===0){injected++;if(failure.endsWith('after'))await (query as any).call(client,text,...args);throw original;}
   return (query as any).call(client,text,...args);
  };
  client.release=function(error?:Error|boolean){client.query=query;client.release=release;release.call(client,error);};return client;
  });
 };
 try{await assert.rejects(worker.cancel(f.id),error=>error===original);}finally{pool.connect=connect;}
 assert.equal(injected,1);const probe=await sourceProbe(f.id);await probe.stop();
 const row=await stored(f.id);assert.equal(row.status,rollback?'completed':'running');assert.equal(row.cancel_requested,failure==='commit-after');
});
test('queued cancellation commits and drains its independent HTTP writer',{skip:!isolated,timeout:15000},async()=>{
 const f=await fixture('queued'),temporary=await worker.writers.acquireOwner([f.id]),probe=await sourceProbe(f.id);
 temporary.finish();await temporary.writerDrained;
 try{await worker.cancel(f.id);await probe.acquire();const row=await stored(f.id);assert.equal(row.status,'cancelled');assert.equal(row.cancel_requested,true);assert.ok(row.finished_at);assert.equal((await pool.query('SELECT status FROM projects WHERE id=$1',[f.projectId])).rows[0].status,'CANCELLED');}
 finally{await probe.stop();}
});
for(const fail of [false,true])test('running cancellation preserves the original producer and HTTP owner: '+fail,{skip:!isolated,timeout:15000},async()=>{
 const f=await fixture(),owner=await worker.writers.acquireOwner([f.id]);worker.active.set(f.id,{projectId:f.projectId,writer:owner});
 let release!:()=>void,entered!:()=>void,cancels=0;
 const gate=new Promise<void>(yes=>{release=yes;}),started=new Promise<void>(yes=>{entered=yes;});
 const {AppError}=await import('../apps/api/src/provider.ts'),original=new AppError(409,'injected original runtime.cancel failure');
 // Explicit runtime double: no Host, model, device or repeated cancellation.
 const r=runtime();r.fixture.cancel=async()=>{worker.writers.assertWriter(f.id);cancels++;entered();await gate;if(fail)throw original;return true;};
 const cancelling=worker.cancel(f.id),observed=cancelling.catch(error=>error);await started;
 owner.finish();let drained=false;owner.writerDrained.then(()=>{drained=true;},()=>{});
 const probe=await sourceProbe(f.id);
 try{
  assert.equal(drained,false,'retained original cancellation producer survives owner finish');release();
  if(fail){assert.equal(await observed,original);await assert.rejects(owner.writerDrained,error=>error===original);const fence=createArchiveWriteFence({traceRoot,lockRoot:join(root,'.archive-write-locks')});await assert.rejects(fence.acquireSource(f.id),{code:'E_ARCHIVE_FENCE_TIMEOUT'});}
  else{assert.equal(await observed,undefined);await owner.writerDrained;await probe.acquire();}
  const row=await stored(f.id);assert.equal(row.status,'running');assert.equal(row.cancel_requested,true);assert.equal(cancels,1);
 }finally{release();await observed;worker.active.delete(f.id);await probe.stop();}
});
test('tick waits for native writer outside SQL then rechecks cancellation, version and department conflicts',{skip:!isolated,timeout:20000},async()=>{
 for(const changed of ['cancel','version','department']){
  const f=await fixture('queued'),fence=createArchiveWriteFence({traceRoot,lockRoot:join(root,'.archive-write-locks')}),source=await fence.acquireSource(f.id);
  const r=runtime();let candidateRead!:()=>void;const seen=new Promise<void>(yes=>{candidateRead=yes;});const query=pool.query;
  (pool as any).query=async(text:any,...args:any[])=>{const result=await (query as any).call(pool,text,...args);if(typeof text==='string'&&text.includes('ORDER BY r.created_at LIMIT 1'))candidateRead();return result;};
  const ticking=worker.tick();
  try{
   assert.equal(await Promise.race([seen.then(()=>true),ticking.then(()=>false)]),true,'candidate must be read outside SQL before native acquisition');
   // FIFO PGlite max1: this SQL completing while native acquisition waits proves
   // no transaction/connection is held by tick; it does not certify PG row locks.
   if(changed==='cancel')await pool.query('UPDATE project_runs SET cancel_requested=true WHERE id=$1',[f.id]);
   else if(changed==='version')await pool.query('UPDATE projects SET version=2 WHERE id=$1',[f.projectId]);
   else {const competing=await fixture('running');await pool.query('UPDATE project_runs SET department_ids=$1 WHERE id=$2',[[f.snapshot.departmentId],competing.id]);}
  }finally{source.release();pool.query=query;}
  await ticking;assert.equal(r.starts,0);assert.equal((await stored(f.id)).status,'queued');
  const available=await fence.acquireSource(f.id);available.release();
  await pool.query('TRUNCATE local_operations,local_devices,project_runs,projects,usage,model_reservations,departments,tool_approvals CASCADE');
 }
});
test('tick transfers its original owner without waiting for business terminal or actual tail',{skip:!isolated,timeout:10000},async()=>{
 const f=await fixture('queued'),fence=createArchiveWriteFence({traceRoot,lockRoot:join(root,'.archive-write-locks')});
 let terminal!:()=>void,drain!:()=>void;const completion=new Promise<any>(yes=>{terminal=()=>yes(completed());}),writerDrained=new Promise<void>(yes=>{drain=yes;});
 runtime({start:async()=>{worker.writers.assertWriter(f.id);return {completion,writerDrained};}});
 await worker.tick();assert.equal((await stored(f.id)).status,'running');assert.equal(worker.active.has(f.id),true);
 await worker.heartbeat();await assert.rejects(fence.acquireSource(f.id),{code:'E_ARCHIVE_FENCE_TIMEOUT'});
 terminal();const deadline=Date.now()+3000;while((await stored(f.id)).status!=='completed'&&Date.now()<deadline)await wait();
 assert.equal((await stored(f.id)).status,'completed');await assert.rejects(fence.acquireSource(f.id),{code:'E_ARCHIVE_FENCE_TIMEOUT'});
 drain();await worker.active.get(f.id)?.work;assert.equal(worker.active.has(f.id),false);const source=await fence.acquireSource(f.id);source.release();
});
test('detached heartbeat SQL and shutdown cancellation run in each original producer context',{skip:!isolated,timeout:10000},async()=>{
 const fixtures=[await fixture(),await fixture()];let finish!:()=>void;
 const completion=new Promise<any>(yes=>{finish=()=>yes(completed());});
 const r=runtime({start:async input=>({completion,writerDrained:Promise.resolve()})});
 const launching=fixtures.map(f=>worker.launch(f.row));
 const deadline=Date.now()+3000;while(r.starts<2&&Date.now()<deadline)await wait();assert.equal(r.starts,2);
 const query=pool.query;let checked=0,cancelled=0;
 (pool as any).query=async(text:any,...args:any[])=>{
  if(typeof text==='string'&&text.startsWith('UPDATE project_runs SET lease_until=')){
   for(const id of args[0][0]){worker.writers.assertWriter(id);checked++;}
  }
  return (query as any).call(pool,text,...args);
 };
 r.fixture.cancel=async(id?:string)=>{worker.writers.assertWriter(id!);cancelled++;return false;};
 try{await worker.heartbeat();assert.equal(checked,2);const closing=worker.close();finish();await Promise.all(launching);await closing;assert.equal(cancelled,2);}
 finally{pool.query=query;finish();await Promise.allSettled(launching);}
});
test('a rejected heartbeat waits for every original SQL update and retains the failed owner',{skip:!isolated,timeout:10000},async()=>{
 const fixtures=[await fixture(),await fixture()];let finish!:()=>void,resume!:()=>void,entered!:()=>void;
 const completion=new Promise<any>(yes=>{finish=()=>yes(completed());}),gate=new Promise<void>(yes=>{resume=yes;}),started=new Promise<void>(yes=>{entered=yes;});
 const r=runtime({start:async()=>({completion,writerDrained:Promise.resolve()})}),launching=fixtures.map(f=>worker.launch(f.row));
 const deadline=Date.now()+3000;while(r.starts<2&&Date.now()<deadline)await wait();assert.equal(r.starts,2);
 const query=pool.query,logError=console.error,diagnostics:unknown[][]=[];
 console.error=(...args:unknown[])=>{diagnostics.push(args);};
 (pool as any).query=async(text:any,...args:any[])=>{
  if(typeof text==='string'&&text.startsWith('UPDATE project_runs SET lease_until=')){
   if(args[0][0][0]===fixtures[0].id)throw Error('isolated heartbeat failure');entered();await gate;
  }
  return (query as any).call(pool,text,...args);
 };
 let settled=false;const heartbeat=worker.heartbeat();heartbeat.then(()=>{settled=true;},()=>{settled=true;});
 try{
  await started;await wait();assert.equal(settled,false,'first rejection must not discard another original SQL tail');
  const fence=createArchiveWriteFence({traceRoot,lockRoot:join(root,'.archive-write-locks')});
  await assert.rejects(fence.acquireSource(fixtures[1].id),{code:'E_ARCHIVE_FENCE_TIMEOUT'});
  resume();await assert.rejects(heartbeat,/isolated heartbeat failure/);finish();await Promise.all(launching);
  assert.equal(worker.active.get(fixtures[0].id)?.phase,'drain-failed');
  await assert.rejects(fence.acquireSource(fixtures[0].id),{code:'E_ARCHIVE_FENCE_TIMEOUT'});
  const source=await fence.acquireSource(fixtures[1].id);source.release();
  assert.deepEqual(diagnostics,[['Run lease cancellation:','Error']]);
 }finally{pool.query=query;resume();finish();await Promise.allSettled(launching);console.error=logError;}
});
const endings=(id:string)=>readRun(traceRoot,id)!.events.filter(event=>event.type==='run/finished');
for(const action of ['heartbeat','shutdown'] as const)test('Task2c3 failed usage with pending completion isolates '+action,{skip:!isolated,timeout:15000},async()=>{
 const failed=await fixture(),healthy=await fixture(),usageId=randomUUID(),failure=Error('pending completion usage persistence failure'),query=pool.query;
 let failUsage!:()=>void,consumed!:()=>void,finishFailed!:()=>void,finishHealthy!:()=>void,drainFailed!:()=>void;
 const trigger=new Promise<void>(done=>{failUsage=done;}),recorded=new Promise<void>(done=>{consumed=done;});
 const failedCompletion=new Promise<void>(done=>{finishFailed=done;}),healthyCompletion=new Promise<void>(done=>{finishHealthy=done;}),failedDrain=new Promise<void>(done=>{drainFailed=done;});
 const cancellations:string[]=[];
 (pool as any).query=function(text:any,...args:any[]){if(text==='SELECT id FROM model_reservations WHERE id=$1'&&args[0]?.[0]===usageId)throw failure;return (query as any).call(pool,text,...args);};
 const r=runtime({start:async input=>({runtimeRunId:input.runId,writerDrained:input.runId===failed.id?failedDrain:Promise.resolve(),completion:input.runId===failed.id?(async()=>{
  await trigger;await assert.rejects(worker.recordUsage(failed.id,{id:usageId} as any),error=>error===failure);consumed();await failedCompletion;return completed();
 })():healthyCompletion.then(()=>completed())})});
 r.fixture.cancel=async(id?:string)=>{cancellations.push(id!);return false;};
 const failedLaunch=worker.launch(failed.row),healthyLaunch=worker.launch(healthy.row);
 let closing:Promise<void>|undefined,observed:Promise<unknown>|undefined;
 try{
  const deadline=Date.now()+3000;while(r.starts<2&&Date.now()<deadline)await wait();assert.equal(r.starts,2);
  failUsage();await recorded;await wait();assert.equal(worker.active.get(failed.id)?.drainFailure,failure);
  if(action==='heartbeat'){
   await pool.query("UPDATE project_runs SET lease_until=now()-interval '1 minute' WHERE id=$1",[healthy.id]);
   const before=await stored(failed.id),heartbeat=await worker.heartbeat();
   assert.deepEqual(heartbeat,{ids:[healthy.id],held:[healthy.id]});
   assert.ok(new Date((await stored(healthy.id)).lease_until).getTime()>Date.now());
   assert.deepEqual(await stored(failed.id),before);assert.deepEqual(cancellations,[]);
  }else{
   closing=worker.close();let settled=false;observed=closing.then(()=>{settled=true;},error=>{settled=true;return error;});
   await wait();assert.equal(settled,false,'shutdown must join the still-pending original work despite its latched writer');
   assert.deepEqual(cancellations,[healthy.id],'failed work must not receive another cancellation');
   finishHealthy();await healthyLaunch;finishFailed();await wait();assert.equal(settled,false,'original writer drain is still pending');
   const fence=createArchiveWriteFence({traceRoot,lockRoot:join(root,'.archive-write-locks')});
   await assert.rejects(fence.acquireSource(failed.id),{code:'E_ARCHIVE_FENCE_TIMEOUT'});
   drainFailed();await failedLaunch;assert.equal(await observed,failure);
   assert.equal(worker.active.get(failed.id)?.phase,'drain-failed');
   await assert.rejects(fence.acquireSource(failed.id),{code:'E_ARCHIVE_FENCE_TIMEOUT'});
   const source=await fence.acquireSource(healthy.id);source.release();
  }
 }finally{failUsage();finishFailed();finishHealthy();drainFailed();await Promise.allSettled([failedLaunch,healthyLaunch]);await observed;pool.query=query;worker.closing=undefined;worker.stopped=false;}
});
async function withClientHook<T>(hook:(client:pg.PoolClient,query:any,text:any,args:any[])=>Promise<any>,work:()=>Promise<T>){
 const connect=pool.connect;
 (pool as any).connect=function(callback?:unknown){
  if(typeof callback==='function')return (connect as any).call(pool,callback);
  return (connect as ()=>Promise<pg.PoolClient>).call(pool).then(client=>{const query=client.query,release=client.release;
   (client as any).query=function(text:any,...args:any[]){return hook(client,query,text,args);};
   client.release=function(error?:Error|boolean){client.query=query;client.release=release;release.call(client,error);};return client;
  });
 };
 try{return await work();}finally{pool.connect=connect;}
}
async function approvalApi(){
 const {runManagementRouter}=await import('../apps/api/src/run-management.ts'),app=express();app.use(express.json());app.use(runManagementRouter(traceRoot,worker.writers));
 app.use((error:any,_req:any,res:any,_next:any)=>res.status(error.status??500).json({message:error.message}));
 const server=app.listen(0,'127.0.0.1');await once(server,'listening');
 return {async decide(id:string){const response=await fetch('http://127.0.0.1:'+(server.address() as any).port+'/approvals/'+id,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({decision:'denied'})});return {status:response.status,data:await response.json()};},async close(){server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));}};
}
test('Task2c3 local recovery retains source through receipt replay and rechecks after native waiting',{skip:!isolated,timeout:15000},async()=>{
 const f=await fixture(),usage={id:randomUUID(),modelId:'recovery-model',inputTokens:2,outputTokens:1,cost:0};
 await pool.query("UPDATE project_runs SET snapshot=jsonb_set(snapshot,'{executionTarget}','{\"kind\":\"local\"}'),lease_until=now()-interval '1 minute' WHERE id=$1",[f.id]);
 const {openRunArchive}=await import('../services/agent-runtime/trace-store.mjs');openRunArchive(traceRoot,f.id).append('billing/usage',usage);
 const fence=createArchiveWriteFence({traceRoot,lockRoot:join(root,'.archive-write-locks')}),source=await fence.acquireSource(f.id),connect=pool.connect;let connects=0;
 (pool as any).connect=function(...args:any[]){connects++;return (connect as any).apply(pool,args);};
 // Global expiry and read-only discovery connect; claiming cannot connect yet.
 const recovery=worker.recover();
 try{await new Promise(done=>setTimeout(done,50));assert.equal(connects,2);pool.connect=connect;
  await pool.query("UPDATE project_runs SET lease_until=now()+interval '1 minute',lease_owner='renewed' WHERE id=$1",[f.id]);
 }finally{pool.connect=connect;source.release();await recovery;}
 assert.equal((await stored(f.id)).lease_owner,'renewed');assert.equal((await pool.query('SELECT count(*)::int AS n FROM usage WHERE run_id=$1',[f.id])).rows[0].n,0);
 await pool.query("UPDATE project_runs SET lease_until=now()-interval '1 minute' WHERE id=$1",[f.id]);
 const original=worker.recordUsage;let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(done=>{release=done;}),started=new Promise<void>(done=>{entered=done;});
 worker.recordUsage=async(id,u)=>{entered();await gate;return original.call(worker,id,u);};
 const replay=worker.recover();let probe:Awaited<ReturnType<typeof sourceProbe>>|undefined;
 try{await started;probe=await sourceProbe(f.id);assert.equal((await stored(f.id)).status,'running');release();await replay;await probe.acquire();assert.equal((await stored(f.id)).status,'interrupted');assert.equal((await pool.query('SELECT count(*)::int AS n FROM usage WHERE id=$1',[usage.id])).rows[0].n,1);}
 finally{release();worker.recordUsage=original;await replay;await probe?.stop();}
});

test('Task2c3 denied approval and duplicate usage drain after ordinary bookkeeping',{skip:!isolated,timeout:15000},async()=>{
 const f=await fixture(),usage={id:randomUUID(),modelId:'recovery-model',inputTokens:2,outputTokens:1,cost:0},owner=await worker.writers.acquireOwner([f.id]),probe=await sourceProbe(f.id);
 try{await owner.run(async()=>{
  await worker.recordUsage(f.id,usage);await worker.recordUsage(f.id,usage);
  const pending=worker.approveTool({runId:f.id,agentId:'employee-1',tool:'terminal',arguments:{}});const observed=assert.rejects(pending,/未获批准/);
  while(!(await pool.query('SELECT id FROM tool_approvals WHERE run_id=$1',[f.id])).rowCount)await wait();
  await pool.query("UPDATE tool_approvals SET status='denied' WHERE run_id=$1",[f.id]);await observed;
 });owner.finish();await owner.writerDrained;await probe.acquire();assert.equal((await pool.query('SELECT count(*)::int AS n FROM usage WHERE id=$1',[usage.id])).rows[0].n,1);}
 finally{await probe.stop();}
});

test('Task2c3 HTTP approval commit and competition retain then release original writer',{skip:!isolated,timeout:15000},async()=>{
 const f=await fixture(),id=randomUUID(),api=await approvalApi();await pool.query("INSERT INTO tool_approvals(id,run_id,agent_id,tool,arguments) VALUES($1,$2,'employee-1','terminal','{}')",[id,f.id]);
 let release!:()=>void,entered!:()=>void;const held=new Promise<void>(done=>{release=done;}),started=new Promise<void>(done=>{entered=done;});
 try{await withClientHook(async(client,query,text,args)=>{if(text==='COMMIT'){entered();await held;}return query.call(client,text,...args);},async()=>{
  const deciding=api.decide(id);await started;const probe=await sourceProbe(f.id);
  try{release();assert.equal((await deciding).status,200);await probe.acquire();}finally{release();await probe.stop();}
 });assert.equal((await api.decide(id)).status,409);const source=await createArchiveWriteFence({traceRoot,lockRoot:join(root,'.archive-write-locks')}).acquireSource(f.id);source.release();assert.equal(readRun(traceRoot,f.id)!.events.filter(e=>e.type==='approval/decided').length,1);}
 finally{release();await api.close();}
});

test('Task2c3 trace integrity and rollback failure preserve original cause and latch owner',{skip:!isolated,timeout:15000},async()=>{
 const state=await import('../apps/api/src/run-state.ts'),f=await fixture(),owner=await worker.writers.acquireOwner([f.id]),probe=await sourceProbe(f.id);
 appendFileSync(join(traceRoot,f.id,'events.jsonl'),'corrupt');let original:unknown;
 try{await withClientHook(async(client,query,text,args)=>{const result=await query.call(client,text,...args);if(text==='ROLLBACK')throw Error('secondary rollback failure');return result;},async()=>{
  await owner.run(async()=>{try{await state.finishRun(worker.writers,f.id,worker.owner,'interrupted',null,row=>worker.traceFinished(row,'interrupted','test'));}catch(error){original=error;}});
 });owner.finish();await assert.rejects(owner.writerDrained,error=>error===original);assert.match((original as Error).message,/incomplete/);assert.equal((await stored(f.id)).status,'running');await assert.rejects(createArchiveWriteFence({traceRoot,lockRoot:join(root,'.archive-write-locks')}).acquireSource(f.id),{code:'E_ARCHIVE_FENCE_TIMEOUT'});}
 finally{await probe.stop();}
});

test('Task2c3 HTTP approval append failure never succeeds or releases',{skip:!isolated,timeout:15000},async()=>{
 const f=await fixture(),id=randomUUID(),api=await approvalApi();await pool.query("INSERT INTO tool_approvals(id,run_id,agent_id,tool,arguments) VALUES($1,$2,'employee-1','terminal','{}')",[id,f.id]);appendFileSync(join(traceRoot,f.id,'events.jsonl'),'corrupt');
 try{assert.equal((await api.decide(id)).status,500);assert.equal((await pool.query('SELECT status FROM tool_approvals WHERE id=$1',[id])).rows[0].status,'pending');const probe=await sourceProbe(f.id);await probe.stop();}
 finally{await api.close();}
});
for(const afterCommit of [false,true])test('Task2c3 uncertain terminal commit is never retried: '+afterCommit,{skip:!isolated,timeout:15000},async()=>{
 const f=await fixture(),failure=Error('uncertain terminal commit');let release!:()=>void,entered!:()=>void,commits=0,mutations=0;
 const held=new Promise<void>(done=>{release=done;}),started=new Promise<void>(done=>{entered=done;});
 runtime({start:async input=>({runtimeRunId:input.runId,writerDrained:held,completion:Promise.resolve(completed())})});
 await withClientHook(async(client,query,text,args)=>{
  if(typeof text==='string'&&text.startsWith('UPDATE project_runs SET status='))mutations++;
  if(text==='COMMIT'){commits++;if(afterCommit)await query.call(client,text,...args);entered();throw failure;}
  return query.call(client,text,...args);
 },async()=>{const launching=launch(f.row);let probe:Awaited<ReturnType<typeof sourceProbe>>|undefined;
  try{await started;probe=await sourceProbe(f.id);assert.equal((await stored(f.id)).status,afterCommit?'completed':'running');release();await launching;assert.equal(commits,1);assert.equal(mutations,1);assert.equal(worker.active.get(f.id)?.drainFailure,failure);}
  finally{release();await launching;await probe?.stop();}
 });
});

test('Task2c3 approval poll persistence failure keeps its first error without cancellation retry',{skip:!isolated,timeout:15000},async()=>{
 const f=await fixture(),owner=await worker.writers.acquireOwner([f.id]),query=pool.query,failure=Error('approval poll persistence failure');
 (pool as any).query=function(text:any,...args:any[]){if(text==='SELECT status FROM tool_approvals WHERE id=$1')throw failure;return (query as any).call(pool,text,...args);};
 try{await owner.run(async()=>{await assert.rejects(worker.approveTool({runId:f.id,agentId:'employee-1',tool:'terminal',arguments:{}}),error=>error===failure);});owner.finish();await assert.rejects(owner.writerDrained,error=>error===failure);assert.equal((await pool.query('SELECT status FROM tool_approvals WHERE run_id=$1',[f.id])).rows[0].status,'pending');const probe=await sourceProbe(f.id);await probe.stop();}
 finally{pool.query=query;}
});

test('Task2c3 locked legacy target change defers operations and replay while global expiry remains active',{skip:!isolated},async()=>{
 const f=await fixture(),device=randomUUID(),receipt=await unknownReceipt(f),operation=randomUUID();
 await pool.query("INSERT INTO local_devices(id,token_hash,name,platform,grant_id,label) VALUES($1,'fixture','fixture','win32','grant','fixture')",[device]);
 await pool.query("INSERT INTO local_operations(id,device_id,run_id,grant_id,lease_owner,payload,status) VALUES($1,$2,$3,'grant',$4,'{}','queued')",[operation,device,f.id,worker.owner]);
 await pool.query("UPDATE model_reservations SET status='pending',expires_at=now()-interval '1 minute' WHERE id=$1",[receipt.id]);
 await pool.query("UPDATE project_runs SET snapshot=jsonb_set(snapshot,'{executionTarget}','{\"kind\":\"local\"}'),lease_until=now()-interval '1 minute' WHERE id=$1",[f.id]);
 let changed=false;await withClientHook(async(client,query,text,args)=>{
  if(!changed&&text==='SELECT * FROM project_runs WHERE id=$1 FOR UPDATE'){changed=true;await query.call(client,"UPDATE project_runs SET snapshot=jsonb_set(snapshot,'{executionTarget}','{\"kind\":\"docker\"}') WHERE id=$1",[f.id]);}
  return query.call(client,text,...args);
 },()=>worker.recover());await worker.recover();
 assert.equal(changed,true);assert.equal((await stored(f.id)).status,'running');assert.equal((await stored(f.id)).lease_owner,worker.owner);
 assert.equal((await pool.query('SELECT status FROM local_operations WHERE id=$1',[operation])).rows[0].status,'queued');assert.deepEqual(endings(f.id),[]);
 const storedReceipt=(await pool.query('SELECT * FROM model_reservations WHERE id=$1',[receipt.id])).rows[0];assert.equal(storedReceipt.status,'uncertain');assert.equal(storedReceipt.amount,receipt.amount);assert.deepEqual(storedReceipt.history.slice(0,1),receipt.history);assert.equal(storedReceipt.history.length,2);
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM usage WHERE run_id=$1',[f.id])).rows[0].n,0);
});
test('Task2c3 consumed usage persistence failure stays excluded after completed runtime and original drain',{skip:!isolated,timeout:15000},async()=>{
 const f=await fixture(),query=pool.query,failure=Error('consumed usage persistence failure');let release!:()=>void,recorded!:()=>void;
 const drain=new Promise<void>(done=>{release=done;}),consumed=new Promise<void>(done=>{recorded=done;});
 (pool as any).query=function(text:any,...args:any[]){if(text==='SELECT id FROM model_reservations WHERE id=$1')throw failure;return (query as any).call(pool,text,...args);};
 runtime({start:async input=>({runtimeRunId:input.runId,writerDrained:drain,completion:(async()=>{await assert.rejects(worker.recordUsage(f.id,{id:randomUUID()} as any),error=>error===failure);recorded();return completed();})()})});
 const launching=launch(f.row);let probe:Awaited<ReturnType<typeof sourceProbe>>|undefined;
 try{await consumed;probe=await sourceProbe(f.id);assert.equal((await stored(f.id)).status,'running');release();await launching;assert.equal(worker.active.get(f.id)?.phase,'drain-failed');assert.equal(worker.active.get(f.id)?.drainFailure,failure);await assert.rejects(createArchiveWriteFence({traceRoot,lockRoot:join(root,'.archive-write-locks')}).acquireSource(f.id),{code:'E_ARCHIVE_FENCE_TIMEOUT'});}
 finally{pool.query=query;release();await launching;await probe?.stop();}
});

test('Task2c3 legacy recovery is unchanged on repeated scans',{skip:!isolated,timeout:15000},async()=>{
 const f=await fixture();await pool.query("UPDATE project_runs SET lease_until=now()-interval '1 minute' WHERE id=$1",[f.id]);
 const before=await stored(f.id),events=readRun(traceRoot,f.id)!.events,receipt=await unknownReceipt(f);
 await worker.recover();await worker.recover();assert.deepEqual(await stored(f.id),before);assert.deepEqual(readRun(traceRoot,f.id)!.events,events);
 assert.deepEqual((await pool.query('SELECT * FROM model_reservations WHERE id=$1',[receipt.id])).rows[0],receipt);
 const source=await createArchiveWriteFence({traceRoot,lockRoot:join(root,'.archive-write-locks')}).acquireSource(f.id);source.release();
});

test('Task2c3 state assertion precedes SQL and normal null/false results drain',{skip:!isolated},async()=>{
 const state=await import('../apps/api/src/run-state.ts'),f=await fixture(),connect=pool.connect;let connections=0;
 (pool as any).connect=function(...args:any[]){connections++;return (connect as any).apply(pool,args);};
 try{await assert.rejects((state.finishRun as any)(worker.writers,f.id,worker.owner,'completed'),{code:'E_ARCHIVE_WRITER_SCOPE'});assert.equal(connections,0);}
 finally{pool.connect=connect;}
 await worker.writers.withWriter([f.id],async()=>{assert.equal(await (state.claimExpiredRun as any)(worker.writers,f.id),null);assert.equal(await (state.finishRun as any)(worker.writers,f.id,'foreign','completed'),false);});
 const source=await createArchiveWriteFence({traceRoot,lockRoot:join(root,'.archive-write-locks')}).acquireSource(f.id);source.release();
});
async function idle(){const deadline=Date.now()+5000;while(Date.now()<deadline){if(!worker.active.size&&!worker.ticking)return;await new Promise(done=>setTimeout(done,5));}throw Error('isolated coordinator did not settle');}
async function launch(row:any){await worker.launch(row);}
async function unknownReceipt(f:Awaited<ReturnType<typeof fixture>>){
 const id=randomUUID();
 await pool.query("INSERT INTO model_reservations(id,model_id,project_id,run_id,purpose,amount,input_rate,output_rate,status,context,history) VALUES($1,'recovery-model',$2,$3,'fixture',.096526,0,0,'uncertain',$4,$5)",[id,f.projectId,f.id,{originalRequest:'untouched'},JSON.stringify([{source:'fixture',note:'unknown original request'}])]);
 return (await pool.query('SELECT * FROM model_reservations WHERE id=$1',[id])).rows[0];
}

test('trusted accepted recording-incomplete completion remains SQL completed without a fabricated terminal trace',{skip:!isolated},async()=>{
 const f=await fixture(),receipt=await unknownReceipt(f);
 runtime({start:async input=>({runtimeRunId:input.runId,writerDrained:Promise.resolve(),completion:Promise.resolve(completed('incomplete'))})});
 await launch(f.row);
 const row=await stored(f.id);assert.equal(row.status,'completed');assert.match(row.error,/待核对|记录不完整/);
 assert.equal((await pool.query('SELECT status FROM projects WHERE id=$1',[f.projectId])).rows[0].status,'COMPLETED');
 assert.deepEqual(endings(f.id),[]);assert.deepEqual((await pool.query('SELECT * FROM model_reservations WHERE id=$1',[receipt.id])).rows[0],receipt);
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM usage WHERE run_id=$1',[f.id])).rows[0].n,0);
});

test('usage replay error after trusted completion cannot rewrite business failure or invent usage',{skip:!isolated},async()=>{
 const f=await fixture(),receipt=await unknownReceipt(f),original=worker.recordUsage;
 runtime({start:async input=>({runtimeRunId:input.runId,writerDrained:Promise.resolve(),completion:Promise.resolve(completed('complete',[{id:receipt.id,modelId:'recovery-model',inputTokens:4,outputTokens:2,cost:0}]))})});
 worker.recordUsage=async()=>{throw Error('PRIVATE_USAGE_REPLAY_FAILURE');};
 try{await launch(f.row);}finally{worker.recordUsage=original;}
 const row=await stored(f.id);assert.equal(row.status,'running');assert.equal(row.error,null);assert.equal(worker.active.get(f.id)?.phase,'drain-failed');
 assert.deepEqual(endings(f.id),[]);assert.equal((await pool.query('SELECT count(*)::int AS n FROM usage WHERE run_id=$1',[f.id])).rows[0].n,0);
 assert.deepEqual((await pool.query('SELECT * FROM model_reservations WHERE id=$1',[receipt.id])).rows[0],receipt);
});

test('finish bookkeeping error after trusted completion retains pending reconciliation without retry',{skip:!isolated},async()=>{
 const f=await fixture(),connect=pool.connect;let injected=0;
 (pool as any).connect=function(callback?:unknown){
  if(typeof callback==='function')return (connect as any).call(pool,callback);
  return (connect as ()=>Promise<pg.PoolClient>).call(pool).then(client=>{
  const query=client.query,release=client.release;
  (client as any).query=function(text:any,...args:any[]){if(!injected&&typeof text==='string'&&text.startsWith('UPDATE projects SET status=')){injected++;throw Error('PRIVATE_FINISH_BOOKKEEPING_FAILURE');}return (query as any).call(client,text,...args);};
  client.release=function(error?:Error|boolean){client.query=query;client.release=release;release.call(client,error);};return client;
  });
 };
 try{await launch(f.row);}finally{pool.connect=connect;}
 assert.equal(injected,1);const row=await stored(f.id);assert.equal(row.status,'running');assert.equal(row.error,null);assert.match(worker.active.get(f.id)?.drainFailure?.message??'',/PRIVATE_FINISH/);
 assert.equal((await pool.query('SELECT status FROM projects WHERE id=$1',[f.projectId])).rows[0].status,'RUNNING');assert.deepEqual(endings(f.id),[]);
});

test('cancellation after trusted acceptance cannot turn bookkeeping uncertainty into business cancellation or failure',{skip:!isolated},async()=>{
 const f=await fixture(),original=worker.recordUsage;
 runtime({start:async input=>({runtimeRunId:input.runId,writerDrained:Promise.resolve(),completion:Promise.resolve(completed('complete',[{id:randomUUID()}]))})});
 worker.recordUsage=async()=>{await worker.cancel(f.id);throw Error('PRIVATE_POST_ACCEPTANCE_REPLAY_FAILURE');};
 try{await launch(f.row);}finally{worker.recordUsage=original;}
 const row=await stored(f.id);assert.equal(row.status,'running');assert.equal(row.cancel_requested,true);assert.equal(row.error,null);assert.deepEqual(endings(f.id),[]);
});

test('trusted acceptance fallback cannot overwrite a replacement owner after replay bookkeeping loses ownership',{skip:!isolated},async()=>{
 const f=await fixture(),original=worker.recordUsage;
 runtime({start:async input=>({runtimeRunId:input.runId,writerDrained:Promise.resolve(),completion:Promise.resolve(completed('complete',[{id:randomUUID()}]))})});
 worker.recordUsage=async()=>{await pool.query("UPDATE project_runs SET lease_owner='replacement-owner' WHERE id=$1",[f.id]);throw Error('PRIVATE_POST_ACCEPTANCE_OWNER_CHANGE');};
 try{await launch(f.row);}finally{worker.recordUsage=original;}
 const row=await stored(f.id);assert.equal(row.status,'running');assert.equal(row.lease_owner,'replacement-owner');assert.deepEqual(endings(f.id),[]);
});

test('an ordinary pre-completion runtime rejection retains the existing failed classification',{skip:!isolated},async()=>{
 const f=await fixture();runtime({start:async()=>{throw Error('ordinary fixture startup failure');}});
 await launch(f.row);assert.equal((await stored(f.id)).status,'failed');assert.equal(endings(f.id).at(-1)!.data.status,'failed');
});

test('tick leaves a quarantined project queued and unprepared until the same close promise settles',{skip:!isolated},async()=>{
 const f=await fixture('queued');let releaseClose!:()=>void,quarantined=true;
 const closing=new Promise<void>(resolve=>{releaseClose=resolve;});void closing.then(()=>{quarantined=false;});
 const r=runtime({ready:()=>!quarantined,start:async input=>{if(quarantined)throw pending();return {runtimeRunId:input.runId,writerDrained:Promise.resolve(),completion:Promise.resolve(completed())};}});
 await worker.tick();await idle();
 assert.equal((await stored(f.id)).status,'queued');assert.equal(r.starts,0);assert.equal(existsSync(f.path),false);assert.deepEqual(endings(f.id),[]);
 await worker.tick();assert.equal(r.starts,0);releaseClose();await closing;await wait();
 await Promise.all([worker.tick(),worker.tick()]);await idle();
 assert.equal((await stored(f.id)).status,'completed');assert.equal(r.starts,1);assert.equal(readFileSync(f.path,'utf8'),f.file.content);
});

test('launch readiness check defers an already claimed run before any workspace preparation',{skip:!isolated},async()=>{
 const f=await fixture(),r=runtime({ready:()=>false,start:async()=>{throw pending();}});
 await launch(f.row);const row=await stored(f.id);assert.equal(row.status,'queued');assert.equal(row.lease_owner,null);assert.equal(row.lease_until,null);
 assert.equal(row.attempt,1);assert.equal(r.starts,0);assert.equal(existsSync(f.path),false);assert.deepEqual(endings(f.id),[]);
});

test('check-to-start quarantine race defers the same attempt before input preparation and prepares once after release',{skip:!isolated},async()=>{
 const f=await fixture();let quarantined=false,rejectOnce=true,prepared=0;
 const r=runtime({ready:()=>!quarantined,start:async input=>{
  if(rejectOnce){rejectOnce=false;quarantined=true;throw pending();}
  prepared++;return {runtimeRunId:input.runId,writerDrained:Promise.resolve(),completion:Promise.resolve(completed())};
 }});
 await launch(f.row);const deferred=await stored(f.id);assert.equal(deferred.status,'queued');assert.equal(deferred.lease_owner,null);assert.equal(deferred.attempt,1);
 assert.equal(prepared,0);assert.equal(existsSync(f.path),false);assert.deepEqual(endings(f.id),[]);
 quarantined=false;await worker.tick();await idle();
 assert.equal((await stored(f.id)).status,'completed');assert.equal(prepared,1);assert.equal(r.starts,2);assert.equal(readFileSync(f.path,'utf8'),f.file.content);
});

for(const effect of ['local-operation','uncertain-reservation','settled-reservation','usage'])test('quarantine cannot requeue a run with existing '+effect+' evidence',{skip:!isolated},async()=>{
 const f=await fixture();
 if(effect==='local-operation'){
  const device=randomUUID();await pool.query("INSERT INTO local_devices(id,token_hash,name,platform,grant_id,label) VALUES($1,'fixture','fixture','win32','grant','fixture')",[device]);
  await pool.query("INSERT INTO local_operations(id,device_id,run_id,grant_id,lease_owner,payload,status) VALUES($1,$2,$3,'grant',$4,'{}','queued')",[randomUUID(),device,f.id,worker.owner]);
 }else if(effect==='usage')await pool.query("INSERT INTO usage(id,model_id,project_id,run_id,input_tokens,output_tokens,cost,purpose) VALUES($1,'recovery-model',$2,$3,1,1,0,'fixture')",[randomUUID(),f.projectId,f.id]);
 else {const receipt=await unknownReceipt(f);if(effect==='settled-reservation')await pool.query("UPDATE model_reservations SET status='settled' WHERE id=$1",[receipt.id]);}
 const before=await stored(f.id);runtime({ready:()=>false,start:async()=>{throw pending();}});
 await launch(f.row);const after=await stored(f.id);assert.equal(after.status,'running');assert.equal(after.lease_owner,before.lease_owner);assert.equal(after.attempt,before.attempt);assert.deepEqual(endings(f.id),[]);
 assert.equal(existsSync(f.path),false);
});

test('cancel racing the quarantine rejection remains cancelled and cannot revive as queued',{skip:!isolated},async()=>{
 const f=await fixture();runtime({start:async()=>{await worker.cancel(f.id);throw pending();}});
 await launch(f.row);const row=await stored(f.id);assert.equal(row.status,'cancelled');assert.equal(row.cancel_requested,true);assert.equal(row.lease_owner,null);
 assert.equal((await pool.query('SELECT status FROM projects WHERE id=$1',[f.projectId])).rows[0].status,'CANCELLED');assert.deepEqual(endings(f.id),[]);
});

for(const changed of ['foreign-owner','expired-lease','project-version','attempt','successor'])test('quarantine defer respects '+changed+' fencing',{skip:!isolated},async()=>{
 const f=await fixture();let successor:string|undefined;
 runtime({start:async()=>{
  if(changed==='foreign-owner')await pool.query("UPDATE project_runs SET lease_owner='foreign-worker' WHERE id=$1",[f.id]);
  else if(changed==='expired-lease')await pool.query("UPDATE project_runs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",[f.id]);
  else if(changed==='project-version')await pool.query('UPDATE projects SET version=2 WHERE id=$1',[f.projectId]);
  else if(changed==='attempt')await pool.query('UPDATE project_runs SET attempt=2 WHERE id=$1',[f.id]);
  else {successor=randomUUID();await pool.query("INSERT INTO project_runs(id,project_id,project_version,status,snapshot,attempt,parent_run_id) VALUES($1,$2,1,'queued',$3,2,$4)",[successor,f.projectId,f.snapshot,f.id]);await pool.query("UPDATE projects SET status='QUEUED' WHERE id=$1",[f.projectId]);}
  throw pending();
 }});
 await launch(f.row);const row=await stored(f.id);assert.equal(row.status,'running');assert.deepEqual(endings(f.id),[]);
 if(changed==='foreign-owner')assert.equal(row.lease_owner,'foreign-worker');
 if(successor){assert.equal((await stored(successor)).status,'queued');assert.equal((await pool.query('SELECT status FROM projects WHERE id=$1',[f.projectId])).rows[0].status,'QUEUED');}
});
