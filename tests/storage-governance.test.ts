import {before,after,beforeEach,test} from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {createRequire} from 'node:module';
import {createRunArchive} from '../services/agent-runtime/trace-store.mjs';
const isolated=process.env.SIMULATED_INTEGRATION==='pglite';
let pool:any,server:any,url:string,root:string,traceRoot:string,workspaceRoot:string,runId:string,routerModule:any;
const fixtures:any={};
let attempt=0;
let sandboxAdapter:any;
const {exportFiles,revision}=createRequire(import.meta.url)('../apps/desktop/local-executor.cjs');
before(async()=>{if(!isolated)return;
 root=await mkdtemp(join(tmpdir(),'storage-api-'));traceRoot=join(root,'runs');workspaceRoot=join(root,'workspaces');await mkdir(workspaceRoot);
 process.env.DATA_DIR=root;process.env.TRACE_ROOT=traceRoot;process.env.OBSIDIAN_VAULT=join(root,'vault');
 const db=await import('../apps/api/src/db.ts');pool=db.pool;await db.migrate();
 await pool.query("INSERT INTO departments(id,data) VALUES('storage-department',$1)",[{name:'storage fixture',agents:[]}]);
 await pool.query("INSERT INTO projects(id,department_id,department_version,department_name,requirement,policy,plan,status,source) VALUES('storage-project','storage-department',1,'storage fixture','fixture only',$1,$2,'COMPLETED','manual')",[{}, {agents:[],tasks:[]}]);
 await pool.query("INSERT INTO local_devices(id,token_hash,name,platform,grant_id,label) VALUES('native','fixture','fixture','test','fixture-grant','fixture')");
 routerModule=await import('../apps/api/src/storage-governance.ts').catch(error=>{if(error.code==='ERR_MODULE_NOT_FOUND')return {};throw error;});
 const app=express();app.use(express.json());if(routerModule.storageRouter)app.use('/api',routerModule.storageRouter(traceRoot,{dataRoot:root,workspaceRoot,nativeDeviceId:'native',sandbox:()=>sandboxAdapter},pool));
 app.use((error:any,_req:any,res:any,_next:any)=>res.status(error.status??(error.name==='ZodError'?422:error.code==='STORAGE_CANDIDATE_CHANGED'?409:500)).json({message:error.message,code:error.code}));
 server=app.listen(0,'127.0.0.1');await once(server,'listening');url=`http://127.0.0.1:${server.address().port}/api`;
});
beforeEach(async()=>{if(!isolated)return;sandboxAdapter=undefined;const archive=createRunArchive(traceRoot,{projectId:'storage-project',executionTarget:{kind:'local',deviceId:'native'}});runId=archive.id;
 archive.append('run/finished',{status:'completed'});await mkdir(join(archive.dir,'artifacts'));await mkdir(join(workspaceRoot,runId));
 for(const base of [join(archive.dir,'artifacts'),join(workspaceRoot,runId)])await writeFile(join(base,'delivery.txt'),'official delivery');
 await pool.query("INSERT INTO project_runs(id,project_id,project_version,status,snapshot,attempt) VALUES($1,'storage-project',1,'completed',$2,$3)",[runId,{executionTarget:{kind:'local',deviceId:'native'}},++attempt]);fixtures[runId]=archive;
});
after(async()=>{if(!isolated)return;server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await pool.end();await rm(root,{recursive:true,force:true});});
async function call(path:string,body?:any){const response=await fetch(url+path,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const text=await response.text();let data:any;try{data=JSON.parse(text);}catch{data={message:text};}return {status:response.status,data};}
async function preview(){const r=await call('/storage/preview',{});assert.equal(r.status,201);return r.data;}
const confirm={confirmation:'CLEAN_WORKSPACE_COPIES'};
test('inventory keeps legacy quota fields and reports archive/workspace categories without model calls',{skip:!isolated},async()=>{
 const r=await call('/storage');assert.equal(r.status,200);assert.ok(r.data.bytes>0);assert.equal(r.data.maxBytes,1073741824);assert.equal(r.data.runMaxBytes,67108864);assert.ok(r.data.groups.some((g:any)=>g.id==='workspaces'));assert.ok(r.data.runs.some((run:any)=>run.id===runId));
});

test('retention advice is read-only, uses finished age, and cannot bypass preview confirmation',{skip:!isolated},async()=>{
 await pool.query("UPDATE project_runs SET finished_at=now()-interval '8 days' WHERE id=$1",[runId]);
 const before=(await pool.query('SELECT count(*)::int AS n FROM storage_cleanups')).rows[0].n;
 for(let n=0;n<2;n++){const r=await call('/storage/retention');assert.equal(r.status,200);assert.equal(r.data.mode,'suggestion-only');assert.ok(r.data.recommendations.some((a:any)=>a.runId===runId&&a.kind==='journal'));}
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM storage_cleanups')).rows[0].n,before);assert.equal(await readFile(join(workspaceRoot,runId,'delivery.txt'),'utf8'),'official delivery');
 await pool.query("UPDATE project_runs SET status='failed' WHERE id=$1",[runId]);assert.ok(!(await call('/storage/retention')).data.recommendations.some((a:any)=>a.runId===runId));
});
test('explicit confirmation deletes only completed identical copies and repeated confirmation never repeats deletion',{skip:!isolated},async()=>{
 const p=await preview();assert.ok(p.preview.candidates.some((c:any)=>c.runId===runId));
 const r=await call('/storage/cleanups/'+p.id+'/confirm',confirm);assert.equal(r.status,200);assert.equal(r.data.status,'completed');
 assert.ok(p.preview.metadataReservationBytes>Buffer.byteLength(JSON.stringify(r.data.preview))+Buffer.byteLength(JSON.stringify(r.data.result)),'metadata admission reserves room for the receipt');
 await assert.rejects(readFile(join(workspaceRoot,runId,'delivery.txt')),{code:'ENOENT'});assert.equal(await readFile(join(traceRoot,runId,'artifacts','delivery.txt'),'utf8'),'official delivery');
 const again=await call('/storage/cleanups/'+p.id+'/confirm',confirm);assert.equal(again.status,200);assert.deepEqual(again.data.result,r.data.result);
});
test('failed/running and unregistered workspaces are retained; queued work blocks confirmation',{skip:!isolated},async()=>{
 const p=await preview();await pool.query("UPDATE project_runs SET status='running' WHERE id=$1",[runId]);
 const r=await call('/storage/cleanups/'+p.id+'/confirm',confirm);assert.equal(r.status,409);assert.equal(await readFile(join(workspaceRoot,runId,'delivery.txt'),'utf8'),'official delivery');
 await pool.query("UPDATE project_runs SET status='failed' WHERE id=$1",[runId]);const p2=await preview();assert.ok(!p2.preview.candidates.some((c:any)=>c.runId===runId));
});
test('post-preview file change refuses the whole batch',{skip:!isolated},async()=>{
 for(const base of [join(traceRoot,runId,'artifacts'),join(workspaceRoot,runId)])await writeFile(join(base,'second.txt'),'second');
 const p=await preview();await writeFile(join(workspaceRoot,runId,'second.txt'),'changed');
 const r=await call('/storage/cleanups/'+p.id+'/confirm',confirm);assert.equal(r.status,409);assert.equal(await readFile(join(workspaceRoot,runId,'delivery.txt'),'utf8'),'official delivery');
});
test('expired persisted previews reject confirmation',{skip:!isolated},async()=>{
 const p=await preview();await pool.query("UPDATE storage_cleanups SET created_at=now()-interval '31 minutes' WHERE id=$1",[p.id]);
 assert.equal((await call('/storage/cleanups/'+p.id+'/confirm',confirm)).status,409);
});
test('restart preserves preview/history and interrupted deletion is reconciled without replay',{skip:!isolated},async()=>{
 const p=await preview();await pool.query("UPDATE storage_cleanups SET status='started' WHERE id=$1",[p.id]);await rm(join(workspaceRoot,runId,'delivery.txt'));
 server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));
 const restarted=express();restarted.use(express.json());restarted.use('/api',routerModule.storageRouter(traceRoot,{dataRoot:root,workspaceRoot,nativeDeviceId:'native',sandbox:()=>sandboxAdapter},pool));
 restarted.use((error:any,_req:any,res:any,_next:any)=>res.status(error.status??(error.name==='ZodError'?422:500)).json({message:error.message,code:error.code}));server=restarted.listen(0,'127.0.0.1');await once(server,'listening');url=`http://127.0.0.1:${server.address().port}/api`;
 assert.equal((await call('/storage/cleanups/'+p.id+'/confirm',confirm)).status,409);
 const list=await call('/storage/cleanups');assert.ok(list.data.some((row:any)=>row.id===p.id&&row.status==='started'));
 const r=await call('/storage/cleanups/'+p.id+'/reconcile',{});assert.equal(r.status,200);assert.equal(r.data.status,'interrupted');assert.ok(r.data.result.observed.some((item:any)=>item.runId===runId&&item.state==='missing-copy'&&item.canonicalPreserved));
 assert.equal(await readFile(join(traceRoot,runId,'artifacts','delivery.txt'),'utf8'),'official delivery');
});
test('wrong confirmation and arbitrary path input cannot authorize deletion',{skip:!isolated},async()=>{
 const p=await preview();assert.equal((await call('/storage/cleanups/'+p.id+'/confirm',{confirmation:'yes',path:'/tmp'})).status,422);
 assert.equal(await readFile(join(workspaceRoot,runId,'delivery.txt'),'utf8'),'official delivery');
});
test('unchanged previews reuse one durable record rather than duplicating file lists',{skip:!isolated},async()=>{
 const a=await preview(),b=await preview();assert.equal(a.id,b.id);
});
test('bounded cleanup metadata refuses new previews without deleting stored history',{skip:!isolated},async()=>{
 await pool.query("INSERT INTO storage_cleanups(id,preview) SELECT 'capacity-fixture-'||n,'{}'::jsonb FROM generate_series(1,1000) n");
 const r=await call('/storage/preview',{});assert.equal(r.status,409);assert.equal(r.data.code,'STORAGE_PREVIEW_LIMIT');
 assert.equal((await pool.query("SELECT count(*)::int AS n FROM storage_cleanups WHERE id LIKE 'capacity-fixture-%'")).rows[0].n,1000);
 await pool.query("DELETE FROM storage_cleanups WHERE id LIKE 'capacity-fixture-%'");
});
test('a cancelled operation that started without a receipt blocks cleanup until explicitly reconciled',{skip:!isolated},async()=>{
 const p=await preview(),op=randomUUID();await pool.query("INSERT INTO local_operations(id,device_id,run_id,grant_id,lease_owner,payload,status,started) VALUES($1,'native',$2,'fixture-grant','fixture','{}','cancelled',true)",[op,runId]);
 const r=await call('/storage/cleanups/'+p.id+'/confirm',confirm);assert.equal(r.status,409);assert.equal(r.data.code,'STORAGE_UNKNOWN_OPERATION');
 assert.equal(await readFile(join(workspaceRoot,runId,'delivery.txt'),'utf8'),'official delivery');
 await pool.query('DELETE FROM local_operations WHERE id=$1',[op]);
});
test('simultaneous preview requests reuse one record under the shared metadata lock',{skip:!isolated},async()=>{
 const [a,b]=await Promise.all([preview(),preview()]);assert.equal(a.id,b.id);
});
test('every model reservation including free-accounted conversation stops on low disk before provider dispatch',{skip:!isolated},async t=>{
 const original=fs.statfsSync;t.mock.method(fs,'statfsSync',()=>({bavail:0,bsize:4096}));syncBuiltinESMExports();
 try{const {reserveCall}=await import('../apps/api/src/cost-control.ts');
  for(const options of [{purpose:'planning'},{purpose:'组织需求对话',accountingMode:'conversation' as const}])await assert.rejects(reserveCall({model:{id:'not-registered',inputRate:0,outputRate:0},amount:0,...options}),(e:any)=>e.code==='STORAGE_FREE_LIMIT'&&e.status===422);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM model_reservations WHERE model_id='not-registered'")).rows[0].n,0);
 }finally{fs.statfsSync=original;syncBuiltinESMExports();}
});

