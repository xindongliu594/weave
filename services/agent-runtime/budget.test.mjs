import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ExecutionBudget} from './budget.mjs';
import {OpenAiCompatibleAdapter} from './openai-compatible.mjs';
import {assignedTask} from './task-attribution.mjs';

test('task attribution follows host-owned assignments and retains the completed task for final reporting',()=>{
 const state={members:[{id:'session',name:'employee',status:'working'}],tasks:[{id:'t1',assignee:'employee',status:'claimed',attemptId:'attempt'}]};
 const link=assignedTask(state,'session','employee');assert.deepEqual(link,{taskId:'t1',attemptId:'attempt'});
 state.tasks[0].status='completed';assert.deepEqual(assignedTask(state,'session','employee',link),link);
 assert.throws(()=>assignedTask(state,'foreign-session','employee',link),/ATTRIBUTION_MISSING/);
 assert.throws(()=>assignedTask(state,'session','employee',{taskId:'t999',attemptId:'fake'}),/ATTRIBUTION_MISSING/);
 state.tasks.push({id:'t2',assignee:'employee',status:'claimed',attemptId:'next'});
 assert.deepEqual(assignedTask(state,'session','employee',link),{taskId:'t2',attemptId:'next'});
});

test('concurrent reservations share both the project and task caps without leaking rejected reservations',()=>{
 const budget=new ExecutionBudget({maxBudget:1,tasks:[{id:'a',assigneeId:'employee',maxBudget:.6}]});
 const actor={taskId:'a',employeeId:'employee'},first=budget.reserve(.4,actor);
 assert.throws(()=>budget.reserve(.3,actor),e=>e.code==='TASK_BUDGET_EXCEEDED');
 assert.equal(budget.run.calls,1);assert.equal(budget.run.reserved,.4);
 assert.throws(()=>budget.reserve(.1,{...actor,employeeId:'intruder'}),e=>e.code==='TASK_BUDGET_IDENTITY');
 assert.throws(()=>budget.reserve(.1,{taskId:'unknown'}),e=>e.code==='TASK_BUDGET_UNKNOWN');
 const second=budget.reserve(.5);assert.throws(()=>budget.reserve(.2),e=>e.code==='BUDGET_EXCEEDED');
 first.settle(.2);second.release();assert.equal(budget.run.reserved,0);assert.equal(budget.tasks.get('a').reserved,0);
 const third=budget.reserve(.4,actor);third.settle(.4);third.check();
 assert.throws(()=>budget.reserve(0,actor),e=>e.code==='TASK_BUDGET_EXCEEDED');
});

test('warnings include prior spend and block fallback and further calls at the defined thresholds',()=>{
 const events=[],budget=new ExecutionBudget({maxBudget:.3,priorSpend:.7,onEvent:e=>events.push(e)});
 const first=budget.reserve(.1);first.settle(.1);first.check();
 const second=budget.reserve(.1);second.settle(.1);second.check();
 assert.throws(()=>budget.reserve(.01,{},true),e=>e.code==='BUDGET_RETRY_DISABLED');
 const final=budget.reserve(.1);final.settle(.1);final.check();
 assert.throws(()=>budget.reserve(0),e=>e.code==='BUDGET_EXCEEDED');
 assert.deepEqual(events.filter(e=>e.kind==='warning').map(e=>e.threshold),[70,90,100]);
});

test('retry counters are retained and a task cannot exceed the policy turn cap',()=>{
 const budget=new ExecutionBudget({maxBudget:1,maxModelCalls:4,priorModelCalls:2,maxTaskModelCalls:2,
  tasks:[{id:'a',assigneeId:'e'}],taskUsage:{a:{cost:.1,calls:1}}});
 const actor={taskId:'a',employeeId:'e'},request=budget.reserve(.1,actor);request.release();
 assert.throws(()=>budget.reserve(.1,actor),e=>e.code==='TASK_TURN_LIMIT');
 budget.reserve(.1).release();assert.throws(()=>budget.reserve(.1),e=>e.code==='TURN_LIMIT');
 assert.equal(budget.tasks.get('a').spent,.1);
});

const route={id:'m',name:'fixture',wireModel:'fixture',baseUrl:'https://fixture.invalid/v1',inputRate:0,outputRate:1,maxOutputTokens:10};
const options={model:'m',sessionId:'session',messages:[{role:'user',content:[{type:'text',text:'work'}]}]};
const consume=async adapter=>{const chunks=[];for await(const c of adapter.stream(options))chunks.push(c);return chunks;};
test('adapter counts fallback against the same task and refuses it before a second fetch',async()=>{
 const original=globalThis.fetch;let calls=0;
 globalThis.fetch=async()=>{calls++;return new Response('',{status:429});};
 try{
  const adapter=new OpenAiCompatibleAdapter({routes:[route,{...route,id:'backup'}],maxBudget:1,tasks:[{id:'task',assigneeId:'employee',maxModelCalls:1}]});
  adapter.attribution=()=>({taskId:'task',employeeId:'employee',sessionId:'session'});adapter.sessionPolicies.set('session',{fallbackModelId:'backup'});
  await assert.rejects(consume(adapter),e=>e.code==='TASK_TURN_LIMIT');assert.equal(calls,1);assert.equal(adapter.reserved,0);assert.equal(adapter.budget.run.reserved,0);
 }finally{globalThis.fetch=original;}
});

