import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {defineTool} from '@deepseek-ai/dsh-tools';
import {LlmAdapter} from '@deepseek-ai/dsh-llm';
import {createTeamHost} from './host.mjs';
import {EmployeeHostFactory} from './employee-hosts.mjs';
import {captureToolDefinition} from './tool-definition-effects.mjs';
import {effectDigest} from './tool-effects.mjs';
import {installProductTools} from './product-tools.mjs';
const req=createRequire(import.meta.url),base=createRequire(req.resolve('@deepseek-ai/dsh-base/package.json'));
const deferred=()=>{let resolve;return {promise:new Promise(done=>resolve=done),resolve:(...args)=>resolve(...args)};};

test('C1 workspace knowledge search cannot use the old internal read retry',async()=>{
 const registered=new Map();let queries=0;const error=Object.assign(Error('index write result unknown'),{code:'EAGAIN'});
 const snapshot={agents:[{id:'manager',role:'manager',tools:['knowledge_search']}],knowledge:{format:'document-versions-v2'},policy:{maxReadRetries:2},effectContractVersion:1,effectContracts:[{toolName:'knowledge_search',effect:'workspace',retry:'never'}]};
 installProductTools({tools:{register:tool=>{registered.set(tool.name,tool);return()=>{};}}},{snapshot,captainId:()=> 'captain',archive:{append(){}},queryKnowledge:async()=>{queries++;throw error;}});
 await assert.rejects(registered.get('knowledge_search').execute({query:'test'},{agent:{id:'captain'},signal:new AbortController().signal,callId:'search'}),caught=>caught===error);
 assert.equal(queries,1);
});
test('Host checks exact production runtime bindings before constructing a runtime',async()=>{
 const original=Error('TOOL_EFFECT_RUNTIME_BINDING_INVALID');let checks=0,reads=0;
 const snapshot={},queryKnowledge=()=>{reads++;};
 await assert.rejects(createTeamHost({sessionRoot:join(tmpdir(),'unused-effect-binding'),product:{snapshot,queryKnowledge,effectAuthority:{assertRuntimeBindings(input){checks++;assert.equal(input.snapshot,snapshot);assert.equal(input.queryKnowledge,queryKnowledge);throw original;}}}}),error=>error===original);
 assert.equal(checks,1);assert.equal(reads,0);
});