async function enableSandbox(){
 const target={kind:'local',deviceId:'native',grantId:'fixture-grant',backend:{kind:'openshell',fingerprint:'f'.repeat(64)}},sandboxId=randomUUID();
 await rm(join(traceRoot,runId),{recursive:true});const record=createRunArchive(traceRoot,{projectId:'storage-project',executionTarget:target},{id:runId});record.append('run/finished',{status:'completed'});await mkdir(join(record.dir,'artifacts'));await writeFile(join(record.dir,'artifacts','delivery.txt'),'official delivery');
 await pool.query('UPDATE project_runs SET snapshot=$2 WHERE id=$1',[runId,{executionTarget:target}]);await pool.query('UPDATE local_devices SET backend=$1 WHERE id=\'native\'',[target.backend]);
 const expected=revision(exportFiles(join(traceRoot,runId,'artifacts')));let phase='ready',retired=0,inspected=0;
 sandboxAdapter={deviceId:'native',grantId:'fixture-grant',fingerprint:target.backend.fingerprint,executor:{storageScopes:()=>[{runId,sandboxId,phase,workspaceRevision:expected,storage:{workspace:{bytes:17},temp:{bytes:0},hardQuota:false,checkedAt:new Date().toISOString()}}],inspectStorage:async()=>{inspected++;return {runId,sandboxId,workspaceRevision:expected,storage:{workspace:{bytes:17},temp:{bytes:0},hardQuota:false}};},retireStorage:async()=>{retired++;if(sandboxAdapter.disconnect){phase='unknown';throw Object.assign(Error('uncertain deletion'),{code:'LOCAL_OUTCOME_UNKNOWN'});}phase='retired';return {runId,sandboxId,state:'retired',replayed:false};},reconcileStorage:async()=>{phase='retired';return {runId,sandboxId,state:'retired',replayed:false};}}};
 return {expected,sandboxId,counts:()=>({retired,inspected})};
}

