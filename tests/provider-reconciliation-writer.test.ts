import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {pool} from '../apps/api/src/db.ts';
import {queryProviderForCall} from '../apps/api/src/provider-reconciliation.ts';
import {ProviderReconciliationService} from '../apps/api/src/provider-reconciliation.ts';
import {costRouter} from '../apps/api/src/cost-router.ts';
import express from 'express';
import http from 'node:http';
import {createArchiveWriterManager} from '../services/agent-runtime/archive-writer-scope.mjs';
import {createArchiveWriteFence} from '../services/agent-runtime/archive-write-fence.mjs';

// Controlled SQL replies isolate the original transaction tail; native guards
// are real. This does not prove PostgreSQL backend locking or billing business SQL.
const root=mkdtempSync(join(process.cwd(),'.private','provider-writer-20261029','native-'));
const writers=createArchiveWriterManager({traceRoot:join(root,'runs')});
const fence=createArchiveWriteFence({traceRoot:writers.traceRoot,lockRoot:writers.lockRoot});
after(async()=>{await pool.end();console.log('PROVIDER_WRITER_EXIT_CLEANUP='+root);});
function gate(){let release!:()=>void;const promise=new Promise<void>(resolve=>release=resolve);return {promise,release};}
const pause=()=>new Promise(resolve=>setTimeout(resolve,60));
async function available(runId:string){try{const guard=await fence.acquireSource(runId,{timeoutMs:0});guard.release();return true;}catch(error){assert.equal((error as any).code,'E_ARCHIVE_FENCE_TIMEOUT');return false;}}
function fixture(t:any,runId:string|null=randomUUID()){
 const row:any={id:randomUUID(),run_id:runId,project_id:null,status:'uncertain',context:{},history:[]};
 const statements:string[]=[],released:any[]=[];let commits=0;
 const state={row,statements,released,hook:async(_text:string):Promise<any>=>{},commits:()=>commits,gateway:{version:1,data:{baseUrl:'https://billing.invalid/v1'}}};
 const query=async(text:string,values:any[]=[])=>{
  statements.push(text);const overridden=await state.hook(text);if(overridden)return overridden;
  if(text==='COMMIT')commits++;
  if(text.startsWith('SELECT run_id'))return {rows:[{run_id:row.run_id}]};
  if(text.includes('FROM gateways WHERE'))return {rows:[state.gateway]};
  if(text.startsWith('SELECT project_id'))return {rows:[{project_id:row.project_id}]};
  if(text.startsWith('SELECT * FROM model_reservations'))return {rows:[row]};
  if(text.startsWith('SELECT data FROM product_settings'))return {rows:[{data:{}}]};
  if(text.startsWith('UPDATE model_reservations SET context=context||'))Object.assign(row.context,JSON.parse(values[1]));
  if(text.startsWith("UPDATE model_reservations SET context=(context-'billingQueryClaim')")){delete row.context.billingQueryClaim;Object.assign(row.context,JSON.parse(values[1]));}
  return {rows:[]};
 };
 t.mock.method(pool,'query',query);
 t.mock.method(pool,'connect',async()=>({query,release:(discard:any)=>released.push(discard)}));
 return state;
}
async function sourceProbe(runId:string){
 const child=spawn(process.execPath,[fileURLToPath(new URL('./fixtures/provider-writer-probe.mjs',import.meta.url))],{windowsHide:true,stdio:['ignore','pipe','inherit'],env:{...process.env,ARCHIVE_WRITER_TEST:JSON.stringify({traceRoot:writers.traceRoot,lockRoot:writers.lockRoot,runId})}});
 const exited=once(child,'exit');let timer:NodeJS.Timeout|undefined,output='';child.stdout!.on('data',data=>output+=data);
 try{const [code]=await Promise.race([exited,new Promise<never>((_,reject)=>timer=setTimeout(()=>reject(Error('probe timeout')),10000))]);assert.equal(code,0);return JSON.parse(output.trim());}
 finally{clearTimeout(timer);if(child.exitCode===null)child.kill();await exited;}
}
function billing(t:any,f:ReturnType<typeof fixture>,wait=Promise.resolve(),records:any[]=[]){
 f.row.context.billingRoute={gatewayId:'synthetic',gatewayVersion:1,baseUrl:f.gateway.data.baseUrl,wireModel:'fixture',billingUnit:{quotaPerUSD:500000}};
 f.row.context.providerRequestId='receipt-1';
 let calls=0;
 t.mock.method(globalThis,'fetch',async(url:string)=>{
  calls++;const path=new URL(url).pathname;
  if(path==='/api/log/token'){await wait;return Response.json({success:true,data:records});}
  if(path==='/api/status')return Response.json({success:true,data:{display_in_currency:true,quota_per_unit:500000}});
  return Response.json({code:true,data:{total_granted:100,total_used:1,total_available:99,unlimited_quota:false,expires_at:-1}});
 });return ()=>calls;
}

