import test,{before} from 'node:test';
import {identitySession} from '../apps/web/src/identity-session.ts';
import assert from 'node:assert/strict';
import {api,ApiError,readApiResponse} from '../apps/web/src/api.ts';
import {generatePlanningCandidate,uncertainResponse,restoredPlanningDraft,type PlanningParameters} from '../apps/web/src/ProjectPlanning.tsx';
import {createOrganizationChatRequest,ensureOrganizationConversation,organizationReplyFailure,type Draft} from '../apps/web/src/organization-draft.ts';

before(async()=>{const original=globalThis.fetch;try{globalThis.fetch=async()=>Response.json({mode:'legacy-local',authenticated:true,user:null,csrf:null,loginAvailable:false});await identitySession.refresh();}finally{globalThis.fetch=original;}});

test('empty/non-JSON HTTP failures preserve status and never echo raw bodies or masquerade as success',async()=>{
 for(const [status,body] of [[431,''],[502,'<html>sk-synthetic-body-value</html>'],[503,'not json']] as const){
  await assert.rejects(readApiResponse(new Response(body,{status})),error=>error instanceof ApiError&&error.status===status&&error.message.includes('HTTP '+status)&&!error.message.includes('sk-'));
 }
 await assert.rejects(readApiResponse(new Response('',{status:200})),{status:200,code:'EMPTY_RESPONSE'});
 await assert.rejects(readApiResponse(new Response('not-json',{status:200})),{status:200,code:'INVALID_RESPONSE'});
 assert.deepEqual(await readApiResponse(Response.json({ok:true})),{ok:true});
 await assert.rejects(readApiResponse(Response.json({message:'Original safe permission denial',code:'PERMISSION_DENIED'},{status:403})),{message:'Original safe permission denial',status:403,code:'PERMISSION_DENIED'});
});

test('a timeout while receiving a successful response body remains a read timeout, not invalid JSON',async()=>{
 const original=globalThis.fetch;
 try {
  globalThis.fetch=async()=>new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('{"partial":'));controller.error(new DOMException('fixture body timeout','TimeoutError'));}}));
  await assert.rejects(api('/runs/fixture'),error=>error instanceof ApiError&&error.code==='READ_TIMEOUT'&&error.status===408);
 } finally {globalThis.fetch=original;}
});

test('explicitly cancelled body reads preserve cancellation and failed writes remain uncertain',async()=>{
 const original=globalThis.fetch;
 try {
  globalThis.fetch=async()=>new Response(new ReadableStream({start(controller){controller.error(new DOMException('fixture cancelled','AbortError'));}}));
  await assert.rejects(api('/runs/fixture'),{name:'AbortError'});
  await assert.rejects(api('/projects/fixture/approve','POST',{},'original-key'),error=>error instanceof Error&&!(error instanceof ApiError)&&error.message.includes('结果尚未确认'));
 } finally {globalThis.fetch=original;}
});

test('body AbortError caused by the request deadline is reported as timeout',async()=>{
 const originalFetch=globalThis.fetch,originalTimeout=AbortSignal.timeout,deadline=new AbortController();
 let arrive!:()=>void;const started=new Promise<void>(resolve=>{arrive=resolve;});
 try {
  AbortSignal.timeout=()=>deadline.signal;
  globalThis.fetch=async(_input,init)=>new Response(new ReadableStream({start(controller){arrive();
   init!.signal!.addEventListener('abort',()=>controller.error(new DOMException('body aborted','AbortError')),{once:true});
  }}));
  const pending=api('/runs/fixture');await started;deadline.abort(new DOMException('deadline','TimeoutError'));
  await assert.rejects(pending,error=>error instanceof ApiError&&error.code==='READ_TIMEOUT');
 } finally {globalThis.fetch=originalFetch;AbortSignal.timeout=originalTimeout;}
});

test('planning quote POST carries the complete JSON body, no mutation key, and makes one request on HTTP431',async()=>{
 const original=globalThis.fetch,calls:Array<{url:string;init?:RequestInit}>=[],body={revisionRequest:'中'.repeat(4000),modelId:'fixture',version:1,maxPlanningCost:.2,maxOutputTokens:5000};
 globalThis.fetch=async(input,init)=>{calls.push({url:String(input),init});return new Response('',{status:431});};
 try{
  await assert.rejects(api('/projects/fixture/planning-quote','POST',body),{status:431,code:'HTTP_RESPONSE_ERROR'});
  assert.equal(calls.length,1);assert.equal(calls[0].url,'/api/projects/fixture/planning-quote');assert.equal(calls[0].init?.method,'POST');assert.deepEqual(JSON.parse(String(calls[0].init?.body)),body);
  const headers=new Headers(calls[0].init?.headers);assert.equal(headers.get('idempotency-key'),null);assert.equal(headers.get('content-type'),'application/json');assert.equal(calls[0].init?.cache,'no-store');assert.ok(calls[0].init?.signal instanceof AbortSignal);
 }finally{globalThis.fetch=original;}
});