async function fixture(t,body,changes={},factoryOptions={}){
 const root=await mkdtemp(join(tmpdir(),'runtime-effects-')),events=[],rows=new Map();let invoked=0;
 const host=await createTeamHost({adapter:new class extends LlmAdapter{async *stream(){throw Error('NO_MODEL_CALL');}}(),provider:'fixture',sessionRoot:join(root,'sessions')});
 host.ctx.tools.register(defineTool({name:'office_write',description:'fixture workspace action',parameters:{value:{type:'string'}},output:{schema:{type:'json'},render:(_,v)=>[{type:'text',text:JSON.stringify(v)}]},execute:async(args,exec)=>{invoked++;events.push('body');return body(args,exec);}}));
 const definition=captureToolDefinition(host.ctx.tools.get('office_write'),'weiwu-coordinator-registry-v1');
 const contract={schema:1,capabilityId:'office.write',namespace:'weiwu',toolName:'office_write',source:{kind:'builtin',reference:'fixture',version:'1',digest:'a'.repeat(64)},definitionSha256:definition.definitionSha256,effect:'workspace',isolationProfile:'runtime-v1',permissions:['office:write'],retry:'never',cost:{kind:'free'},reconciliation:{kind:'receipt'},compensation:{kind:'none',requiresApproval:true},evidenceRefs:['fixture:source']};
 const operations={async prepare(input){events.push('prepare');const operation={operationId:randomUUID(),version:1,state:'prepared',intentSha256:effectDigest(input)};rows.set(operation.operationId,{input,operation,evidence:[]});return operation;},async dispatch(input){events.push('dispatch');const row=rows.get(input.operationId);assert.equal(row.operation.state,'prepared');return row.operation={...row.operation,version:2,state:'dispatched'};},async recordEvidence(input){events.push('evidence');rows.get(input.operationId).evidence.push(input.evidence);return {...rows.get(input.operationId).operation,state:input.evidence.outcome};},async markUnknown(input){events.push('unknown');rows.get(input.operationId).evidence.push({outcome:'unknown'});},...changes};
 const authority={assertSnapshot:async()=>{},withAdmission:async()=>{throw Error('OLD_ADMISSION_USED');},runtimeOperations:operations};
 operations.abortPrepared=async input=>{events.push('abort-prepared');const row=rows.get(input.operationId);if(row.operation.state!=='prepared'||row.operation.version!==input.expectedVersion||row.operation.intentSha256!==input.intentSha256)throw Error('TOOL_OPERATION_ABORT_CONFLICT');return row.operation={...row.operation,version:row.operation.version+1,state:'failed-known'};};
 const factory=new EmployeeHostFactory({coordinator:host.ctx,provider:'fixture',sessionRoot:join(root,'sessions'),identify:()=>({id:'employee',tools:['office_write']}),effectSnapshot:{effectContractVersion:1,effectContracts:[contract]},effectAuthority:authority,loadPlugin:name=>import(pathToFileURL(base.resolve(name)).href),...factoryOptions});
 t.after(async()=>{await factory.close().catch(()=>{});await host.close().catch(()=>{});await rm(root,{recursive:true,force:true});});
 const handle=await factory.createAgent(host.ctx,{sessionId:randomUUID(),agentOptions:{provider:'fixture',model:'unused'}}),ctx=factory.list()[0].ctx;
 const call=(args={},signal=new AbortController().signal)=>ctx.tools.execute({name:'office_write',arguments:args,agent:handle.agent,callId:randomUUID(),signal});
 return {ctx,handle,factory,events,rows,operations,call,contract,invoked:()=>invoked};
}
test('real DSH employee forwarding records one operation and dispatches one original body after checkpoint',async t=>{
 const f=await fixture(t,async()=>17);const flush=f.ctx.sessions.flush.bind(f.ctx.sessions);f.ctx.sessions.flush=async(...args)=>{f.events.push('flush');return flush(...args);};
 const result=await f.call({value:'x'});assert.equal(result.isError,false);assert.equal(result.value,17);assert.equal(f.invoked(),1);assert.equal(f.rows.size,1);
 assert.ok(f.events.indexOf('flush')<f.events.indexOf('prepare'));assert.deepEqual(f.events.filter(x=>x!=='flush'),['prepare','dispatch','body','evidence']);
});
test('real DSH binds the effective forwarded arguments and rejects mutation after durable dispatch',async t=>{
 await t.test('normalized forwarding is prepared once',async t=>{
  let effective,transforms=0;const f=await fixture(t,async args=>{effective=args;return 17;},{},{prepareToolArguments:(_agent,_name,args)=>{transforms++;return {...args,value:'normalized'};}});
  assert.equal((await f.call({value:'original'})).isError,false);assert.equal(transforms,1);assert.equal(effective.value,'normalized');
  assert.equal([...f.rows.values()][0].input.argumentsSha256,effectDigest(effective));
 });
 await t.test('downstream argument replacement cannot enter body',async t=>{
  const f=await fixture(t,async()=>17);f.ctx.on('tools/execute',async(exec,next)=>{exec.arguments.value='changed';return next();});
  assert.equal((await f.call({value:'original'})).isError,true);assert.equal(f.invoked(),0);
 });
 await t.test('direct reuse of an earlier execution cannot enter body twice',async t=>{
  const f=await fixture(t,async()=>17);let original;f.ctx.tools.guard(exec=>{original=exec;});
  assert.equal((await f.call({value:'original'})).isError,false);
  await assert.rejects(f.ctx.tools.get('office_write').execute(original.arguments,original),/TOOL_EFFECT_DISPATCH_REQUIRED/);assert.equal(f.invoked(),1);
 });
});
test('real DSH checkpoint, uncertain dispatch and receipt failure never resend an original body',async t=>{
 await t.test('checkpoint fails before preparing',async t=>{
  const f=await fixture(t,async()=>17);f.ctx.sessions.flush=async()=>{throw Error('checkpoint unavailable');};
  assert.equal((await f.call()).isError,true);assert.equal(f.invoked(),0);assert.equal(f.rows.size,0);
 });
 await t.test('dispatch reply lost keeps the original operation and enters no body',async t=>{
  const f=await fixture(t,async()=>17),dispatch=f.operations.dispatch;f.operations.dispatch=async input=>{await dispatch(input);throw Error('dispatch COMMIT reply lost');};
  assert.equal((await f.call()).isError,true);assert.equal(f.invoked(),0);assert.equal(f.rows.size,1);assert.equal([...f.rows.values()][0].operation.state,'dispatched');
  assert.equal((await f.call()).isError,true);assert.equal(f.rows.size,1);
 });
 await t.test('receipt reply lost retains dispatch and close failure',async t=>{
  const original=Error('receipt COMMIT reply lost'),f=await fixture(t,async()=>17,{recordEvidence:async()=>{throw original;}});
  assert.equal((await f.call()).isError,true);assert.equal(f.invoked(),1);assert.equal(f.rows.size,1);assert.equal([...f.rows.values()][0].operation.state,'dispatched');
  await assert.rejects(f.factory.close(),error=>error instanceof AggregateError&&error.errors.some(item=>item instanceof AggregateError&&item.errors.includes(original)));
 });
});
test('real DSH refuses prepared/dispatch failure before body',async t=>{
 for(const method of ['prepare','dispatch'])await t.test(method,async t=>{const f=await fixture(t,async()=>17,{[method]:async()=>{throw Error(method+' unavailable');}});assert.equal((await f.call()).isError,true);assert.equal(f.invoked(),0);});
});

