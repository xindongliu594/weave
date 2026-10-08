import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { OpenAiCompatibleAdapter } from './openai-compatible.mjs';
import { readOnlyEvidenceSignature } from './request-context.mjs';

const route = { id:'model',name:'local fixture',wireModel:'fixture-model',baseUrl:'https://fixture.invalid/v1',apiKey:'fixture-secret',
  inputRate:2,outputRate:10,maxOutputTokens:1400 };
const task = { id:'qa',assigneeId:'tester',maxModelCalls:14 };
const actor = { sessionId:'session',employeeId:'tester',taskId:'qa',runtimeTaskId:'t2',attemptId:'attempt' };
const request = { model:route.id,sessionId:actor.sessionId,system:'approved position',messages:[{role:'user',content:[{type:'text',text:'approved task'}]}],
  tools:[{name:'filesystem',description:'read the assigned file',parameters:{type:'object',properties:{path:{type:'string'}}}}] };
const state = adapter => structuredClone({run:adapter.budget.run,tasks:adapter.budget.tasks,calls:adapter.calls,reserved:adapter.reserved,
  spent:adapter.spent,pending:adapter.pendingRequests});
function create(config={}) {
  const callbacks=[];
  const adapter = new OpenAiCompatibleAdapter({routes:[route],maxBudget:.3,priorSpend:.7,maxModelCalls:37,priorModelCalls:21,
    tasks:[task],taskUsage:{qa:{cost:.1,calls:4,reserved:.02}},
    onBudget:event=>callbacks.push(['budget',event]),beforeRequest:async event=>callbacks.push(['receipt',event]),
    onRequest:event=>callbacks.push(['request',event]),onContext:event=>callbacks.push(['context',event]),
    onError:error=>callbacks.push(['error',error.code]),...config});
  adapter.attribution=()=>actor;
  return {adapter,callbacks};
}
const consume = async(adapter,options=request)=>{for await(const _ of adapter.stream(options)) {}};

test('repeated preview is read-only even at warning thresholds and cannot expose credentials or mutate schemas',()=>{
  const {adapter,callbacks}=create(),before=state(adapter),original=structuredClone(request);
  const first=adapter.prepareRequest(request),second=adapter.prepareRequest(request);
  assert.deepEqual(first,second);assert.ok(Math.abs(first.fitted.availableBudget-.3)<1e-10);
  assert.deepEqual(state(adapter),before);assert.deepEqual(callbacks,[]);
  assert.equal(first.body.max_tokens,1400);assert.equal(first.attribution.taskId,'qa');
  assert.ok(!JSON.stringify(first).includes(route.apiKey));assert.ok(!JSON.stringify(first).includes(route.baseUrl));
  first.body.tools[0].function.parameters.properties.path.type='number';
  assert.deepEqual(request,original,'preview does not lend the caller its source schema object');
  assert.deepEqual(adapter.prepareRequest(request),second);
});

test('successful stream uses the exact prepared body and amount, while real admission still emits warnings',async()=>{
  const originalFetch=globalThis.fetch,{adapter,callbacks}=create();
  adapter.sessionPolicies.set(actor.sessionId,{reasoningEffort:'low'});
  const options={...request,maxTokens:987,temperature:.2,stop:['STOP']};
  const prepared=adapter.prepareRequest(options),before=state(adapter);let fetched=0;
  globalThis.fetch=async(url,init)=>{
    fetched++;assert.equal(url,route.baseUrl+'/chat/completions');assert.deepEqual(JSON.parse(init.body),prepared.body);
    const receipt=callbacks.find(([kind])=>kind==='receipt')[1];assert.equal(receipt.reservation,prepared.reservation);
    assert.equal(adapter.budget.run.calls,before.run.calls+1);assert.equal(adapter.budget.tasks.get('qa').calls,5);
    assert.ok(adapter.budget.run.reserved>=receipt.reservation);
    return Response.json({choices:[{message:{content:'fixture response'}}],usage:{prompt_tokens:10,completion_tokens:3}});
  };
  try {await consume(adapter,options);assert.equal(fetched,1);assert.ok(callbacks.some(([kind,event])=>kind==='budget'&&event.kind==='warning'));
    assert.equal(adapter.pendingRequests,0);assert.equal(adapter.reserved,0);
  }finally{globalThis.fetch=originalFetch;}
});