test('source in another process is blocked across the original external bill query',async t=>{
 const f=fixture(t),finish=gate(),started=gate();const calls=billing(t,f,finish.promise);
 f.hook=async text=>{if(text==='SELECT data,version FROM gateways WHERE id=$1')started.release();};
 const work=queryProviderForCall(f.row.id,false,writers);await started.promise;await pause();
 let during;try{during=await sourceProbe(f.row.run_id);}finally{finish.release();}
 assert.equal((await work).status,'unresolved');assert.deepEqual(during,{blocked:true});
 assert.deepEqual(await sourceProbe(f.row.run_id),{acquired:true});assert.equal(calls(),3);
});

test('lost settlement claim drains only after the original rollback and save',async t=>{
 const f=fixture(t),records=[{type:2,model_name:'fixture',prompt_tokens:3,completion_tokens:4,quota:10000,request_id:'receipt-1'}];
 billing(t,f,Promise.resolve(),records);let reads=0;
 f.hook=async text=>{if(text.startsWith('SELECT * FROM model_reservations')&&++reads===2)f.row.context.providerReconciliation.token='newer-claim';};
 assert.equal((await queryProviderForCall(f.row.id,false,writers)).status,'unresolved');
 assert.equal(f.statements.filter(text=>text==='ROLLBACK').length,1);assert.equal(await available(f.row.run_id),true);
 assert.equal(f.statements.some(text=>text.startsWith('INSERT INTO usage')),false);
});

test('settlement COMMIT uncertainty is never converted into a successful second save',async t=>{
 const f=fixture(t),original=Error('settlement commit unknown');
 const calls=billing(t,f,Promise.resolve(),[{type:2,model_name:'fixture',prompt_tokens:3,completion_tokens:4,quota:10000,request_id:'receipt-1'}]);
 f.hook=async text=>{if(text==='COMMIT'&&f.commits()===1)throw original;};
 await assert.rejects(queryProviderForCall(f.row.id,false,writers),error=>error===original);
 assert.equal(await available(f.row.run_id),false);assert.equal(f.released.at(-1),true);
 assert.equal(f.statements.filter(text=>text==='COMMIT').length,2);
 assert.equal(f.statements.some(text=>text.startsWith("UPDATE model_reservations SET context=(context-'billingQueryClaim')")),false);
 f.hook=async()=>{};
 assert.equal((await queryProviderForCall(f.row.id,false,writers)).status,'unresolved');assert.equal(calls(),3,'an in-flight claim never repeats the bill query');
});

test('network failure preserves unknown cost and drains after its confirmed save',async t=>{
 const f=fixture(t);billing(t,f);t.mock.method(globalThis,'fetch',async()=>{throw Error('synthetic network down');});
 assert.equal((await queryProviderForCall(f.row.id,false,writers)).status,'failed');
 assert.equal(f.row.status,'uncertain');assert.equal(await available(f.row.run_id),true);
 assert.equal(f.statements.filter(text=>text==='COMMIT').length,2);
});

test('changed run identity after native waiting cannot claim under the old run writer',async t=>{
 const f=fixture(t),old=f.row.run_id,guard=await fence.acquireSource(old);
 const work=queryProviderForCall(f.row.id,false,writers);await pause();f.row.run_id=randomUUID();guard.release();
 await assert.rejects(work,(error:any)=>error.code==='RECONCILIATION_IDENTITY_CHANGED');
 assert.equal(f.statements.some(text=>text.startsWith('UPDATE')),false);assert.equal(await available(old),true);
});

test('automatic service retains its injected writer while closing an active bill query',async t=>{
 const f=fixture(t),finish=gate(),started=gate();billing(t,f,finish.promise);f.row.context.billingRoute.autoReconcile=true;
 f.hook=async text=>{
  if(text.includes('FROM backup_restore_anchor'))return {rows:[{operation_id:null,expected_enterprise_operation_id:null}]};
  if(text.startsWith("SELECT id FROM model_reservations WHERE status='uncertain'"))return {rows:[{id:f.row.id}]};
  if(text==='SELECT data,version FROM gateways WHERE id=$1')started.release();
 };
 const service=new ProviderReconciliationService(writers);service.start();await started.promise;await pause();
 const close=service.close();let closed=false;close.then(()=>closed=true);
 let during;try{during=await sourceProbe(f.row.run_id);assert.equal(closed,false);}finally{finish.release();await close;}
 assert.deepEqual(during,{blocked:true});assert.equal(await available(f.row.run_id),true);
});

