import { before,after,beforeEach,test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import express from 'express';

// Regression fixtures exercise real transactions and HTTP; they are not model acceptance.
const base=process.env.DATABASE_URL??'postgres://agent_department:local-development-only@127.0.0.1:55432/agent_department';
const admin=new pg.Pool({connectionString:base}),schema='provider_receipt_'+Date.now();
let pool:pg.Pool,directory:string,server:http.Server,costServer:http.Server,costUrl:string,gatewayBaseUrl:string;
let cost:typeof import('../apps/api/src/cost-control.ts'),reconciliation:typeof import('../apps/api/src/provider-reconciliation.ts');
let mode='matched',queries=0,releaseLog:(()=>void)|undefined,logStarted:Promise<void>,startLog:(()=>void)|undefined;
const paths:string[]=[];
const model={id:'fixture-model',inputRate:100,outputRate:100};
const record={type:2,model_name:'fixture-model',prompt_tokens:3,completion_tokens:4,quota:10000,request_id:'relay-unique-1'};
before(async()=>{
 await admin.query('CREATE SCHEMA '+schema);const databaseUrl=new URL(base);databaseUrl.searchParams.set('options','-c search_path='+schema);process.env.DATABASE_URL=databaseUrl.href;
 directory=await mkdtemp(join(tmpdir(),'provider-receipt-'));process.env.DATA_DIR=directory;
 ({pool}=await import('../apps/api/src/db.ts'));await (await import('../apps/api/src/db.ts')).migrate();
 cost=await import('../apps/api/src/cost-control.ts');reconciliation=await import('../apps/api/src/provider-reconciliation.ts');
 server=http.createServer(async(req,res)=>{
  const requestMode=mode;queries++;paths.push(req.url!);res.setHeader('content-type','application/json');
  if(req.url==='/api/status')return void res.end(JSON.stringify({success:true,data:{display_in_currency:true,quota_per_unit:requestMode==='unit-changed'?1000000:500000}}));
  if(req.url==='/api/usage/token/')return void res.end(JSON.stringify({code:true,data:{total_granted:100000,total_used:10000,total_available:90000,unlimited_quota:false,expires_at:-1}}));
  if(req.url==='/api/log/token'){
   if(requestMode==='delay'||requestMode==='delay-denied'){startLog?.();await new Promise<void>(resolve=>{releaseLog=resolve;});}
   const status=requestMode==='denied'||requestMode==='delay-denied'?403:requestMode==='unauthorized'?401:requestMode==='unsupported'?404:requestMode==='temporary'?503:requestMode==='rate'?429:undefined;
   if(status){res.writeHead(status);return void res.end(JSON.stringify({error:'Synthetic refusal, never a model response'}));}
   if(requestMode==='drop'){req.socket.destroy();return;}
   if(requestMode==='rejected')return void res.end(JSON.stringify({success:false,message:'Synthetic inaccessible log'}));
   if(requestMode==='incompatible')return void res.end(JSON.stringify({success:true,data:{items:[]}}));
   return void res.end(JSON.stringify({success:true,data:requestMode==='missing'?[]:[record]}));
  }
  res.writeHead(404);res.end('{}');
 });
 server.listen(0,'127.0.0.1');await once(server,'listening');
 const origin='http://127.0.0.1:'+(server.address() as {port:number}).port;
 gatewayBaseUrl=origin+'/v1';
 await pool.query("INSERT INTO gateways(id,data) VALUES('fixture-gateway',$1)",[{name:'Ledger fixture',baseUrl:gatewayBaseUrl,pricingSource:'new-api',_billingUnit:{quotaPerUSD:500000,basis:'new-api-status',verifiedAt:new Date().toISOString()}}]);
 await pool.query("INSERT INTO models(id,data) VALUES('fixture-model',$1)",[{name:'Ledger fixture',model:'fixture-model',gatewayId:'fixture-gateway',inputRate:100,outputRate:100}]);
 const app=express();app.use('/api',(await import('../apps/api/src/cost-router.ts')).costRouter());costServer=app.listen(0,'127.0.0.1');await once(costServer,'listening');costUrl='http://127.0.0.1:'+(costServer.address() as {port:number}).port+'/api/costs';
});
beforeEach(async()=>{
 await pool.query('TRUNCATE model_reservations,usage CASCADE');await pool.query("UPDATE gateways SET version=1,data=jsonb_set(data,'{baseUrl}',to_jsonb($1::text)) WHERE id='fixture-gateway'",[gatewayBaseUrl]);
 mode='matched';queries=0;paths.length=0;releaseLog=undefined;logStarted=new Promise<void>(resolve=>{startLog=resolve;});
});
after(async()=>{
 releaseLog?.();server?.closeAllConnections();if(server)await new Promise<void>(resolve=>server.close(()=>resolve()));
 costServer?.closeAllConnections();if(costServer)await new Promise<void>(resolve=>costServer.close(()=>resolve()));
 await pool?.end();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();if(directory)await rm(directory,{recursive:true,force:true});
});
async function uncertain(){const id=await cost.reserveCall({model,amount:.1,purpose:'Synthetic ledger regression'});await cost.recordProviderResponse(id,{providerRequestId:'relay-unique-1',providerStatus:200});await cost.markCallUncertain(id,'Synthetic lost body');return id;}

test('exact request identity is required; ambiguous, mismapped, missing and refund records retain unknown fees',()=>{
 const valid={type:2,modelName:'fixture-model',promptTokens:3,completionTokens:4,quota:10000,requestId:'relay-unique-1'};
 const identity={wireModel:'fixture-model',providerRequestId:'relay-unique-1'};
 assert.equal(reconciliation.matchNewApiReceipt(identity,[valid]).record,valid);
 for(const records of [[],[valid,valid],[{...valid,modelName:'mapped-other'}],[{...valid,promptTokens:undefined}],[{...valid,quota:-1}],[{...valid,type:5}],[valid,{...valid,type:6,quota:-10000}]])assert.equal(reconciliation.matchNewApiReceipt(identity,records).record,undefined);
 assert.equal(reconciliation.matchNewApiReceipt({wireModel:'fixture-model'},[valid]).record,undefined);
 assert.equal(reconciliation.matchNewApiReceipt({wireModel:'fixture-model',upstreamRequestId:'upstream'},[{...valid,upstreamRequestId:'upstream'}]).record?.quota,10000);
});
test('provider charge is settled once from exact log plus verified units; replayed usage preserves authoritative charge',async()=>{
 const id=await uncertain();const result=await reconciliation.queryProviderForCall(id);
 assert.equal(result.status,'settled');assert.equal(result.cost,.02);assert.equal(queries,3);
 assert.equal(Number((await pool.query('SELECT cost FROM usage WHERE id=$1',[id])).rows[0].cost),.02);
 await cost.settleCall(id,3,4);assert.equal(Number((await pool.query('SELECT cost FROM usage WHERE id=$1',[id])).rows[0].cost),.02);
 assert.equal((await reconciliation.queryProviderForCall(id)).status,'already-settled');assert.equal(queries,3);
 assert.equal(Number((await pool.query('SELECT count(*) AS n FROM usage')).rows[0].n),1);
});
test('absent logs retain reservation and durable query state until a later exact receipt is found',async()=>{
 mode='missing';const id=await uncertain();assert.equal((await reconciliation.queryProviderForCall(id)).status,'unresolved');
 const row=(await pool.query('SELECT * FROM model_reservations WHERE id=$1',[id])).rows[0];assert.equal(row.status,'uncertain');assert.equal(row.context.providerReconciliation.attempts,1);assert.equal(row.history.at(-1).source,'billing-query');
 assert.equal((await pool.query('SELECT id FROM usage')).rowCount,0);
 mode='matched';assert.equal((await reconciliation.queryProviderForCall(id)).status,'settled');
});
test('changed gateway configuration and legacy calls cannot be settled using a replacement connection',async()=>{
 const id=await uncertain();await pool.query("UPDATE gateways SET version=2 WHERE id='fixture-gateway'");
 assert.equal((await reconciliation.queryProviderForCall(id)).status,'unresolved');assert.equal(queries,0);
 await pool.query("UPDATE model_reservations SET context=context-'billingRoute' WHERE id=$1",[id]);
 const result=await reconciliation.queryProviderForCall(id);assert.match(result.message,/历史请求/);assert.equal(queries,0);assert.equal((await pool.query('SELECT status FROM model_reservations WHERE id=$1',[id])).rows[0].status,'uncertain');
});
test('concurrent query and manual settlement preserve the manual receipt and do not duplicate charges',async()=>{
 mode='delay';const id=await uncertain();const automatic=reconciliation.queryProviderForCall(id);await logStarted;
 assert.equal((await reconciliation.queryProviderForCall(id)).status,'unresolved');assert.equal(queries,3);
 await cost.settleCall(id,10,10,{},'Synthetic authoritative manual receipt');releaseLog!();
 assert.equal((await automatic).status,'already-settled');
 const row=(await pool.query('SELECT * FROM model_reservations WHERE id=$1',[id])).rows[0];assert.equal(row.history.filter((h:any)=>h.source==='new-api').length,0);assert.equal(row.context.providerReconciliation.status,'settled');assert.equal(Number((await pool.query('SELECT cost FROM usage WHERE id=$1',[id])).rows[0].cost),.002);
});
test('changed quota conversion and lost query ownership never fabricate a zero settled cost',async()=>{
 const id=await uncertain();mode='unit-changed';assert.equal((await reconciliation.queryProviderForCall(id)).status,'unresolved');
 assert.equal((await pool.query('SELECT id FROM usage')).rowCount,0);
 await assert.rejects(cost.settleCall(id,3,4,{reconciliationToken:'expired-claim',providerBill:{source:'new-api',quota:10000,quotaPerUSD:500000}}),(error:any)=>error.code==='RECONCILIATION_CLAIM_LOST');
 assert.equal((await pool.query('SELECT status FROM model_reservations WHERE id=$1',[id])).rows[0].status,'uncertain');
});
test('restart cleanup terminates a stale third query without releasing or repeatedly querying the model',async()=>{
 const id=await uncertain();await pool.query("UPDATE model_reservations SET context=context||$2::jsonb WHERE id=$1",[id,JSON.stringify({providerReconciliation:{status:'querying',checkedAt:new Date(Date.now()-60000).toISOString(),attempts:3,token:'stale'}})]);
 const service=new reconciliation.ProviderReconciliationService();service.start();await service.close();
 const row=(await pool.query('SELECT * FROM model_reservations WHERE id=$1',[id])).rows[0];assert.equal(row.status,'uncertain');assert.equal(row.context.providerReconciliation.status,'unresolved');assert.equal(row.context.providerReconciliation.attempts,3);assert.equal(queries,0);
});

test('permanent log failures pause the same configuration across receipts and service recreation without releasing fees',async()=>{
 for(const failure of ['denied','unauthorized','unsupported','incompatible','rejected']){
  await pool.query('TRUNCATE model_reservations,usage CASCADE');mode=failure;queries=0;paths.length=0;
  const first=await uncertain(),result=await reconciliation.queryProviderForCall(first,true);
  assert.equal(result.status,'failed');assert.equal(result.automaticPaused,true);assert.equal(queries,3);
  for(let repeated=0;repeated<3;repeated++)assert.equal((await reconciliation.queryProviderForCall(first,true)).automaticPaused,true);
  const second=await uncertain();assert.equal((await reconciliation.queryProviderForCall(second,true)).automaticPaused,true);assert.equal(queries,3);
  let rows=(await pool.query('SELECT id,status,context FROM model_reservations ORDER BY created_at')).rows;
  assert.equal(rows[0].context.providerReconciliation.attempts,1);assert.equal(rows[1].context.providerReconciliation.attempts,0);assert.ok(rows.every(row=>row.status==='uncertain'));
  assert.equal((await pool.query('SELECT id FROM usage')).rowCount,0);assert.deepEqual(await cost.dailyTotals(pool),{spent:0,reserved:.2});
  // Explicit settlement is authorized fixture input, never inferred from a denial.
  await cost.settleCall(first,0,0,{},'Synthetic operator confirms no charge');
  assert.ok((await pool.query('SELECT context FROM model_reservations WHERE id=$1',[first])).rows[0].context.billingAutoQueryPause);
  const restarted=new reconciliation.ProviderReconciliationService();restarted.start();await restarted.close();
  const third=await uncertain();assert.equal((await reconciliation.queryProviderForCall(third,true)).automaticPaused,true);assert.equal(queries,3);
  const costs=await(await fetch(costUrl)).json() as any,serialized=JSON.stringify(costs);
  for(const privateField of ['billingRoute','billingAutoQueryPause','billingManualQueryToken','billingQueryClaim',gatewayBaseUrl])assert.equal(serialized.includes(privateField),false,privateField);
  assert.equal(costs.calls.length,2);assert.equal(costs.calls.every((row:any)=>row.status==='uncertain'),true);assert.equal(costs.reserved,.2);
  assert.equal(paths.some(path=>path.includes('chat/completions')),false);
 }
});

test('exact legacy helper failures survive manual settlement, while explicit manual queries supersede scope pauses',async()=>{
 const first=await uncertain(),at=new Date(Date.now()-1000).toISOString();
 const message='账单查询失败：查询被中转站拒绝，请检查此查询接口的权限；保留待核对状态';
 await pool.query('UPDATE model_reservations SET context=context||$2::jsonb,history=history||$3::jsonb WHERE id=$1',[first,JSON.stringify({providerReconciliation:{status:'failed',message,checkedAt:at,attempts:3}}),JSON.stringify([{source:'billing-query',status:'failed',note:message,at}])]);
 await cost.settleCall(first,0,0,{},'Synthetic legacy no-charge confirmation');
 const retained=(await pool.query('SELECT history FROM model_reservations WHERE id=$1',[first])).rows[0].history;
 const second=await uncertain();assert.equal((await reconciliation.queryProviderForCall(second,true)).automaticPaused,true);assert.equal(queries,0);
 mode='missing';assert.equal((await reconciliation.queryProviderForCall(second)).status,'unresolved');assert.equal(queries,3);
 assert.equal((await pool.query('SELECT context FROM model_reservations WHERE id=$1',[second])).rows[0].context.providerReconciliation.attempts,1);
 const third=await uncertain();assert.equal((await reconciliation.queryProviderForCall(third,true)).status,'unresolved');assert.equal(queries,6);
 assert.deepEqual((await pool.query('SELECT history FROM model_reservations WHERE id=$1',[first])).rows[0].history,retained);
 assert.equal((await pool.query('SELECT context FROM model_reservations WHERE id=$1',[first])).rows[0].context.providerReconciliation.attempts,3);
 assert.deepEqual(await cost.dailyTotals(pool),{spent:0,reserved:.2});
});

test('an explicit manual probe retries once and reinstates a pause when the same permission denial remains',async()=>{
 mode='denied';const first=await uncertain();assert.equal((await reconciliation.queryProviderForCall(first,true)).automaticPaused,true);assert.equal(queries,3);
 const manual=await uncertain();assert.equal((await reconciliation.queryProviderForCall(manual,true)).automaticPaused,true);assert.equal(queries,3);
 const retried=await reconciliation.queryProviderForCall(manual);assert.equal(retried.status,'failed');assert.equal(retried.automaticPaused,true);assert.equal(queries,6);
 const third=await uncertain();assert.equal((await reconciliation.queryProviderForCall(third,true)).automaticPaused,true);assert.equal(queries,6);
 for(const [id,attempts] of [[first,1],[manual,1],[third,0]] as const){
  const row=(await pool.query('SELECT status,context FROM model_reservations WHERE id=$1',[id])).rows[0];assert.equal(row.status,'uncertain');assert.equal(row.context.providerReconciliation.attempts,attempts);
 }
 assert.equal((await pool.query('SELECT id FROM usage')).rowCount,0);assert.deepEqual(await cost.dailyTotals(pool),{spent:0,reserved:.3});
});

test('untrusted legacy prose containing denial words is not a permanent failure classification',async()=>{
 const first=await uncertain();await pool.query('UPDATE model_reservations SET context=context||$2::jsonb WHERE id=$1',[first,JSON.stringify({providerReconciliation:{status:'failed',message:'账单查询失败：临时 HTTP403 / permission denied / 不支持（供应方任意正文）',checkedAt:new Date().toISOString(),attempts:3}})]);
 mode='missing';const second=await uncertain(),result=await reconciliation.queryProviderForCall(second,true);
 assert.equal(result.status,'unresolved');assert.equal(result.automaticPaused,undefined);assert.equal(queries,3);
 assert.equal((await pool.query('SELECT id FROM usage')).rowCount,0);
});

test('scope pauses do not carry into a different configuration version or base URL, and old receipts stay pinned',async()=>{
 mode='denied';const old=await uncertain();assert.equal((await reconciliation.queryProviderForCall(old,true)).automaticPaused,true);assert.equal(queries,3);
 await pool.query("UPDATE gateways SET version=2 WHERE id='fixture-gateway'");
 mode='missing';const next=await uncertain();assert.equal((await reconciliation.queryProviderForCall(next,true)).status,'unresolved');assert.equal(queries,6);
 mode='denied';assert.equal((await reconciliation.queryProviderForCall(next,true)).automaticPaused,true);assert.equal(queries,9);
 await pool.query("UPDATE gateways SET data=jsonb_set(data,'{baseUrl}',to_jsonb($1::text)) WHERE id='fixture-gateway'",[gatewayBaseUrl.replace('/v1','/alternate-v1')]);
 mode='missing';const differentBase=await uncertain();assert.equal((await reconciliation.queryProviderForCall(differentBase,true)).status,'unresolved');assert.equal(queries,12);
 const changed=await reconciliation.queryProviderForCall(old);assert.equal(changed.status,'unresolved');assert.match(changed.message,/配置已变化/);assert.equal(queries,12);
 assert.equal((await pool.query('SELECT id FROM usage')).rowCount,0);assert.deepEqual(await cost.dailyTotals(pool),{spent:0,reserved:.3});
});

test('distinct gateway IDs at the same origin and version do not inherit each other’s permission pause',async()=>{
 mode='denied';const first=await uncertain();assert.equal((await reconciliation.queryProviderForCall(first,true)).automaticPaused,true);assert.equal(queries,3);
 await pool.query("INSERT INTO gateways(id,version,data) SELECT 'fixture-other-gateway',version,data FROM gateways WHERE id='fixture-gateway'");
 await pool.query("INSERT INTO models(id,data) VALUES('fixture-other-model',$1)",[{name:'Other gateway fixture',model:'fixture-model',gatewayId:'fixture-other-gateway',inputRate:100,outputRate:100}]);
 const other=await cost.reserveCall({model:{...model,id:'fixture-other-model'},amount:.1,purpose:'Synthetic distinct gateway scope'});
 await cost.recordProviderResponse(other,{providerRequestId:'relay-unique-1',providerStatus:200});await cost.markCallUncertain(other,'Synthetic body loss');
 mode='missing';const result=await reconciliation.queryProviderForCall(other,true);assert.equal(result.status,'unresolved');assert.equal(result.automaticPaused,undefined);assert.equal(queries,6);
 assert.equal((await pool.query('SELECT id FROM usage')).rowCount,0);
});

test('temporary network, rate, 5xx and absent-log outcomes retain the bounded three automatic probes',async()=>{
 for(const failure of ['temporary','rate','drop','missing']){
  await pool.query('TRUNCATE model_reservations,usage CASCADE');mode=failure;queries=0;
  const id=await uncertain();for(let attempt=1;attempt<=3;attempt++){
   const result=await reconciliation.queryProviderForCall(id,true);assert.equal(result.automaticPaused,undefined);assert.equal(queries,3*attempt);
  }
  const exhausted=await reconciliation.queryProviderForCall(id,true);assert.equal(exhausted.status,'unresolved');assert.match(exhausted.message,/次数已用完/);assert.equal(queries,9);
  const row=(await pool.query('SELECT status,context FROM model_reservations WHERE id=$1',[id])).rows[0];assert.equal(row.status,'uncertain');assert.equal(row.context.providerReconciliation.attempts,3);assert.equal(row.context.billingAutoQueryPause,undefined);
  const other=await uncertain();assert.equal((await reconciliation.queryProviderForCall(other,true)).automaticPaused,undefined);assert.equal(queries,12);
  assert.equal((await pool.query('SELECT id FROM usage')).rowCount,0);assert.deepEqual(await cost.dailyTotals(pool),{spent:0,reserved:.2});
 }
});

test('concurrent automatic receipts defer the same scope and remember its first definitive denial',async()=>{
 mode='delay-denied';const first=await uncertain(),second=await uncertain();
 const pending=reconciliation.queryProviderForCall(first,true);await logStarted;
 const waiting=await reconciliation.queryProviderForCall(second,true);assert.equal(waiting.status,'unresolved');assert.match(waiting.message,/正在进行/);assert.equal(queries,3);
 assert.equal((await pool.query('SELECT context FROM model_reservations WHERE id=$1',[second])).rows[0].context.providerReconciliation.attempts,0);
 releaseLog!();assert.equal((await pending).automaticPaused,true);
 assert.equal((await reconciliation.queryProviderForCall(second,true)).automaticPaused,true);assert.equal(queries,3);
 assert.equal((await pool.query('SELECT id FROM usage')).rowCount,0);assert.deepEqual(await cost.dailyTotals(pool),{spent:0,reserved:.2});
});

test('a later explicit manual probe supersedes an earlier in-flight denial without resetting counts',async()=>{
 mode='delay-denied';const first=await uncertain(),manual=await uncertain();
 const pending=reconciliation.queryProviderForCall(first,true);await logStarted;
 mode='missing';assert.equal((await reconciliation.queryProviderForCall(manual)).status,'unresolved');assert.equal(queries,6);
 releaseLog!();const late=await pending;assert.equal(late.status,'failed');assert.equal(late.automaticPaused,undefined);
 const after=(await pool.query('SELECT context FROM model_reservations WHERE id=$1',[first])).rows[0].context;
 assert.equal(after.providerReconciliation.attempts,1);assert.equal(after.providerReconciliation.automaticPaused,undefined);assert.ok(after.billingAutoQueryPause);assert.ok(after.billingManualQueryToken);assert.equal(after.billingQueryClaim,undefined);
 const third=await uncertain();assert.equal((await reconciliation.queryProviderForCall(third,true)).status,'unresolved');assert.equal(queries,9);
 assert.equal((await pool.query('SELECT id FROM usage')).rowCount,0);
});

test('a definitive denial arriving after manual settlement preserves the settled ledger and scope evidence',async()=>{
 mode='delay-denied';const first=await uncertain(),pending=reconciliation.queryProviderForCall(first,true);await logStarted;
 await cost.settleCall(first,10,10,{},'Synthetic independently confirmed charged receipt');releaseLog!();
 assert.equal((await pending).status,'already-settled');
 const row=(await pool.query('SELECT status,context,history FROM model_reservations WHERE id=$1',[first])).rows[0];assert.equal(row.status,'settled');assert.equal(row.context.providerReconciliation.status,'settled');assert.ok(row.context.billingAutoQueryPause);assert.equal(row.context.billingQueryClaim,undefined);
 assert.equal(row.history.filter((entry:any)=>entry.source==='manual').length,1);assert.equal(row.history.filter((entry:any)=>entry.source==='new-api').length,0);
 assert.equal(Number((await pool.query('SELECT cost FROM usage WHERE id=$1',[first])).rows[0].cost),.002);
 const second=await uncertain();assert.equal((await reconciliation.queryProviderForCall(second,true)).automaticPaused,true);assert.equal(queries,3);
 assert.equal((await reconciliation.queryProviderForCall(first)).status,'already-settled');assert.equal(queries,3);assert.equal((await pool.query('SELECT id FROM usage')).rowCount,1);
});
