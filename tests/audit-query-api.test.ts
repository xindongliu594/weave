import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import express from 'express';
import {PGlite} from '@electric-sql/pglite';
import {migrateIdentity} from '../apps/api/src/identity-schema.ts';
import {appendAudit, appendHumanAudit} from '../apps/api/src/audit-events.ts';
import type {Principal} from '../apps/api/src/identity-types.ts';

const modulePath='../apps/api/src/observability-router.ts';
const implementation:any=await import(modulePath).catch(error=>{if(error.code==='ERR_MODULE_NOT_FOUND')return {};throw error;});
const principal:Principal={kind:'human',userId:'admin-1',issuer:'https://identity.invalid',subject:'admin',orgRole:'admin',sessionId:'test',sessionEpoch:0,authenticatedAt:'2026-10-24T00:00:00.000Z'};
const hash='a'.repeat(64), range='after=2026-10-23T00%3A00%3A00.000Z&before=2026-10-25T00%3A00%3A00.000Z';
const event=(id=randomUUID())=>({eventId:id,action:'tool.result' as const,actor:{kind:'system' as const,service:'coordinator'},correlation:{correlationId:'correlation-1',runId:'run-1',operationId:'op-1'},resource:{type:'tool_operation' as const,id:'op-1',departmentIds:[]},outcome:'success' as const,changes:{state:'confirmed' as const,capabilitySha256:hash}});

