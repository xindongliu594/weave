import test from 'node:test';
import assert from 'node:assert/strict';
import { createUsageSync, COSTS_CHANGED_EVENT } from '../apps/web/src/usage-sync.ts';
import type { Usage } from '../packages/contracts/index.ts';

const row=(id:string,cost:number):Usage=>({id,modelId:'local-fixture',projectId:null,inputTokens:7,outputTokens:3,cost,purpose:'local-regression',createdAt:'2026-10-04T12:00:00.000Z'});
const flush=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};
function timers(){
  let serial=0;
  const queued=new Map<number,()=>void>();
  return {queued,schedule:(fn:()=>void,delay:number)=>{assert.equal(delay,15000);const id=++serial;queued.set(id,fn);return id;},cancel:(id:unknown)=>{queued.delete(id as number);},tick:()=>{const [id,fn]=queued.entries().next().value!;queued.delete(id);fn();}};
}

test('usage refresh shares in-flight reads and publishes the new records',async()=>{
  let loads=0,finish!:(rows:Usage[])=>void;
  const clock=timers(),updates:string[]=[];
  const sync=createUsageSync(()=>{loads++;return new Promise(resolve=>{finish=resolve;});},{...clock,now:()=> '2026-10-04T12:00:01.000Z'});
  const stop=sync.subscribe(()=>updates.push(sync.getSnapshot().rows[0]?.id??'empty'));
  const first=sync.refresh(),second=sync.refresh();
  assert.equal(first,second);await flush();assert.equal(loads,1);assert.equal(sync.getSnapshot().refreshing,true);
  finish([row('new-call',0.5258)]);await first;
  assert.equal(sync.getSnapshot().rows[0].id,'new-call');assert.equal(sync.getSnapshot().refreshing,false);
  assert.equal(sync.getSnapshot().updatedAt,'2026-10-04T12:00:01.000Z');assert.ok(updates.includes('new-call'));
  stop();assert.equal(clock.queued.size,0);
});

test('failed local reads keep the previous usage and update time until a successful retry',async()=>{
  let loads=0;
  const sync=createUsageSync(async()=>{loads++;if(loads===2)throw new TypeError('Failed to fetch');return [row('call-'+loads,loads*.01)];},{now:()=> 'checked-'+loads});
  await sync.refresh();const previous=sync.getSnapshot();
  await assert.rejects(sync.refresh());
  assert.equal(sync.getSnapshot().rows,previous.rows);assert.equal(sync.getSnapshot().updatedAt,previous.updatedAt);
  assert.match(sync.getSnapshot().error,/本机用量读取失败/);assert.equal(sync.getSnapshot().refreshing,false);
  await sync.refresh();assert.equal(sync.getSnapshot().rows[0].id,'call-3');assert.equal(sync.getSnapshot().error,'');
});

test('polling pauses while hidden and refreshes on visibility, focus and cost updates',async()=>{
  const activity=new EventTarget(),visibility=new EventTarget(),clock=timers();
  let visible=true,loads=0;
  const sync=createUsageSync(async()=>[row('read-'+(++loads),.01)],{...clock,activity,visibility,visible:()=>visible});
  const stop=sync.subscribe(()=>{});
  assert.equal(loads,0);assert.equal(clock.queued.size,1);
  clock.tick();await flush();assert.equal(loads,1);assert.equal(clock.queued.size,1);
  visible=false;visibility.dispatchEvent(new Event('visibilitychange'));activity.dispatchEvent(new Event('focus'));await flush();
  assert.equal(loads,1);assert.equal(clock.queued.size,0);
  visible=true;visibility.dispatchEvent(new Event('visibilitychange'));await flush();assert.equal(loads,2);
  activity.dispatchEvent(new Event('focus'));await flush();assert.equal(loads,3);
  activity.dispatchEvent(new Event(COSTS_CHANGED_EVENT));await flush();assert.equal(loads,4);
  stop();assert.equal(clock.queued.size,0);
  activity.dispatchEvent(new Event('focus'));visibility.dispatchEvent(new Event('visibilitychange'));await flush();assert.equal(loads,4);
});

test('a focus event shares a slow poll and unsubscription cancels further polling',async()=>{
  const activity=new EventTarget(),clock=timers();let loads=0,finish!:(rows:Usage[])=>void;
  const sync=createUsageSync(()=>{loads++;return new Promise(resolve=>{finish=resolve;});},{...clock,activity});
  const stop=sync.subscribe(()=>{});clock.tick();await flush();
  activity.dispatchEvent(new Event('focus'));await flush();assert.equal(loads,1);assert.equal(clock.queued.size,0);
  stop();finish([row('slow-call',.01)]);await flush();assert.equal(clock.queued.size,0);
});
