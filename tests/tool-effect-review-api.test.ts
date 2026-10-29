import {after,before,test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import express from 'express';
import type {Server} from 'node:http';
import pg from 'pg';
import {migrateIdentity} from '../apps/api/src/identity-schema.ts';
import {ToolEffectContractService,migrateToolEffectContracts,toolEffectContractsRouter} from '../apps/api/src/tool-effect-contracts.ts';
import {effectDigest} from '../services/agent-runtime/tool-effects.mjs';
import type {EffectContract} from '../packages/contracts/tool-effects.ts';
import type {HumanPrincipal} from '../apps/api/src/identity-types.ts';
import {migrateRestoreControlFixture} from './helpers/restore-control-schema.ts';
assert.equal(process.env.SIMULATED_INTEGRATION,'pglite','Use isolated runner');
const contract:EffectContract={schema:1,capabilityId:'fixture:knowledge',namespace:'fixture',toolName:'knowledge_read',source:{kind:'builtin',reference:'fixture',version:'1',digest:'a'.repeat(64)},definitionSha256:'b'.repeat(64),effect:'read',isolationProfile:'fixture',permissions:['tool:knowledge_read'],retry:'bounded-read',cost:{kind:'free'},reconciliation:{kind:'receipt'},compensation:{kind:'none',requiresApproval:true},evidenceRefs:['fixture:protocol-only']};
let db:pg.Pool,server:Server,url:string,sourceLoads=0;
before(async()=>{
 db=new pg.Pool({connectionString:process.env.DATABASE_URL});await db.query('CREATE TABLE departments(id text PRIMARY KEY)');await migrateIdentity(db);await migrateToolEffectContracts(db);
 await migrateRestoreControlFixture(db);
 await db.query("INSERT INTO human_users(id,issuer,subject,status,org_role) VALUES('admin','https://issuer.test','admin','active','admin'),('member','https://issuer.test','member','active','member')");
 const service=new ToolEffectContractService({db,resolveBinding:async(_db,key)=>key.toolName===contract.toolName&&key.namespace===contract.namespace?contract:null});
 const app=express();app.use(express.json());app.use((req,res,next)=>{
  // Protocol fixture only: the service still checks the real stored user/epoch.
  const userId=req.headers['x-fixture-user'];if(typeof userId==='string')res.locals.principal={kind:'human',userId,sessionId:'session',issuer:'https://issuer.test',subject:userId,orgRole:'admin',sessionEpoch:0,authenticatedAt:new Date().toISOString()} satisfies HumanPrincipal;next();
 });
 app.use('/api',toolEffectContractsRouter(async()=>service,async()=>{sourceLoads++;return [contract];}));
 app.use((error:any,_req:any,res:any,_next:any)=>res.status(error.status??500).json({code:error.code??'ERROR'}));
 server=app.listen(0,'127.0.0.1');await once(server,'listening');url='http://127.0.0.1:'+(server.address() as any).port+'/api';
});
after(async()=>{server?.closeAllConnections();if(server)await new Promise<void>(resolve=>server.close(()=>resolve()));await db?.end();});
async function request(path:string,method='GET',body?:unknown,user='admin'){const response=await fetch(url+path,{method,headers:{'content-type':'application/json',...(user?{'x-fixture-user':user}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});const text=await response.text();return {status:response.status,data:response.headers.get('content-type')?.includes('application/json')?JSON.parse(text):text};}
test('lazy contract HTTP routes verify the current admin before listing and bind review/retirement to fixed versions',async()=>{
 assert.equal((await request('/tool-effect-contracts/sources','GET',undefined,'')).status,403);assert.equal(sourceLoads,0);
 assert.equal((await request('/tool-effect-contracts/sources','GET',undefined,'member')).status,403);assert.equal(sourceLoads,0,'claimed admin role cannot override the database');
 const listed=await request('/tool-effect-contracts/sources');assert.equal(listed.status,200);assert.equal(listed.data[0].toolName,'knowledge_read');
 const key={namespace:contract.namespace,toolName:contract.toolName},candidate=await request('/tool-effect-contracts/candidate?'+new URLSearchParams(key));assert.equal(candidate.status,200);assert.equal(candidate.data.status,'unreviewed');
 const reviewed=await request('/tool-effect-contracts/reviews','POST',{...key,expectedDigest:effectDigest(contract)});assert.equal(reviewed.status,200);assert.equal(reviewed.data.status,'reviewed');
 const retired=await request('/tool-effect-contracts/'+reviewed.data.digest+'/retire','POST',{expectedVersion:reviewed.data.version});assert.equal(retired.status,200);assert.equal(retired.data.status,'retired');
 const again=await request('/tool-effect-contracts/reviews','POST',{...key,expectedDigest:effectDigest(contract)});assert.equal(again.status,409);assert.equal(again.data.code,'TOOL_EFFECT_RETIRED');
 await db.query("UPDATE human_users SET session_epoch=1 WHERE id='admin'");const count=sourceLoads;
 assert.equal((await request('/tool-effect-contracts/sources')).status,403);assert.equal(sourceLoads,count);
 assert.equal((await db.query('SELECT count(*)::int n FROM human_audit_events')).rows[0].n,2);
});
