import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type pg from 'pg';
import {mkdtemp} from 'node:fs/promises';
import {writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {once} from 'node:events';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createArchiveWriterManager} from '../services/agent-runtime/archive-writer-scope.mjs';
import {createArchiveWriteFence} from '../services/agent-runtime/archive-write-fence.mjs';
import {createRunArchive,readRun} from '../services/agent-runtime/trace-store.mjs';

// Actual SQL, native process locks and HTTP protocol; no device/model dispatch.
// PGlite cannot prove independent PostgreSQL backend locking or disconnect tails.
const isolated=process.env.SIMULATED_INTEGRATION==='pglite';
let pool:pg.Pool,root:string,traceRoot:string,url:string,server:any;
let local:typeof import('../apps/api/src/local-execution.ts');
let writers:ReturnType<typeof createArchiveWriterManager>,fence:ReturnType<typeof createArchiveWriteFence>;
const employee={id:'employee',name:'fixture',title:'manager',role:'manager',modelId:'unused',tools:[],instructions:'Fixture only'};
const token='a'.repeat(64),departmentId='local-writer-fixture';
before(async()=>{
 if(!isolated)return;
 assert.match(process.env.DATABASE_URL??'',/^postgresql:\/\/postgres:postgres@127\.0\.0\.1:\d+\/postgres$/);
 root=await mkdtemp(join(tmpdir(),'local-operation-writer-'));traceRoot=join(root,'runs');
 console.log('ARCHIVE_WRITER_FIXTURE_CREATED='+JSON.stringify({root,pid:process.pid}));
 process.env.DATA_DIR=root;process.env.TRACE_ROOT=traceRoot;process.env.OBSIDIAN_VAULT=join(root,'vault');
 const db=await import('../apps/api/src/db.ts');pool=db.pool;await db.migrate();
 await pool.query('INSERT INTO departments(id,data) VALUES($1,$2)',[departmentId,{name:'Fixture',agents:[employee]}]);
 writers=createArchiveWriterManager({traceRoot});fence=createArchiveWriteFence({traceRoot,lockRoot:writers.lockRoot});
 local=await import('../apps/api/src/local-execution.ts');
 const app=express();app.use(express.json());app.use(local.localDeviceRouter(traceRoot,writers));
 app.use((error:any,_req:any,res:any,_next:any)=>res.status(error.status??500).json({code:error.code,message:error.message}));
 server=app.listen(0,'127.0.0.1');await once(server,'listening');url='http://127.0.0.1:'+server.address().port;
});
after(async()=>{
 if(!isolated)return;
 if(server){server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));}await pool?.end();
 // Failure cases keep original guards until process exit; no test-only unlock.
 console.log('ARCHIVE_WRITER_EXIT_CLEANUP='+root);
});
async function fixture(status='claimed',started=false){
 const runId=randomUUID(),projectId=randomUUID(),deviceId=randomUUID(),grantId=randomUUID(),owner=randomUUID(),id=randomUUID(),claimToken=randomUUID();
 const policy={maxBudget:1,maxAgents:1,maxConcurrentAgents:1,maxModelCalls:10,deadlineSeconds:300,executionTarget:{kind:'local',deviceId,grantId}};
 const snapshot={projectId,planVersion:1,departmentId,policy,agents:[employee],tasks:[],executionTarget:{...policy.executionTarget,platform:process.platform}};
 await pool.query('INSERT INTO local_devices(id,token_hash,name,platform,grant_id,label,allow_commands) VALUES($1,$2,$3,$4,$5,$6,true)',[deviceId,createHash('sha256').update(token).digest('hex'),'Fixture',process.platform,grantId,'Fixture']);
 await pool.query('INSERT INTO projects(id,department_id,department_version,department_name,requirement,policy,plan,source) VALUES($1,$2,1,$3,$4,$5,$6,$7)',[projectId,departmentId,'Fixture','Fixture',policy,{agents:[employee],tasks:[]},'manual']);
 await pool.query("INSERT INTO project_runs(id,project_id,project_version,status,snapshot,lease_owner,lease_until) VALUES($1,$2,1,'running',$3,$4,clock_timestamp()+interval '5 minutes')",[runId,projectId,snapshot,owner]);
 await pool.query('INSERT INTO local_operations(id,device_id,run_id,grant_id,lease_owner,payload,status,started,claim_token) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[id,deviceId,runId,grantId,owner,{runId,deviceId,grantId,name:'prepare',arguments:{},context:{},files:[]},status,started,claimToken]);
 const archive=createRunArchive(traceRoot,snapshot,{id:runId}),service=new local.LocalOperationService(traceRoot,owner,writers);
 return {runId,projectId,deviceId,grantId,owner,id,claimToken,archive,snapshot,service};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
async function call(f:Fixture,action:string,body:any={}){
 const path=action==='poll'?'/poll':'/operations/'+f.id+'/'+action;
 const response=await fetch(url+'/local-devices/'+f.deviceId+path,{method:'POST',headers:{'content-type':'application/json','X-Local-Device-Key':token},body:JSON.stringify(body)});
 return {status:response.status,data:await response.json() as any};
}
const row=async(f:Fixture)=>(await pool.query('SELECT * FROM local_operations WHERE id=$1',[f.id])).rows[0];
const pause=(ms:number)=>new Promise<void>(done=>setTimeout(done,ms));
const gate=()=>{let release!:()=>void;const promise=new Promise<void>(done=>release=done);return {promise,release};};
async function reached(promise:Promise<void>){let timer:NodeJS.Timeout|undefined;try{await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('original transaction did not reach commit')),3000);})]);}finally{clearTimeout(timer);}}
async function probe(runId:string){
 const child=spawn(process.execPath,[fileURLToPath(new URL('./fixtures/archive-admission-probe.mjs',import.meta.url))],{windowsHide:true,stdio:['ignore','inherit','inherit','ipc'],env:{...process.env,ARCHIVE_WRITER_TEST:JSON.stringify({traceRoot,lockRoot:writers.lockRoot,runId})}});
 const exited=once(child,'exit');let timer:NodeJS.Timeout|undefined;
 try{return await Promise.race([once(child,'message').then(([value])=>value),exited.then(()=>{throw Error('probe exited early');}),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('probe timeout')),10000);})]);}
 finally{clearTimeout(timer);if(child.exitCode===null&&child.signalCode===null)child.kill();await exited;}
}
type Hook=(sql:string,next:()=>Promise<any>,raw:(sql:string,values?:any[])=>Promise<any>)=>Promise<any>;
async function intercept(hook:Hook,work:()=>Promise<void>,released:(value:any)=>void=()=>{}){
 const connect=pool.connect,poolQuery=pool.query;
 (pool as any).query=(sql:any,...args:any[])=>hook(typeof sql==='string'?sql:sql.text,()=>Promise.resolve((poolQuery as any).call(pool,sql,...args)),(text,values)=>Promise.resolve((poolQuery as any).call(pool,text,values)));
 (pool as any).connect=function(callback?:any){
  if(typeof callback==='function')return (connect as any).call(pool,callback);
  return (connect as ()=>Promise<pg.PoolClient>).call(pool).then(client=>{
   const query=client.query,release=client.release;
   (client as any).query=(sql:any,...args:any[])=>hook(typeof sql==='string'?sql:sql.text,()=>Promise.resolve((query as any).call(client,sql,...args)),(text,values)=>Promise.resolve((query as any).call(client,text,values)));
   client.release=function(value?:any){client.query=query;client.release=release;released(value);release.call(client,value);};return client;
  });
 };
 try{await work();}finally{pool.connect=connect;pool.query=poolQuery;}
}

