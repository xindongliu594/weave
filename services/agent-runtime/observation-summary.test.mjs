import test from 'node:test';
import assert from 'node:assert/strict';
const api=await import('./observation-summary.mjs').catch(()=>({}));
const runId='11111111-1111-4111-8111-111111111111',requestId='22222222-2222-4222-8222-222222222222';
const source=(type,data={})=>({kind:'trace',runId,event:{seq:2,at:'2026-10-24T00:00:00.000Z',type,data}});
function summarize(value){assert.equal(typeof api.summarizeObservation,'function');return api.summarizeObservation(value);}
test('raw prompt and nested secrets never enter a new scalar summary',()=>{
 const secret='private value without any recognizable prefix',body={messages:[secret],system:secret,url:secret,cookie:secret,headers:{token:secret},filename:secret,commandOutput:secret};body.cycle=body;
 const input=source('tool/result',{name:secret,arguments:body,result:{isError:false,value:body},error:secret});input.event.taskId=requestId;input.event.requestId=requestId;
 const result=summarize(input);assert.deepEqual(result,{schema:1,sourceEventId:'trace:'+runId+':2',at:'2026-10-24T00:00:00.000Z',name:'tool.result',correlation:{runId},outcome:'success'});
 assert.equal(JSON.stringify(result).includes(secret),false);assert.ok(Object.isFrozen(result));assert.ok(Object.isFrozen(result.correlation));
});
test('unknown and model/session/request body sources are dropped without visiting getters',()=>{
 let read=0;const value=source('model/request');Object.defineProperty(value.event,'data',{get(){read++;throw Error('secret');}});
 assert.equal(summarize(value),null);assert.equal(read,0);
 for(const type of ['session/message','billing/provider-response','custom/secret'])assert.equal(summarize(source(type)),null);
 const guarded=source('tool/result');Object.defineProperty(guarded.event,'data',{get(){read++;throw Error('secret');}});assert.equal(summarize(guarded),null);assert.equal(read,0);
});
test('arbitrary string identity and unsafe numeric metadata are never admitted',()=>{
 assert.equal(summarize({...source('run/created'),runId:'email@example.test'}),null);
 const value=summarize(source('billing/usage',{inputTokens:12,outputTokens:-1,durationMs:Infinity,cost:123,secret:'no'}));
 assert.equal(value.inputTokens,12);assert.equal(value.outputTokens,undefined);assert.equal(value.durationMs,undefined);assert.equal(value.confirmedCost,undefined);
 const safe=summarize(source('run/created'));assert.equal(api.validateObservationSummary({...safe,sourceEventId:'my private path'}),null);
 assert.equal(api.validateObservationSummary({...safe,error:'private'}),null);assert.equal(api.validateObservationSummary({...safe,correlation:{runId,requestId:'private'}}),null);
});
test('audit projection exports actor kind and canonical UUID correlations but no raw actor or capability claims',()=>{
 const result=summarize({kind:'audit',projection:{sourceEventId:requestId,occurredAt:'2026-10-24T00:00:00.000Z',action:'tool.result',actor:{kind:'human',userId:'private',email:'secret'},correlation:{correlationId:runId,runId:requestId,requestId:'private'},outcome:'unknown',reasonCode:'result-unknown',changes:{state:'unknown',capabilityId:'not-reviewed',capabilityVersion:'secret',capabilitySha256:'a'.repeat(64)}}});
 assert.deepEqual(result,{schema:1,sourceEventId:'audit:'+requestId,at:'2026-10-24T00:00:00.000Z',name:'audit.tool.result',correlation:{correlationId:runId,runId:requestId},actorKind:'human',outcome:'unknown',reasonCode:'result-unknown'});
});
test('only explicit unknown and fixed phase values survive source mapping',()=>{
 assert.equal(summarize(source('billing/unconfirmed',{message:'private'})).costUnknown,true);
 assert.equal(summarize(source('runtime/status',{employees:[{phase:'waiting_approval',name:'private'}]})).phase,'waiting_approval');
 assert.equal(summarize(source('runtime/anomaly',{phase:'private',code:'my private error',message:'private'})).phase,undefined);
});
test('checkpoint mapping uses the registered team event',()=>{
 assert.equal(summarize(source('team/checkpoint',{private:'body'}))?.name,'task.checkpoint');
 assert.equal(summarize(source('handoff/checkpoint')),null);
});
test('finished lifecycle does not claim execution success',()=>{
 // Existing local-device notExecuted uses operation-finished without a distinguishing field.
 assert.equal(summarize(source('runtime/operation-finished',{name:'local_workspace'})).outcome,undefined);
 assert.equal(summarize(source('runtime/operation-finished',{notExecuted:true})).outcome,undefined);
});