test('sandbox storage shows registered identity and explicit inspection never deletes',{skip:!isolated},async()=>{
 const f=await enableSandbox();const report=await call('/storage/sandboxes');assert.equal(report.status,200);assert.equal(report.data.scopes[0].sandboxId,f.sandboxId);
 const inspected=await call('/storage/sandboxes/'+runId+'/inspect',{});assert.equal(inspected.status,200);assert.equal(inspected.data.storage.hardQuota,false);assert.deepEqual(f.counts(),{retired:0,inspected:1});
});
test('sandbox retirement requires its own confirmation and preserves official delivery',{skip:!isolated},async()=>{
 const f=await enableSandbox(),p=await call('/storage/preview',{kind:'sandbox',runId});assert.equal(p.status,201);
 const wrong=await call('/storage/cleanups/'+p.data.id+'/confirm',confirm);assert.equal(wrong.status,422);assert.equal(f.counts().retired,0);
 const done=await call('/storage/cleanups/'+p.data.id+'/confirm',{confirmation:'RETIRE_SANDBOX'});assert.equal(done.status,200);assert.equal(done.data.status,'completed');
 await call('/storage/cleanups/'+p.data.id+'/confirm',{confirmation:'RETIRE_SANDBOX'});assert.equal(f.counts().retired,1);assert.equal(await readFile(join(traceRoot,runId,'artifacts','delivery.txt'),'utf8'),'official delivery');
});
test('changed canonical delivery blocks sandbox retirement before external delete',{skip:!isolated},async()=>{
 const f=await enableSandbox(),p=await call('/storage/preview',{kind:'sandbox',runId});assert.equal(p.status,201);await writeFile(join(traceRoot,runId,'artifacts','delivery.txt'),'new version');
 assert.equal((await call('/storage/cleanups/'+p.data.id+'/confirm',{confirmation:'RETIRE_SANDBOX'})).status,409);assert.equal(f.counts().retired,0);
});
test('sandbox uncertain deletion records partial and only reconciles without another delete',{skip:!isolated},async()=>{
 const f=await enableSandbox(),p=await call('/storage/preview',{kind:'sandbox',runId});assert.equal(p.status,201);sandboxAdapter.disconnect=true;
 assert.equal((await call('/storage/cleanups/'+p.data.id+'/confirm',{confirmation:'RETIRE_SANDBOX'})).status,409);
 const checked=await call('/storage/cleanups/'+p.data.id+'/reconcile',{});assert.equal(checked.status,200);assert.equal(checked.data.result.replayed,false);assert.equal(f.counts().retired,1);
});
test('journal preview seals real completed events and preserves exact trace reads',{skip:!isolated},async()=>{
 fixtures[runId].append('evidence/test-output',{output:'test evidence\n'.repeat(2000)});
 const {readRun}=await import('../services/agent-runtime/trace-store.mjs'),before=readRun(traceRoot,runId),p=await call('/storage/preview',{kind:'journal',runId});assert.equal(p.status,201);
 const done=await call('/storage/cleanups/'+p.data.id+'/confirm',{confirmation:'ARCHIVE_JOURNAL'});assert.equal(done.status,200);assert.equal(done.data.status,'completed');assert.deepEqual(readRun(traceRoot,runId),before);
 await assert.rejects(readFile(join(traceRoot,runId,'events.jsonl')),{code:'ENOENT'});assert.equal((await readFile(join(traceRoot,runId,'events.jsonl.gz'))).length>0,true);
});

