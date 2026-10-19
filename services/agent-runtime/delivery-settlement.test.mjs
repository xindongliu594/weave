import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ProductDshRuntime } from './product-runtime.mjs';
import { readRun } from './trace-store.mjs';

// Real installed DSH Hosts, native task transitions and HTTP transport in an
// isolated directory. Fixture replies verify shutdown ordering, not Todo/model
// acceptance; no paid API or user's delivery/database is accessed.
async function bounded(promise,label,signal,timeout=10000) {
  let timer,onAbort;
  const interrupted=new Promise((_,reject)=>{
    timer=setTimeout(()=>reject(Error(`Timed out waiting for ${label}`)),timeout);
    if(signal){onAbort=()=>reject(signal.reason);if(signal.aborted)onAbort();else signal.addEventListener('abort',onAbort,{once:true});}
  });
  try{return await Promise.race([promise,interrupted]);}
  finally{clearTimeout(timer);if(onAbort)signal.removeEventListener('abort',onAbort);}
}

async function nativeDeliveryScenario(t,cancelDuringSettlement=false) {
  const root=await mkdtemp(join(tmpdir(),'delivery-settlement-')),requests=[],usages=[],unknown=[],timers=new Set();
  const settlementStarted=Promise.withResolvers();
  let workerStep=0;
  const server=http.createServer(async(req,res)=>{
    let text='';for await(const chunk of req)text+=chunk;
    const body=JSON.parse(text);requests.push(body);const worker=body.model==='worker-fixture';
    const step=worker?workerStep++:-1;
    // Keep a coordinator request in flight before native delivery. A completed
    // worker can correctly suppress its optional next request; that scheduling
    // race must not prevent this test from reaching cancellation settlement.
    const tail=!worker&&requests.filter(item=>item.model==='manager-fixture').length===1;
    const combined=body.messages.map(message=>message.content??'').join('\n');
    const attempt=/"attemptId":"([a-f0-9-]+)"/.exec(combined)?.[1]??/Attempt id: ([a-f0-9-]+)/.exec(combined)?.[1];
    let message={content:'coordinator ordering fixture'};
    if(worker){
      const calls=[['agent_teams_claim_task',{task_id:'t1'}],['agent_teams_update_task',{task_id:'t1',attempt_id:attempt,status:'in_progress'}],
        ['agent_teams_update_task',{task_id:'t1',attempt_id:attempt,status:'completed',output:'isolated native text task complete',acceptanceResults:[],commandsRun:[]}],
        ['agent_teams_send_message',{to:'captain',content:'late reply must not execute'}]];
      const [name,args]=calls[Math.min(step,3)];message={content:null,tool_calls:[{id:'fixture-call-'+step,type:'function',function:{name,arguments:JSON.stringify(args)}}]};
    }
    const send=()=>{res.setHeader('content-type','application/json');res.setHeader('X-Oneapi-Request-Id',tail?'original-tail-response':'fixture-'+step);
      res.end(JSON.stringify({choices:[{message,finish_reason:worker?'tool_calls':'stop'}],usage:{prompt_tokens:tail?37:7,completion_tokens:tail?5:1}}));};
    if(tail){const timer=setTimeout(()=>{timers.delete(timer);send();},5000);timers.add(timer);}else send();
  });
  const runId=randomUUID(),snapshot={projectId:'isolated-delivery',planVersion:1,requirement:'engineering fixture',executionBudget:1,
    approval:{kind:'project',projectVersion:1},policy:{maxBudget:1,maxConcurrentAgents:2,deadlineSeconds:12,contextManagement:'prune',maxModelCalls:10,maxTaskModelCalls:6,allowedTools:[]},
    agents:[{id:'manager',employeeId:'manager',role:'manager',modelId:'manager-fixture',rolePrompt:'Coordinate.',tools:[]},
      {id:'writer',employeeId:'writer',role:'member',modelId:'worker-fixture',rolePrompt:'Complete the assigned engineering text task.',tools:[]}],
    tasks:[{id:'approved-text',kind:'work',subject:'isolated text task',objective:'Native completion for ordering regression',assignee:'writer',assigneeId:'writer',dependencies:[],inputs:[],outputs:[],acceptanceCriteria:[],verify:[]}]};
  const runtime=new ProductDshRuntime({traceRoot:root,beforeRequest:async()=>{},onUsage:async(_id,usage)=>usages.push(usage),onCallError:event=>unknown.push(event),
    createExecutor:archive=>{const originalAppend=archive.append.bind(archive);archive.append=(type,data,links)=>{
      const event=originalAppend(type,data,links);if(type==='runtime/model-settling'&&data.reason==='delivery-completed')settlementStarted.resolve();return event;
    };const artifacts=join(archive.dir,'artifacts');mkdirSync(artifacts,{recursive:true});return{root:artifacts,prepare:async()=>{},close:async()=>{}};}});
  let completion;
  try{
    server.listen(0,'127.0.0.1');await bounded(once(server,'listening'),'fixture HTTP listener',t.signal);
    const started=await runtime.start({runId,approvedSnapshot:snapshot,routes:['manager-fixture','worker-fixture'].map(model=>({id:model,name:model,wireModel:model,
      baseUrl:`http://127.0.0.1:${server.address().port}/v1`,inputRate:1,outputRate:2,maxOutputTokens:512}))});
    completion=started.completion;
    if(cancelDuringSettlement){
      await bounded(Promise.race([settlementStarted.promise,completion.then(result=>{
        throw Error(`Run ended before delivery settlement: ${result.status}: ${result.message??''}`);
      })]),'delivery settlement',t.signal);
      await bounded(runtime.cancel(runId),'runtime cancellation',t.signal);
    }
    const result=await bounded(completion,'runtime completion',t.signal),run=readRun(root,runId),events=run.events;
    assert.equal(result.status,cancelDuringSettlement?'cancelled':'completed',result.message);assert.equal(run.integrity,'ok');
    const seal=events.find(event=>event.type==='handoff/accepted');assert.ok(seal);
    const settling=events.find(event=>event.type==='runtime/model-settling'&&event.data.reason==='delivery-completed');assert.ok(settling);
    if(cancelDuringSettlement){
      assert.ok(events.some(event=>event.type==='runtime/model-settled'&&event.data.reason==='delivery-completed'&&event.data.aborted));
      assert.equal(unknown.length,1);assert.equal(unknown[0].dispatched,true);
      assert.ok(!usages.some(usage=>usage.id===unknown[0].id),'cancelled unknown response is not settled as zero or guessed usage');
    }else{
      assert.ok(events.some(event=>event.type==='runtime/model-settled'&&event.data.reason==='delivery-completed'&&event.data.pendingRequests===0&&event.data.finishedRequests>=1&&!event.data.timedOut));
      const metadata=events.find(event=>event.type==='billing/provider-response'&&event.data.providerRequestId==='original-tail-response');assert.ok(metadata&&metadata.seq>settling.seq);
      const tail=usages.find(usage=>usage.id===metadata.data.id);assert.ok(tail);assert.equal(tail.inputTokens,37);assert.equal(tail.outputTokens,5);assert.equal(tail.cost,47/1e6);
      assert.equal(unknown.length,0);
    }
    assert.ok(workerStep>=3&&workerStep<=4,'native task completed; optional post-completion requests may be suppressed');
    assert.ok(!events.some(event=>event.type==='tool/start'&&event.data.name==='agent_teams_send_message'&&event.seq>seal.seq));
    assert.ok(!events.some(event=>event.type==='model/wire-request'&&event.seq>settling.seq));
    assert.equal(events.at(-1).type,'run/finished');assert.equal(events.at(-1).data.status,cancelDuringSettlement?'cancelled':'completed');
  }finally{
    // Abort the runtime and close the HTTP sockets before awaiting either one:
    // a failed assertion or a test timeout must not leave the delayed reply live.
    const cancellation=runtime.cancel(runId);
    for(const timer of timers)clearTimeout(timer);
    const closed=new Promise(resolve=>server.close(resolve));server.closeAllConnections();
    const cleanup=await bounded(Promise.allSettled([cancellation,completion,closed]),'fixture shutdown',undefined,3000);
    await rm(root,{recursive:true,force:true,maxRetries:3,retryDelay:100});
    for(const result of cleanup)if(result.status==='rejected')throw result.reason;
  }
}
test('successful native delivery settles an already dispatched tail request before disposal and suppresses late tools', { timeout: 15000 },t=>nativeDeliveryScenario(t));
test('user cancellation during successful-delivery settlement remains cancelled and retains an unknown dispatched fee', { timeout: 15000 },t=>nativeDeliveryScenario(t,true));
