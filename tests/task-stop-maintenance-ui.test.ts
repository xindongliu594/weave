import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';

const runId='10000000-0000-0000-0000-000000000001';
const key={runId,taskId:'a',attemptId:'attempt-a',generation:1};
const sandboxId='10000000-0000-0000-0000-000000000002',stopId='10000000-0000-0000-0000-000000000003',revision='a'.repeat(64);
const scope=(state='unknown'):any=>({key,sandboxId,workspaceRevision:revision,state,...(state==='no-intent'?{}:{stopId}),...(state==='stopped'?{}:{reasonCode:state==='no-intent'?'TASK_STOP_NO_INTENT':'TASK_STOP_UNKNOWN'}),canReconcile:!['stopped','no-intent'].includes(state)});
const projection=(entry:any=scope()):any=>({version:1,state:entry.state==='stopped'?'stopped':'pending',scopes:[entry]});
const load=async()=>import('../apps/web/src/TaskStopMaintenance.tsx').catch(()=>({} as any));

test('only a validated original pending intent exposes original-ID reconciliation and retained disk status',async()=>{
 const module=await load();assert.equal(typeof module.TaskStopMaintenance,'function');
 for(const state of ['unknown','prepared','dispatching','stopped','no-intent']){
  const html=renderToStaticMarkup(createElement(module.TaskStopMaintenance,{runId,maintenance:projection(scope(state)),onRefresh:async()=>{}}));
  for(const text of ['任务 a','attempt-a','代次 1',sandboxId,revision,'文件','磁盘'])assert.ok(html.includes(text),text);
  assert.equal(html.includes('核对原停止结果'),!['stopped','no-intent'].includes(state));assert.doesNotMatch(html,/重新执行|预览回收|核对容量与文件版本/);
 }
 const invalid=renderToStaticMarkup(createElement(module.TaskStopMaintenance,{runId,maintenance:projection({...scope(),proof:{private:true}}),onRefresh:async()=>{}}));assert.doesNotMatch(invalid,/<button|private/);assert.match(invalid,/未核对/);
 const otherRun=renderToStaticMarkup(createElement(module.TaskStopMaintenance,{runId:'10000000-0000-0000-0000-000000000009',maintenance:projection(),onRefresh:async()=>{}}));assert.doesNotMatch(otherRun,/<button|attempt-a/);assert.match(otherRun,/未核对/);
 const unverified={state:'unverified',displayKey:'b'.repeat(64),reasonCode:'TASK_STOP_SCOPE_MISSING',canReconcile:false,unresolvedCount:2};
 const html=renderToStaticMarkup(createElement(module.TaskStopMaintenance,{runId,maintenance:projection(unverified),onRefresh:async()=>{}}));assert.doesNotMatch(html,/<button/);assert.match(html,/2 项/);
 const disabled=renderToStaticMarkup(createElement(module.TaskStopMaintenance,{runId,maintenance:projection(),disabled:true,onRefresh:async()=>{}}));assert.match(disabled,/<button disabled=""/);
});

test('task storage uses exact scope identity, omits legacy mutation buttons and preserves legacy rows',async()=>{
 const {SandboxStorageReport}=await import('../apps/web/src/StorageCenter.tsx');
 const rows=[{runId,scopeKind:'task',key,sandboxId,workspaceRevision:revision,phase:'stopped',taskStopMaintenance:scope('stopped')}];
 const html=renderToStaticMarkup(createElement(SandboxStorageReport,{data:{available:true,scopes:rows},busy:false,onInspect:()=>{},onPreview:()=>{},onTaskRefresh:async()=>{}} as any));
 assert.match(html,/任务 a/);assert.match(html,/已确认停止/);assert.doesNotMatch(html,/核对容量与文件版本|预览回收/);
 const legacy=renderToStaticMarkup(createElement(SandboxStorageReport,{data:{available:true,scopes:[{runId:'legacy',sandboxId:'legacy-sandbox',phase:'ready',storage:{workspace:{bytes:3},temp:{bytes:0},checkedAt:'2026-10-21T00:00:00.000Z'}}]},busy:false,onInspect:()=>{},onPreview:()=>{}}));
 assert.match(legacy,/核对容量与文件版本/);assert.match(legacy,/预览回收/);
 const module=await load();assert.equal(typeof module.taskStopScopeKey,'function');
 assert.notEqual(module.taskStopScopeKey(scope()),module.taskStopScopeKey({...scope(),key:{...key,generation:2}}));
 assert.notEqual(module.taskStopScopeKey(scope()),module.taskStopScopeKey({...scope(),sandboxId:'10000000-0000-0000-0000-000000000004'}));
 assert.equal(module.taskStopScopeKey({state:'unverified',displayKey:'b'.repeat(64),reasonCode:'TASK_STOP_UNVERIFIED',canReconcile:false}),'b'.repeat(64));
});

