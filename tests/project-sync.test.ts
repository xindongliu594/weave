import test,{before} from 'node:test';
import {identitySession} from '../apps/web/src/identity-session.ts';
import assert from 'node:assert/strict';
import { createProjectSync, projectIsActive, PROJECT_POLL_LIMIT, PROJECT_POLL_MS } from '../apps/web/src/project-sync.ts';
import { api } from '../apps/web/src/api.ts';
before(async()=>{const original=globalThis.fetch;try{globalThis.fetch=async()=>Response.json({mode:'legacy-local',authenticated:true,user:null,csrf:null,loginAvailable:false});await identitySession.refresh();}finally{globalThis.fetch=original;}});
import type { Project } from '../packages/contracts/index.ts';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PlanningParametersView } from '../apps/web/src/ProjectPlanning.tsx';

const row=(status:Project['status'],version=12):Project=>({id:'project',status,version} as Project);
const flush=async()=>{for(let i=0;i<25;i++)await Promise.resolve();};
function timers(){let serial=0;const queued=new Map<number,()=>void>();return {queued,schedule:(fn:()=>void,delay:number)=>{assert.equal(delay,PROJECT_POLL_MS);const id=++serial;queued.set(id,fn);return id;},cancel:(id:unknown)=>queued.delete(id as number),tick:()=>{const first=queued.entries().next().value!;queued.delete(first[0]);first[1]();}};}

test('same-document entry refresh and bounded active polling replace RUNNING with FAILED and enable the real planning model control',async()=>{
 const clock=timers();let loads=0;
 const sync=createProjectSync(async()=>[row(++loads===1?'RUNNING':'FAILED')],clock),stop=sync.subscribe(()=>{});
 sync.watch(true,'project');await flush();assert.equal(projectIsActive(sync.getSnapshot().rows[0]),true);assert.equal(clock.queued.size,1);
 const control=()=>renderToStaticMarkup(React.createElement(PlanningParametersView,{parameters:{projectId:'project',version:12,modelId:'',maxPlanningCost:.2,maxOutputTokens:12000},models:[],allowedModelIds:[],disabled:projectIsActive(sync.getSnapshot().rows[0]),onChange(){}}));
 assert.match(control(),/<select[^>]*aria-label="规划模型"[^>]*disabled=""/);
 clock.tick();await flush();assert.equal(sync.getSnapshot().rows[0].status,'FAILED');assert.equal(projectIsActive(sync.getSnapshot().rows[0]),false);
 assert.ok(!/<select[^>]*aria-label="规划模型"[^>]*disabled/.test(control()));assert.equal(clock.queued.size,0);
 sync.watch(false,'project');sync.watch(true,'project');await flush();assert.equal(loads,3,'Re-entering projects performs a new GET even after terminal status');stop();
});

test('initial workspace refresh cancelled by projects entry resolves without an Abort error or stale project publication',async()=>{
 const pending:{signal:AbortSignal;finish:(rows:Project[])=>void}[]=[];
 const sync=createProjectSync(signal=>new Promise((resolve,reject)=>{pending.push({signal,finish:resolve});signal.addEventListener('abort',()=>reject(new DOMException('Cancelled old readonly GET','AbortError')),{once:true});}));
 const stop=sync.subscribe(()=>{}),initial=sync.refresh({fresh:true});await flush();sync.watch(true,'project');await flush();
 assert.equal(pending.length,2);assert.equal(pending[0].signal.aborted,true);assert.deepEqual(await initial,[]);assert.equal(sync.getSnapshot().error,'');
 pending[1].finish([row('FAILED')]);await flush();assert.equal(sync.getSnapshot().rows[0].status,'FAILED');assert.equal(sync.getSnapshot().error,'');stop();
});

test('an action fresh read supersedes a slow poll; late old version or same-version RUNNING cannot overwrite confirmation or terminal status',async()=>{
 const pending:{signal:AbortSignal;finish:(rows:Project[])=>void}[]=[];
 const sync=createProjectSync(signal=>new Promise(resolve=>pending.push({signal,finish:resolve}))),stop=sync.subscribe(()=>{});
 const old=sync.refresh();assert.equal(sync.refresh(),old);await flush();
 const confirmed=sync.refresh({fresh:true});await flush();assert.equal(pending[0].signal.aborted,true);
 pending[1].finish([row('FAILED',13)]);await confirmed;pending[0].finish([row('RUNNING',12)]);await old;
 assert.equal(sync.getSnapshot().rows[0].version,13);assert.equal(sync.getSnapshot().rows[0].status,'FAILED');
 const lagging=sync.refresh({fresh:true});await flush();pending[2].finish([row('RUNNING',12)]);await lagging;
 assert.equal(sync.getSnapshot().rows[0].version,13);assert.equal(sync.getSnapshot().rows[0].status,'FAILED','Older-version response preserves the latest confirmed row');
 const slow=sync.refresh();await flush();const final=sync.refresh({fresh:true});await flush();pending[4].finish([row('FAILED',13)]);await final;pending[3].finish([row('RUNNING',13)]);await slow;
 assert.equal(sync.getSnapshot().rows[0].status,'FAILED');stop();
});

