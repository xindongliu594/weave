import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,existsSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createArchiveWriterManager} from '../services/agent-runtime/archive-writer-scope.mjs';
import {createArchiveWriteFence} from '../services/agent-runtime/archive-write-fence.mjs';
import {createRunArchive} from '../services/agent-runtime/trace-store.mjs';
import {LocalRunExecutor,LocalOperationService} from '../apps/api/src/local-execution.ts';
import {TaskAcceptedStopLifecycle} from '../apps/api/src/task-accepted-stop.ts';
import {AppError} from '../apps/api/src/provider.ts';
import {pool,migrate} from '../apps/api/src/db.ts';

const isolated=process.env.SIMULATED_INTEGRATION==='pglite';
let root:string,writers:ReturnType<typeof createArchiveWriterManager>,fence:ReturnType<typeof createArchiveWriteFence>;
const signal=()=>new AbortController().signal;
const gate=()=>{let release!:(value?:any)=>void;const promise=new Promise<any>(done=>release=done);return {promise,release};};
const pause=(ms=60)=>new Promise(done=>setTimeout(done,ms));
before(async()=>{if(!isolated)return;root=mkdtempSync(join(tmpdir(),'executor-writer-'));process.env.DATA_DIR=root;process.env.TRACE_ROOT=root;process.env.OBSIDIAN_VAULT=join(root,'vault');writers=createArchiveWriterManager({traceRoot:root});fence=createArchiveWriteFence({traceRoot:root,lockRoot:writers.lockRoot});await migrate();await pool.query('INSERT INTO departments(id,data) VALUES($1,$2)',['department',{name:'fixture',agents:[]}]);});
after(async()=>{if(!isolated)return;await pool.end();console.log('EXECUTOR_WRITER_EXIT_CLEANUP='+JSON.stringify({root,pid:process.pid}));});
async function fixture(){
 const runId=randomUUID(),projectId=randomUUID(),owner=randomUUID(),snapshot={projectId,planVersion:1,executionProfile:'task-attempt-openshell-v1',agents:[],tasks:[]};
 await pool.query("INSERT INTO projects(id,department_id,department_version,department_name,requirement,policy,plan,source) VALUES($1,'department',1,'fixture','fixture','{}','{}','manual')",[projectId]);
 await pool.query("INSERT INTO project_runs(id,project_id,project_version,status,snapshot,lease_owner,lease_until) VALUES($1,$2,1,'running',$3,$4,now()+interval '1 hour')",[runId,projectId,snapshot,owner]);
 const archive=createRunArchive(root,snapshot,{id:runId}),service=new LocalOperationService(root,owner,writers),executor=new LocalRunExecutor(archive,snapshot,service),stops=new TaskAcceptedStopLifecycle(runId,service);
 return {runId,projectId,archive,service,executor,stops};
}
async function available(runId:string){try{const guard=await fence.acquireSource(runId,{timeoutMs:80});guard.release();return true;}catch(error){assert.equal((error as any).code,'E_ARCHIVE_FENCE_TIMEOUT');return false;}}
async function intercept(t:any,hook:(text:string,next:()=>Promise<any>)=>Promise<any>,released:any[]=[]){
 const connect=pool.connect.bind(pool);
 t.mock.method(pool,'connect',function(callback?:any){if(typeof callback==='function')return connect(callback);return (async()=>{const db=await connect(),query=db.query.bind(db),release=db.release.bind(db);db.query=((...args:any[])=>hook(typeof args[0]==='string'?args[0]:args[0].text,()=>query(...args as [any]))) as any;db.release=((value?:any)=>{db.query=query as any;db.release=release;released.push(value);release(value);}) as any;return db;})();});
}
test('executor construction does not create an artifacts directory before writer admission',{skip:!isolated},async()=>{const f=await fixture();assert.equal(existsSync(f.executor.root),false);});
test('legacy prepare creates its empty workspace only after native writer admission',{skip:!isolated},async()=>{
 const f=await fixture(),source=await fence.acquireSource(f.runId);f.executor.snapshot={executionTarget:{deviceId:'fixture'}};
 f.service.enqueue=async()=>{writers.assertWriter(f.runId);assert.equal(existsSync(f.executor.root),true);return randomUUID();};f.service.wait=async()=>({files:[],localWorkspace:'fixture'});
 const work=f.executor.prepare(signal());work.catch(()=>{});await pause();const early=existsSync(f.executor.root);source.release();await work;assert.equal(early,false);assert.equal(existsSync(f.executor.root),true);
});
for(const kind of ['task','stop'] as const)test(kind+' transaction waits for native source before SQL and takes the shared SQL gate',{skip:!isolated},async t=>{
 const f=await fixture(),source=await fence.acquireSource(f.runId),sql:string[]=[];let pending:Promise<any>|undefined;
 await intercept(t,async(text,next)=>{sql.push(text);return next();});
 try{
  pending=kind==='task'?(f.executor as any).taskTransaction(signal(),async()=>17):(f.stops as any).transaction(async()=>17,signal());
  await pause();assert.equal(sql.length,0,'native admission must precede the first SQL query');source.release();assert.equal(await pending,17);
  const shared=sql.findIndex(text=>text.includes('918275')),project=sql.findIndex(text=>text.includes('FROM projects')&&text.includes('FOR UPDATE')),run=sql.findIndex(text=>text.includes('SELECT * FROM project_runs'));
  assert.ok(shared>=0&&shared<project&&project<run,JSON.stringify(sql));assert.equal(await available(f.runId),true);
 }finally{try{source.release();}catch{}await pending?.catch(()=>{});t.mock.restoreAll();}
});
for(const kind of ['task','stop'] as const)for(const failure of ['known','commit','rollback'] as const)test(kind+' transaction '+failure+' preserves the original outcome and native guard',{skip:!isolated},async t=>{
 const f=await fixture(),first=new AppError(409,'original denial','TASK_SCOPE_DENIED'),second=Error('second failure'),releases:any[]=[];
 await intercept(t,async(text,next)=>{if(text==='COMMIT'&&failure==='commit'){await next();throw first;}if(text==='ROLLBACK'&&failure==='rollback'){await next();throw second;}return next();},releases);
 try{
  const callback=async()=>{if(failure!=='commit')throw first;return 1;};
  await assert.rejects(kind==='task'?(f.executor as any).taskTransaction(signal(),callback):(f.stops as any).transaction(callback,signal()),error=>error===first);
  assert.equal(await available(f.runId),failure==='known');if(failure!=='known')assert.equal(releases.at(-1),true);
 }finally{t.mock.restoreAll();}
});
test('legacy execution holds its original writer through device wait and mirror and close waits for it',{skip:!isolated},async()=>{
 const f=await fixture(),waiting=gate(),finish=gate(),seen:boolean[]=[];f.executor.snapshot={};f.executor.preparing=Promise.resolve();
 // Only the physical device's completion is controlled; mirror and archive append are real.
 f.service.enqueue=async()=>randomUUID();f.service.wait=async()=>{waiting.release();return finish.promise;};
 const append=f.archive.append.bind(f.archive);f.archive.append=(...args:any[])=>{writers.assertWriter(f.runId);seen.push(true);return (append as any)(...args);};
 const work=f.executor.execute('artifact_write',{},signal(),{callId:'call'});await waiting.promise;
 let closed=false;const closing=f.executor.close().then(()=>{closed=true;});
 await pause();const blocked=!(await available(f.runId));const closedEarly=closed;
 finish.release({files:[{path:'out.txt',content:Buffer.from('output').toString('base64')}],localWorkspace:'fixture'});
 await work;await closing;assert.equal(blocked,true);assert.equal(closedEarly,false);assert.equal(readFileSync(join(f.executor.root,'out.txt'),'utf8'),'output');assert.equal(seen.length,1);
 await assert.rejects(f.executor.execute('artifact_write',{},signal(),{}),{code:'LOCAL_EXECUTOR_CLOSED'});
});
test('close awaits a failing original device producer and preserves its first error over cleanup failure',{skip:!isolated},async t=>{
 const f=await fixture(),waiting=gate(),finish=gate(),first=Object.freeze(Error('device outcome unknown')),second=Error('cleanup failure');f.executor.snapshot={};f.executor.preparing=Promise.resolve();
 f.service.enqueue=async()=>randomUUID();f.service.wait=async()=>{waiting.release();await finish.promise;throw first;};
 const work=f.executor.execute('artifact_write',{},signal(),{callId:'call'});const result=work.catch(error=>error);await waiting.promise;
 await intercept(t,async(text,next)=>{if(text.startsWith('UPDATE local_operations SET status='))throw second;return next();});
 const closing=f.executor.close().catch(error=>error);let settled=false;closing.then(()=>{settled=true;});await pause();const early=settled;finish.release();
 assert.equal(await result,first);assert.equal(await closing,first);assert.equal(early,false);assert.equal(await available(f.runId),false);t.mock.restoreAll();
});
test('accepted-stop abort retains the original pool acquisition until it settles without starting SQL',{skip:!isolated},async t=>{
 const f=await fixture(),arrived=gate(),finish=gate(),connect=pool.connect.bind(pool),abort=new AbortController();let queries=0,released=0;
 t.mock.method(pool,'connect',async()=>{arrived.release();await finish.promise;const db=await connect(),query=db.query.bind(db),release=db.release.bind(db);db.query=((...args:any[])=>{queries++;return query(...args as [any]);}) as any;db.release=((value?:any)=>{db.query=query as any;db.release=release;released++;release(value);}) as any;return db;});
 let settled=false;const work=(f.stops as any).transaction(async()=>1,abort.signal).catch((error:any)=>error);work.then(()=>{settled=true;});await arrived.promise;abort.abort();await pause();const early=settled,guarded=!(await available(f.runId));finish.release();await work;
 assert.equal(early,false);assert.equal(guarded,true);assert.equal(queries,0);assert.equal(released,1);assert.equal(await available(f.runId),true);t.mock.restoreAll();
});
for(const interrupted of [false,true])test('checkpoint physical '+(interrupted?'failure stays latched':'completion is distinct from SQL rollback'),{skip:!isolated},async()=>{
 const f=await fixture(),original=Error('checkpoint failure'),file=join(f.archive.dir,'partial-object');
 await assert.rejects((f.executor as any).taskTransaction(signal(),async(_db:any,_run:any,persist:any)=>{
  persist(()=>{writers.assertWriter(f.runId);writeFileSync(file,'durable bytes');if(interrupted)throw original;});throw original;
 }),error=>error===original);
 assert.equal(readFileSync(file,'utf8'),'durable bytes','SQL rollback does not undo a completed physical write');assert.equal(await available(f.runId),!interrupted);
});
test('checkpoint transaction cancellation drains a late pool connection without any SQL',{skip:!isolated},async t=>{
 const f=await fixture(),entered=gate(),finish=gate(),connect=pool.connect.bind(pool),abort=new AbortController(),reason=Error('checkpoint cancelled before connection');let queries=0,released=0,called=0,settled=false;let work:Promise<any>|undefined;
 t.mock.method(pool,'connect',async()=>{entered.release();await finish.promise;const db=await connect(),query=db.query.bind(db),release=db.release.bind(db);db.query=((...args:any[])=>{queries++;return query(...args as [any]);}) as any;db.release=((value?:any)=>{db.query=query as any;db.release=release;released++;release(value);}) as any;return db;});
 try{
  work=(f.executor as any).taskTransaction(abort.signal,async()=>{called++;}).catch((error:any)=>error);work!.then(()=>{settled=true;});await entered.promise;abort.abort(reason);await pause();
  assert.equal(settled,false);assert.equal(await available(f.runId),false,'the original connection producer still owns the writer');
  finish.release();assert.equal(await work,reason);assert.equal(queries,0);assert.equal(released,1);assert.equal(called,0);assert.equal(await available(f.runId),true);
 }finally{finish.release();await work;t.mock.restoreAll();}
});