test('unresolved sandbox reconciliation can query the same ID again without replaying deletion',{skip:!isolated},async()=>{
 const f=await enableSandbox(),p=await call('/storage/preview',{kind:'sandbox',runId});sandboxAdapter.disconnect=true;
 await call('/storage/cleanups/'+p.data.id+'/confirm',{confirmation:'RETIRE_SANDBOX'});
 let checks=0;sandboxAdapter.executor.reconcileStorage=async()=>({runId,sandboxId:f.sandboxId,state:++checks===1?'present':'retired',replayed:false});
 const first=await call('/storage/cleanups/'+p.data.id+'/reconcile',{});assert.equal(first.data.status,'partial');assert.equal(first.data.result.state,'present');
 const last=await call('/storage/cleanups/'+p.data.id+'/reconcile',{});assert.equal(last.data.result.state,'retired');assert.equal(checks,2);assert.equal(f.counts().retired,1);
});
test('journal archive refuses post-preview append and never removes original evidence',{skip:!isolated},async()=>{
 fixtures[runId].append('evidence/test-output',{output:'test evidence\n'.repeat(2000)});
 const p=await call('/storage/preview',{kind:'journal',runId});assert.equal(p.status,201);fixtures[runId].append('late/evidence',{});
 assert.equal((await call('/storage/cleanups/'+p.data.id+'/confirm',{confirmation:'ARCHIVE_JOURNAL'})).status,409);assert.ok((await readFile(join(traceRoot,runId,'events.jsonl'))).length>0);
});
