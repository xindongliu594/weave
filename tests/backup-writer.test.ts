import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {once} from 'node:events';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import type pg from 'pg';
import {createArchiveWriterManager} from '../services/agent-runtime/archive-writer-scope.mjs';
import {createArchiveWriteFence} from '../services/agent-runtime/archive-write-fence.mjs';
import {inspectBackupRestoreStartup} from '../apps/api/src/backup-restore-state.ts';
if(process.env.SIMULATED_INTEGRATION!=='pglite')throw Error('Use the owned isolated integration runner');
let pool:pg.Pool,backup:any;const roots:string[]=[],password='owned-backup-root-test',runId=randomUUID();
type QueryHook=(sql:string,next:()=>Promise<any>)=>Promise<any>;
let hook:QueryHook|undefined,releases:any[]=[],caught:any[]=[];
before(async()=>{
 const db=await import('../apps/api/src/db.ts');pool=db.pool;await db.migrate();await (await import('../apps/api/src/backup-restore-state.ts')).migrateBackupRestoreState(pool);backup=await import('../apps/api/src/backup.ts');
 const connect=pool.connect.bind(pool);
 (pool as any).connect=(callback?:any)=>{if(callback)return connect(callback);return connect().then(client=>{const query=client.query.bind(client),release=client.release.bind(client);(client as any).query=(...args:any[])=>hook?hook(typeof args[0]==='string'?args[0]:args[0].text,()=>query(...args as [any])):query(...args as [any]);client.release=(error?:any)=>{releases.push(error);client.query=query;client.release=release;release(error);};return client;});};
});
after(async()=>{hook=undefined;await pool?.end();console.log('BACKUP_WRITER_OWNED_ROOTS='+JSON.stringify({pid:process.pid,roots}));});
async function fixture(){
 hook=undefined;releases=[];caught=[];const root=mkdtempSync(join(tmpdir(),'weiwu-backup-writer-'));roots.push(root);writeFileSync(join(root,'.owned-backup-test.json'),JSON.stringify({pid:process.pid,root}));
 const traceRoot=join(root,'runs');process.env.DATA_DIR=root;process.env.TRACE_ROOT=traceRoot;process.env.OBSIDIAN_VAULT=join(root,'vault');process.env.LOCAL_WORKSPACE_ROOT=root;
 const writers=createArchiveWriterManager({traceRoot});mkdirSync(join(traceRoot,runId,'artifacts'),{recursive:true});const artifact=join(traceRoot,runId,'artifacts','proof.txt');writeFileSync(artifact,'after');writeFileSync(join(root,'credential.key'),Buffer.alloc(32,9));
 await pool.query("DELETE FROM departments");await pool.query("INSERT INTO departments(id,data) VALUES('backup-writer-department',$1)",[{name:'after',agents:[]}]);
 const app=express();app.use(express.json({limit:'70mb'}));app.use((_req,res,next)=>{res.locals.principal={kind:'local-owner'};next();});
 app.use((backup.backupRouter as any)(traceRoot,writers));app.use((error:any,_req:any,res:any,_next:any)=>{caught.push(error);res.status(error.status??500).json({code:error.code,message:error.message});});
 const server=app.listen(0,'127.0.0.1');await once(server,'listening');const url='http://127.0.0.1:'+(server.address() as any).port;
 const post=async(path:string,body:any)=>{const response=await fetch(url+'/backup/'+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});return {status:response.status,data:await response.json()};};
 const exported=await post('export',{password});assert.equal(exported.status,200,JSON.stringify(exported.data));
 writeFileSync(artifact,'before');writeFileSync(join(root,'credential.key'),Buffer.alloc(32,3));await pool.query("UPDATE departments SET data=$1 WHERE id='backup-writer-department'",[{name:'before',agents:[]}]);
 return {root,traceRoot,writers,artifact,restore:()=>post('restore',{password,backup:exported.data,confirmation:'RESTORE'}),close:async()=>{hook=undefined;server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}};
}
test('restore waits for original native writer before SQL or live effects',async()=>{
 const f=await fixture();try{const owner=await f.writers.acquireOwner([runId]);let queries=0;hook=async(_sql,next)=>{queries++;return next();};const work=f.restore();await new Promise(resolve=>setTimeout(resolve,600));const before=queries;owner.finish();await owner.writerDrained;const result=await work;assert.equal(before,0);assert.equal(result.status,200,JSON.stringify(result.data));assert.equal(readFileSync(f.artifact,'utf8'),'after');}finally{await f.close();}
});
test('a real COMMIT followed by lost acknowledgement keeps the committed physical generation and original error',async()=>{
 const f=await fixture();try{const first=Object.freeze(Error('owned COMMIT response lost'));hook=async(sql,next)=>{const value=await next();if(sql==='COMMIT')throw first;return value;};const result=await f.restore();hook=undefined;assert.equal(result.status,500);assert.equal(caught.at(-1),first);assert.equal((await pool.query("SELECT data FROM departments WHERE id='backup-writer-department'")).rows[0].data.name,'after');assert.equal(readFileSync(f.artifact,'utf8'),'after','committed SQL must not be paired with undone files');assert.deepEqual(readFileSync(join(f.root,'credential.key')),Buffer.alloc(32,9));assert.equal(releases.at(-1),true);}finally{await f.close();}
});
async function writerAvailable(f:Awaited<ReturnType<typeof fixture>>){const fence=createArchiveWriteFence({traceRoot:f.traceRoot,lockRoot:f.writers.lockRoot});try{const guard=await fence.acquireWriter([runId],{timeoutMs:0});guard.release();return true;}catch(error){assert.equal((error as any).code,'E_ARCHIVE_FENCE_TIMEOUT');return false;}}
test('COMMIT failure before dispatch also preserves both generations and blocks a second write without replay',async()=>{
 const f=await fixture();try{const first=Object.freeze(Error('COMMIT dispatch unknown'));let imports=0;hook=async(sql,next)=>{if(sql.startsWith('TRUNCATE '))imports++;if(sql==='COMMIT')throw first;return next();};const result=await f.restore();hook=undefined;assert.equal(result.status,500);assert.equal(caught.at(-1),first);assert.equal(releases.at(-1),true);assert.equal(readFileSync(f.artifact,'utf8'),'after');assert.equal(inspectBackupRestoreStartup({traceRoot:f.traceRoot,dataRoot:f.root}).pending,true);assert.equal(await writerAvailable(f),false);assert.equal((await pool.query("SELECT data FROM departments WHERE id='backup-writer-department'")).rows[0].data.name,'before');let queries=0;hook=async(_sql,next)=>{queries++;return next();};const again=await f.restore();assert.equal(again.status,500);assert.equal(queries,0);assert.equal(imports,1);}finally{await f.close();}
});
test('a deterministic SQL failure and acknowledged rollback restore old files, release root and permit a fresh request',async()=>{
 const f=await fixture();try{const first=Object.freeze(Error('known import rejection'));hook=async(sql,next)=>{if(sql.startsWith('TRUNCATE '))throw first;return next();};const result=await f.restore();hook=undefined;assert.equal(result.status,500);assert.equal(caught.at(-1),first);assert.equal(readFileSync(f.artifact,'utf8'),'before');assert.equal(inspectBackupRestoreStartup({traceRoot:f.traceRoot,dataRoot:f.root}).pending,false);assert.equal(await writerAvailable(f),true);assert.equal((await f.restore()).status,200);}finally{await f.close();}
});
test('rollback acknowledgement failure preserves the first error, discards the client and keeps pending evidence',async()=>{
 const f=await fixture();try{const first=Object.freeze(Error('first import failure')),second=Error('second rollback failure');hook=async(sql,next)=>{if(sql.startsWith('TRUNCATE '))throw first;const result=await next();if(sql==='ROLLBACK')throw second;return result;};const result=await f.restore();hook=undefined;assert.equal(result.status,500);assert.equal(caught.at(-1),first);assert.equal(releases.at(-1),true);assert.equal(inspectBackupRestoreStartup({traceRoot:f.traceRoot,dataRoot:f.root}).pending,true);assert.equal(await writerAvailable(f),false);assert.equal(readFileSync(f.artifact,'utf8'),'before');}finally{await f.close();}
});