for(const rollbackFails of [false,true])test('checkpoint transaction cancellation stops SQL continuation and '+(rollbackFails?'retains uncertain rollback':'awaits acknowledged rollback'),{skip:!isolated},async t=>{
 const f=await fixture(),entered=gate(),finish=gate(),abort=new AbortController(),reason=Error('checkpoint cancelled during SQL'),queries:string[]=[],released:any[]=[];let called=0,settled=false,work:Promise<any>|undefined;
 await intercept(t,async(text,next)=>{queries.push(text);if(text==='ROLLBACK'&&rollbackFails)throw Error('rollback response unknown');const result=await next();if(text==='SELECT project_id FROM project_runs WHERE id=$1'){entered.release();await finish.promise;}return result;},released);
 try{
  work=(f.executor as any).taskTransaction(abort.signal,async()=>{called++;}).catch((error:any)=>error);work!.then(()=>{settled=true;});await entered.promise;abort.abort(reason);await pause();
  assert.equal(settled,false);assert.equal(await available(f.runId),false);const before=queries.length;
  finish.release();assert.equal(await work,reason);assert.equal(called,0,'cancelled SQL preparation must not execute the checkpoint callback');assert.deepEqual(queries.slice(before),['ROLLBACK']);assert.equal(released.length,1);assert.equal(Boolean(released[0]),rollbackFails);assert.equal(await available(f.runId),!rollbackFails);
 }finally{finish.release();await work;t.mock.restoreAll();}
});

