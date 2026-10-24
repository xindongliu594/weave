import {before,after,test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {once} from 'node:events';
import type {AddressInfo} from 'node:net';
import type pg from 'pg';
import {createArchiveWriterManager} from '../services/agent-runtime/archive-writer-scope.mjs';
import {createBackupRestoreState,migrateBackupRestoreState} from '../apps/api/src/backup-restore-state.ts';
import {RunCoordinator} from '../apps/api/src/run-coordinator.ts';
import {ManagerChatService} from '../apps/api/src/manager-chat.ts';
import {AutomationLearningService} from '../apps/api/src/automation-learning.ts';
import {ProviderReconciliationService} from '../apps/api/src/provider-reconciliation.ts';
import {createApp} from '../apps/api/src/app.ts';
import {createRunArchive} from '../services/agent-runtime/trace-store.mjs';
import {createObservability} from '../apps/api/src/observability.ts';

assert.equal(process.env.SIMULATED_INTEGRATION,'pglite','Use the isolated integration runner');
let pool:pg.Pool;
before(async()=>{const db=await import('../apps/api/src/db.ts');pool=db.pool;await db.migrate();await migrateBackupRestoreState(pool);});
after(async()=>{await pool.end();});
const turn=()=>new Promise<void>(resolve=>setImmediate(resolve));
function gate(){let release!:()=>void;const promise=new Promise<void>(resolve=>{release=resolve;});return {promise,release};}
function fixture(t:TestContext){
 const root=mkdtempSync(join(tmpdir(),'weiwu-app-startup-')),traceRoot=join(root,'runs');
 Object.assign(process.env,{DATA_DIR:root,TRACE_ROOT:traceRoot,OBSIDIAN_VAULT:join(root,'vault'),LOCAL_WORKSPACE_ROOT:root,WEIWU_AUTH_MODE:'legacy-local'});
 const writers=createArchiveWriterManager({traceRoot}),state=createBackupRestoreState({pool,writers,traceRoot,dataRoot:root});
 let starts=0;
 for(const prototype of [RunCoordinator.prototype,ManagerChatService.prototype,AutomationLearningService.prototype,ProviderReconciliationService.prototype]){
  t.mock.method(prototype,'start',function(this:unknown){starts++;return this;});
 }
 return {root,traceRoot,writers,state,starts:()=>starts,remove:()=>rmSync(root,{recursive:true,force:true})};
}
async function prepareCommitted(f:ReturnType<typeof fixture>){
 writeFileSync(join(f.traceRoot,'proof.txt'),'before');
 await f.writers.withRootExclusive(async()=>{
  const db=await pool.connect();try{
   await db.query('BEGIN');const stage=f.state.createStage();writeFileSync(join(stage.path,'proof.txt'),'after');
   const operation=await f.state.prepareRestore(db,{stage,vaultFiles:{},previousPaths:[],nativePluginBundles:{},inputDigest:'a'.repeat(64)});
   f.state.installArchive(operation);await f.state.recordCommitReceipt(db,operation);await db.query('COMMIT');
  }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
 });
}

test('whole app waits for actual restore evidence before identity, HTTP admission and background starts',async t=>{
 t.mock.timers.enable({apis:['setInterval']});
 const f=fixture(t);await prepareCommitted(f);const entered=gate(),release=gate();
 const owner=f.writers.withRootExclusive(async()=>{entered.release();await release.promise;});await entered.promise;
 const originalConnect=pool.connect,originalQuery=pool.query;let databaseCalls=0;
 pool.connect=function(...args:any[]){databaseCalls++;return (originalConnect as any).apply(pool,args);} as any;
 pool.query=function(...args:any[]){databaseCalls++;return (originalQuery as any).apply(pool,args);} as any;
 const app=createApp();void app.locals.ready.catch(()=>{});let ready=false;void app.locals.ready.then(()=>{ready=true;},()=>{});
 const server=app.listen(0,'127.0.0.1');await once(server,'listening');const base='http://127.0.0.1:'+(server.address() as AddressInfo).port;
 let admitted=false;const request=fetch(base+'/auth/session').then(response=>{admitted=true;return response;});
 try{
  assert.equal((await fetch(base+'/healthz')).status,200);t.mock.timers.tick(61000);await turn();
  assert.equal(f.starts(),0,'no coordinator, chat, automation or billing worker before restore');
  assert.equal(databaseCalls,0,'root ownership precedes identity and application SQL');assert.equal(ready,false);assert.equal(admitted,false);
  release.release();await owner;await app.locals.ready;
  assert.equal(f.starts(),4);assert.equal((await request).status,200);assert.equal(readFileSync(join(f.traceRoot,'proof.txt'),'utf8'),'after');
 }finally{
  release.release();await owner;await app.locals.shutdown();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));
  await request.catch(()=>{});pool.connect=originalConnect;pool.query=originalQuery;f.remove();
 }
});

test('app observes committed trace and disposes observation even when worker close fails',async t=>{
 const f=fixture(t),app=createApp();await app.locals.ready;
 const failure=Error('fixture drain failed');t.mock.method(RunCoordinator.prototype,'close',async()=>{throw failure;});
 try{
  createRunArchive(f.traceRoot,{syntheticSecret:'never include in summary'});
  const health=app.locals.observationHealth();assert.equal(health.accepted,1);assert.equal(health.state,'disabled');
  assert.equal(JSON.stringify(health).includes('syntheticSecret'),false);
  await assert.rejects(app.locals.shutdown(),error=>error===failure);
  assert.equal(app.locals.observationHealth().state,'closed');
  const next=createObservability({traceRoot:f.traceRoot,db:pool});await next.close();
  await assert.rejects(app.locals.shutdown(),error=>error===failure);
 }finally{await app.locals.shutdown().catch(()=>{});f.remove();}
});

test('unresolved restore blocks the app while liveness stays available',async t=>{
 const f=fixture(t);mkdirSync(join(f.root,'.backup-restore-state'));writeFileSync(join(f.root,'.backup-restore-state','active.json'),'{');
 const app=createApp();void app.locals.ready.catch(()=>{});const server=app.listen(0,'127.0.0.1');await once(server,'listening');const base='http://127.0.0.1:'+(server.address() as AddressInfo).port;
 try{
  await assert.rejects(app.locals.ready,{code:'BACKUP_RESTORE_RECONCILIATION_REQUIRED'});
  assert.equal(f.starts(),0);assert.equal((await fetch(base+'/auth/session')).status,503);assert.equal((await fetch(base+'/healthz')).status,200);
  assert.equal(readFileSync(join(f.root,'.backup-restore-state','active.json'),'utf8'),'{');
 }finally{await app.locals.shutdown();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));f.remove();}
});

test('shutdown while restore is waiting prevents late identity or background activation',async t=>{
 const f=fixture(t);await prepareCommitted(f);const entered=gate(),release=gate();
 const owner=f.writers.withRootExclusive(async()=>{entered.release();await release.promise;});await entered.promise;
 const app=createApp();void app.locals.ready.catch(()=>{});const closing=app.locals.shutdown();
 try{
  await turn();assert.equal(f.starts(),0);release.release();await owner;await closing;
  await assert.rejects(app.locals.ready);assert.equal(f.starts(),0);
 }finally{release.release();await owner;await closing;f.remove();}
});