test('audit query uses canonical records with bounded HTTP access and current identity',async t=>{
 assert.equal(typeof implementation.observabilityRouter,'function','audit query router must exist');
 const raw=await PGlite.create();let queryCount=0,commitFailure=false,beginFailure=false,releaseError:unknown,maxSourceBytes=0;
 const db:any={async query(sql:string,values?:unknown[]){queryCount++;if(commitFailure&&sql==='COMMIT')throw Error('PRIVATE CONNECTION DATA');if(beginFailure&&sql==='BEGIN'){await raw.exec('BEGIN');throw Error('PRIVATE BEGIN DATA');}const result=values?await raw.query(sql,values):(await raw.exec(sql)).at(-1)!;for(const row of result.rows as any[])if(row.source)maxSourceBytes=Math.max(maxSourceBytes,Buffer.byteLength(JSON.stringify(row.source)));return {rows:result.rows,rowCount:result.affectedRows??result.rows.length};},release(error?:unknown){releaseError=error;},async connect(){return db;}};
 await db.query('CREATE TABLE departments(id text PRIMARY KEY)');await migrateIdentity(db);
 await db.query("INSERT INTO human_users(id,issuer,subject,status,org_role) VALUES ('admin-1','https://identity.invalid','admin','active','admin')");
 // Fixture-only timestamp source permits real PostgreSQL microsecond ordering tests.
 await db.query("CREATE FUNCTION fixture_audit_time() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF current_setting('weiwu.test_now',true) IS NOT NULL THEN NEW.occurred_at=current_setting('weiwu.test_now')::timestamptz; END IF; RETURN NEW; END $$; CREATE TRIGGER fixture_audit_time BEFORE INSERT ON human_audit_events FOR EACH ROW EXECUTE FUNCTION fixture_audit_time()");
 const at=async(time:string)=>db.query("SELECT set_config('weiwu.test_now',$1,false)",[time]);
 const app=express();let actor:Principal|null=principal;
 app.use((_req,res,next)=>{if(actor)res.locals.principal=actor;next();});
 app.use('/api',implementation.observabilityRouter(db,{now:()=>new Date('2026-10-24T23:00:00.000Z')}));
 app.use((error:any,_req:any,res:any,_next:any)=>res.status(error.status??500).json({code:error.code??'ERROR'}));
 const server=app.listen(0,'127.0.0.1');await once(server,'listening');
 t.after(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await raw.close();});
 const get=(query=range)=>fetch(`http://127.0.0.1:${(server.address() as any).port}/api/audit/events?${query}`);
 await t.test('unidentified member auditor device and system rejected before database access',async()=>{
  for(const candidate of [null,{...principal,orgRole:'member'},{...principal,orgRole:'auditor'},{kind:'device',deviceId:'test'},{kind:'system',service:'test'}]){
   actor=candidate as Principal|null;const before=queryCount;assert.equal((await get()).status,candidate?403:401);assert.equal(queryCount,before);
  }actor=principal;
 });
 const ids=[randomUUID(),randomUUID(),randomUUID()];
 await at('2026-10-24T01:00:00.000001Z');await appendAudit(db,event(ids[0]));
 await at('2026-10-24T01:00:00.000002Z');await appendAudit(db,event(ids[1]));
 await at('2026-10-24T01:00:00.000003Z');await appendAudit(db,event(ids[2]));
 await at('2026-10-26T00:00:00Z'); // Read audits are outside the fixed fixture range.
 await t.test('canonical summaries work without a projection and reads are audited',async()=>{
  const response=await get(range+'&runId=run-1');assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
  const body=await response.json();assert.deepEqual(body.items.map((row:any)=>row.sourceEventId),[...ids].reverse());
  assert.equal(body.items[0].actor.kind,'system');assert.equal(body.items[0].outcome,'success');
  for(const forbidden of ['canonical_payload','authority_evidence','actor_snapshot','sessionEpoch','sessionId'])assert.ok(!JSON.stringify(body).includes(forbidden));
  assert.equal((await db.query('SELECT count(*)::int n FROM audit_run_projection')).rows[0].n,0);
  assert.equal((await db.query("SELECT count(*)::int n FROM human_audit_events WHERE action='audit.read'")).rows[0].n,1);
 });
 await t.test('microsecond cursor has no omissions and cannot be reused with different filters or actor',async()=>{
  const first=await (await get(range+'&runId=run-1&limit=1')).json();assert.equal(first.items[0].sourceEventId,ids[2]);assert.ok(first.nextCursor);
  const next=await (await get(range+'&runId=run-1&limit=1&cursor='+encodeURIComponent(first.nextCursor))).json();assert.equal(next.items[0].sourceEventId,ids[1]);
  const last=await (await get(range+'&runId=run-1&limit=1&cursor='+encodeURIComponent(next.nextCursor))).json();assert.equal(last.items[0].sourceEventId,ids[0]);assert.equal(last.nextCursor,null);
  assert.equal((await get(range+'&runId=run-2&limit=1&cursor='+encodeURIComponent(first.nextCursor))).status,422);
  actor={kind:'local-owner'};assert.equal((await get(range+'&runId=run-1&limit=1&cursor='+encodeURIComponent(first.nextCursor))).status,422);actor=principal;
 });
 await t.test('default time bounds stay fixed over continuation pages',async()=>{
  const first=await (await get('runId=run-1&limit=1')).json();assert.ok(first.nextCursor);
  const next=await (await get('runId=run-1&limit=1&cursor='+encodeURIComponent(first.nextCursor))).json();assert.equal(next.items[0].sourceEventId,ids[1]);assert.deepEqual(next.range,first.range);
 });
 await t.test('explicit microsecond range preserves its endpoints',async()=>{
  const query=new URLSearchParams({after:'2026-10-24T01:00:00.000002Z',before:'2026-10-24T01:00:00.000003Z',runId:'run-1'});
  const body=await (await get(String(query))).json();assert.deepEqual(body.items.map((row:any)=>row.sourceEventId),[ids[2],ids[1]]);
 });
 await t.test('unknown duplicate oversized malformed and excessive filters fail before SQL',async()=>{
  for(const query of ['limit=0','limit=101','limit=1.5','limit=1&limit=2','raw=true','after=2026-02-30T00:00:00Z','after=2025-01-01T00:00:00Z&before=2026-10-24T00:00:00Z','after=2026-10-25T00:00:00Z&before=2026-10-24T00:00:00Z','runId='+ 'a'.repeat(129),'cursor=%5Bbad%5D','outcome=secret']){
   const before=queryCount;assert.equal((await get(query)).status,422,query);assert.equal(queryCount,before);
  }
  assert.equal((await get(range+'&runId='+encodeURIComponent("' OR 1=1 --"))).status,200);
 });
 await t.test('legacy canonical actor is preserved and incomplete legacy raw fields never leak',async()=>{
  await at('2026-10-24T02:00:00Z');await appendHumanAudit(db,{actor:principal,action:'identity.logout',resourceType:'human_session',resourceId:'legacy-session',outcome:'success'});
  await db.query("INSERT INTO human_audit_events(id,actor_kind,actor_snapshot,action,resource_type,resource_id,outcome,changes) VALUES('old','system','{\"secret\":\"PRIVATE BODY\"}','PRIVATE ACTION','PRIVATE TYPE','PRIVATE ID','failure','{\"secret\":\"PRIVATE BODY\"}')");await at('2026-10-26T00:00:00Z');
  const result=await (await get()).json();assert.equal(result.items.find((row:any)=>row.action==='identity.logout').actor.kind,'human');assert.ok(result.items.some((row:any)=>row.integrity==='legacy-unverified'));assert.ok(!JSON.stringify(result).includes('PRIVATE'));
 });
 await t.test('revocation rejects next reads despite a still-valid principal object',async()=>{
  await db.query("UPDATE human_users SET session_epoch=1 WHERE id='admin-1'");assert.equal((await get()).status,404);
  await db.query("UPDATE human_users SET session_epoch=0 WHERE id='admin-1'");
 });
 await t.test('oversized legacy rows cannot leak through cursors or flood the database response',async()=>{
  await at('2026-10-24T05:00:00Z');
  await db.query("INSERT INTO human_audit_events(id,actor_kind,actor_snapshot,action,resource_type,resource_id,outcome,changes) VALUES($1,'system','{}','old','old','old','failure',$2)",['PRIVATE-ID'.repeat(400),{raw:'PRIVATE BODY'+'x'.repeat(2*1024*1024)}]);
  await at('2026-10-26T00:00:00Z');maxSourceBytes=0;
  const first=await (await get(range+'&limit=1')).json();assert.ok(first.nextCursor.length<1024);assert.ok(!Buffer.from(first.nextCursor,'base64url').toString().includes('PRIVATE'));assert.ok(maxSourceBytes<=65536);
  assert.equal((await get(range+'&limit=1&cursor='+encodeURIComponent(first.nextCursor))).status,200);
 });
 await t.test('unknown BEGIN discards the connection and returns no rows',async()=>{
  beginFailure=true;releaseError=undefined;try{const response=await get();assert.equal(response.status,503);assert.ok(!(await response.text()).includes('PRIVATE'));assert.ok(releaseError);}finally{beginFailure=false;await db.query('ROLLBACK');}
 });
 await t.test('unknown commit discards connection and does not return queried data',async()=>{
  commitFailure=true;const response=await get();assert.equal(response.status,503);const body=await response.text();assert.ok(!body.includes('PRIVATE'));assert.ok(!body.includes(ids[0]));assert.ok(releaseError);commitFailure=false;await db.query('ROLLBACK');
 });
});