for(const kind of ['start','enqueue','close'] as const)test(kind+' waits for native source before SQL and rechecks current state',{skip:!isolated,timeout:20000},async()=>{
 const f=await fixture(),source=await fence.acquireSource(f.runId),abort=new AbortController();let begins=0,pending:Promise<any>|undefined,wasReleased=false,settled=false;
 const executor=new local.LocalRunExecutor(f.archive,f.snapshot,f.service);
 try{await intercept(async(sql,next)=>{if(sql==='BEGIN')begins++;return next();},async()=>{
  pending=kind==='start'?call(f,'start',{claimToken:f.claimToken}):kind==='enqueue'?f.service.enqueue(f.runId,'prepare',{}, {},[],abort.signal).catch(error=>error):executor.close();
  pending.then(()=>settled=true,()=>settled=true);
  await pause(120);assert.equal(begins,0,'no transaction may start while native source is held');assert.equal(settled,false,'autocommit must also wait for native admission');
  await pool.query('UPDATE project_runs SET cancel_requested=true WHERE id=$1',[f.runId]);
  source.release();wasReleased=true;const result=await pending;
  if(kind==='start')assert.equal(result.status,409);else if(kind==='enqueue')assert.equal(result.code,'LOCAL_LEASE_DENIED');
 });}finally{if(!wasReleased)source.release();await pending;}
 assert.deepEqual(await probe(f.runId),{acquired:true});
});

