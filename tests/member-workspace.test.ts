import test from 'node:test';
import assert from 'node:assert/strict';
import {identitySession,identityAuthorized} from '../apps/web/src/identity-session.ts';
import {api} from '../apps/web/src/api.ts';

const modulePath='../apps/web/src/MemberWorkspace-data.ts';
const session=(role='member',status='active',id='member-a')=>({mode:'oidc',authenticated:status==='active',user:{id,displayName:id,email:null,status,orgRole:role},csrf:'synthetic',loginAvailable:true});
async function select(value:unknown){globalThis.fetch=async()=>Response.json(value);await identitySession.refresh();}
const flush=async()=>{for(let i=0;i<15;i++)await Promise.resolve();};

test('member transport reads only allowlisted resources and leaves common admin transport closed',async()=>{
 const original=globalThis.fetch;
 try{
  const {memberRead}=await import(modulePath);await select(session());assert.equal(identityAuthorized(identitySession.getSnapshot()),false);await assert.rejects(api('/projects'));
  const seen:string[]=[];globalThis.fetch=async(input,init)=>{seen.push(String(input));assert.equal(init?.method,'GET');assert.equal(init?.credentials,'same-origin');assert.equal(init?.cache,'no-store');assert.equal(new Headers(init?.headers).get('x-fixture-actor'),null);return Response.json([]);};
  await memberRead('departments');await memberRead('projects',100);await memberRead('runs');assert.deepEqual(seen,['/api/departments','/api/projects?limit=100&offset=100','/api/runs?limit=100&offset=0']);
  await assert.rejects(memberRead('settings' as any));await assert.rejects(memberRead('runs',-1));assert.equal(seen.length,3);
  for(const [role,status] of [['auditor','active'],['member','pending'],['member','disabled'],['admin','active']]){await select(session(role,status));globalThis.fetch=async()=>{throw Error('must not fetch');};await assert.rejects(memberRead('projects'));}
 }finally{globalThis.fetch=original;}
});

test('refresh clears old rows, latest request wins, reset aborts and rejects late principal data',async()=>{
 const original=globalThis.fetch;
 try{
  const {createMemberWorkspace}=await import(modulePath);await select(session());
  let pending:Array<(r:Response)=>void>=[];const signals:AbortSignal[]=[];
  globalThis.fetch=async(_input,init)=>{signals.push(init!.signal!);return new Promise(resolve=>pending.push(resolve));};
  const store=createMemberWorkspace(),stop=store.subscribe(()=>{});const first=store.refresh();await flush();
  pending.splice(0).forEach(done=>done(Response.json([])));await first;assert.equal(store.getSnapshot().status,'ready');
  const stale=store.refresh();await flush();const staleResponses=pending.splice(0);const latest=store.refresh();await flush();
  assert.equal(store.getSnapshot().status,'loading');assert.equal(signals[3].aborted,true);pending.splice(0).forEach(done=>done(Response.json([])));await latest;
  staleResponses.forEach(done=>done(Response.json([{id:'old',name:'old',requirement:'old',status:'running'}])));await stale;assert.deepEqual(store.getSnapshot().departments,[]);
  const revoked=store.refresh();await flush();const oldResponses=pending.splice(0);identitySession.invalidate();assert.equal(store.getSnapshot().status,'idle');assert.ok(signals.at(-1)!.aborted);
  oldResponses.forEach(done=>done(Response.json([{id:'old',name:'old',requirement:'old',status:'running'}])));await revoked;assert.deepEqual(store.getSnapshot().projects,[]);stop();
 }finally{globalThis.fetch=original;}
});

test('401 invalidates; 403 and malformed payload clear all displayed rows without retry',async()=>{
 const original=globalThis.fetch;
 try{
  const {createMemberWorkspace}=await import(modulePath);
  for(const status of [200,401,403]){
   await select(session());globalThis.fetch=async()=>Response.json([{id:'prior',name:'部门',requirement:'项目',status:'running'}]);
   const store=createMemberWorkspace();await store.refresh();assert.equal(store.getSnapshot().runs.length,1);
   let calls=0;globalThis.fetch=async()=>{calls++;return Response.json(status===200?{invalid:true}:{message:'denied'},{status});};
   const pending=store.refresh();assert.deepEqual(store.getSnapshot().runs,[]);await pending;assert.equal(store.getSnapshot().status,'error');assert.deepEqual(store.getSnapshot().runs,[]);assert.equal(calls,3);assert.equal(identitySession.getSnapshot().status,status===401?'signed-out':'member');
  }
 }finally{globalThis.fetch=original;}
});