test('checkpoint transaction cancellation prevents a late physical checkpoint write',{skip:!isolated},async()=>{
 const f=await fixture(),entered=gate(),finish=gate(),abort=new AbortController(),reason=Error('checkpoint cancelled before file write'),file=join(f.archive.dir,'cancelled-checkpoint-object');let work:Promise<any>|undefined;
 try{
  work=(f.executor as any).taskTransaction(abort.signal,async(_db:any,_run:any,persist:any)=>{entered.release();await finish.promise;persist(()=>writeFileSync(file,'must not be persisted'));}).catch((error:any)=>error);
  await entered.promise;abort.abort(reason);assert.equal(await available(f.runId),false);finish.release();assert.equal(await work,reason);assert.equal(existsSync(file),false);assert.equal(await available(f.runId),true);
 }finally{finish.release();await work;}
});

test('checkpoint transaction cancellation after COMMIT never invokes its publisher',{skip:!isolated},async t=>{
 const f=await fixture(),abort=new AbortController(),reason=Error('checkpoint cancelled after commit');let published=0,committed=0;
 await intercept(t,async(text,next)=>{const value=await next();if(text==='COMMIT'){committed++;abort.abort(reason);}return value;});
 try{
  await assert.rejects((f.executor as any).taskTransaction(abort.signal,async()=>23,()=>{published++;return 23;}),error=>error===reason);
  assert.equal(committed,1);assert.equal(published,0);assert.equal(await available(f.runId),true,'acknowledged SQL commit is preserved without publishing a cancelled checkpoint');
 }finally{t.mock.restoreAll();}
});

