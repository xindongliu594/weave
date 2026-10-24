import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import type pg from 'pg';
import {createIdentityHttp} from '../apps/api/src/identity-http.ts';
import {loadIdentityConfig} from '../apps/api/src/identity-config.ts';

assert.equal(process.env.SIMULATED_INTEGRATION,'pglite','Use the isolated integration runner');
let pool:pg.Pool;
before(async()=>{const database=await import('../apps/api/src/db.ts');pool=database.pool;await database.migrate();});
after(async()=>{await pool.end();});
function gate(){let release!:()=>void,reject!:(error:Error)=>void;const promise=new Promise<void>((yes,no)=>{release=yes;reject=no;});void promise.catch(()=>{});return {promise,release,reject};}
const turn=()=>new Promise<void>(resolve=>setImmediate(resolve));
function counts(){
 const connect=pool.connect,query=pool.query;let connections=0,queries=0;
 pool.connect=function(...args:any[]){connections++;return (connect as any).apply(pool,args);} as any;
 pool.query=function(...args:any[]){queries++;return (query as any).apply(pool,args);} as any;
 return {snapshot:()=>({connections,queries}),restore:()=>{pool.connect=connect;pool.query=query;}};
}

test('identity initialization and request admission wait for the restore barrier',async()=>{
 const barrier=gate(),calls=counts(),identity=createIdentityHttp({pool,config:{mode:'legacy-local'},initializeAfter:barrier.promise});
 void identity.ready.catch(()=>{});let authenticated=false;
 const request=identity.authenticate({} as any).then(value=>{authenticated=true;return value;});
 try{
  await turn();assert.deepEqual(calls.snapshot(),{connections:0,queries:0});assert.equal(authenticated,false);
  barrier.release();await identity.ready;assert.deepEqual(await request,{kind:'local-owner'});assert.ok(calls.snapshot().connections>0);
 }finally{barrier.release();await identity.ready.catch(()=>{});await request.catch(()=>{});await identity.close();calls.restore();}
});

test('failed restore barrier preserves its error and never activates identity or prunes sessions',async t=>{
 t.mock.timers.enable({apis:['setInterval']});
 const config=loadIdentityConfig({WEIWU_AUTH_MODE:'oidc',WEIWU_PUBLIC_ORIGIN:'https://fixture.example',WEIWU_OIDC_ISSUER:'https://issuer.invalid',WEIWU_BOOTSTRAP_ISSUER:'https://issuer.invalid',WEIWU_BOOTSTRAP_SUBJECT:'owner',WEIWU_OIDC_CLIENT_ID:'fixture',WEIWU_OIDC_CLIENT_SECRET:'synthetic-only',WEIWU_SESSION_SECRETS:JSON.stringify(['R5fKs9vX2aQ7wZ4nE8cJ6tH3yU0pL1dB'])});
 const barrier=gate(),calls=counts();let transports=0;
 const identity=createIdentityHttp({pool,config,initializeAfter:barrier.promise,transport:async()=>{transports++;throw Error('No external network');}});
 const original=Object.assign(Error('Restore result remains unknown'),{code:'BACKUP_RESTORE_RECONCILIATION_REQUIRED'});
 void identity.ready.catch(()=>{});
 try{
  t.mock.timers.tick(61000);await turn();assert.deepEqual(calls.snapshot(),{connections:0,queries:0});assert.equal(transports,0);
  barrier.reject(original);await assert.rejects(identity.ready,error=>error===original);
  t.mock.timers.tick(61000);await turn();assert.deepEqual(calls.snapshot(),{connections:0,queries:0});assert.equal(transports,0);
 }finally{barrier.reject(original);await identity.ready.catch(()=>{});await identity.close();calls.restore();t.mock.timers.reset();}
});

test('closing before restore readiness prevents a late identity activation',async()=>{
 const barrier=gate(),calls=counts(),identity=createIdentityHttp({pool,config:{mode:'legacy-local'},initializeAfter:barrier.promise});
 void identity.ready.catch(()=>{});
 try{
  await identity.close();barrier.release();await assert.rejects(identity.ready,{message:'Identity service is closed'});
  assert.deepEqual(calls.snapshot(),{connections:0,queries:0});
 }finally{barrier.release();await identity.ready.catch(()=>{});await identity.close();calls.restore();}
});

test('close drains identity initialization that has already entered SQL',async()=>{
 const original=pool.connect,entered=gate(),release=gate();let closed=false;
 pool.connect=function(...args:any[]){if(args.length)return (original as any).apply(pool,args);entered.release();return release.promise.then(()=>(original as any).call(pool));} as any;
 const identity=createIdentityHttp({pool,config:{mode:'legacy-local'}});void identity.ready.catch(()=>{});
 try{
  await entered.promise;const closing=identity.close().then(()=>{closed=true;});
  await turn();assert.equal(closed,false,'close must retain the original initialization SQL tail');
  release.release();await closing;await assert.rejects(identity.ready,{message:'Identity service is closed'});assert.equal(closed,true);
 }finally{release.release();await identity.ready.catch(()=>{});await identity.close();pool.connect=original;}
});