test('manual cost route keeps its injected writer across external bill waiting',{timeout:15000},async t=>{
 const f=fixture(t),finish=gate(),started=gate();billing(t,f,finish.promise);
 f.hook=async text=>{if(text==='SELECT data,version FROM gateways WHERE id=$1')started.release();};
 // Execute the registered product handler without loopback networking.
 const route=(costRouter(writers) as any).stack.find((layer:any)=>layer.route?.path==='/costs/:id/query-provider').route;
 let result:any;const work=route.stack[0].handle({params:{id:f.row.id}},{json:(value:any)=>{result=value;}});
 try{await started.promise;await pause();assert.equal(await available(f.row.run_id),false);finish.release();await work;assert.equal(result.status,'unresolved');assert.equal(await available(f.row.run_id),true);}
 finally{finish.release();await work;}
});

test('manual HTTP request retains the same writer through the bill query',{skip:process.env.PROVIDER_WRITER_HTTP!=='1',timeout:15000},async t=>{
 const f=fixture(t),finish=gate(),started=gate();billing(t,f,finish.promise);
 f.hook=async text=>{if(text==='SELECT data,version FROM gateways WHERE id=$1')started.release();};
 const app=express();app.use(costRouter(writers));const server=app.listen(0,'127.0.0.1');await once(server,'listening');
 const work=new Promise<any>((resolve,reject)=>{const request=http.request('http://127.0.0.1:'+(server.address() as any).port+'/costs/'+f.row.id+'/query-provider',{method:'POST'},response=>{let body='';response.on('data',data=>body+=data);response.on('end',()=>resolve({status:response.statusCode,body}));});request.on('error',reject);request.end();});
 try{
  await Promise.race([started.promise,work.then(value=>{throw Error('request ended before billing: '+JSON.stringify(value));})]);
  assert.equal(await available(f.row.run_id),false);finish.release();
  const response=await work;assert.equal(response.status,200,response.body);assert.equal(JSON.parse(response.body).status,'unresolved');assert.equal(await available(f.row.run_id),true);
 }finally{finish.release();await work.catch(()=>{});server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test('writer covers the original save COMMIT after claim completion',async t=>{
 const f=fixture(t),entered=gate(),finish=gate();
 f.hook=async text=>{if(text==='COMMIT'&&f.commits()===1){entered.release();await finish.promise;}};
 const work=queryProviderForCall(f.row.id,false,writers);
 await entered.promise;
 const blocked=!(await available(f.row.run_id));finish.release();
 assert.equal((await work).status,'unresolved');assert.equal(blocked,true);
 assert.equal(await available(f.row.run_id),true);
});

test('native admission precedes claim SQL and rechecks the receipt state after waiting',async t=>{
 const f=fixture(t),guard=await fence.acquireSource(f.row.run_id);
 const work=queryProviderForCall(f.row.id,false,writers);await pause();
 const opened=f.statements.includes('BEGIN');f.row.status='settled';guard.release();
 assert.equal((await work).status,'already-settled');assert.equal(opened,false);
 assert.equal(f.statements.some(text=>text.startsWith('UPDATE')),false);
 assert.equal(await available(f.row.run_id),true);
});

test('a pending receipt is rejected after confirmed rollback without retaining its writer',async t=>{
 const f=fixture(t);f.row.status='pending';
 await assert.rejects(queryProviderForCall(f.row.id,false,writers),(error:any)=>error.code==='CALL_STILL_PENDING');
 assert.equal(await available(f.row.run_id),true);
});

test('an unknown original save COMMIT escapes the catch and retains the run',async t=>{
 const f=fixture(t),original=Error('save commit reply lost');
 f.hook=async text=>{if(text==='COMMIT'&&f.commits()===1)throw original;};
 await assert.rejects(queryProviderForCall(f.row.id,false,writers),error=>error===original);
 assert.equal(await available(f.row.run_id),false);assert.equal(f.released.at(-1),true);
 assert.equal(f.statements.filter(text=>text==='COMMIT').length,2,'no catch-driven second save');
});

test('rollback uncertainty retains the original error and run guard',async t=>{
 const f=fixture(t);f.row.status='pending';f.hook=async text=>{if(text==='ROLLBACK')throw Error('rollback unavailable');};
 await assert.rejects(queryProviderForCall(f.row.id,false,writers),(error:any)=>error.code==='CALL_STILL_PENDING');
 assert.equal(await available(f.row.run_id),false);assert.equal(f.released.at(-1),true);
});

test('unbound receipts use the shared SQL fee gate while root source is held',async t=>{
 const f=fixture(t,null),other=createArchiveWriterManager({traceRoot:join(root,'unbound-runs'),lockRoot:join(root,'unbound-locks')});
 const guard=await createArchiveWriteFence({traceRoot:other.traceRoot,lockRoot:other.lockRoot}).acquireRootExclusive();
 try{assert.equal((await queryProviderForCall(f.row.id,false,other)).status,'unresolved');}
 finally{guard.release();}
 assert.equal(f.statements.filter(text=>text==='SELECT pg_advisory_xact_lock_shared(918275)').length,2);
});
