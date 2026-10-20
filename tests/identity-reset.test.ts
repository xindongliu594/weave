import test from 'node:test';
import assert from 'node:assert/strict';
import {createHealthSync} from '../apps/web/src/health-sync.ts';
import {createUsageSync} from '../apps/web/src/usage-sync.ts';
import {createProjectSync} from '../apps/web/src/project-sync.ts';

for(const [name,create,value,empty] of [
 ['health',createHealthSync,{database:'private-a',runtime:{ready:true,reason:'a'},version:'a'},(state:any)=>state.health===null],
 ['usage',createUsageSync,[{id:'private-a'}],(state:any)=>state.rows.length===0],
 ['project',createProjectSync,[{id:'private-a',version:1,status:'RUNNING'}],(state:any)=>state.rows.length===0],
] as const)test(`${name} reset aborts reads and excludes a noncooperative old response`,async()=>{
 let finish!:(value:any)=>void,signal!:AbortSignal;const timers=new Set<unknown>();
 const store:any=(create as Function)((next:AbortSignal)=>{signal=next;return new Promise(resolve=>{finish=resolve;});},{schedule:(fn:()=>void)=>{timers.add(fn);return fn;},cancel:(timer:unknown)=>timers.delete(timer)});
 const stop=store.subscribe(()=>{}),pending=store.refresh();await Promise.resolve();
 assert.ok(signal instanceof AbortSignal);store.reset();assert.equal(signal.aborted,true);assert.ok(empty(store.getSnapshot()));assert.equal(timers.size,0);
 finish(value);await pending.catch(()=>{});assert.ok(empty(store.getSnapshot()));assert.equal(timers.size,0);stop();
});