test('single pending lock issues one exact POST and refreshes SQL after success without using the response as local fact',async()=>{
 const module=await load();assert.equal(typeof module.createTaskStopReconciler,'function');
 let finish!:(value:any)=>void;const calls:any[]=[],states:any[]=[],reads:string[]=[];
 const action=module.createTaskStopReconciler(runId,(state:any)=>states.push(state),async(id:string)=>{reads.push(id);},async(...args:any[])=>{calls.push(args);return new Promise(done=>{finish=done;});});
 const first=action.reconcile(scope());await action.reconcile(scope());assert.equal(calls.length,1);assert.deepEqual(calls[0].slice(0,3),['/runs/'+runId+'/task-stops/reconcile','POST',{key,sandboxId,workspaceRevision:revision,stopId}]);assert.equal(states.at(-1).pending,true);
 finish({maintenance:projection(scope('stopped')),replayed:false});await first;
 assert.deepEqual(reads,[runId]);assert.deepEqual(states.at(-1),{pending:false,error:''});
});

test('a rejected observation still refreshes SQL and never reports success; invalid scopes issue no request',async()=>{
 const module=await load();assert.equal(typeof module.createTaskStopReconciler,'function');
 const states:any[]=[],reads:string[]=[];let calls=0;
 const action=module.createTaskStopReconciler(runId,(state:any)=>states.push(state),async(id:string)=>{reads.push(id);},async()=>{calls++;throw Error('原设备授权已变化');});
 for(const entry of [scope('stopped'),scope('no-intent'),{...scope(),canReconcile:false},{...scope(),key:{...key,runId:'10000000-0000-0000-0000-000000000009'}}])await action.reconcile(entry);
 assert.equal(calls,0);await action.reconcile(scope());assert.equal(calls,1);assert.deepEqual(reads,[runId]);assert.equal(states.at(-1).pending,false);assert.match(states.at(-1).error,/原设备授权已变化/);assert.doesNotMatch(states.at(-1).error,/成功/);
});

test('unmounted or switched-run actions cannot publish late state or refresh into the replacement run',async()=>{
 const module=await load();assert.equal(typeof module.createTaskStopReconciler,'function');
 let finish!:(value:any)=>void;const states:any[]=[],reads:string[]=[];
 const action=module.createTaskStopReconciler(runId,(state:any)=>states.push(state),async(id:string)=>{reads.push(id);},async()=>new Promise(done=>{finish=done;}));
 const pending=action.reconcile(scope());action.dispose();finish({maintenance:projection(scope('stopped')),replayed:false});await pending;
 assert.deepEqual(reads,[]);assert.equal(states.length,1);await action.reconcile(scope());assert.equal(states.length,1);
});

test('refresh settlement retains the same pending lock and a failed refresh remains visibly unresolved',async()=>{
 const module=await load();let release!:()=>void,started!:()=>void,calls=0;const reading=new Promise<void>(done=>{started=done;}),states:any[]=[];
 const action=module.createTaskStopReconciler(runId,(state:any)=>states.push(state),async()=>{started();await new Promise<void>(done=>{release=done;});throw Error('read unavailable');},async()=>{calls++;return {maintenance:projection(scope('stopped')),replayed:false};});
 const first=action.reconcile(scope());await reading;await action.reconcile(scope());assert.equal(calls,1);assert.equal(states.at(-1).pending,true);release();await first;
 assert.equal(states.at(-1).pending,false);assert.match(states.at(-1).error,/维护记录刷新失败/);assert.doesNotMatch(states.at(-1).error,/成功/);
});

test('maintenance timeline events use Chinese labels',async()=>{
 const {RunTraceEvent}=await import('../apps/web/src/RunCenter.tsx');
 for(const [type,label] of [['runtime/maintenance-pending','任务沙箱维护待核对'],['runtime/maintenance-completed','任务沙箱维护已确认']] as const){
  const html=renderToStaticMarkup(createElement(RunTraceEvent,{event:{type,seq:1,at:'2026-10-21T00:00:00.000Z',data:{}} as any}));assert.match(html,new RegExp(label));assert.doesNotMatch(html,new RegExp('>'+type+'<'));
 }
});