test('a mutation retains its original key and is never retried after an empty503 response or network loss',async()=>{
 const original=globalThis.fetch;let calls=0;
 try{
  globalThis.fetch=async(_input,init)=>{calls++;assert.equal(new Headers(init?.headers).get('idempotency-key'),'original-generation-key');return new Response('',{status:503});};
  await assert.rejects(api('/projects/fixture/generate','POST',{original:'body'},'original-generation-key'),error=>!(error instanceof ApiError)&&error instanceof Error&&error.message.includes('HTTP 503')&&error.message.includes('结果尚未确认'));assert.equal(calls,1);
  globalThis.fetch=async()=>{calls++;throw new TypeError('fixture network loss');};
  await assert.rejects(api('/projects/fixture/generate','POST',{original:'body'},'original-generation-key'),/结果尚未确认/);assert.equal(calls,2);
 }finally{globalThis.fetch=original;}
});

test('real generation precheck/onSubmit preserves the original pending key and parameters on empty or malformed HTTP200',async()=>{
 const original=globalThis.fetch,oldStorage=Object.getOwnPropertyDescriptor(globalThis,'sessionStorage');
 const parameters:PlanningParameters={projectId:'fixture',version:1,modelId:'fixture-model',maxPlanningCost:.2,maxOutputTokens:5000,retainUncertainCosts:false,revisionRequest:'原始调整不截断'};
 const quote={...parameters,checkedAt:'2026-10-06T00:00:00.000Z',reservation:.05,inputBytes:100,rates:{inputRate:.3,outputRate:1.2},costReadiness:{recordedCost:0,reserved:0,availableBudget:10,pendingCount:0,uncertainCount:0,receipts:[]},allowed:true,reasons:[],nativeExecutionChecked:false as const};
 try{for(const body of ['', '{broken']){
  const request={key:'one-original-generation-key',parameters};let pending:typeof request|undefined;let stored='';const dispatched:Array<{path:string;key:string|null}>=[];
  Object.defineProperty(globalThis,'sessionStorage',{configurable:true,value:{getItem:()=>stored}});
  globalThis.fetch=async(input,init)=>{const path=String(input),key=new Headers(init?.headers).get('idempotency-key');dispatched.push({path,key});return path.endsWith('/planning-quote')?Response.json(quote):new Response(body,{status:200});};
  const before=JSON.stringify(request);let cause:unknown;
  try{await generatePlanningCandidate(parameters,quote,request.key,api,()=>{pending=request;stored=JSON.stringify({parameters,generation:request});});}catch(error){cause=error;}
  assert.ok(cause instanceof Error&&!(cause instanceof ApiError));assert.equal(uncertainResponse(cause),true);assert.equal(JSON.stringify(request),before);assert.equal(pending,request);
  assert.deepEqual(restoredPlanningDraft({id:'fixture',version:1,policy:{maxBudget:10}} as any).generation,request);
  assert.deepEqual(dispatched,[{path:'/api/projects/fixture/planning-quote',key:null},{path:'/api/projects/fixture/generate',key:request.key}]);
 }}finally{globalThis.fetch=original;if(oldStorage)Object.defineProperty(globalThis,'sessionStorage',oldStorage);else Reflect.deleteProperty(globalThis,'sessionStorage');}
});

test('organization response failures retain the same persisted pending identity unless a structured HTTP refusal is confirmed',async()=>{
 const original=globalThis.fetch;
 try{for(const body of ['', '<html>invalid200</html>']){
  const initial=ensureOrganizationConversation({messages:[],modelId:'fixture',policy:{maxBudget:10,maxAgents:1,maxConcurrentAgents:1,deadlineSeconds:300},maxPlanningCost:.2,input:'原需求'});
  const request=createOrganizationChatRequest(initial,'原需求','original-settings'),draft:Draft={...initial,pendingRequest:request};let calls=0;
  globalThis.fetch=async(_input,init)=>{calls++;assert.equal(new Headers(init?.headers).get('idempotency-key'),request.key);assert.deepEqual(JSON.parse(String(init?.body)),JSON.parse(JSON.stringify(request.body)));return new Response(body,{status:200});};
  let cause:unknown;try{await api('/organizations/chat','POST',request.body,request.key);}catch(error){cause=error;}
  assert.ok(cause instanceof Error&&!(cause instanceof ApiError));const retained=organizationReplyFailure(draft,cause);assert.equal(retained,draft);assert.deepEqual(JSON.parse(JSON.stringify(retained)).pendingRequest,JSON.parse(JSON.stringify(request)));assert.equal(calls,1);
  assert.equal(organizationReplyFailure(draft,new ApiError('confirmed refusal',422,'POLICY_DENIED')).pendingRequest,undefined);
 }}finally{globalThis.fetch=original;}
});
