import test from 'node:test';
import assert from 'node:assert/strict';
import {api,ApiError,artifactText} from '../apps/web/src/api.ts';
import {createIdentitySession,identitySession,principalStorage} from '../apps/web/src/identity-session.ts';

const local={mode:'legacy-local',authenticated:true,user:null,csrf:null,loginAvailable:false};
const oidc=(id='admin-a',status='active',orgRole='admin')=>({mode:'oidc',authenticated:status==='active',user:{id,displayName:'Synthetic '+id,email:id+'@example.test',status,orgRole},csrf:'synthetic-csrf',loginAvailable:true});
const flush=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};
async function selectSession(value:unknown){const original=globalThis.fetch;globalThis.fetch=async()=>Response.json(value);try{await identitySession.refresh();}finally{globalThis.fetch=original;}}

test('business transport waits for session readiness and sends same-origin credentials',async()=>{
 const original=globalThis.fetch,seen:string[]=[];
 globalThis.fetch=async(input,init)=>{seen.push(String(input));assert.equal(init?.credentials,'same-origin');return Response.json(String(input)==='/auth/session'?{mode:'legacy-local',authenticated:true,user:null,csrf:null,loginAvailable:false}:{ok:true});};
 try{await api('/projects');assert.deepEqual(seen,['/auth/session','/api/projects']);}finally{globalThis.fetch=original;}
});

test('session failure denies all business requests instead of selecting local owner',async()=>{
 const session=createIdentitySession({fetch:async()=>{throw new TypeError('offline');}});await session.refresh();assert.equal(session.getSnapshot().status,'unavailable');await assert.rejects(session.requireAuthorized());
 await selectSession(oidc());const original=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw new TypeError('offline');};
 try{await identitySession.refresh();await assert.rejects(api('/projects'));assert.equal(calls,1);}finally{globalThis.fetch=original;}
});

test('session GET deduplicates, stops polling while hidden or unsubscribed and focus rechecks revocation',async()=>{
 const activity=new EventTarget(),visibility=new EventTarget(),queued=new Map<number,()=>void>();let shown=true,loads=0,finish!:(value:Response)=>void;
 const session=createIdentitySession({activity,visibility,visible:()=>shown,fetch:async()=>{loads++;return new Promise(resolve=>{finish=resolve;});},schedule:fn=>{queued.set(1,fn);return 1;},cancel:id=>queued.delete(id as number)});
 const stop=session.subscribe(()=>{}),first=session.refresh();assert.equal(session.refresh(),first);assert.equal(loads,1);finish(Response.json(oidc()));await first;assert.equal(queued.size,1);
 shown=false;visibility.dispatchEvent(new Event('visibilitychange'));assert.equal(queued.size,0);
 activity.dispatchEvent(new Event('focus'));assert.equal(loads,1);shown=true;activity.dispatchEvent(new Event('focus'));assert.equal(loads,2);finish(Response.json({...oidc(),authenticated:false,user:null}));await flush();assert.equal(session.getSnapshot().status,'signed-out');
 stop();assert.equal(queued.size,0);activity.dispatchEvent(new Event('focus'));assert.equal(loads,2);
});

test('unsafe quote, PATCH, PUT, DELETE use current CSRF independently of billing/idempotency semantics',async()=>{
 await selectSession(oidc());const original=globalThis.fetch,seen:RequestInit[]=[];
 globalThis.fetch=async(_input,init)=>{seen.push(init!);return Response.json({ok:true});};
 try{for(const method of ['POST','PATCH','PUT','DELETE'])await api(method==='POST'?'/projects/p/planning-quote':'/projects/p',method,{},'stable-key');
  assert.equal(seen.length,4);for(const init of seen){assert.equal(new Headers(init.headers).get('x-csrf-token'),'synthetic-csrf');assert.equal(init.credentials,'same-origin');}
  assert.equal(new Headers(seen[0].headers).get('idempotency-key'),null);for(const init of seen.slice(1))assert.equal(new Headers(init.headers).get('idempotency-key'),'stable-key');
 }finally{globalThis.fetch=original;}
});

test('401 invalidates immediately even with an unreadable body, 403 preserves session, neither replays writes',async()=>{
 const original=globalThis.fetch;try{
  await selectSession(oidc());let calls=0;globalThis.fetch=async()=>{calls++;return Response.json({error:'Access denied'},{status:403});};
  await assert.rejects(api('/projects/p','PUT',{},'original'),{status:403});assert.equal(identitySession.getSnapshot().status,'authenticated');assert.equal(calls,1);
  globalThis.fetch=async()=>{calls++;return new Response('',{status:401});};await assert.rejects(api('/projects/p','PUT',{},'original'),error=>error instanceof ApiError&&error.status===401);assert.equal(identitySession.getSnapshot().status,'signed-out');assert.equal(calls,2);
 }finally{globalThis.fetch=original;}
});

test('late old principal GET and artifact body cannot reach the next identity',async()=>{
 const original=globalThis.fetch;try{
  await selectSession(oidc());let finish!:(value:Response)=>void;globalThis.fetch=async()=>new Promise(resolve=>{finish=resolve;});const pending=api('/projects');await flush();await selectSession(oidc('admin-b'));finish(Response.json([{private:'admin-a'}]));await assert.rejects(pending,{name:'AbortError'});
  let body!:ReadableStreamDefaultController<Uint8Array>;globalThis.fetch=async()=>new Response(new ReadableStream({start(controller){body=controller;}}));const preview=artifactText('/runs/r/artifact?path=report.txt');await flush();await selectSession(oidc('admin-a'));body.enqueue(new TextEncoder().encode('admin-b private'));body.close();await assert.rejects(preview,{name:'AbortError'});
  globalThis.fetch=async()=>new Response('',{status:401});await assert.rejects(artifactText('/runs/r/artifact?path=report.txt'),{status:401});assert.equal(identitySession.getSnapshot().status,'signed-out');
 }finally{globalThis.fetch=original;}
});

