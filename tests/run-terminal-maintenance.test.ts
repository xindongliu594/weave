import {before,after,beforeEach,test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {existsSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import type pg from 'pg';
import {recoveryModel} from './model-fixture.ts';
import {createRunArchive,readRun} from '../services/agent-runtime/trace-store.mjs';

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
 process.env.DATA_DIR=root;process.env.TRACE_ROOT=traceRoot;process.env.OBSIDIAN_VAULT=join(root,'vault');
 const db=await import('../apps/api/src/db.ts');pool=db.pool;await db.migrate();
 const {RunCoordinator}=await import('../apps/api/src/run-coordinator.ts');worker=new RunCoordinator(traceRoot);await worker.close();
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
 await rm(root,{recursive:true,force:true});
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
 worker.active.set(f.id,{projectId:f.projectId});
 const launching=worker.launch(f.row);let ended=false;launching.then(()=>{ended=true;});
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
 worker.active.set(f.id,{projectId:f.projectId});
 try{
  const heartbeat=worker.heartbeat();await started;
  await worker.launch(f.row);assert.equal((await stored(f.id)).status,'completed');assert.equal(worker.active.has(f.id),false);
  const closing=worker.close();let closed=false;closing.then(()=>{closed=true;});await wait();assert.equal(closed,false);
  release();await heartbeat;await closing;assert.equal(cancels,0);
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
const endings=(id:string)=>readRun(traceRoot,id)!.events.filter(event=>event.type==='run/finished');
async function idle(){const deadline=Date.now()+5000;while(Date.now()<deadline){if(!worker.active.size&&!worker.ticking)return;await new Promise(done=>setTimeout(done,5));}throw Error('isolated coordinator did not settle');}
async function launch(row:any){worker.active.set(row.id,{projectId:row.project_id});await worker.launch(row);}
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
 const row=await stored(f.id);assert.equal(row.status,'completed');assert.match(row.error,/待核对|记录不完整/);assert.ok(!row.error.includes('PRIVATE_USAGE'));
 assert.deepEqual(endings(f.id),[]);assert.equal((await pool.query('SELECT count(*)::int AS n FROM usage WHERE run_id=$1',[f.id])).rows[0].n,0);
 assert.deepEqual((await pool.query('SELECT * FROM model_reservations WHERE id=$1',[receipt.id])).rows[0],receipt);
});

test('finish bookkeeping error after trusted completion retries completed bookkeeping without failed trace',{skip:!isolated},async()=>{
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
 assert.equal(injected,1);const row=await stored(f.id);assert.equal(row.status,'completed');assert.match(row.error,/待核对|记录不完整/);assert.ok(!row.error.includes('PRIVATE_FINISH'));
 assert.equal((await pool.query('SELECT status FROM projects WHERE id=$1',[f.projectId])).rows[0].status,'COMPLETED');assert.deepEqual(endings(f.id),[]);
});

test('cancellation after trusted acceptance cannot turn bookkeeping uncertainty into business cancellation or failure',{skip:!isolated},async()=>{
 const f=await fixture(),original=worker.recordUsage;
 runtime({start:async input=>({runtimeRunId:input.runId,writerDrained:Promise.resolve(),completion:Promise.resolve(completed('complete',[{id:randomUUID()}]))})});
 worker.recordUsage=async()=>{await worker.cancel(f.id);throw Error('PRIVATE_POST_ACCEPTANCE_REPLAY_FAILURE');};
 try{await launch(f.row);}finally{worker.recordUsage=original;}
 const row=await stored(f.id);assert.equal(row.status,'completed');assert.equal(row.cancel_requested,true);assert.match(row.error,/待核对|记录不完整/);assert.deepEqual(endings(f.id),[]);
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