test('preview checks owner, task, project/task calls and retained holds without stopped events',()=>{
  const cases=[
    [{}, {...actor,taskId:'unknown'},'TASK_BUDGET_UNKNOWN'],
    [{}, {...actor,employeeId:'foreign'},'TASK_BUDGET_IDENTITY'],
    [{priorModelCalls:37},actor,'TURN_LIMIT'],
    [{taskUsage:{qa:{cost:.1,calls:14}}},actor,'TASK_TURN_LIMIT'],
    [{tasks:[{...task,maxBudget:.1}],taskUsage:{qa:{cost:.05,calls:4,reserved:.051}}},actor,'TASK_BUDGET_EXCEEDED'],
    [{maxBudget:0},actor,'BUDGET_EXCEEDED'],
  ];
  for(const [config,attribution,code]of cases){
    const {adapter,callbacks}=create(config);adapter.attribution=()=>attribution;const before=state(adapter);
    assert.throws(()=>adapter.prepareRequest(request),error=>error.code===code,code);
    assert.deepEqual(state(adapter),before,code);assert.deepEqual(callbacks,[],code);
  }
});

test('preview reports the true single-request protected minimum, retaining full file evidence, tools and output',()=>{
  const sha='a'.repeat(64),read={path:'server.mjs',sha256:sha,content:'unique complete file\n'.repeat(150)};
  const options={...request,messages:[
    {role:'user',content:[{type:'text',text:'old unprotected discussion'.repeat(120)}]},
    {role:'assistant',content:[{type:'tool-call',id:'read',name:'filesystem',arguments:'{"path":"server.mjs"}'}]},
    {role:'tool',content:[{type:'tool-result',toolCallId:'read',content:[{type:'text',text:JSON.stringify(read)}]}]},
    {role:'user',source:{kind:'plugin',plugin:'@deepseek-ai/dsh-system-prompt',form:'snapshot',sections:[{name:'department:approved-context',text:'current complete contract'}]},
      content:[{type:'text',text:'current complete contract'}]},
  ]};
  const {adapter,callbacks}=create({maxBudget:.001,priorSpend:0,taskUsage:{qa:{cost:0,calls:4}}}),before=state(adapter);let failure;
  try{adapter.prepareRequest(options);assert.fail('must reject');}catch(error){failure=error;}
  assert.equal(failure.code,'BUDGET_CONTEXT_LIMIT');assert.equal(failure.contextBudget.maxTokens,1400);
  assert.ok(failure.contextBudget.minimumReservation>.001);
  assert.ok(failure.contextBudget.minimumReservation<failure.contextBudget.reservationBefore,'drop only the old unprotected group');
  assert.equal(failure.contextBudget.additionalBudget,failure.contextBudget.minimumReservation-.001);
  assert.deepEqual(callbacks,[]);assert.deepEqual(state(adapter),before);
  const funded=create({maxBudget:failure.contextBudget.minimumReservation+1e-6,priorSpend:0,taskUsage:{qa:{cost:0,calls:4}}}).adapter;
  const preview=funded.prepareRequest(options);
  assert.equal(preview.fitted.afterBytes,failure.contextBudget.minimumEnvelopeBytes);
  assert.equal(preview.body.max_tokens,1400);assert.ok(preview.body.messages.some(message=>message.role==='tool'&&message.content===JSON.stringify(read)));
  assert.deepEqual(preview.body.tools[0].function.parameters,request.tools[0].parameters);
});

test('a stale successful preview cannot admit a later request after another employee holds the allowance',async()=>{
  const {adapter,callbacks}=create({maxBudget:.05,priorSpend:0,taskUsage:{qa:{cost:0,calls:4}}}),preview=adapter.prepareRequest(request);
  const competing=adapter.budget.reserve(.05-preview.reservation/2,{}),beforeFetch=globalThis.fetch;let fetched=0;
  globalThis.fetch=async()=>{fetched++;throw Error('must not dispatch stale preview');};
  try{await assert.rejects(consume(adapter),error=>error.code==='BUDGET_CONTEXT_LIMIT');
    assert.equal(fetched,0);assert.equal(callbacks.filter(([kind])=>kind==='receipt').length,0);assert.equal(adapter.budget.run.calls,22);
  }finally{competing.release();globalThis.fetch=beforeFetch;}
});