test('checkpoint publisher remains in the same writer after acknowledged COMMIT',{skip:!isolated},async t=>{
 const f=await fixture();let committed=false;
 await intercept(t,async(text,next)=>{const result=await next();if(text==='COMMIT')committed=true;return result;});
 assert.equal(await (f.executor as any).taskTransaction(signal(),async()=>()=>{assert.equal(committed,true);writers.assertWriter(f.runId);return 23;},(publish:any)=>publish()),23);assert.equal(await available(f.runId),true);t.mock.restoreAll();
});
test('accepted-stop abort cannot replace a held original SQL reply or issue a late continuation',{skip:!isolated},async t=>{
 const f=await fixture(),entered=gate(),finish=gate(),abort=new AbortController();let queries=0;
 await intercept(t,async(text,next)=>{queries++;const value=await next();if(text==='SELECT project_id FROM project_runs WHERE id=$1'){entered.release();await finish.promise;}return value;});
 const work=(f.stops as any).transaction(async()=>1,abort.signal).catch((error:any)=>error);let settled=false;work.then(()=>settled=true);await entered.promise;abort.abort();await pause();const early=settled,guarded=!(await available(f.runId)),calls=queries;finish.release();await work;
 assert.equal(early,false);assert.equal(guarded,true);assert.equal(queries,calls);assert.equal(await available(f.runId),false);t.mock.restoreAll();
});
test('a second rejected dispatch callback cannot undo an already granted stop effect',{skip:!isolated},async()=>{
 const f=await fixture(),original=new AppError(409,'second admission denied','TASK_SCOPE_DENIED');let calls=0;
 const selected={executor:{},stop:async(_key:any,_expected:any,admit:()=>Promise<void>)=>{await admit();await admit();}};
 await assert.rejects((f.stops as any).dispatch(selected,{}, {},async()=>{if(calls++)throw original;},signal()),error=>error===original);
 assert.equal(await available(f.runId),false);
});
test('local wait keeps its first error when cancellation COMMIT is unknown and retains the original scope',{skip:!isolated},async t=>{
 const f=await fixture(),device=randomUUID(),grant=randomUUID(),operation=randomUUID(),first=Object.freeze(Error('original wait failure')),second=Error('cancellation commit reply lost'),releases:any[]=[];let reads=0,commits=0;
 await pool.query("INSERT INTO local_devices(id,token_hash,name,platform,grant_id,label,allow_commands) VALUES($1,$2,'fixture','linux',$3,'fixture',true)",[device,'a'.repeat(64),grant]);
 await pool.query("INSERT INTO local_operations(id,device_id,run_id,grant_id,lease_owner,payload,status) VALUES($1,$2,$3,$4,$5,'{}','queued')",[operation,device,f.runId,grant,f.service.owner]);
 await intercept(t,async(text,next)=>{if(text==='SELECT * FROM local_operations WHERE id=$1 FOR UPDATE'&&reads++===0){await next();throw first;}if(text==='COMMIT'){commits++;await next();throw second;}return next();},releases);
 try{await assert.rejects(writers.withWriter([f.runId],()=>f.service.wait(operation,signal())),error=>error===first);assert.equal(commits,1);assert.equal(releases.at(-1),true);assert.equal(await available(f.runId),false);}
 finally{t.mock.restoreAll();}
});
test('an unknown executor operation cannot acquire fresh finalization authority',{skip:!isolated},async t=>{
 const f=await fixture(),original=Error('device unknown');let queries=0,stops=0;
 const executor=new LocalRunExecutor(f.archive,{},f.service,{sandboxMaintenance:()=>({deviceId:'device',grantId:'grant',fingerprint:'a'.repeat(64),executor:{acceptedStopCapabilities:()=>({version:1,deadline:'shared-abort-v1'}),stopAcceptedTask:async()=>{stops++;},reconcileAcceptedTaskStop:async()=>{stops++;}} as any})});executor.preparing=Promise.resolve();
 f.service.enqueue=async()=>randomUUID();f.service.wait=async()=>{throw original;};await assert.rejects(executor.execute('artifact_write',{},signal(),{}),error=>error===original);
 await intercept(t,async(_text,next)=>{queries++;return next();});try{assert.equal((await executor.finalizeAccepted(signal())).state,'pending');assert.equal(queries,0);assert.equal(stops,0);await assert.rejects(executor.close(),error=>error===original);}finally{t.mock.restoreAll();}
});

