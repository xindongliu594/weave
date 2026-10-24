import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import fs,{mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,renameSync,rmSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {syncBuiltinESMExports} from 'node:module';
import type pg from 'pg';
import {createArchiveWriterManager} from '../services/agent-runtime/archive-writer-scope.mjs';
if(process.env.SIMULATED_INTEGRATION!=='pglite')throw Error('Use the owned isolated integration runner');
let stateModule:any,pool:pg.Pool;const roots:string[]=[],runId=randomUUID();
before(async()=>{const db=await import('../apps/api/src/db.ts');pool=db.pool;await db.migrate();stateModule=await import('../apps/api/src/backup-restore-state.ts').catch(()=>({}));});
after(async()=>{await pool?.end();console.log('BACKUP_STATE_OWNED_ROOTS='+JSON.stringify({pid:process.pid,roots}));});
function fixture(){
 assert.equal(typeof stateModule.createBackupRestoreState,'function','durable restore state is required');
 const root=mkdtempSync(join(tmpdir(),'weiwu-backup-state-'));roots.push(root);writeFileSync(join(root,'.owned-backup-test.json'),JSON.stringify({root,pid:process.pid}));
 const traceRoot=join(root,'runs'),writers=createArchiveWriterManager({traceRoot});process.env.DATA_DIR=root;process.env.OBSIDIAN_VAULT=join(root,'vault');process.env.LOCAL_WORKSPACE_ROOT=root;
 mkdirSync(join(traceRoot,runId),{recursive:true});writeFileSync(join(traceRoot,runId,'proof.txt'),'before');writeFileSync(join(root,'credential.key'),Buffer.alloc(32,2));mkdirSync(join(root,'vault'));writeFileSync(join(root,'vault','note.md'),'before-note');
 const service=stateModule.createBackupRestoreState({pool,writers,traceRoot,dataRoot:root});return {root,traceRoot,writers,service};
}
async function prepared(f:ReturnType<typeof fixture>,client:pg.PoolClient){
 const stage=f.service.createStage();mkdirSync(join(stage.path,runId));writeFileSync(join(stage.path,runId,'proof.txt'),'after');
 return f.service.prepareRestore(client,{stage,master:Buffer.alloc(32,8).toString('base64'),vaultFiles:{'note.md':Buffer.from('after-note').toString('base64')},previousPaths:['note.md'],nativePluginBundles:{},inputDigest:'a'.repeat(64)});
}
test('startup inspector is read-only and treats a broken active pointer as pending',()=>{
 const f=fixture();assert.deepEqual(stateModule.inspectBackupRestoreStartup({traceRoot:f.traceRoot,dataRoot:f.root}),{pending:false});assert.equal(existsSync(join(f.root,'.backup-restore-state')),false);
 mkdirSync(join(f.root,'.backup-restore-state'));writeFileSync(join(f.root,'.backup-restore-state','active.json'),'{');assert.deepEqual(stateModule.inspectBackupRestoreStartup({traceRoot:f.traceRoot,dataRoot:f.root}),{pending:true});
});
test('same-transaction receipt proves commit and a valid new generation clears pending without replay',async()=>{
 const f=fixture();await stateModule.migrateBackupRestoreState(pool);
 await f.writers.withRootExclusive(async()=>{const client=await pool.connect();try{await client.query('BEGIN');const op=await prepared(f,client);writeFileSync(join(f.root,'vault','note.md'),'after-note');f.service.installArchive(op);await f.service.recordCommitReceipt(client,op);await client.query('COMMIT');}finally{client.release();}});
 assert.equal(stateModule.inspectBackupRestoreStartup({traceRoot:f.traceRoot,dataRoot:f.root}).pending,true);assert.deepEqual(await f.service.reconcilePending(),{status:'committed'});assert.equal(readFileSync(join(f.traceRoot,runId,'proof.txt'),'utf8'),'after');assert.deepEqual(readFileSync(join(f.root,'credential.key')),Buffer.alloc(32,8));assert.equal(readFileSync(join(f.root,'vault','note.md'),'utf8'),'after-note');assert.deepEqual(await f.service.reconcilePending(),{status:'clear'});
});
test('absent receipt plus unchanged DB generation restores verified old trace key and vault and retains new trace',async()=>{
 const f=fixture();await stateModule.migrateBackupRestoreState(pool);let operation:any;
 await f.writers.withRootExclusive(async()=>{const client=await pool.connect();try{await client.query('BEGIN');operation=await prepared(f,client);writeFileSync(join(f.root,'vault','note.md'),'after-note');f.service.installArchive(operation);await client.query('ROLLBACK');}finally{client.release();}});
 assert.deepEqual(await f.service.reconcilePending(),{status:'rolled-back'});assert.equal(readFileSync(join(f.traceRoot,runId,'proof.txt'),'utf8'),'before');assert.deepEqual(readFileSync(join(f.root,'credential.key')),Buffer.alloc(32,2));assert.equal(readFileSync(join(f.root,'vault','note.md'),'utf8'),'before-note');assert.equal(readFileSync(join(operation.retainedAfter,runId,'proof.txt'),'utf8'),'after');
});
test('committed DB cannot certify changed physical bytes and leaves original evidence pending',async()=>{
 const f=fixture();await stateModule.migrateBackupRestoreState(pool);
 await f.writers.withRootExclusive(async()=>{const client=await pool.connect();try{await client.query('BEGIN');const op=await prepared(f,client);writeFileSync(join(f.root,'vault','note.md'),'after-note');f.service.installArchive(op);await f.service.recordCommitReceipt(client,op);await client.query('COMMIT');}finally{client.release();}});
 writeFileSync(join(f.root,'vault','note.md'),'external edit');await assert.rejects(f.service.reconcilePending(),{code:'BACKUP_RESTORE_RECONCILIATION_REQUIRED'});assert.equal(readFileSync(join(f.root,'vault','note.md'),'utf8'),'external edit');assert.equal(stateModule.inspectBackupRestoreStartup({traceRoot:f.traceRoot,dataRoot:f.root}).pending,true);
});
test('missing active pointer cannot hide an unfinished durable operation',async()=>{
 const f=fixture();await stateModule.migrateBackupRestoreState(pool);
 await f.writers.withRootExclusive(async()=>{const client=await pool.connect();try{await client.query('BEGIN');await prepared(f,client);await client.query('ROLLBACK');}finally{client.release();}});
 unlinkSync(join(f.root,'.backup-restore-state','active.json'));
 assert.equal(stateModule.inspectBackupRestoreStartup({traceRoot:f.traceRoot,dataRoot:f.root}).pending,true);
 await assert.rejects(f.service.reconcilePending(),{code:'BACKUP_RESTORE_RECONCILIATION_REQUIRED'});
 assert.equal(readFileSync(join(f.traceRoot,runId,'proof.txt'),'utf8'),'before');
});
test('new staged archive files are fsynced before publishing the active durable operation',async()=>{
 const f=fixture();await stateModule.migrateBackupRestoreState(pool);const opened=new Map<number,string>(),synced:string[]=[];let publishedAt=-1;
 const originalOpen=fs.openSync,originalSync=fs.fsyncSync,originalRename=fs.renameSync;
 (fs as any).openSync=(name:any,...args:any[])=>{const fd=(originalOpen as any)(name,...args);opened.set(fd,String(name));return fd;};
 fs.fsyncSync=fd=>{synced.push(opened.get(fd)??'');return originalSync(fd);};
 fs.renameSync=(from,to)=>{if(String(to).endsWith('active.json'))publishedAt=synced.length;return originalRename(from,to);};
 try{await f.writers.withRootExclusive(async()=>{const client=await pool.connect();try{await client.query('BEGIN');const operation=await prepared(f,client);await client.query('ROLLBACK');f.service.rollbackAfterSql(operation);}finally{client.release();}});}finally{fs.openSync=originalOpen;fs.fsyncSync=originalSync;fs.renameSync=originalRename;}
 assert.ok(publishedAt>0);assert.ok(synced.slice(0,publishedAt).some(name=>name.includes('restore-')&&name.endsWith('proof.txt')),'new generation must be durable before marker and live replacement');
});
async function restartWorker(f:ReturnType<typeof fixture>,action:string,phase?:string){
 const worker=fork(fileURLToPath(new URL('./fixtures/backup-restore-crash.mjs',import.meta.url)),[],{execArgv:['--import','tsx'],stdio:['ignore','inherit','inherit','ipc'],env:{...process.env,OWNED_BACKUP_RESTART_TEST:JSON.stringify({root:f.root,runId,action,phase})}}),exited=once(worker,'exit');
 let timeout:ReturnType<typeof setTimeout>|undefined;try{const [message]=await Promise.race([once(worker,'message'),exited.then(([code])=>{throw Error('Restart worker exited '+code);}),new Promise<never>((_,reject)=>{timeout=setTimeout(()=>reject(Error('Restart worker deadline')),15000);})]);return {worker,exited,message};}catch(error){worker.kill();await exited;throw error;}finally{clearTimeout(timeout);}
}
for(const phase of ['prepared','old-moved','installed','committed'])test(`process restart after ${phase} reconciles actual SQL and recorded physical generations without replay`,async()=>{
 const f=fixture();await stateModule.migrateBackupRestoreState(pool);const first=await restartWorker(f,'crash',phase);assert.equal(first.message.phase,phase);first.worker.kill();await first.exited;
 if(phase==='old-moved')assert.equal(existsSync(f.traceRoot),false);
 const restarted=await restartWorker(f,'reconcile');assert.deepEqual(restarted.message,{status:phase==='committed'?'committed':'rolled-back'});assert.equal((await restarted.exited)[0],0);
 const committed=phase==='committed';assert.equal(readFileSync(join(f.traceRoot,runId,'proof.txt'),'utf8'),committed?'after':'before');assert.deepEqual(readFileSync(join(f.root,'credential.key')),Buffer.alloc(32,committed?8:2));assert.equal(readFileSync(join(f.root,'vault','note.md'),'utf8'),committed?'after-note':'before-note');assert.equal((await pool.query('SELECT count(*)::int AS count FROM activity WHERE id=$1',[first.message.operationId])).rows[0].count,committed?1:0);assert.equal(stateModule.inspectBackupRestoreStartup({traceRoot:f.traceRoot,dataRoot:f.root}).pending,false);
});
test('vault physical rollback failure does not replace the first frozen restore error',async()=>{
 const f=fixture(),file=join(f.root,'vault','note.md'),first=Object.freeze(Error('original vault restore failure')),second=Error('secondary vault rollback failure');
 const {restoreVaultFiles}=await import('../apps/api/src/obsidian.ts'),original=fs.writeFileSync;let writes=0;
 (fs as any).writeFileSync=(name:any,...args:any[])=>{if(String(name)===file)throw ++writes===1?first:second;return (original as any)(name,...args);};syncBuiltinESMExports();
 try{assert.throws(()=>restoreVaultFiles({'note.md':Buffer.from('after-note').toString('base64')},['note.md']),error=>error===first);assert.equal(writes,2);}finally{fs.writeFileSync=original;syncBuiltinESMExports();}
});