test('automatic rework is refused at 90 percent of the original task budget before dispatch',async()=>{
 const original=globalThis.fetch;let calls=0;
 globalThis.fetch=async()=>{calls++;throw Error('must not fetch');};
 try{
  const adapter=new OpenAiCompatibleAdapter({routes:[route],maxBudget:2,tasks:[{id:'task',assigneeId:'employee',maxBudget:1}],taskUsage:{task:{cost:.9,calls:3}}});
  adapter.attribution=()=>({taskId:'task',employeeId:'employee',reworkRound:1});
  await assert.rejects(consume(adapter),e=>e.code==='BUDGET_RETRY_DISABLED');
  assert.equal(calls,0);assert.equal(adapter.budget.tasks.get('task').calls,3);assert.equal(adapter.budget.run.reserved,0);
 }finally{globalThis.fetch=original;}
});
test('adapter persists an excessive actual receipt before stopping and does not emit its tool call',async()=>{
 const original=globalThis.fetch,usage=[],events=[];
 globalThis.fetch=async()=>Response.json({choices:[{message:{tool_calls:[{id:'call',function:{name:'artifact_write',arguments:'{}'}}]}}],usage:{prompt_tokens:0,completion_tokens:100}});
 try{
  const adapter=new OpenAiCompatibleAdapter({routes:[route],maxBudget:1,tasks:[{id:'task',assigneeId:'employee',maxBudget:.00005}],onUsage:async u=>usage.push(u),onBudget:e=>events.push(e)});
  adapter.attribution=()=>({taskId:'task',employeeId:'employee'});
  const chunks=[];await assert.rejects(async()=>{for await(const c of adapter.stream(options))chunks.push(c);},e=>e.code==='TASK_BUDGET_EXCEEDED');
  assert.equal(usage.length,1);assert.equal(usage[0].cost,.0001);assert.equal(chunks.length,0);assert.equal(events.at(-1).kind,'stopped');assert.equal(adapter.reserved,0);
 }finally{globalThis.fetch=original;}
});

test('persistent reservations precede dispatch, and fallback preserves the first uncertain request identity',async()=>{
 const original=globalThis.fetch,reserved=[],failed=[],billed=[];let count=0;
 globalThis.fetch=async()=>{assert.equal(reserved.length,++count);return count===1?new Response('',{status:503}):Response.json({choices:[{message:{content:'ok'}}],usage:{prompt_tokens:0,completion_tokens:1}});};
 try{
  const adapter=new OpenAiCompatibleAdapter({routes:[route,{...route,id:'backup'}],maxBudget:1,beforeRequest:async data=>reserved.push(data),onCallError:async data=>failed.push(data),onUsage:async data=>billed.push(data)});
  adapter.sessionPolicies.set('session',{fallbackModelId:'backup'});await consume(adapter);
  assert.equal(reserved.length,2);assert.notEqual(reserved[0].id,reserved[1].id);assert.deepEqual(failed,[{id:reserved[0].id,dispatched:true,code:'HTTP_503'}]);assert.equal(billed[0].id,reserved[1].id);
 }finally{globalThis.fetch=original;}
});
test('admission rejection never dispatches; archive failure after reservation releases an unsent call',async()=>{
 const original=globalThis.fetch;let count=0;const errors=[];
 globalThis.fetch=async()=>{count++;throw Error('unexpected fetch');};
 try{
  const denied=new OpenAiCompatibleAdapter({routes:[route],maxBudget:1,beforeRequest:async()=>{throw Object.assign(Error('部门预算已用尽'),{status:422,code:'DEPARTMENT_DAILY_BUDGET_EXCEEDED'});},onCallError:async data=>errors.push(data)});
  await assert.rejects(consume(denied),e=>e.code==='DEPARTMENT_DAILY_BUDGET_EXCEEDED');assert.equal(count,0);assert.equal(errors.length,0);
  const brokenArchive=new OpenAiCompatibleAdapter({routes:[route],maxBudget:1,beforeRequest:async()=>{},onRequest:()=>{throw Error('disk full');},onCallError:async data=>errors.push(data)});
  await assert.rejects(consume(brokenArchive));assert.equal(count,0);assert.equal(errors.length,1);assert.equal(errors[0].dispatched,false);
 }finally{globalThis.fetch=original;}
});