test('offset navigation requests backend pages and never invents frontend department grants',async()=>{
 const original=globalThis.fetch;
 try{
  const {createMemberWorkspace}=await import(modulePath);await select(session());const seen:string[]=[];
  globalThis.fetch=async input=>{seen.push(String(input));return Response.json([]);};const store=createMemberWorkspace();await store.refresh({projectOffset:100,runOffset:200});
  assert.equal(store.getSnapshot().projectOffset,100);assert.equal(store.getSnapshot().runOffset,200);assert.ok(seen.includes('/api/projects?limit=100&offset=100'));assert.ok(seen.includes('/api/runs?limit=100&offset=200'));
 }finally{globalThis.fetch=original;}
});

test('a late member response body cannot cross into the next principal',async()=>{
 const original=globalThis.fetch;
 try{
  const {memberRead}=await import(modulePath);await select(session());let body!:ReadableStreamDefaultController<Uint8Array>;
  globalThis.fetch=async()=>new Response(new ReadableStream({start(controller){body=controller;}}));
  const pending=memberRead('runs');await flush();await select(session('member','active','member-b'));
  body.enqueue(new TextEncoder().encode('[{"id":"private-a","status":"completed"}]'));body.close();await assert.rejects(pending,{name:'AbortError'});
 }finally{globalThis.fetch=original;}
});

test('session publication during a pending automatic resource read never aborts or restarts it',async()=>{
 const original=globalThis.fetch;let stopIdentity=()=>{},stopStore=()=>{};
 try{
  const {createMemberWorkspace}=await import(modulePath);await select(session());
  const signals:AbortSignal[]=[],pending:Array<(response:Response)=>void>=[];
  globalThis.fetch=async(input,init)=>String(input)==='/auth/session'?Response.json(session()):new Promise(resolve=>{signals.push(init!.signal!);pending.push(resolve);});
  const store=createMemberWorkspace();stopStore=store.subscribe(()=>{});
  // Exercise the same automatic refresh callback as the React session effect.
  stopIdentity=identitySession.subscribe(()=>void store.refreshAutomatically());
  await identitySession.refresh();await flush();assert.equal(signals.length,3);
  await identitySession.refresh();await identitySession.refresh();await flush();
  const aborted=signals.slice(0,3).some(signal=>signal.aborted),requests=signals.length;
  pending.splice(0).forEach(resolve=>resolve(Response.json([])));await flush();
  assert.equal(aborted,false,'the existing resource reads must survive repeated session publications');assert.equal(requests,3);assert.equal(store.getSnapshot().status,'ready');
  await identitySession.refresh();await flush();assert.equal(signals.length,6,'a completed successful read may be automatically revalidated');pending.splice(0).forEach(resolve=>resolve(Response.json([])));await flush();
 }finally{stopIdentity();stopStore();globalThis.fetch=original;}
});

test('session publications never retry resource denials or network errors; explicit refresh can retry',async()=>{
 const original=globalThis.fetch;let stopIdentity=()=>{},stopStore=()=>{};
 try{
  const {createMemberWorkspace}=await import(modulePath);
  for(const failure of ['denied','network']){
   await select(session());let requests=0;
   globalThis.fetch=async input=>{if(String(input)==='/auth/session')return Response.json(session());requests++;if(failure==='network')throw new TypeError('fixture offline');return Response.json({message:'denied'},{status:403});};
   const store=createMemberWorkspace();stopStore=store.subscribe(()=>{});stopIdentity=identitySession.subscribe(()=>void store.refreshAutomatically());
   await identitySession.refresh();await flush();assert.equal(store.getSnapshot().status,'error');assert.equal(requests,3);
   await identitySession.refresh();await identitySession.refresh();await flush();assert.equal(requests,3,'automatic session updates must preserve the failed state');assert.equal(store.getSnapshot().status,'error');
   await store.refresh();assert.equal(requests,6,'explicit user refresh may retry');stopIdentity();stopStore();
  }
 }finally{stopIdentity();stopStore();globalThis.fetch=original;}
});
