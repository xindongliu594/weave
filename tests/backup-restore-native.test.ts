import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import pg from 'pg';
import {createArchiveWriterManager} from '../services/agent-runtime/archive-writer-scope.mjs';
import {createArchiveWriteFence} from '../services/agent-runtime/archive-write-fence.mjs';
const connectionString=process.env.BACKUP_RESTORE_POSTGRES_URL,enabled=!!connectionString;
if(enabled){const url=new URL(connectionString!);if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||url.username!=='weiwu_test'||!/^\/weiwu_backup_test_[a-f0-9]{32}$/.test(url.pathname)||!url.port||url.search||url.hash)throw Error('Explicit owned backup native database required');}
let pool:pg.Pool,stateModule:any;const roots:string[]=[],children:Array<{worker:ReturnType<typeof fork>;exited:Promise<any>}>=[],runId=randomUUID();
before(async()=>{if(!enabled)return;process.env.DATABASE_URL=connectionString;pool=new pg.Pool({connectionString,max:4});const identity=(await pool.query('SELECT current_user AS username,current_database() AS name')).rows[0];assert.equal(identity.username,'weiwu_test');assert.match(identity.name,/^weiwu_backup_test_[a-f0-9]{32}$/);stateModule=await import('../apps/api/src/backup-restore-state.ts');await stateModule.migrateBackupRestoreState(pool);await pool.query('CREATE TABLE IF NOT EXISTS activity(id text PRIMARY KEY,kind text NOT NULL,title text NOT NULL)');});
after(async()=>{if(!enabled)return;for(const {worker,exited} of children)if(worker.exitCode===null&&worker.signalCode===null){worker.kill();await exited;}await pool.end();for(const root of roots){const owner=JSON.parse(fs.readFileSync(path.join(root,'.owned-backup-test.json'),'utf8'));assert.equal(owner.root,root);assert.equal(owner.pid,process.pid);assert.equal(fs.realpathSync(root),root);assert.match(path.relative(fs.realpathSync(os.tmpdir()),root),/^weiwu-backup-state-[A-Za-z0-9]+$/);fs.rmSync(root,{recursive:true});}});
function fixture(){
 const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'weiwu-backup-state-'));roots.push(root);fs.writeFileSync(path.join(root,'.owned-backup-test.json'),JSON.stringify({root,pid:process.pid}));process.env.DATA_DIR=root;process.env.OBSIDIAN_VAULT=path.join(root,'vault');process.env.LOCAL_WORKSPACE_ROOT=root;
 const traceRoot=path.join(root,'runs'),writers=createArchiveWriterManager({traceRoot});fs.mkdirSync(path.join(traceRoot,runId));fs.writeFileSync(path.join(traceRoot,runId,'proof.txt'),'before');fs.writeFileSync(path.join(root,'credential.key'),Buffer.alloc(32,2));fs.mkdirSync(path.join(root,'vault'));fs.writeFileSync(path.join(root,'vault','note.md'),'before-note');
 return {root,traceRoot,writers,service:stateModule.createBackupRestoreState({pool,writers,traceRoot,dataRoot:root})};
}
async function worker(f:ReturnType<typeof fixture>,args:Record<string,unknown>){
 const child=fork(fileURLToPath(new URL('./fixtures/backup-restore-crash.mjs',import.meta.url)),[],{execArgv:['--import','tsx'],stdio:['ignore','inherit','inherit','ipc'],env:{...process.env,OWNED_BACKUP_NATIVE_TEST:'true',OWNED_BACKUP_RESTART_TEST:JSON.stringify({root:f.root,runId,...args})}}),exited=once(child,'exit');children.push({worker:child,exited});
 let timer:ReturnType<typeof setTimeout>|undefined;try{const [message]=await Promise.race([once(child,'message'),exited.then(([code])=>{throw Error('Native backup worker exited '+code);}),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('Native backup worker deadline')),15000);})]);return {child,exited,message};}finally{clearTimeout(timer);}
}
function assertPhysical(f:ReturnType<typeof fixture>,committed:boolean){assert.equal(fs.readFileSync(path.join(f.traceRoot,runId,'proof.txt'),'utf8'),committed?'after':'before');assert.deepEqual(fs.readFileSync(path.join(f.root,'credential.key')),Buffer.alloc(32,committed?8:2));assert.equal(fs.readFileSync(path.join(f.root,'vault','note.md'),'utf8'),committed?'after-note':'before-note');}
for(const phase of ['prepared','old-moved','installed','committed'])test(`native PostgreSQL process restart after ${phase} proves the same operation outcome`,{skip:!enabled},async()=>{
 const f=fixture(),original=await worker(f,{action:'crash',phase});assert.equal(original.message.phase,phase);original.child.kill();await original.exited;if(phase==='old-moved')assert.equal(fs.existsSync(f.traceRoot),false);
 const restored=await worker(f,{action:'reconcile'});assert.deepEqual(restored.message,{status:phase==='committed'?'committed':'rolled-back'});assert.equal((await restored.exited)[0],0);assertPhysical(f,phase==='committed');assert.equal((await pool.query('SELECT count(*)::int AS count FROM activity WHERE id=$1',[original.message.operationId])).rows[0].count,phase==='committed'?1:0);
});
for(const commit of [false,true])test(`independent backend reconciliation waits for original SQL ${commit?'COMMIT':'ROLLBACK'} before deciding from receipt absence`,{skip:!enabled},async()=>{
 const f=fixture(),client=await pool.connect();let operation:any;
 try{
  await f.writers.withRootExclusive(async()=>{await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(918274)');await client.query('SELECT pg_advisory_xact_lock(918275)');const stage=f.service.createStage();fs.mkdirSync(path.join(stage.path,runId));fs.writeFileSync(path.join(stage.path,runId,'proof.txt'),'after');operation=await f.service.prepareRestore(client,{stage,master:Buffer.alloc(32,8).toString('base64'),vaultFiles:{'note.md':Buffer.from('after-note').toString('base64')},previousPaths:['note.md'],nativePluginBundles:{},inputDigest:'c'.repeat(64)});fs.writeFileSync(path.join(f.root,'vault','note.md'),'after-note');f.service.installArchive(operation);await client.query("INSERT INTO activity(id,kind,title) VALUES($1,'owned-backup-barrier','one original import')",[operation.id]);await f.service.recordCommitReceipt(client,operation);});
  // Deliberately release the original native owner while its backend remains in
  // a transaction, modelling a disconnected process whose DB outcome is pending.
  const applicationName='owned-backup-barrier-'+randomUUID(),other=await worker(f,{action:'reconcile',notifyWait:true,applicationName});assert.deepEqual(other.message,{phase:'reconcile-starting'});let waiting=false;
  const deadline=Date.now()+5000;while(Date.now()<deadline){const rows=(await pool.query("SELECT pid,wait_event_type FROM pg_stat_activity WHERE application_name=$1 AND state='active'",[applicationName])).rows;if(rows.some(row=>row.wait_event_type==='Lock')){waiting=true;break;}await new Promise(resolve=>setTimeout(resolve,20));}assert.equal(waiting,true,'second backend must actually wait on original SQL gate');
  const fence=createArchiveWriteFence({traceRoot:f.traceRoot,lockRoot:f.writers.lockRoot});await assert.rejects(fence.acquireWriter([runId],{timeoutMs:0}),{code:'E_ARCHIVE_FENCE_TIMEOUT'});
  const completed=once(other.child,'message');await client.query(commit?'COMMIT':'ROLLBACK');assert.deepEqual((await completed)[0],{status:commit?'committed':'rolled-back'});assert.equal((await other.exited)[0],0);assertPhysical(f,commit);assert.equal((await pool.query('SELECT count(*)::int AS count FROM activity WHERE id=$1',[operation.id])).rows[0].count,commit?1:0);
 }finally{try{await client.query('ROLLBACK');}catch{}client.release();}
});
