import test from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeSupervisor } from './supervisor.mjs';
import { retryRead, classifyFailure, unresolvedOperations } from './recovery.mjs';

function setup(policy={}) {
  let time=0;const events=[];
  const supervisor=new RuntimeSupervisor({policy,now:()=>time,archive:{append(type,data){events.push({type,data});}}});
  supervisor.observe({type:'run/task-mapping',data:{tasks:[{task_id:'t1',seed_id:'build'}]}});
  const ref={sessionId:'s1',taskId:'t1',attemptId:'a'};
  const status={tasks:[{id:'t1',assignee:'writer',status:'in_progress',attempt_id:'a'}],members:[{member_id:'s1',name:'writer',status:'working'}]};
  const action=(name,args,result)=>{supervisor.observe({type:'tool/start',callId:'c',...ref,data:{name,arguments:args}});supervisor.observe({type:'tool/result',callId:'c',...ref,data:{name,result}});};
  supervisor.session('s1',ref);
  return {supervisor,events,ref,status,action,advance:ms=>{time+=ms;}};
}
test('approval, model and capacity waits pause progress time without hiding later stalls',()=>{
  const s=setup({progressTimeoutSeconds:60});
  for(const phase of ['waiting_approval','waiting_capacity']){const leave=s.supervisor.enter('s1',phase);s.advance(120000);assert.equal(s.supervisor.tick(s.status)[0].phase,phase);leave();const time=s.supervisor.sessions.get('s1').lastProgressAt;leave();assert.equal(s.supervisor.sessions.get('s1').lastProgressAt,time,'ending one wait twice cannot hide extra work time');}
  s.supervisor.observe({type:'model/request',...s.ref,data:{}});s.advance(90000);s.supervisor.tick(s.status);
  s.supervisor.observe({type:'model/finish',...s.ref,data:{}});s.supervisor.tick(s.status);assert.equal(s.supervisor.failure,undefined);
  s.advance(61000);assert.throws(()=>s.supervisor.tick(s.status),/NO_PROGRESS/);
});
test('coordinator polling and untrusted text do not reset evidence-based progress',()=>{
  const s=setup({progressTimeoutSeconds:60});s.supervisor.observe({type:'run/captain',data:{sessionId:'captain'}});
  for(let i=0;i<20;i++)s.supervisor.observe({type:'tool/start',sessionId:'captain',callId:'poll'+i,data:{name:'agent_teams_status',arguments:{}}});
  s.supervisor.observe({type:'session/assistant/message',...s.ref,data:{message:'Making great progress'}});
  s.advance(61000);assert.throws(()=>s.supervisor.tick(s.status),/NO_PROGRESS/);assert.equal(s.supervisor.sessions.size,1);
});
test('identical and alternating read loops stop before another request can be admitted',()=>{
  const s=setup({repeatActionLimit:3});
  for(let i=0;i<3;i++){s.action('filesystem',{path:'a.txt'},{value:{content:'same'}});if(i<2)s.action('filesystem',{path:'b.txt'},{value:{content:'same'}});}
  assert.throws(()=>s.supervisor.check(),/REPEATED_ACTION/);assert.equal(s.events.filter(e=>e.type==='runtime/anomaly').length,1);
});
test('same error and nonzero command exits are detected, successful changed files reset the window',()=>{
  const s=setup({repeatErrorLimit:3});
  s.action('terminal_test',{command:'check'},{value:{exitCode:1}});s.action('terminal_test',{command:'check'},{value:{exitCode:1}});
  s.supervisor.observe({type:'artifact/updated',...s.ref,data:{files:[{path:'a',sha256:'new'}]}});
  s.action('terminal_test',{command:'check'},{value:{exitCode:1}});assert.equal(s.supervisor.failure,undefined);
  s.action('terminal_test',{command:'check'},{value:{exitCode:1}});s.action('terminal_test',{command:'check'},{value:{exitCode:1}});
  assert.throws(()=>s.supervisor.check(),/REPEATED_ERROR/);
});
test('status with no attempt credential does not discard a known assignment; idle is per employee',()=>{
  const s=setup();s.supervisor.observe({type:'tool/start',sessionId:'s1',taskId:'t1',callId:'c',data:{name:'agent_teams_claim_task',arguments:{task_id:'t1'}}});
  s.supervisor.observe({type:'tool/start',sessionId:'s1',taskId:'t999',attemptId:'forged',callId:'spoof',data:{name:'agent_teams_update_task',arguments:{task_id:'t999'}}});
  assert.equal(s.supervisor.sessions.get('s1').runtimeTaskId,'t1','tool arguments cannot replace the trusted assignment');
  assert.equal(s.supervisor.sessions.get('s1').attemptId,'a');s.status.members[0].status='idle';
  s.supervisor.observe({type:'tool/result',callId:'c',data:{result:{value:{}}}});s.supervisor.tick(s.status);s.advance(10001);
  assert.throws(()=>s.supervisor.tick(s.status),/EMPLOYEE_IDLE/);
});
test('transient read retry is bounded and cancellation/mutations never replay',async()=>{
  let calls=0,retries=[];const busy=Object.assign(Error('busy'),{code:'EBUSY'});
  assert.equal(await retryRead('filesystem',async()=>{if(++calls<3)throw busy;return 'ok';},{wait:async()=>{},onRetry:x=>retries.push(x)}),'ok');assert.equal(calls,3);assert.equal(retries.length,2);
  calls=0;await assert.rejects(retryRead('filesystem',async()=>{calls++;throw busy;},{wait:async()=>{}}),/busy/);assert.equal(calls,3);
  calls=0;await assert.rejects(retryRead('artifact_write',async()=>{calls++;throw busy;},{wait:async()=>{}}),/busy/);assert.equal(calls,1);
  const controller=new AbortController();controller.abort();await assert.rejects(retryRead('filesystem',async()=>{calls++;},{signal:controller.signal}));assert.equal(calls,1);
  assert.equal(classifyFailure('model',busy,true),'outcome_unknown');assert.equal(classifyFailure('terminal',Error('OUT_OF_SCOPE: file'),true),'blocked');
});
test('waiting for approval is safe; a started mutation without an outcome requires reconciliation',()=>{
  const events=[{type:'runtime/supervision',data:{}},{type:'tool/start',callId:'a',data:{name:'terminal',arguments:{command:'work'}}}];
  assert.deepEqual(unresolvedOperations(events),[]);
  events.push({type:'runtime/operation-start',callId:'a',data:{name:'terminal',arguments:{command:'work'}}});assert.equal(unresolvedOperations(events).length,1);
  events.push({type:'runtime/outcome-unknown',callId:'a',data:{callId:'a',name:'terminal'}},{type:'tool/result',callId:'a',data:{}});assert.equal(unresolvedOperations(events).length,1);
  events.push({type:'runtime/operation-finished',callId:'a',data:{}});assert.deepEqual(unresolvedOperations(events),[]);
});