test('fallback and rework previews keep the approved 90% stop gate and never alter warning sets',()=>{
  const {adapter,callbacks}=create({maxBudget:.08,priorSpend:.92}),before=state(adapter);
  assert.throws(()=>adapter.prepareRequest({...request,fallbackAttempted:true}),error=>error.code==='BUDGET_RETRY_DISABLED');
  adapter.attribution=()=>({...actor,reworkRound:1});
  assert.throws(()=>adapter.prepareRequest(request),error=>error.code==='BUDGET_RETRY_DISABLED');
  assert.deepEqual(state(adapter),before);assert.deepEqual(callbacks,[]);
});

test('compaction cannot preview a shortened source, and stopped, unknown and aborted previews fail without dispatch',()=>{
  const {adapter,callbacks}=create({contextBytes:80});const before=state(adapter);
  assert.throws(()=>adapter.prepareRequest({...request,purpose:'compaction'}),error=>error.code==='CONTEXT_LIMIT');
  assert.throws(()=>adapter.prepareRequest({...request,model:'unknown'}),error=>error.code==='UNKNOWN_MODEL');
  const controller=new AbortController();controller.abort(Error('local stop'));
  assert.throws(()=>adapter.prepareRequest({...request,signal:controller.signal}),/local stop/);
  adapter.stopAdmission(Error('runtime stopped'));
  assert.throws(()=>adapter.prepareRequest(request),/runtime stopped/);
  assert.deepEqual(state(adapter),before);assert.deepEqual(callbacks,[]);
});

const evidence = { path:'server.mjs',content:'complete local fixture\n'.repeat(80) };
evidence.sha256 = createHash('sha256').update(evidence.content).digest('hex');
const readGroup = id => [
  {role:'assistant',content:[{type:'tool-call',id,name:'filesystem',arguments:'{"path":"server.mjs"}'}]},
  {role:'tool',source:{kind:'tool',callId:id},content:[{type:'tool-result',toolCallId:id,isError:false,content:[{type:'text',text:JSON.stringify(evidence)}]}]},
];
const reads = () => ({...request,messages:[...readGroup('earlier'),...readGroup('latest'),request.messages[0]]});
function attestFixture(meta) {
  const signed = readOnlyEvidenceSignature('filesystem',{path:evidence.path},evidence);
  if (meta.sessionId !== actor.sessionId || meta.employeeId !== actor.employeeId || meta.taskId !== actor.taskId || meta.attemptId !== actor.attemptId ||
      !meta.calls.every(call => call.name === signed.name && call.argumentsSha256 === signed.argumentsSha256 && call.resultSha256 === signed.resultSha256)) return;
  return {scopeId:'b'.repeat(64),canonicalSha256:meta.canonicalSha256,successful:true,readOnly:true,complete:true};
}

test('prepared and dispatched packets keep the newest complete source-attested group and preserve the native transcript',async()=>{
  const {adapter,callbacks}=create(),options=reads(),original=JSON.stringify(options),before=state(adapter);
  adapter.attestReadGroup=attestFixture;
  const preview=adapter.prepareRequest(options);
  assert.equal(preview.fitted.deduplicatedGroups,1);assert.ok(preview.fitted.deduplicatedBytes>0);
  assert.deepEqual(preview.body.messages.filter(message=>message.role==='tool').map(message=>message.tool_call_id),['latest']);
  assert.equal(preview.body.messages.find(message=>message.role==='tool').content,JSON.stringify(evidence));
  assert.deepEqual(state(adapter),before);assert.deepEqual(callbacks,[]);assert.equal(JSON.stringify(options),original);
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async(_url,init)=>{assert.deepEqual(JSON.parse(init.body),preview.body);
    return Response.json({choices:[{message:{content:'fixture'}}],usage:{prompt_tokens:10,completion_tokens:3}});};
  try{await consume(adapter,options);const audit=callbacks.find(([kind])=>kind==='context')[1];
    assert.equal(audit.deduplicatedGroups,1);assert.equal(audit.evidenceDuplicates.length,1);
    assert.equal(JSON.stringify(options),original);
  }finally{globalThis.fetch=originalFetch;}
});

