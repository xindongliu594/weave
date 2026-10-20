import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import type {AddressInfo} from 'node:net';
import express from 'express';
import type {Principal} from '../apps/api/src/identity-types.ts';

assert.equal(process.env.SIMULATED_INTEGRATION,'pglite','Run with scripts/test-integration.mjs');
assert.ok(process.env.DATABASE_URL);
let db:typeof import('../apps/api/src/db.ts'),server:ReturnType<ReturnType<typeof express>['listen']>,url:string;
let current:Principal|null=null,calls=0;
const human=(userId:string,sessionId:string):Principal=>({kind:'human',userId,sessionId,issuer:'https://issuer.example',subject:userId,
  orgRole:'admin',sessionEpoch:0,authenticatedAt:new Date().toISOString()});

before(async()=>{
  db=await import('../apps/api/src/db.ts');
  await db.pool.query('CREATE TABLE request_keys (key text PRIMARY KEY,fingerprint text NOT NULL,status integer,response jsonb,created_at timestamptz NOT NULL DEFAULT now())');
  await db.pool.query("INSERT INTO request_keys(key,fingerprint,status,response) VALUES('historical1','old',201,'{\"saved\":true}')");
  await db.migrate();
  const {idempotency}=await import('../apps/api/src/idempotency.ts');
  const app=express();app.use(express.json());
  app.use('/api',(_req,res,next)=>{if(current)res.locals.principal=current;next();},idempotency);
  app.post('/api/echo',(_req,res)=>{calls++;res.json({calls});});
  server=app.listen(0,'127.0.0.1');await once(server,'listening');
  url=`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/echo`;
});
after(async()=>{server?.closeAllConnections();if(server)await new Promise<void>(resolve=>server.close(()=>resolve()));await db?.pool.end();});
const send=async()=>{const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json','idempotency-key':'same-key-123'},body:'{}'});return {status:response.status,body:await response.json()};};

test('migration preserves historical request keys in legacy-local namespace',async()=>{
  const row=(await db.pool.query("SELECT principal_key,key,fingerprint,status,response FROM request_keys WHERE key='historical1'")).rows[0];
  assert.equal(row.principal_key,'legacy-local');assert.equal(row.status,201);assert.deepEqual(row.response,{saved:true});
});

test('same key belongs independently to two humans and revoked session cannot replay it',async()=>{
  current=human('alice','alice-session');
  assert.deepEqual(await send(),{status:200,body:{calls:1}});
  assert.deepEqual(await send(),{status:200,body:{calls:1}});
  current=human('bob','bob-session');
  assert.deepEqual(await send(),{status:200,body:{calls:2}});
  current=null;
  assert.equal((await send()).status,403);
  assert.equal(calls,2);
  const rows=(await db.pool.query("SELECT principal_key FROM request_keys WHERE key='same-key-123' ORDER BY principal_key")).rows;
  assert.deepEqual(rows.map(row=>row.principal_key),['human:alice','human:bob']);
});
