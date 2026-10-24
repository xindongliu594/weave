import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,mkdirSync,writeFileSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {fork} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createArchiveWriterManager} from '../services/agent-runtime/archive-writer-scope.mjs';
import {createArchiveWriteFence} from '../services/agent-runtime/archive-write-fence.mjs';
import {createRunArchive} from '../services/agent-runtime/trace-store.mjs';
import {AppError} from '../apps/api/src/provider.ts';
const isolated=process.env.SIMULATED_INTEGRATION==='pglite';
const {exportFiles,revision}=createRequire(import.meta.url)('../apps/desktop/local-executor.cjs');
const gate=()=>{let release!:(value?:any)=>void;const promise=new Promise<any>(resolve=>release=resolve);return {promise,release};};
const pause=()=>new Promise(resolve=>setTimeout(resolve,50));
let root:string,traceRoot:string,pool:any,writers:any,fence:any,server:any,url:string,adapter:any,principal:any={kind:'local-owner'};
let captured:any[]=[],queryHook:((sql:string,next:()=>Promise<any>,query:(sql:string,values?:any[])=>Promise<any>)=>Promise<any>)|undefined,releases:any[]=[];
before(async()=>{if(!isolated)return;
 root=mkdtempSync(join(realpathSync(tmpdir()),'maintenance-writer-'));traceRoot=join(root,'runs');writeFileSync(join(root,'.fixture-owner'),String(process.pid));
 process.env.DATA_DIR=root;process.env.TRACE_ROOT=traceRoot;process.env.OBSIDIAN_VAULT=join(root,'vault');
 const db=await import('../apps/api/src/db.ts');pool=db.pool;await db.migrate();writers=createArchiveWriterManager({traceRoot});fence=createArchiveWriteFence({traceRoot,lockRoot:writers.lockRoot});
 await pool.query("INSERT INTO departments(id,data) VALUES('maintenance-department',$1)",[{name:'fixture',agents:[]}]);
 await pool.query("INSERT INTO projects(id,department_id,department_version,department_name,requirement,policy,plan,status,source) VALUES('maintenance-project','maintenance-department',1,'fixture','fixture','{}','{}','COMPLETED','manual')");
 await pool.query("INSERT INTO local_devices(id,token_hash,name,platform,grant_id,label,backend) VALUES('maintenance-device','fixture','fixture','test','maintenance-grant','fixture',$1)",[{kind:'openshell',fingerprint:'f'.repeat(64)}]);
 const wrapped={query:pool.query.bind(pool),connect:async()=>{const client=await pool.connect();return {query:(...args:any[])=>queryHook?queryHook(typeof args[0]==='string'?args[0]:args[0].text,()=>client.query(...args),client.query.bind(client)):client.query(...args),release:(value?:any)=>{releases.push(value);client.release(value);}};}};
 const {storageRouter}=await import('../apps/api/src/storage-governance.ts');const app=express();app.use(express.json());app.use((_req,res,next)=>{res.locals.principal=principal;next();});
 app.use('/api',(storageRouter as any)(traceRoot,{sandbox:()=>adapter},wrapped,writers));app.use((error:any,_req:any,res:any,_next:any)=>{captured.push(error);res.status(error.status??500).json({code:error.code,message:error.message});});
 server=app.listen(0,'127.0.0.1');await once(server,'listening');url=`http://127.0.0.1:${server.address().port}/api`;
});
after(async()=>{if(!isolated)return;queryHook=undefined;server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await pool.end();console.log('MAINTENANCE_WRITER_EXIT_CLEANUP='+JSON.stringify({root,pid:process.pid}));});
async function call(path:string,body:any){const response=await fetch(url+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});return {status:response.status,data:await response.json()};}
async function available(runId:string){try{const guard=await fence.acquireWriter([runId],{timeoutMs:0});guard.release();return true;}catch(error){assert.equal((error as any).code,'E_ARCHIVE_FENCE_TIMEOUT');return false;}}
async function fixture(){
 queryHook=undefined;releases=[];captured=[];principal={kind:'local-owner'};const runId=randomUUID(),sandboxId=randomUUID(),target={kind:'local',deviceId:'maintenance-device',grantId:'maintenance-grant',backend:{kind:'openshell',fingerprint:'f'.repeat(64)}},snapshot={projectId:'maintenance-project',executionTarget:target};
 const archive=createRunArchive(traceRoot,snapshot,{id:runId});archive.append('run/finished',{status:'completed'});mkdirSync(join(archive.dir,'artifacts'));writeFileSync(join(archive.dir,'artifacts','delivery.txt'),'canonical owned fixture');
 await pool.query("INSERT INTO project_runs(id,project_id,project_version,status,snapshot,attempt) VALUES($1,'maintenance-project',1,'completed',$2,(SELECT COALESCE(max(attempt),0)+1 FROM project_runs))",[runId,snapshot]);
 const workspaceRevision=revision(exportFiles(join(archive.dir,'artifacts')));let retired=0,inspected=0,reconciled=0;
 adapter={deviceId:target.deviceId,grantId:target.grantId,fingerprint:target.backend.fingerprint,executor:{storageScopes:()=>[{runId,sandboxId,phase:'ready',workspaceRevision,storage:{workspace:{bytes:23},temp:{bytes:0}}}],inspectStorage:async()=>{inspected++;return {runId,sandboxId};},retireStorage:async()=>{retired++;return {runId,sandboxId,state:'retired',replayed:false};},reconcileStorage:async()=>{reconciled++;return {runId,sandboxId,state:'retired',replayed:false};}}};
 const preview=await call('/storage/preview',{kind:'sandbox',runId});assert.equal(preview.status,201,JSON.stringify(preview));
 return {runId,sandboxId,preview:preview.data,counts:()=>({retired,inspected,reconciled}),confirm:()=>call('/storage/cleanups/'+preview.data.id+'/confirm',{confirmation:'RETIRE_SANDBOX'}),reconcile:()=>call('/storage/cleanups/'+preview.data.id+'/reconcile',{})};
}
test('inspection waits for native admission before SQL and rechecks a run changed during that wait',{skip:!isolated},async()=>{
 const f=await fixture(),owner=await writers.acquireOwner([f.runId]),sql:string[]=[];queryHook=async(text,next)=>{sql.push(text);return next();};
 const work=call('/storage/sandboxes/'+f.runId+'/inspect',{});await pause();const before=[...sql];await pool.query("UPDATE project_runs SET status='running' WHERE id=$1",[f.runId]);owner.finish();await owner.writerDrained;const result=await work;
 await pool.query("UPDATE project_runs SET status='completed' WHERE id=$1",[f.runId]);assert.equal(before.length,0);assert.equal(result.status,409);assert.equal(f.counts().inspected,0);assert.equal(await available(f.runId),true);
});
test('confirmation rechecks the exact preview after native wait rather than using an old discovery row',{skip:!isolated},async()=>{
 const f=await fixture(),owner=await writers.acquireOwner([f.runId]);let queries=0;queryHook=async(_sql,next)=>{queries++;return next();};
 const work=f.confirm();await pause();const before=queries;await pool.query("UPDATE storage_cleanups SET preview=jsonb_set(preview,'{policy}','\"changed\"') WHERE id=$1",[f.preview.id]);owner.finish();await owner.writerDrained;const result=await work;
 assert.equal(before,0);assert.equal(result.status,409);assert.equal(result.data.code,'STORAGE_PREVIEW_STALE');assert.equal(f.counts().retired,0);assert.equal(await available(f.runId),true);
});
test('current human identity is revalidated after the native wait before inspection',{skip:!isolated},async()=>{
 const f=await fixture(),userId=randomUUID();await pool.query("INSERT INTO human_users(id,issuer,subject,display_name,status,org_role,session_epoch) VALUES($1,'maintenance-issuer',$1,'fixture','active','admin',1)",[userId]);principal={kind:'human',userId,sessionId:'fixture-session',authenticatedAt:new Date().toISOString(),issuer:'maintenance-issuer',subject:userId,orgRole:'admin',sessionEpoch:1};
 const owner=await writers.acquireOwner([f.runId]),work=call('/storage/sandboxes/'+f.runId+'/inspect',{});await pause();await pool.query('UPDATE human_users SET session_epoch=2 WHERE id=$1',[userId]);owner.finish();await owner.writerDrained;const result=await work;
 assert.equal(result.status,404);assert.equal(f.counts().inspected,0);assert.equal(await available(f.runId),true);
});
test('exclusive spans both commits and the real provider promise; completed confirmation never replays',{skip:!isolated},async()=>{
 const f=await fixture(),first=gate(),releaseFirst=gate(),provider=gate(),releaseProvider=gate(),last=gate(),releaseLast=gate();let commits=0;
 queryHook=async(sql,next)=>{const value=await next();if(sql==='COMMIT'){commits++;if(commits===1){first.release();await releaseFirst.promise;}if(commits===2){last.release();await releaseLast.promise;}}return value;};
 const retire=adapter.executor.retireStorage;adapter.executor.retireStorage=async()=>{provider.release();await releaseProvider.promise;return retire();};
 const work=f.confirm();await first.promise;const heldFirst=!(await available(f.runId));releaseFirst.release();await provider.promise;const heldProvider=!(await available(f.runId));
 const child=fork(fileURLToPath(new URL('../services/agent-runtime/test-helpers/archive-maintenance-child.mjs',import.meta.url)),[],{stdio:['ignore','inherit','inherit','ipc'],env:{...process.env,ARCHIVE_MAINTENANCE_TEST:JSON.stringify({traceRoot,lockRoot:writers.lockRoot,runId:f.runId,action:'probe'})}}),exited=once(child,'exit');
 const [childState]=await once(child,'message');releaseProvider.release();await last.promise;const heldLast=!(await available(f.runId));releaseLast.release();const result=await work;
 const retried=once(child,'message');child.send('retry');const [releasedState]=await retried;const [childCode]=await exited;
 assert.deepEqual(childState,{writerBlocked:true,sourceBlocked:true});assert.deepEqual(releasedState,{acquired:true});assert.equal(childCode,0);assert.deepEqual([heldFirst,heldProvider,heldLast],[true,true,true]);assert.equal(result.status,200);assert.equal(await available(f.runId),true);queryHook=undefined;assert.equal((await f.confirm()).status,200);assert.equal(f.counts().retired,1);
});
test('known wrong confirmation and proven rollback do not poison the run scope',{skip:!isolated},async()=>{
 const f=await fixture(),result=await call('/storage/cleanups/'+f.preview.id+'/confirm',{confirmation:'ARCHIVE_JOURNAL'});assert.equal(result.status,422);assert.equal(f.counts().retired,0);assert.equal(await available(f.runId),true);
});
for(const phase of ['claim','receipt'])for(const where of ['before','after'])test(`${phase} COMMIT ${where} failure retains the original guard and discards the connection`,{skip:!isolated},async()=>{
 const f=await fixture(),first=Object.freeze(new AppError(409,'original commit uncertainty','MAINTENANCE_TEST_UNKNOWN'));let commits=0;
 queryHook=async(sql,next)=>{if(sql==='COMMIT'&&++commits===(phase==='claim'?1:2)){if(where==='after')await next();throw first;}return next();};
 const result=await f.confirm();queryHook=undefined;assert.equal(result.status,409);assert.equal(captured.at(-1),first);assert.equal(await available(f.runId),false);assert.equal(releases.at(-1),true);assert.equal(f.counts().retired,phase==='claim'?0:1);
 const saved=(await pool.query('SELECT status FROM storage_cleanups WHERE id=$1',[f.preview.id])).rows[0].status;assert.equal(saved,phase==='claim'?(where==='after'?'started':'preview'):(where==='after'?'completed':'started'));
});
test('a failed rollback after physical failure preserves the first frozen error and keeps the guard',{skip:!isolated},async()=>{
 const f=await fixture(),first=Object.freeze(new AppError(409,'original physical uncertainty','LOCAL_OUTCOME_UNKNOWN')),second=Error('rollback acknowledgement lost');adapter.executor.retireStorage=async()=>{throw first;};queryHook=async(sql,next)=>{const value=await next();if(sql==='ROLLBACK')throw second;return value;};
 const result=await f.confirm();queryHook=undefined;assert.equal(result.status,409);assert.equal(captured.at(-1),first);assert.equal(await available(f.runId),false);assert.equal(releases.at(-1),true);
});
test('source state rejected after the durable claim records partial but releases after proven no physical effect',{skip:!isolated},async()=>{
 const f=await fixture();let commits=0;queryHook=async(sql,next,query)=>{const result=await next();if(sql==='COMMIT'&&++commits===1)await query("UPDATE project_runs SET status='running' WHERE id=$1",[f.runId]);return result;};
 const result=await f.confirm();queryHook=undefined;await pool.query("UPDATE project_runs SET status='completed' WHERE id=$1",[f.runId]);assert.equal(result.status,409);assert.equal(f.counts().retired,0);assert.equal(await available(f.runId),true);assert.equal((await pool.query('SELECT status FROM storage_cleanups WHERE id=$1',[f.preview.id])).rows[0].status,'partial');
});
test('reconciliation retains its original inspection producer without reissuing retirement',{skip:!isolated},async()=>{
 const f=await fixture(),entered=gate(),finish=gate();await pool.query("UPDATE storage_cleanups SET status='started' WHERE id=$1",[f.preview.id]);const reconcile=adapter.executor.reconcileStorage;adapter.executor.reconcileStorage=async()=>{entered.release();await finish.promise;return reconcile();};
 const work=f.reconcile();await entered.promise;const blocked=!(await available(f.runId));finish.release();const result=await work;assert.equal(blocked,true);assert.equal(result.status,200);assert.deepEqual(f.counts(),{retired:0,inspected:0,reconciled:1});assert.equal(await available(f.runId),true);
});
for(const uncertain of [false,true])test(`partial receipt ${uncertain?'COMMIT unknown stays latched':'known rollback does not poison a proven no-effect rejection'}`,{skip:!isolated},async()=>{
 const f=await fixture(),second=Object.freeze(Error('secondary receipt failure'));let commits=0;
 queryHook=async(sql,next,query)=>{
  if(!uncertain&&sql.startsWith("UPDATE storage_cleanups SET status='partial'"))throw second;
  if(sql==='COMMIT'&&++commits===2&&uncertain)throw second;
  const result=await next();if(sql==='COMMIT'&&commits===1)await query("UPDATE project_runs SET status='running' WHERE id=$1",[f.runId]);return result;
 };
 const result=await f.confirm();queryHook=undefined;await pool.query("UPDATE project_runs SET status='completed' WHERE id=$1",[f.runId]);
 assert.equal(result.status,409);assert.equal(result.data.code,'STORAGE_ACTIVE_RUN');assert.notEqual(captured.at(-1),second);assert.equal(f.counts().retired,0);assert.equal(await available(f.runId),!uncertain);assert.equal(releases.at(-1),uncertain);
});
test('persisted cleanup targets over the native bound are rejected before starting SQL or providers',{skip:!isolated},async()=>{
 const f=await fixture(),candidates=Array.from({length:129},()=>({runId:randomUUID(),path:'untrusted',bytes:0}));await pool.query("UPDATE storage_cleanups SET preview=jsonb_set(preview,'{candidates}',$2::jsonb) WHERE id=$1",[f.preview.id,JSON.stringify(candidates)]);let sql=0;queryHook=async(_sql,next)=>{sql++;return next();};
 const result=await f.confirm();queryHook=undefined;assert.equal(result.status,409);assert.equal(result.data.code,'STORAGE_PREVIEW_LIMIT');assert.equal(sql,0);assert.equal(f.counts().retired,0);
});