test('polling has a finite limit and leaving, hiding or unmounting cancels GETs and cannot publish late state',async()=>{
 const clock=timers(),visibility=new EventTarget();let visible=true,loads=0;
 const sync=createProjectSync(async()=>{loads++;return [row('RUNNING')];},{...clock,visibility,visible:()=>visible}),stop=sync.subscribe(()=>{});
 sync.watch(true,'project');await flush();for(let i=0;i<PROJECT_POLL_LIMIT;i++){assert.equal(clock.queued.size,1);clock.tick();await flush();}
 assert.equal(loads,PROJECT_POLL_LIMIT+1);assert.equal(clock.queued.size,0);
 visible=false;visibility.dispatchEvent(new Event('visibilitychange'));await flush();assert.equal(clock.queued.size,0);
 visible=true;visibility.dispatchEvent(new Event('visibilitychange'));await flush();assert.equal(clock.queued.size,1);
 const alreadyQueued=[...clock.queued.values()][0];sync.watch(false,'project');assert.equal(clock.queued.size,0);const priorLoads=loads;alreadyQueued();await flush();assert.equal(loads,priorLoads,'A timer already queued before cancellation cannot launch a GET after leaving');stop();visibility.dispatchEvent(new Event('visibilitychange'));await flush();assert.equal(clock.queued.size,0);
 for(const reason of ['leave','hide','unmount']){
  let signal!:AbortSignal,finish!:(rows:Project[])=>void,isVisible=true,publications=0;const events=new EventTarget();
  const pending=createProjectSync(value=>new Promise(resolve=>{signal=value;finish=resolve;}),{visibility:events,visible:()=>isVisible});
  const unsubscribe=pending.subscribe(()=>publications++);pending.watch(true,'project');await flush();
  if(reason==='leave')pending.watch(false,'project');else if(reason==='hide'){isVisible=false;events.dispatchEvent(new Event('visibilitychange'));}else unsubscribe();
  assert.equal(signal.aborted,true);const count=publications;finish([row('RUNNING',99)]);await flush();assert.equal(pending.getSnapshot().rows.length,0);assert.equal(publications,count,'Cancelled GET cannot publish after leaving/hiding/unmounting');unsubscribe();
 }
});

test('confirmed GET failure keeps cached rows and records a readable error until explicit refresh succeeds',async()=>{
 let loads=0;const sync=createProjectSync(async()=>{if(++loads===2)throw Error('本机服务暂不可达');return [row(loads===1?'RUNNING':'FAILED')];}),stop=sync.subscribe(()=>{});
 await sync.refresh();await assert.rejects(sync.refresh(),/本机服务/);assert.equal(sync.getSnapshot().rows[0].status,'RUNNING');assert.equal(sync.getSnapshot().error,'本机服务暂不可达');
 await sync.refresh({fresh:true});assert.equal(sync.getSnapshot().rows[0].status,'FAILED');assert.equal(sync.getSnapshot().error,'');stop();
});

test('caller AbortSignal only cancels readonly api reads; paid POST has no new signal or retry',async()=>{
 const original=globalThis.fetch,seen:RequestInit[]=[];let calls=0;
 globalThis.fetch=async(_url,init)=>{calls++;seen.push(init!);return new Response('{"ok":true}',{status:200,headers:{'Content-Type':'application/json'}});};
 try{
  const controller=new AbortController();await api('/projects','GET',undefined,undefined,controller.signal);assert.ok(seen[0].signal);controller.abort();assert.equal(seen[0].signal!.aborted,true);
  await api('/projects/project/generate','POST',{version:12},'original-paid-key',controller.signal);assert.equal(seen[1].signal,undefined);assert.equal((seen[1].headers as Record<string,string>)['Idempotency-Key'],'original-paid-key');assert.equal(calls,2);
 }finally{globalThis.fetch=original;}
});