for(const action of ['poll','start','result','late-result','close'] as const)test(action+' holds writer through the original pending commit',{skip:!isolated,timeout:20000},async()=>{
 const f=await fixture(action==='poll'?'queued':'claimed',action==='result'||action==='late-result');
 if(action==='late-result')await pool.query("UPDATE project_runs SET status='interrupted' WHERE id=$1",[f.runId]);
 const entered=gate(),release=gate();let pending:Promise<any>|undefined,observed:any,updated=false;
 try{await intercept(async(sql,next)=>{
  if(sql.startsWith('UPDATE local_operations'))updated=true;
  if(sql==='COMMIT'&&updated){entered.release();await release.promise;}
  return next();
 },async()=>{
  pending=action==='close'?new local.LocalRunExecutor(f.archive,f.snapshot,f.service).close():action==='poll'?call(f,'poll',{}):call(f,action==='late-result'?'result':action,action==='start'?{claimToken:f.claimToken}:{claimToken:f.claimToken,ok:false,error:{code:'FIXTURE',message:'known failure',notExecuted:true}});
  await reached(entered.promise);observed=await probe(f.runId);release.release();const result=await pending;if(action!=='close')assert.equal(result.status,200,JSON.stringify(result.data));
 });}finally{release.release();await pending;}
 assert.deepEqual(observed,{blocked:true});assert.deepEqual(await probe(f.runId),{acquired:true});
});

test('known protocol rejection and identical stored receipt leave source available',{skip:!isolated},async()=>{
 const f=await fixture('started',true),denied=await call(f,'start',{claimToken:f.claimToken});assert.equal(denied.status,409);
 assert.deepEqual(await probe(f.runId),{acquired:true});
 const body={claimToken:f.claimToken,ok:false,error:{code:'FIXTURE',message:'known failure',notExecuted:true}};
 assert.equal((await call(f,'result',body)).status,200);assert.equal((await call(f,'result',body)).status,200);
 assert.deepEqual(await probe(f.runId),{acquired:true});
});

for(const failure of ['rollback','commit-before','commit-after'] as const)test(failure+' preserves the original failure and native guard without repeating start',{skip:!isolated,timeout:20000},async()=>{
 const f=await fixture();let result:any,updates=0,commits=0,discard:any,primary=new Error('original '+failure);
 await intercept(async(sql,next)=>{
  if(sql.startsWith('UPDATE local_operations')){updates++;if(failure==='rollback')throw primary;}
  if(sql==='ROLLBACK'&&failure==='rollback'){await next();throw Error('rollback acknowledgement lost');}
  if(sql==='COMMIT'){commits++;if(failure==='commit-before')throw primary;if(failure==='commit-after'){await next();throw primary;}}
  return next();
 },async()=>{result=await call(f,'start',{claimToken:f.claimToken});},value=>discard=value);
 assert.equal(result.status,500);assert.equal(result.data.message,primary.message);assert.equal(updates,1);assert.equal(commits,failure==='rollback'?0:1);
 assert.equal(discard,true);assert.equal((await row(f)).status,failure==='commit-after'?'started':'claimed');assert.deepEqual(await probe(f.runId),{blocked:true});
});

