import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {PGlite} from '@electric-sql/pglite';
import type pg from 'pg';
import {migrateIdentity} from '../apps/api/src/identity-schema.ts';
import {appendAudit} from '../apps/api/src/audit-events.ts';
import * as outbox from '../apps/api/src/audit-outbox.ts';
import {createRunArchive} from '../services/agent-runtime/trace-store.mjs';
const api=await import('../apps/api/src/observability.ts').catch(()=>({})) as typeof import('../apps/api/src/observability.ts');
function create(options:Parameters<typeof api.createObservability>[0]){assert.equal(typeof api.createObservability,'function');return api.createObservability(options);}
const event=()=>({eventId:randomUUID(),action:'identity.login' as const,actor:{kind:'unidentified' as const},correlation:{correlationId:randomUUID(),requestId:'private-request'},resource:{type:'human_user' as const,id:'private-user',departmentIds:[]},outcome:'denied' as const,reasonCode:'forbidden' as const,changes:{}});
async function fixture(work:(root:string,db:pg.Pool,hook:{afterCommit?:()=>void})=>Promise<void>){
 const root=await mkdtemp(join(tmpdir(),'observation-pipeline-')),db=await PGlite.create(),hook:{afterCommit?:()=>void}={};let tail=Promise.resolve();
 const acquire=async()=>{const prior=tail;let release!:()=>void;tail=new Promise<void>(r=>release=r);await prior;return release;};
 const query=async(sql:string,values?:unknown[])=>{const r=values?.length?await db.query(sql,values):(await db.exec(sql)).at(-1)!;if(sql==='COMMIT')hook.afterCommit?.();return {rows:r.rows,rowCount:r.affectedRows??r.rows.length};};
 const pool={async query(sql:string,values?:unknown[]){const release=await acquire();try{return await query(sql,values);}finally{release();}},async connect(){const release=await acquire();return {query,release};}} as unknown as pg.Pool;
 try{await pool.query('CREATE TABLE departments(id text PRIMARY KEY)');await migrateIdentity(pool);await work(root,pool,hook);}finally{await db.close();const within=relative(resolve(tmpdir()),resolve(root));assert.ok(within.startsWith('observation-pipeline-')&&!within.startsWith('..')&&!isAbsolute(within));await rm(root,{recursive:true,force:true});}
}
test('root trace and acknowledged audit projection feed the same safe local sink',()=>fixture(async(root,db,hook)=>{
 const sink=create({traceRoot:root,db});try{
  const archive=createRunArchive(root,{}),before=await readFile(join(archive.dir,'events.jsonl'),'utf8');assert.equal(sink.snapshot().accepted,1);
  await appendAudit(db,event());let committed=false;hook.afterCommit=()=>{committed=true;};
  assert.equal(typeof outbox.observeAuditProjections,'function');let observed=false;const dispose=outbox.observeAuditProjections(db,()=>{observed=true;assert.equal(committed,true);});
  try{const result=await outbox.projectAuditOutbox(db,{limit:10,now:new Date()});assert.equal(result.projected,1);assert.equal(observed,true);assert.equal(sink.snapshot().accepted,2);assert.equal(await readFile(join(archive.dir,'events.jsonl'),'utf8'),before);
   await outbox.projectAuditOutbox(db,{limit:10,now:new Date()});assert.equal(sink.snapshot().accepted,2);
  }finally{dispose();}
 }finally{await sink.close();}
}));
test('lost projection COMMIT acknowledgement emits nothing and never replays the published projection',()=>fixture(async(root,db,hook)=>{
 const sink=create({traceRoot:root,db});try{await appendAudit(db,event());let failed=false;hook.afterCommit=()=>{if(!failed){failed=true;throw Error('private lost acknowledgement');}};
  await assert.rejects(outbox.projectAuditOutbox(db,{limit:10,now:new Date()}),/AUDIT_STORAGE_UNAVAILABLE/);assert.equal(sink.snapshot().accepted,0);hook.afterCommit=undefined;
  assert.equal((await outbox.projectAuditOutbox(db,{limit:10,now:new Date()})).projected,0);assert.equal(sink.snapshot().accepted,0);
 }finally{await sink.close();}
}));
test('throwing audit observer cannot turn a committed projection into failure',()=>fixture(async(root,db)=>{
 const sink=create({traceRoot:root,db});assert.equal(typeof outbox.observeAuditProjections,'function');const dispose=outbox.observeAuditProjections(db,()=>{throw Error('private observer error');});
 try{await appendAudit(db,event());assert.equal((await outbox.projectAuditOutbox(db,{limit:10,now:new Date()})).projected,1);assert.equal(sink.snapshot().accepted,1);assert.equal(JSON.stringify(sink.snapshot()).includes('private'),false);}finally{dispose();await sink.close();}
}));
test('100000 fresh IDs retain only fixed counters and close disposes both subscriptions',()=>fixture(async(root,db)=>{
 const sink=create({traceRoot:root,db});for(let i=0;i<100000;i++)assert.equal(sink.offer({schema:1,sourceEventId:'audit:'+randomUUID(),at:'2026-10-24T00:00:00.000Z',name:'audit.identity.login',correlation:{},actorKind:'unidentified',outcome:'denied'}),true);
 const health=sink.snapshot();assert.equal(health.accepted,100000);assert.equal(health.pendingRecords,0);assert.equal(health.pendingBytes,0);assert.ok(JSON.stringify(health).length<4096);assert.equal(health.state,'disabled');
 assert.equal(sink.offer({rawBody:'private'}),false);assert.equal(sink.snapshot().dropped,1);await sink.close();await sink.close();assert.equal(sink.snapshot().state,'closed');assert.equal(sink.offer({}),false);
 for(let i=0;i<50;i++){const next=create({traceRoot:root,db});await next.close();}
 const next=create({traceRoot:root,db});try{createRunArchive(root,{});assert.equal(next.snapshot().accepted,1);await appendAudit(db,event());await outbox.projectAuditOutbox(db,{limit:10,now:new Date()});assert.equal(next.snapshot().accepted,2);assert.equal(sink.snapshot().accepted,100000);}finally{await next.close();}
}));
test('audit subscription changes during dispatch cannot extend the current notification traversal',()=>fixture(async(root,db)=>{
 const anchor=outbox.observeAuditProjections(db,()=>{});let calls=0,dispose=()=>{};
 const sink=()=>{calls++;dispose();if(calls<3)dispose=outbox.observeAuditProjections(db,sink);};dispose=outbox.observeAuditProjections(db,sink);
 try{await appendAudit(db,event());await outbox.projectAuditOutbox(db,{limit:10,now:new Date()});assert.equal(calls,1);}
 finally{dispose();anchor();}
}));
test('audit pool limits and pipeline initialization failure release all subscriptions',()=>fixture(async(root,db)=>{
 const releases:(()=>void)[]=[];try{
  for(let i=0;i<16;i++)releases.push(outbox.observeAuditProjections({} as pg.Pool,()=>{}));
  assert.throws(()=>create({traceRoot:root,db}),/AUDIT_OBSERVER_POOL_LIMIT/);
 }finally{for(const stop of releases)stop();}
 const next=create({traceRoot:root,db});try{assert.throws(()=>create({traceRoot:root,db}),/OBSERVATION_ROOT_REGISTERED/);createRunArchive(root,{});assert.equal(next.snapshot().accepted,1);}
 finally{await next.close();}
 const listeners:(()=>void)[]=[];try{for(let i=0;i<8;i++)listeners.push(outbox.observeAuditProjections(db,()=>{}));assert.throws(()=>outbox.observeAuditProjections(db,()=>{}),/AUDIT_OBSERVER_LIMIT/);}
 finally{for(const stop of listeners)stop();}
 assert.equal(outbox.auditProjectionObservationHealth(db).subscribers,0);
}));
