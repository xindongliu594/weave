import {test} from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {once} from 'node:events';
import {randomUUID,createHash,createHmac} from 'node:crypto';
import {access,mkdtemp,readFile,rename,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import type {AddressInfo} from 'node:net';
import {routePolicy,assertRouteInventory} from '../apps/api/src/api-route-policies.ts';
import {idempotency} from '../apps/api/src/idempotency.ts';
import type {SandboxMaintenance} from '../apps/api/src/storage-lifecycle.ts';
import {readRun} from '../services/agent-runtime/trace-store.mjs';

const key={runId:'10000000-0000-0000-0000-000000000001',taskId:'a',attemptId:'attempt-a',generation:1};
const request={key,sandboxId:'10000000-0000-0000-0000-000000000003',workspaceRevision:'1'.repeat(64),stopId:'10000000-0000-0000-0000-000000000004'};
async function serve(app:express.Express){const server=app.listen(0,'127.0.0.1');await once(server,'listening');return {server,base:'http://127.0.0.1:'+(server.address() as AddressInfo).port,close:async()=>{server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));}};}

test('original-ID reconciliation has one explicit admin policy and a matching literal router mount',()=>{
 assert.deepEqual(routePolicy('POST','/api/runs/'+key.runId+'/task-stops/reconcile'),{method:'POST',path:'/api/runs/:id/task-stops/reconcile',access:'admin',source:'task-stop-maintenance.ts'});
 for(const path of ['/api/runs/'+key.runId+'/task-stops/reconcile/','/api/runs/'+key.runId+'/task-stops/other'])assert.equal(routePolicy('POST',path),null);
 assert.equal(routePolicy('GET','/api/runs/'+key.runId+'/task-stops/reconcile'),null);assert.doesNotThrow(()=>assertRouteInventory());
});

test('exact reconciliation POST bypasses response caching while nearby mutations keep key validation',async()=>{
 const app=express();app.use(express.json());app.use('/api',(_req,res,next)=>{res.locals.principal={kind:'local-owner'};next();},idempotency);
 app.use((_req,res)=>res.json({current:true}));const f=await serve(app);
 try{
  for(const [path,status] of [['/runs/'+key.runId+'/task-stops/reconcile',200],['/runs/'+key.runId+'/task-stops/reconcile/',200],['/runs/'+key.runId+'/task-stops/reconcile/extra',422],['/runs/'+key.runId+'/task-stops/other',422],['/runs/'+key.runId+'/cancel',422]] as const){
   const response=await fetch(f.base+'/api'+path,{method:'POST',headers:{'content-type':'application/json','idempotency-key':'bad'},body:'{}'});assert.equal(response.status,status,path);
  }
 }finally{await f.close();}
});

test('strict four-field body and path binding reject before selecting a maintenance provider',async()=>{
 const module=await import('../apps/api/src/task-stop-maintenance.ts') as any;assert.equal(typeof module.taskStopMaintenanceRouter,'function');
 let selected=0,throwPrivate=false;const app=express();app.use(express.json());app.use('/api',module.taskStopMaintenanceRouter('unused',{traceRoot:'unused',owner:'unused'},()=>{selected++;if(throwPrivate)throw Error('Bearer private provider / raw SQL');return undefined;}));
 const f=await serve(app);
 try{
  for(const body of [{...request,proof:{}},{...request,result:{phase:'stopped'}},{...request,key:{...key,extra:true}},{...request,stopId:'bad'},{...request,key:{...key,generation:0}},{...request,key:{...key,taskId:'private\n'}}]){
   const response=await fetch(f.base+'/api/runs/'+key.runId+'/task-stops/reconcile',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});assert.equal(response.status,422);assert.equal((await response.json() as any).code,'VALIDATION_ERROR');
  }
  const response=await fetch(f.base+'/api/runs/'+randomUUID()+'/task-stops/reconcile',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(request)});assert.equal(response.status,409);assert.equal((await response.json() as any).code,'TASK_STOP_IDENTITY_MISMATCH');assert.equal(selected,0);
  const unavailable=await fetch(f.base+'/api/runs/'+key.runId+'/task-stops/reconcile',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(request)});assert.equal(unavailable.status,409);assert.equal((await unavailable.json() as any).code,'TASK_STOP_UNAVAILABLE');
  throwPrivate=true;const failed=await fetch(f.base+'/api/runs/'+key.runId+'/task-stops/reconcile',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(request)});assert.equal(failed.status,409);const failure=await failed.json() as any;assert.equal(failure.code,'TASK_ACCEPTED_STOP_UNRESOLVED');assert.equal(JSON.stringify(failure).includes('private'),false);assert.equal(selected,2);
 }finally{await f.close();}
});