test('SQL failure with confirmed pre-commit rollback releases the writer',{skip:!isolated},async()=>{
 const f=await fixture();let result:any;
 await intercept(async(sql,next)=>{if(sql.startsWith('UPDATE local_operations'))throw Error('known rolled-back SQL');return next();},async()=>{result=await call(f,'start',{claimToken:f.claimToken});});
 assert.equal(result.status,500);assert.equal((await row(f)).status,'claimed');assert.deepEqual(await probe(f.runId),{acquired:true});
});

test('wait known admission rejection still commits cancellation after its confirmed rollback',{skip:!isolated},async()=>{
 const f=await fixture();await pool.query('UPDATE projects SET version=version+1 WHERE id=$1',[f.projectId]);
 await assert.rejects(f.service.wait(f.id),{code:'RUN_REAPPROVAL_REQUIRED',notExecuted:true});
 assert.equal((await row(f)).status,'cancelled');assert.deepEqual(await probe(f.runId),{acquired:true});
});

test('enqueue archive failure remains latched after rollback and never retries admission',{skip:!isolated},async()=>{
 const f=await fixture();writeFileSync(join(f.archive.dir,'events.jsonl'),'corrupt\n');let inserts=0,error:any;
 await intercept(async(sql,next)=>{if(sql.startsWith('INSERT INTO local_operations'))inserts++;return next();},async()=>{try{await f.service.enqueue(f.runId,'prepare',{}, {},[]);}catch(caught){error=caught;}});
 assert.ok(error);assert.equal(inserts,1);assert.equal((await pool.query('SELECT count(*)::int AS n FROM local_operations WHERE run_id=$1',[f.runId])).rows[0].n,1);
 assert.deepEqual(await probe(f.runId),{blocked:true});assert.notEqual(readRun(traceRoot,f.runId)?.integrity,'ok');
});

test('wait abort holds source until its original cancellation commit finishes',{skip:!isolated,timeout:20000},async()=>{
 const f=await fixture(),abort=new AbortController(),reason=Error('caller stopped'),entered=gate(),release=gate();abort.abort(reason);
 let changed=false,pending:Promise<any>|undefined,observed:any;
 try{await intercept(async(sql,next)=>{if(sql.startsWith('UPDATE local_operations'))changed=true;if(sql==='COMMIT'&&changed){entered.release();await release.promise;}return next();},async()=>{
  pending=f.service.wait(f.id,abort.signal).catch(error=>error);await reached(entered.promise);observed=await probe(f.runId);release.release();assert.equal(await pending,reason);
 });}finally{release.release();await pending;}
 assert.deepEqual(observed,{blocked:true});assert.equal((await row(f)).status,'cancelled');assert.deepEqual(await probe(f.runId),{acquired:true});
});

test('wait persistence failure does not issue a second cancellation or replace the original error',{skip:!isolated},async()=>{
 const f=await fixture(),original=Error('original wait commit unknown');let updates=0,commits=0,error:any;
 await pool.query('UPDATE project_runs SET cancel_requested=true WHERE id=$1',[f.runId]);
 await intercept(async(sql,next)=>{if(sql.startsWith('UPDATE local_operations'))updates++;if(sql==='COMMIT'){commits++;await next();throw original;}return next();},async()=>{try{await f.service.wait(f.id);}catch(caught){error=caught;}});
 assert.equal(error,original);assert.equal(updates,1);assert.equal(commits,1);assert.deepEqual(await probe(f.runId),{blocked:true});
});

test('nested service writes latch the original owner even when the caller catches the error',{skip:!isolated},async()=>{
 const f=await fixture(),owner=await writers.acquireOwner([f.runId]),original=Error('nested commit lost');let error:any;
 await intercept(async(sql,next)=>{if(sql==='COMMIT'){await next();throw original;}return next();},async()=>{
  await owner.run(async()=>{try{await new local.LocalRunExecutor(f.archive,f.snapshot,f.service).close();}catch(caught){error=caught;}});
 });
 owner.finish();assert.equal(error,original);await assert.rejects(owner.writerDrained,error=>error===original);assert.deepEqual(await probe(f.runId),{blocked:true});
});