for(const abortFirst of [false,true])test('acknowledged device cancellation preserves unknown receipt without poisoning local writer: '+abortFirst,{skip:!isolated},async()=>{
 const f=await fixture(),device=randomUUID(),grant=randomUUID(),operation=randomUUID(),controller=new AbortController(),reason=Error('requested stop');
 await pool.query("INSERT INTO local_devices(id,token_hash,name,platform,grant_id,label,allow_commands) VALUES($1,$2,'fixture','linux',$3,'fixture',true)",[device,'b'.repeat(64),grant]);
 await pool.query("INSERT INTO local_operations(id,device_id,run_id,grant_id,lease_owner,payload,status,started) VALUES($1,$2,$3,$4,$5,'{}',$6,true)",[operation,device,f.runId,grant,f.service.owner,abortFirst?'started':'cancelled']);
 if(abortFirst)controller.abort(reason);
 await assert.rejects((f.executor as any).waitOperation(operation,controller.signal),(error:any)=>abortFirst?error===reason:error.code==='LOCAL_OPERATION_CANCELLED');
 const row=(await pool.query('SELECT status,started,result,late_result FROM local_operations WHERE id=$1',[operation])).rows[0];
 assert.deepEqual(row,{status:'cancelled',started:true,result:null,late_result:null});
 assert.equal(await available(f.runId),true,'settled local SQL is drained; unresolved device outcome stays in the durable receipt');
});