test('failed, unproven, mixed and altered native tool results never become duplicate evidence',()=>{
  const alterations=[
    parts=>{delete parts[1].source;}, parts=>{parts[1].source={kind:'plugin',plugin:'fixture'};},
    parts=>{parts[1].source.callId='foreign';}, parts=>{parts[1].content[0].isError=true;},
    parts=>{delete parts[1].content[0].isError;}, parts=>{parts[1].content.push({type:'text',text:'unique finding'});},
    parts=>{parts[1].content[0].content[0].text=JSON.stringify({...evidence,content:'only a fragment'});},
    parts=>{parts[0].content.push({type:'tool-result',toolCallId:'different',isError:false,content:[]});},
  ];
  for(const alter of alterations){
    const {adapter}=create(),options=reads();adapter.attestReadGroup=attestFixture;
    alter(options.messages.slice(0,2));alter(options.messages.slice(2,4));
    const preview=adapter.prepareRequest(options);
    assert.equal(preview.fitted.deduplicatedGroups,0);assert.equal(preview.body.messages.length,options.messages.length+1);
  }
  const {adapter}=create(),options=reads();
  assert.equal(adapter.prepareRequest(options).fitted.deduplicatedGroups,0,'no Host proof after cold restart retains all evidence');
  adapter.attestReadGroup=attestFixture;adapter.attribution=()=>({...actor,attemptId:'another-attempt'});
  assert.equal(adapter.prepareRequest(options).fitted.deduplicatedGroups,0,'current task/attempt admission must match source proofs');
});

test('summary source retains all original read groups even when execution can deduplicate them',()=>{
  const {adapter}=create(),options=reads();adapter.attestReadGroup=attestFixture;
  assert.equal(adapter.prepareRequest(options).fitted.deduplicatedGroups,1);
  const summary=adapter.prepareRequest({...options,purpose:'compaction'});
  assert.equal(summary.fitted.deduplicatedGroups,0);assert.equal(summary.body.messages.filter(message=>message.role==='tool').length,2);
});

test('official DSH user-role tool results qualify without accepting malformed source or failed results',()=>{
  const {adapter}=create(),options=reads();adapter.attestReadGroup=attestFixture;
  for(const message of options.messages)if(message.source?.kind==='tool')message.role='user';
  assert.equal(adapter.prepareRequest(options).fitted.deduplicatedGroups,1);
  options.messages[1].content[0].isError=true;options.messages[3].content[0].isError=true;
  assert.equal(adapter.prepareRequest(options).fitted.deduplicatedGroups,0);
});

test('superseded output reads require a complete native CAS pair and positive Host proof; unknown and unpaired writes retain protection',()=>{
  const hash=value=>createHash('sha256').update(value).digest('hex'),content='complete current output\n';
  const options=()=>({...request,messages:[...readGroup('old'),
    {role:'assistant',content:[{type:'tool-call',id:'write',name:'artifact_write',arguments:JSON.stringify({path:evidence.path,content,expectedSha256:evidence.sha256})}]},
    {role:'user',source:{kind:'tool',callId:'write'},content:[{type:'tool-result',toolCallId:'write',isError:false,content:[{type:'text',text:JSON.stringify({path:evidence.path,bytes:Buffer.byteLength(content),sha256:hash(content)})}]}]},request.messages[0]]});
  const {adapter}=create();adapter.attestSupersededRead=()=>({scopeId:'b'.repeat(64),successful:true,complete:true,superseded:true});
  const source=options(),unchanged=JSON.stringify(source);
  assert.equal(adapter.prepareRequest(source).fitted.supersededReads.length,1);assert.equal(JSON.stringify(source),unchanged);
  for(const alter of [
    o=>{o.messages[3].content[0].isError=true;},o=>{delete o.messages[3].source;},o=>{o.messages[3].source.callId='foreign';},
    o=>{o.messages[3].content[0].content[0].text=JSON.stringify({path:evidence.path,bytes:1,sha256:hash(content)});},
    o=>{o.messages[2].content[0].arguments=JSON.stringify({path:evidence.path,content});},
    o=>{o.messages[2].content[0].arguments=JSON.stringify({path:evidence.path,content,expectedSha256:'c'.repeat(64)});},
    o=>{o.messages.splice(4,0,structuredClone(o.messages[3]));},o=>{o.messages[2].role='user';},
  ]){const o=options();alter(o);assert.equal(adapter.prepareRequest(o).fitted.supersededReads.length,0);}
  adapter.attestSupersededRead=()=>undefined;assert.equal(adapter.prepareRequest(options()).fitted.supersededReads.length,0);
  adapter.attestSupersededRead=()=>Promise.resolve({scopeId:'b'.repeat(64),successful:true,complete:true,superseded:true});
  assert.equal(adapter.prepareRequest(options()).fitted.supersededReads.length,0);
});