test('logout unmounts immediately, clears registered state, and never resubmits on lost response',async()=>{
 let finish!:(response:Response)=>void,resets=0,calls=0;
 const session=createIdentitySession({fetch:async(input)=>String(input).endsWith('/session')?Response.json(oidc()):(calls++,new Promise(resolve=>{finish=resolve;}))});await session.refresh();session.onReset(()=>resets++);
 const pending=session.logout();await flush();assert.equal(session.getSnapshot().status,'signed-out');assert.equal(resets,1);finish(new Response('',{status:503}));await pending;assert.equal(calls,1);assert.match(session.getSnapshot().error,/尚未确认/);
});

test('login POST receives JSON handoff, sends CSRF and navigates only after server URL validation',async()=>{
 const navigated:string[]=[],seen:RequestInit[]=[];const session=createIdentitySession({navigate:url=>navigated.push(url),fetch:async(input,init)=>{
  seen.push(init!);return String(input).endsWith('/session')?Response.json({...oidc(),authenticated:false,user:null}):Response.json({authorizationUrl:'https://idp.example/authorize?state=synthetic'});
 }});await session.refresh();await session.login('/');assert.deepEqual(navigated,['https://idp.example/authorize?state=synthetic']);assert.equal(seen[1].method,'POST');assert.equal(seen[1].redirect,'error');assert.equal(new Headers(seen[1].headers).get('x-csrf-token'),'synthetic-csrf');assert.deepEqual(JSON.parse(String(seen[1].body)),{returnTo:'/'});
});

test('cached drafts and late component writes remain scoped to the captured principal',async()=>{
 const values=new Map<string,string>([['legacy-draft','private legacy']]),storage={getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{values.set(key,value);},removeItem:(key:string)=>{values.delete(key);}};
 await selectSession(oidc());const first=principalStorage(storage);assert.equal(first.getItem('legacy-draft'),null);first.setItem('draft','private a');
 await selectSession(oidc('admin-b'));const second=principalStorage(storage);assert.equal(second.getItem('draft'),null);first.setItem('draft','late a');assert.equal(second.getItem('draft'),null);
 await selectSession(oidc());assert.equal(principalStorage(storage).getItem('draft'),'late a');await selectSession(local);assert.equal(principalStorage(storage).getItem('legacy-draft'),'private legacy');
});

test('a broken reset subscriber cannot keep the old principal authorized',async()=>{
 const session=createIdentitySession({fetch:async()=>Response.json(oidc())});await session.refresh();session.onReset(()=>{throw Error('broken cache');});
 session.invalidate();assert.equal(session.getSnapshot().status,'unavailable');await assert.rejects(session.requireAuthorized());
});

test('focus and explicit reads during an unresolved logout cannot remount the old session',async()=>{
 let finish!:(response:Response)=>void,loads=0;const activity=new EventTarget();
 const session=createIdentitySession({activity,fetch:async input=>{if(String(input).endsWith('/session')){loads++;return Response.json(oidc());}return new Promise(resolve=>{finish=resolve;});}});
 await session.refresh();const stop=session.subscribe(()=>{});await session.refresh();const pending=session.logout();await flush();const before=loads;
 try{activity.dispatchEvent(new Event('focus'));await session.refresh();assert.equal(loads,before);assert.equal(session.getSnapshot().status,'signed-out');}
 finally{finish(new Response('',{status:503}));await pending;stop();}
});

test('a lost logout response holds the workspace closed until explicit verification',async()=>{
 const timers=new Set<()=>void>(),activity=new EventTarget();let gets=0,posts=0;
 const session=createIdentitySession({activity,schedule:fn=>{timers.add(fn);return fn;},cancel:id=>timers.delete(id as ()=>void),fetch:async input=>String(input).endsWith('/session')?(gets++,Response.json(oidc())):(posts++,new Response('',{status:503}))});
 await session.refresh();const stop=session.subscribe(()=>{});await session.refresh();
 try{await session.logout();const before=gets;assert.equal(session.getSnapshot().status,'signed-out');assert.equal(timers.size,0);activity.dispatchEvent(new Event('focus'));activity.dispatchEvent(new Event('pagehide'));activity.dispatchEvent(new Event('pageshow'));await flush();assert.equal(gets,before);assert.equal(session.getSnapshot().status,'signed-out');assert.equal(posts,1);await session.refresh();assert.equal(gets,before+1);assert.equal(session.getSnapshot().status,'authenticated');}
 finally{stop();}
});

test('page restore blocks the old business subtree until identity revalidation completes',async()=>{
 const activity=new EventTarget();let finish!:(response:Response)=>void,delayed=false;
 const session=createIdentitySession({activity,fetch:async()=>delayed?new Promise(resolve=>{finish=resolve;}):Response.json(oidc())});
 await session.refresh();const stop=session.subscribe(()=>{});await session.refresh();delayed=true;
 try{activity.dispatchEvent(new Event('pagehide'));assert.equal(session.getSnapshot().status,'loading');activity.dispatchEvent(new Event('pageshow'));assert.equal(session.getSnapshot().status,'loading');finish(Response.json({...oidc('b'),authenticated:false,user:null}));await flush();assert.equal(session.getSnapshot().status,'signed-out');}
 finally{stop();}
});