test('known dispatch refusal closes only its original prepared operation',async t=>{
 const f=await fixture(t,async()=>17,{dispatch:async()=>{throw Error('TOOL_EFFECT_RETIRED');}});
 assert.equal((await f.call()).isError,true);assert.equal(f.invoked(),0);
 assert.equal([...f.rows.values()][0].operation.state,'failed-known');
 assert.equal(f.events.filter(value=>value==='abort-prepared').length,1);
});

test('cancellation after prepare closes the unstarted operation without using the cancelled signal',async t=>{
 const abort=new AbortController(),f=await fixture(t,async()=>17),prepare=f.operations.prepare;
 f.operations.prepare=async input=>{const row=await prepare(input);abort.abort(Error('cancel after prepare'));return row;};
 assert.equal((await f.call({},abort.signal)).isError,true);assert.equal(f.invoked(),0);
 assert.equal([...f.rows.values()][0].operation.state,'failed-known');
 assert.equal(f.events.includes('dispatch'),false);
});
test('real DSH cancellation waits for original body and retains unknown then original late evidence',async t=>{
 const entered=deferred(),finish=deferred(),abort=new AbortController();const f=await fixture(t,async()=>{entered.resolve();await finish.promise;return 17;});
 const work=f.call({},abort.signal);t.after(()=>finish.resolve());await Promise.race([entered.promise,work.then(result=>assert.fail('original body was not entered: '+JSON.stringify(result.error)))]);abort.abort(Error('caller cancelled'));await new Promise(done=>setTimeout(done,20));
 let closed=false;const closing=f.factory.close().then(()=>{closed=true;},()=>{closed=true;});await new Promise(done=>setTimeout(done,20));assert.equal(closed,false);assert.ok(f.events.includes('unknown'));finish.resolve();await work;await closing;
 assert.equal(f.invoked(),1);assert.equal(f.rows.size,1);assert.ok([...f.rows.values()][0].evidence.length>=2);
});