test('actual createApp authenticates each original-ID observation and re-reads SQL after uncached 409', {skip:process.env.SIMULATED_INTEGRATION!=='pglite'},async t=>{
 // Real API/SQL/Handoff provenance; model/physical operation/stop transports are
 // the established fixture. This does not certify physical JJ or paid models.
 const directory=await mkdtemp(join(tmpdir(),'task-stop-http-')),secret='R5fKs9vX2aQ7wZ4nE8cJ6tH3yU0pL1dB';
 Object.assign(process.env,{DATA_DIR:directory,TRACE_ROOT:directory,WEIWU_AUTH_MODE:'oidc',WEIWU_PUBLIC_ORIGIN:'https://stop-review.example',WEIWU_OIDC_ISSUER:'https://stop-idp.invalid',WEIWU_BOOTSTRAP_ISSUER:'https://stop-idp.invalid',WEIWU_BOOTSTRAP_SUBJECT:'owner',WEIWU_OIDC_CLIENT_ID:'stop-review',WEIWU_OIDC_CLIENT_SECRET:'fixture-client-credential',WEIWU_SESSION_SECRETS:JSON.stringify([secret]),ALLOWED_ORIGINS:''});
 const db=await import('../apps/api/src/db.ts');await db.migrate();
 const {acceptedStopApiFixture}=await import('./helpers/task-accepted-stop-api-fixture.ts');
 const f=await acceptedStopApiFixture(directory),provider:SandboxMaintenance=f.maintenance(),originalObserve=provider.executor.reconcileAcceptedTaskStop!;
 let allowObservation=false,observations=0;
 provider.executor.reconcileAcceptedTaskStop=async(...args:any[])=>{observations++;if(!allowObservation)throw Object.assign(Error('private provider / Bearer fixture-secret'),{code:'LOCAL_OUTCOME_UNKNOWN'});return originalObserve.apply(provider.executor,args as any);};
 let app:any,httpServer:Awaited<ReturnType<typeof serve>>|undefined;
 try{
  await f.acceptA();const next=await f.bind('b');f.control.afterEffect=async()=>{throw Error('fixture lost acknowledgement / private');};
  await assert.rejects(()=>f.executor.prepareTask(next,new AbortController().signal));f.control.afterEffect=undefined;
  const row=(await db.pool.query("SELECT accepted_stop FROM task_attempt_workspaces WHERE run_id=$1 AND task_id='a'",[f.runId])).rows[0],identity=row.accepted_stop.identity,body={key:identity.key,sandboxId:identity.sandboxId,workspaceRevision:identity.workspaceRevision,stopId:identity.stopId};
  assert.ok(['dispatching','unknown'].includes(row.accepted_stop.state),'lost acknowledgement preserves an unresolved original intent');assert.equal(f.control.effects,1);
  const original=(await db.pool.query('SELECT result FROM local_operations WHERE id=$1',[row.accepted_stop.proof.originalOperationId])).rows[0].result.result;
  assert.deepEqual(original.taskExecution.key,identity.key);assert.equal(original.execution.sandboxId,identity.sandboxId);assert.equal(original.workspaceRevision,identity.workspaceRevision);
  // Read-only device inventory fixture, sourced from the real HTTP/CAS commit.
  // Its physical phase stays unknown; only verified SQL stop facts are projected.
  provider.executor.storageScopes=()=>[{runId:f.runId,key:original.taskExecution.key,sandboxId:original.execution.sandboxId,workspaceRevision:original.workspaceRevision,phase:'unknown'}];
  const {createApp}=await import('../apps/api/src/app.ts');app=createApp({sandboxMaintenance:f.maintenance});await app.locals.ready;await app.locals.shutdownBackground();httpServer=await serve(app);
  const sid=randomUUID(),user=randomUUID(),now=new Date().toISOString(),csrf='stop-review-csrf';
  await db.pool.query("INSERT INTO human_users(id,issuer,subject,status,org_role) VALUES($1,'https://stop-idp.invalid','member','active','member')",[user]);
  await db.pool.query("INSERT INTO human_session_lifecycles(sid,family_sid,valid_until,retain_until) VALUES($1,$1,now()+interval '1 hour',now()+interval '1 hour')",[sid]);
  await db.pool.query("INSERT INTO human_sessions(sid,sess,expire) VALUES($1,$2,now()+interval '1 hour')",[sid,JSON.stringify({cookie:{originalMaxAge:3600000,expires:new Date(Date.now()+3600000).toISOString(),secure:true,httpOnly:true,path:'/',sameSite:'lax'},csrf,human:{userId:user,sessionId:sid,sessionEpoch:0,authenticatedAt:now,createdAt:now,lastSeenAt:now}})]);
  const signed=sid+'.'+createHmac('sha256',secret).update(sid).digest('base64').replace(/=+$/,''),cookie='__Host-weiwu.sid='+encodeURIComponent('s:'+signed),path='/api/runs/'+f.runId+'/task-stops/reconcile',idem='original-stop-same-key';
  const call=(target=path,payload:any=body,extra:Record<string,string>={})=>fetch(httpServer!.base+target,{method:'POST',headers:{'content-type':'application/json','x-forwarded-host':'stop-review.example','x-forwarded-proto':'https',cookie,'x-csrf-token':csrf,'idempotency-key':idem,...extra},body:JSON.stringify(payload)});
  assert.equal((await call()).status,403,'ordinary human cannot observe original device state');
  assert.equal((await fetch(httpServer.base+path,{method:'POST',headers:{'content-type':'application/json','X-Local-Device-Key':'a'.repeat(64)},body:JSON.stringify(body)})).status,403,'device credentials cannot enter this admin route');
  await db.pool.query("UPDATE human_users SET org_role='admin' WHERE id=$1",[user]);
  assert.equal((await call(path,body,{'x-csrf-token':''})).status,403);assert.equal(observations,0);
  assert.equal((await call(path,{...body,proof:{private:'rejected'}})).status,422);
  assert.equal((await call('/api/runs/'+randomUUID()+'/task-stops/reconcile')).status,409);
  const first=await call();assert.equal(first.status,409);const unresolved=await first.json() as any;assert.equal(unresolved.code,'TASK_ACCEPTED_STOP_UNRESOLVED');assert.equal(JSON.stringify(unresolved).includes('private'),false);assert.equal(observations,1);
  allowObservation=true;const second=await call();assert.equal(second.status,200);const resolved=await second.json() as any;assert.equal(resolved.replayed,false);assert.equal(resolved.maintenance.scopes.find((scope:any)=>scope.key?.taskId==='a').state,'stopped');assert.equal(observations,2);assert.equal(f.control.effects,1);
  const repeated=await call();assert.equal(repeated.status,200);assert.equal(observations,3,'confirmed repeat still observes the original ID through the current provider');assert.equal(f.control.effects,1,'confirmed repeat never replays a stop');assert.equal(f.control.calls,1,'route never dispatches another stop');
  assert.equal((await db.pool.query('SELECT count(*)::int n FROM request_keys WHERE key=$1',[idem])).rows[0].n,0);
  await db.pool.query('UPDATE local_devices SET enabled=false WHERE id=$1',[f.deviceId]);assert.equal((await call()).status,409,'same key rechecks current original device binding after confirmation');assert.equal(observations,3,'revoked original device is refused before provider observation');await db.pool.query('UPDATE local_devices SET enabled=true WHERE id=$1',[f.deviceId]);
  await db.pool.query("UPDATE human_users SET org_role='member' WHERE id=$1",[user]);assert.equal((await call()).status,403,'same key rechecks current admin authorization');await db.pool.query("UPDATE human_users SET org_role='admin' WHERE id=$1",[user]);
  const ordinaryKey='ordinary-cache-key',fingerprint=createHash('sha256').update('POST /api/departments {}').digest('hex');
  await db.pool.query('INSERT INTO request_keys(principal_key,key,fingerprint,status,response) VALUES($1,$2,$3,200,$4)',['human:'+user,ordinaryKey,fingerprint,JSON.stringify({ordinaryCached:true})]);
  assert.deepEqual(await (await call('/api/departments',{}, {'idempotency-key':ordinaryKey})).json(),{ordinaryCached:true});
  f.archive.append('runtime/maintenance-pending',{version:1,state:'pending',reasonCode:'TASK_STOP_UNKNOWN'});f.archive.append('runtime/maintenance-completed',{version:1,state:'stopped'});
  const detailHeaders={'x-forwarded-host':'stop-review.example','x-forwarded-proto':'https',cookie};
  const detail=await (await fetch(httpServer.base+'/api/runs/'+f.runId,{headers:detailHeaders})).json() as any;assert.equal(detail.taskStopMaintenance.scopes.find((scope:any)=>scope.key?.taskId==='a').state,'stopped');assert.deepEqual(detail.summaryEvents.filter((event:any)=>event.type.startsWith('runtime/maintenance-')).map((event:any)=>event.type),['runtime/maintenance-pending','runtime/maintenance-completed']);
  const storage=await (await fetch(httpServer.base+'/api/storage/sandboxes',{headers:detailHeaders})).json() as any;assert.equal(storage.available,true);assert.equal(storage.scopes.length,1);
  const retained=storage.scopes[0];assert.equal(retained.scopeKind,'task');assert.equal(retained.phase,'unknown');assert.deepEqual(retained.key,identity.key);assert.equal(retained.sandboxId,identity.sandboxId);assert.equal(retained.workspaceRevision,identity.workspaceRevision);assert.deepEqual(retained.taskStopMaintenance,{key:identity.key,sandboxId:identity.sandboxId,workspaceRevision:identity.workspaceRevision,state:'stopped',stopId:identity.stopId,canReconcile:false});
  const markerBefore=(await db.pool.query("SELECT accepted_stop FROM task_attempt_workspaces WHERE run_id=$1 AND task_id='a'",[f.runId])).rows[0].accepted_stop;
  async function protectedDetail(){
   const response=await fetch(httpServer!.base+'/api/runs/'+f.runId,{headers:detailHeaders});assert.equal(response.status,200);
   const unavailable=await response.json() as any;assert.equal(unavailable.id,f.runId);assert.equal(unavailable.status,detail.status);assert.equal(unavailable.integrity,'incomplete');
   assert.equal(unavailable.taskStopMaintenance.state,'pending');assert.ok(unavailable.taskStopMaintenance.scopes.length>0);assert.ok(unavailable.taskStopMaintenance.scopes.every((scope:any)=>scope.state==='unverified'&&scope.canReconcile===false));
   assert.deepEqual(unavailable.events,[]);assert.deepEqual(unavailable.summaryEvents??[],[]);assert.equal(unavailable.eventCount,0);assert.equal(unavailable.hasMore,false);assert.equal(typeof unavailable.recovery.checkpointBlocked,'string');
   assert.equal(JSON.stringify(unavailable).includes('archive-private-sentinel'),false);
   const observed=await call();assert.equal(observed.status,409);assert.equal((await observed.json() as any).code,'TASK_ACCEPTED_STOP_UNRESOLVED');assert.equal(observations,3);assert.equal(f.control.calls,1);assert.equal(f.control.effects,1);
   assert.deepEqual((await db.pool.query("SELECT accepted_stop FROM task_attempt_workspaces WHERE run_id=$1 AND task_id='a'",[f.runId])).rows[0].accepted_stop,markerBefore);
  }
  await t.test('a missing snapshot preserves only protected SQL detail',async()=>{
   await rename(join(f.archive.dir,'snapshot.json'),join(f.archive.dir,'snapshot.saved'));
   try{assert.equal(readRun(directory,f.runId),null);await protectedDetail();}finally{await rename(join(f.archive.dir,'snapshot.saved'),join(f.archive.dir,'snapshot.json'));}
  });
  await t.test('malformed snapshot JSON cannot bypass the protected SQL detail',async()=>{
   const path=join(f.archive.dir,'snapshot.json'),original=await readFile(path);
   try{await writeFile(path,'{"archive-private-sentinel":');assert.throws(()=>readRun(directory,f.runId));await protectedDetail();}finally{await writeFile(path,original);}
  });
  await t.test('missing plain and archived journal remains visibly unverified',async()=>{
   const path=join(f.archive.dir,'events.jsonl'),saved=join(f.archive.dir,'events.saved');await rename(path,saved);
   try{assert.throws(()=>readRun(directory,f.runId));await protectedDetail();}finally{await rename(saved,path);}
  });
  await t.test('invalid archived journal metadata cannot bypass the protected SQL detail',async()=>{
   const plain=join(f.archive.dir,'events.jsonl'),saved=join(f.archive.dir,'events.saved'),compressed=join(f.archive.dir,'events.jsonl.gz'),metadata=join(f.archive.dir,'journal-archive.json');
   await assert.rejects(access(compressed),{code:'ENOENT'});await assert.rejects(access(metadata),{code:'ENOENT'});await rename(plain,saved);
   try{await writeFile(compressed,Buffer.from('invalid fixture gzip'),{flag:'wx'});await writeFile(metadata,'{"archive-private-sentinel":',{flag:'wx'});assert.throws(()=>readRun(directory,f.runId));await protectedDetail();}finally{await rm(compressed,{force:true});await rm(metadata,{force:true});await rename(saved,plain);}
  });
  assert.equal((await fetch(httpServer.base+'/api/runs/'+randomUUID(),{headers:detailHeaders})).status,404,'no archive and no SQL row remains absent');
 }finally{await app?.locals.shutdown();await httpServer?.close();await f.close();await db.pool.end();await rm(directory,{recursive:true,force:true});}
});
