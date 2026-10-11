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
import {createRunArchive} from '../services/agent-runtime/trace-store.mjs';
const isolated=process.env.SIMULATED_INTEGRATION==='pglite';
let pool:any,server:any,url:string,root:string,traceRoot:string,workspaceRoot:string,runId:string,routerModule:any;
const fixtures:any={};
let attempt=0;
before(async()=>{if(!isolated)return;
 root=await mkdtemp(join(tmpdir(),'storage-api-'));traceRoot=join(root,'runs');workspaceRoot=join(root,'workspaces');await mkdir(workspaceRoot);
 process.env.DATA_DIR=root;process.env.TRACE_ROOT=traceRoot;process.env.OBSIDIAN_VAULT=join(root,'vault');
 const db=await import('../apps/api/src/db.ts');pool=db.pool;await db.migrate();
 await pool.query("INSERT INTO departments(id,data) VALUES('storage-department',$1)",[{name:'storage fixture',agents:[]}]);
 await pool.query("INSERT INTO projects(id,department_id,department_version,department_name,requirement,policy,plan,status,source) VALUES('storage-project','storage-department',1,'storage fixture','fixture only',$1,$2,'COMPLETED','manual')",[{}, {agents:[],tasks:[]}]);
 await pool.query("INSERT INTO local_devices(id,token_hash,name,platform,grant_id,label) VALUES('native','fixture','fixture','test','fixture-grant','fixture')");
 routerModule=await import('../apps/api/src/storage-governance.ts').catch(error=>{if(error.code==='ERR_MODULE_NOT_FOUND')return {};throw error;});
 const app=express();app.use(express.json());if(routerModule.storageRouter)app.use('/api',routerModule.storageRouter(traceRoot,{dataRoot:root,workspaceRoot,nativeDeviceId:'native'},pool));
 app.use((error:any,_req:any,res:any,_next:any)=>res.status(error.status??(error.name==='ZodError'?422:error.code==='STORAGE_CANDIDATE_CHANGED'?409:500)).json({message:error.message,code:error.code}));
 server=app.listen(0,'127.0.0.1');await once(server,'listening');url=`http://127.0.0.1:${server.address().port}/api`;
});
beforeEach(async()=>{if(!isolated)return;const archive=createRunArchive(traceRoot,{projectId:'storage-project',executionTarget:{kind:'local',deviceId:'native'}});runId=archive.id;
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
 const restarted=express();restarted.use(express.json());restarted.use('/api',routerModule.storageRouter(traceRoot,{dataRoot:root,workspaceRoot,nativeDeviceId:'native'},pool));
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