for(const action of ['poll-pending','poll-orphan','start','result'] as const)test(action+' revalidates device credential after native waiting',{skip:!isolated,timeout:20000},async()=>{
 const f=await fixture(action==='poll-pending'?'queued':'claimed',action==='result'),source=await fence.acquireSource(f.runId),discovered=gate();let pending:Promise<any>|undefined,released=false;
 try{await intercept(async(sql,next)=>{const value=await next();if(sql==='SELECT run_id FROM local_operations WHERE id=$1')discovered.release();return value;},async()=>{
  pending=action.startsWith('poll')?call(f,'poll',{}):call(f,action,action==='start'?{claimToken:f.claimToken}:{claimToken:f.claimToken,ok:false,error:{code:'FIXTURE',message:'receipt',notExecuted:true}});
  await reached(discovered.promise);await pool.query('UPDATE local_devices SET token_hash=$1 WHERE id=$2',['b'.repeat(64),f.deviceId]);
  source.release();released=true;const result=await pending;assert.equal(result.status,403,JSON.stringify(result.data));
 });}finally{if(!released)source.release();await pending;}
 const stored=await row(f);assert.equal(stored.status,action==='poll-pending'?'queued':'claimed');assert.equal(stored.result,null);assert.equal(stored.late_result,null);assert.deepEqual(await probe(f.runId),{acquired:true});
});

for(const status of ['queued','claimed'])test('poll '+status+' rejects an operation moved to another device while waiting',{skip:!isolated,timeout:20000},async()=>{
 const f=await fixture(status),other=await fixture(),source=await fence.acquireSource(f.runId),discovered=gate();let pending:Promise<any>|undefined,released=false;
 try{await intercept(async(sql,next)=>{const value=await next();if(sql==='SELECT run_id FROM local_operations WHERE id=$1')discovered.release();return value;},async()=>{
  pending=call(f,'poll',{});await reached(discovered.promise);await pool.query('UPDATE local_operations SET device_id=$1,grant_id=$2 WHERE id=$3',[other.deviceId,other.grantId,f.id]);
  source.release();released=true;const result=await pending;assert.equal(result.status,403,JSON.stringify(result.data));
 });}finally{if(!released)source.release();await pending;}
 assert.equal((await row(f)).status,status);assert.deepEqual(await probe(f.runId),{acquired:true});
});

test('device-only heartbeat revalidates credentials in its own SQL transaction',{skip:!isolated},async()=>{
 const f=await fixture();let result:any,changed=false;
 await intercept(async(sql,next,raw)=>{
  const value=await next();if(sql==='BEGIN'&&!changed){changed=true;await raw('UPDATE local_devices SET token_hash=$1 WHERE id=$2',['b'.repeat(64),f.deviceId]);}return value;
 },async()=>{result=await call(f,'poll',{});});
 assert.equal(changed,true);assert.equal(result.status,403,JSON.stringify(result.data));assert.equal((await row(f)).status,'claimed');
});

for(const frozen of [false,true])test((frozen?'frozen':'mutable')+' offline-shaped unknown enqueue commit preserves error without retry',{skip:!isolated},async()=>{
 const f=await fixture(),original=Object.assign(Error('unknown original commit'),{code:'LOCAL_DEVICE_OFFLINE'});if(frozen)Object.freeze(original);
 let commits=0,inserts=0,error:any;
 await intercept(async(sql,next)=>{
  if(sql.startsWith('INSERT INTO local_operations'))inserts++;
  if(sql==='COMMIT'&&++commits===1){await next();throw original;}return next();
 },async()=>{try{await f.service.enqueue(f.runId,'prepare',{}, {},[]);}catch(caught){error=caught;}});
 assert.equal(error,original);assert.equal(inserts,1);assert.equal(commits,1);assert.equal((await pool.query('SELECT count(*)::int AS n FROM local_operations WHERE run_id=$1',[f.runId])).rows[0].n,2);assert.deepEqual(await probe(f.runId),{blocked:true});
});
