import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { pool } from './db.ts';
import { AppError } from './provider.ts';
import { billingFailureReason, queryNewApiBilling, type BillingFailureReason, type NewApiLogRecord } from './new-api-billing.ts';
import { costMaintenanceTransaction, receiptTransaction, settleCall } from './cost-control.ts';

export type ProviderQueryResult={status:'settled'|'unresolved'|'failed'|'already-settled';message:string;checkedAt:string;requestId?:string;cost?:number;inputTokens?:number;outputTokens?:number;providerQuota?:number;code?:string;upstreamStatus?:number;failureReason?:BillingFailureReason;automaticPaused?:true};
const integer=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;

type BillingScope={gatewayId:string;gatewayVersion:number;baseUrl:string};
type AutomaticPause={checkedAt:string;code:string;upstreamStatus?:number;failureReason:BillingFailureReason;manualToken?:string};
type QueryDatabase=Pick<pg.PoolClient,'query'>;
const instant=(value:unknown)=>typeof value==='string'&&Number.isFinite(Date.parse(value))?Date.parse(value):undefined;
const scopeToken=(value:unknown)=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)?value:undefined;
function billingScope(value:any):BillingScope|undefined{
 if(value&&typeof value.gatewayId==='string'&&Number.isSafeInteger(value.gatewayVersion)&&typeof value.baseUrl==='string')return {gatewayId:value.gatewayId,gatewayVersion:value.gatewayVersion,baseUrl:value.baseUrl};
}
function structuredPause(value:any,checkedAt=value?.checkedAt):AutomaticPause|undefined{
 if(typeof value?.code!=='string'||instant(checkedAt)===undefined)return;
 const upstreamStatus=Number.isInteger(value.upstreamStatus)&&value.upstreamStatus>=100&&value.upstreamStatus<=599?value.upstreamStatus:undefined;
 const failureReason=billingFailureReason(value.code,upstreamStatus);
 if(failureReason)return {checkedAt,code:value.code,failureReason,...(upstreamStatus===undefined?{}:{upstreamStatus}),...(scopeToken(value.manualToken)?{manualToken:value.manualToken}:{})};
}
// Old receipts did not persist structured failure codes. Only exact, fixed
// helper messages qualify; arbitrary provider prose never disables a scope.
const legacyFailures=new Map<string,{code:string;upstreamStatus?:number}>([
 ['查询被中转站拒绝，请检查此查询接口的权限；保留待核对状态',{code:'NEW_API_QUERY_REJECTED'}],
 ['中转站返回 HTTP 401：密钥认证失败，请检查 API Key 是否有效',{code:'GATEWAY_REJECTED',upstreamStatus:401}],
 ['中转站返回 HTTP 403：访问被拒绝，请检查密钥权限或服务访问限制',{code:'GATEWAY_REJECTED',upstreamStatus:403}],
 ['中转站返回 HTTP 404：New API 查询接口不存在，请检查站点版本及代理是否转发 /api 路径',{code:'GATEWAY_REJECTED',upstreamStatus:404}],
 ['消费日志响应格式不兼容，保留待核对状态',{code:'NEW_API_INVALID_LOGS'}],
]);
function legacyPause(message:unknown,checkedAt:unknown):AutomaticPause|undefined{
 if(typeof message!=='string')return;
 for(const [text,failure] of legacyFailures){
  if(message==='账单查询失败：'+text||message==='账单查询失败：'+text+'（近期检测结果；5 分钟后重新探测）')return structuredPause(failure,checkedAt);
 }
}
async function scopeState(db:QueryDatabase,scope:BillingScope,currentId:string){
 const rows=(await db.query(`SELECT id,context->'providerReconciliation' AS reconciliation,context->'billingAutoQueryPause' AS pause,
   context->>'billingManualQueryToken' AS manual_token,context->'billingQueryClaim' AS claim,history
   FROM model_reservations WHERE context->'billingRoute'->>'gatewayId'=$1
   AND context->'billingRoute'->>'gatewayVersion'=$2 AND context->'billingRoute'->>'baseUrl'=$3`,[scope.gatewayId,String(scope.gatewayVersion),scope.baseUrl])).rows;
 // Explicit probes atomically write the same epoch token to every receipt in
 // the scope. A late older failure cannot override a newer manual probe, even
 // when both start in the same millisecond or the system clock moves backwards.
 const manualToken=rows.map(row=>scopeToken(row.manual_token)).find(Boolean);
 let pause:AutomaticPause|undefined,inFlight=false;
 for(const row of rows){
  const candidates:AutomaticPause[]=[];
  const persisted=structuredPause(row.pause);
  if(persisted){if(persisted.manualToken===manualToken)candidates.push(persisted);}
  else if(!manualToken){
   if(row.reconciliation?.status==='failed'){
    const failure=structuredPause(row.reconciliation)??legacyPause(row.reconciliation.message,row.reconciliation.checkedAt);if(failure)candidates.push(failure);
   }
   for(const entry of Array.isArray(row.history)?row.history:[])if(entry?.source==='billing-query'&&entry.status==='failed'){
    const failure=structuredPause(entry,entry.at)??legacyPause(entry.note,entry.at);if(failure)candidates.push(failure);
   }
  }
  for(const failure of candidates)if(!pause||Date.parse(failure.checkedAt)>Date.parse(pause.checkedAt))pause=failure;
  const claimedAt=instant(row.claim?.checkedAt)??(row.reconciliation?.status==='querying'?instant(row.reconciliation.checkedAt):undefined);
  if(row.id!==currentId&&claimedAt!==undefined&&Date.now()-claimedAt<30000)inFlight=true;
 }
 return {pause,inFlight,manualToken};
}

type BillingIdentity={providerRequestId?:string;upstreamRequestId?:string;wireModel:string};
export function matchNewApiReceipt(identity:BillingIdentity,records:NewApiLogRecord[]):{record?:NewApiLogRecord;message:string}{
 if(!identity.providerRequestId&&!identity.upstreamRequestId)return {message:'这次请求没有收到供应方请求编号，无法唯一定位账单。请按调用时间核对供应方记录；余额变化仅作辅助证据。'};
 const related=records.filter(record=>identity.providerRequestId?record.requestId===identity.providerRequestId:record.upstreamRequestId===identity.upstreamRequestId);
 if(related.some(record=>record.type===6))return {message:'该请求存在退款记录，需要核对净扣费；暂时保留预留。'};
 const consumed=related.filter(record=>record.type===2);
 if(consumed.length!==1)return {message:consumed.length?'该请求对应多条消费记录，暂时无法确定最终账单。':'暂未找到这次请求的消费记录。日志可能延迟、关闭或已超出最近记录范围，不能据此按零费用结算。'};
 const record=consumed[0];
 if(record.modelName!==identity.wireModel)return {message:'消费记录的模型名称与这次请求不一致，需要人工核对模型映射。'};
 if(!integer(record.promptTokens)||!integer(record.completionTokens)||record.promptTokens>2147483647||record.completionTokens>2147483647||!integer(record.quota))return {message:'消费记录缺少完整的 Token 或扣费额度，暂时无法自动结算。'};
 return {record,message:'已唯一匹配这次请求的消费记录。'};
}

export async function queryProviderForCall(id:string,automatic=false):Promise<ProviderQueryResult>{
 const checkedAt=new Date().toISOString(),token=randomUUID();
 const claim=await receiptTransaction(id,async(db,row)=>{
  if(['settled','released'].includes(row.status))return {result:{status:'already-settled',message:'这次费用已结算或请求未发送，无需再次核对。',checkedAt} as ProviderQueryResult};
  if(row.status!=='uncertain')throw new AppError(409,'请求仍在进行中，请等待返回或停止后再核对','CALL_STILL_PENDING');
  const previous=row.context.providerReconciliation;
  if(previous?.status==='querying'&&Date.now()-Date.parse(previous.checkedAt)<30000)return {result:{status:'unresolved',message:'这次请求的账单正在查询，请稍后刷新。',checkedAt} as ProviderQueryResult};
  const priorAttempts=integer(previous?.attempts)?previous.attempts:0,attempts=priorAttempts+1;
  const route=row.context.billingRoute;
  if(automatic&&(!route?.autoReconcile||attempts>3))return {result:{status:'unresolved',message:'自动查询次数已用完，仍保留待核对费用，可在网页手动查询。',checkedAt} as ProviderQueryResult};
  const scope=billingScope(route);
  let manualToken:string|undefined;
  if(scope){
   if(automatic){
    const gate=await scopeState(db,scope,id);
    manualToken=gate.manualToken;
    if(gate.pause){
     const result:ProviderQueryResult={status:'failed',checkedAt,message:'该中转站配置的账单接口已明确拒绝或不支持查询，自动查询已暂停；费用仍待核对，修正配置后可在网页手动查询。',code:gate.pause.code,upstreamStatus:gate.pause.upstreamStatus,failureReason:gate.pause.failureReason,automaticPaused:true};
     if(!previous?.automaticPaused)await db.query('UPDATE model_reservations SET context=context||$2::jsonb,history=history||$3::jsonb WHERE id=$1',[id,JSON.stringify({providerReconciliation:{...result,attempts:priorAttempts},billingAutoQueryPause:gate.pause}),JSON.stringify([{at:checkedAt,source:'billing-query-paused',note:result.message,code:result.code}])]);
     return {result};
    }
    if(gate.inFlight){
     const result:ProviderQueryResult={status:'unresolved',checkedAt,message:'同一中转站配置的账单查询正在进行，稍后继续自动核对；未增加查询次数或释放费用。'};
     await db.query('UPDATE model_reservations SET context=context||$2::jsonb WHERE id=$1',[id,JSON.stringify({providerReconciliation:{...result,attempts:priorAttempts,nextAttemptAt:new Date(Date.now()+15000).toISOString()}})]);
     return {result};
    }
   }else{
    // A user-requested probe supersedes older scope pauses without resetting any
    // query/model counters. The new outcome may pause this scope again.
    manualToken=token;
    await db.query(`UPDATE model_reservations SET context=(CASE WHEN status='uncertain' AND context->'providerReconciliation'->>'automaticPaused'='true'
      THEN jsonb_set(context,'{providerReconciliation}',(context->'providerReconciliation')-'automaticPaused'-'nextAttemptAt') ELSE context END)||$4::jsonb
      WHERE context->'billingRoute'->>'gatewayId'=$1 AND context->'billingRoute'->>'gatewayVersion'=$2 AND context->'billingRoute'->>'baseUrl'=$3`,[scope.gatewayId,String(scope.gatewayVersion),scope.baseUrl,JSON.stringify({billingManualQueryAt:checkedAt,billingManualQueryToken:manualToken})]);
   }
  }
  const state={status:'querying',message:'正在查询中转站消费日志和额度，不会重发模型请求。',checkedAt,attempts,token};
  await db.query('UPDATE model_reservations SET context=context||$2::jsonb WHERE id=$1',[id,JSON.stringify({providerReconciliation:state,billingQueryClaim:{token,checkedAt,manualToken},...(manualToken?{billingManualQueryToken:manualToken}:{})})]);
  return {row,route,attempts,manualToken};
 });
 if(claim.result)return claim.result;
 const save=async(result:ProviderQueryResult)=>{
  return receiptTransaction(id,async(db,row)=>{
   const settled=['settled','released'].includes(row.status);
   const alreadySettled=()=>({status:'already-settled',checkedAt:result.checkedAt,message:'查询期间费用已被核对，保留最新记录。'} as ProviderQueryResult);
   if(row.context.billingQueryClaim?.token!==token)return settled?alreadySettled():result;
   const update:Record<string,unknown>={};
   const pause=result.automaticPaused?structuredPause({...result,manualToken:claim.manualToken},checkedAt):undefined;
   if(pause)update.billingAutoQueryPause=pause;
   const currentResult=pause&&scopeToken(row.context.billingManualQueryToken)!==claim.manualToken?{...result,automaticPaused:undefined,message:'本次查询被拒绝；后续手动查询已更新此配置的核对状态，费用仍待核对。'}:result;
   if(row.status==='uncertain'&&row.context.providerReconciliation?.token===token)update.providerReconciliation={...currentResult,attempts:claim.attempts,...(!currentResult.automaticPaused?{nextAttemptAt:new Date(Date.now()+(claim.attempts===1?15000:60000)).toISOString()}:{})};
   const entries=result.status==='settled'||result.status==='already-settled'?[]:[{at:result.checkedAt,source:'billing-query',status:result.status,note:result.message,...(result.requestId?{requestId:result.requestId}:{}),...(result.code?{code:result.code}:{}),...(result.upstreamStatus===undefined?{}:{upstreamStatus:result.upstreamStatus}),...(result.failureReason?{failureReason:result.failureReason}:{})}];
   // Keep scope evidence even if a manual settlement won the race, without
   // overwriting its usage, public settled state, or earlier query history.
   await db.query("UPDATE model_reservations SET context=(context-'billingQueryClaim')||$2::jsonb,history=history||$3::jsonb WHERE id=$1",[id,JSON.stringify(update),JSON.stringify(entries)]);
   return settled&&result.status!=='settled'&&result.status!=='already-settled'?alreadySettled():currentResult;
  });
 };
 try{
  if(!claim.route)return save({status:'unresolved',checkedAt,message:'历史请求没有固定中转站查询信息，不能用新连接替它结算。请核对原中转站账单。'});
  const gateway=(await pool.query('SELECT version,data FROM gateways WHERE id=$1',[claim.route.gatewayId])).rows[0];
  if(!gateway||gateway.version!==claim.route.gatewayVersion||gateway.data.baseUrl!==claim.route.baseUrl)return save({status:'unresolved',checkedAt,message:'这次调用之后中转站地址或凭据配置已变化，保留原费用记录，需核对原账单。'});
  const billing=await queryNewApiBilling(claim.route.gatewayId,claim.route.gatewayVersion,{forceProbe:!automatic});
  if(billing.logs.status!=='available')return save({status:'failed',checkedAt:billing.checkedAt,message:'账单查询失败：'+billing.logs.message+(billing.logs.failureReason?'；自动查询已暂停，可在网页明确重新查询。':''),code:billing.logs.code,upstreamStatus:billing.logs.upstreamStatus,...(billing.logs.failureReason?{failureReason:billing.logs.failureReason,automaticPaused:true}:{})});
  const matched=matchNewApiReceipt({providerRequestId:claim.row.context.providerRequestId,upstreamRequestId:claim.row.context.upstreamRequestId,wireModel:claim.route.wireModel},billing.logs.records??[]);
  if(!matched.record)return save({status:'unresolved',checkedAt:billing.checkedAt,message:matched.message});
  const record=matched.record;
  const pinnedUnit=claim.route.billingUnit;
  if(!billing.billingUnit||!pinnedUnit||pinnedUnit.quotaPerUSD!==billing.billingUnit.quotaPerUSD)return save({status:'unresolved',checkedAt:billing.checkedAt,requestId:record.requestId,providerQuota:record.quota,message:'已找到消费记录，但调用时的额度换算未固定或站点换算已变化，暂不自动修改费用。'});
  const receipt=await settleCall(id,record.promptTokens!,record.completionTokens!,{reconciliationToken:token,providerBill:{source:'new-api',requestId:record.requestId,upstreamRequestId:record.upstreamRequestId,gatewayId:claim.route.gatewayId,gatewayVersion:claim.route.gatewayVersion,quota:record.quota,quotaPerUSD:pinnedUnit.quotaPerUSD,basis:pinnedUnit.basis,unitVerifiedAt:pinnedUnit.verifiedAt,checkedAt:billing.checkedAt}});
  return save({status:receipt.alreadySettled?'already-settled':'settled',message:receipt.alreadySettled?'查询期间费用已被核对，保留最新记录。':'已按唯一匹配的中转站消费记录结算。已用预算与调用次数继续保留。',checkedAt:billing.checkedAt,requestId:record.requestId,providerQuota:record.quota,cost:receipt.cost,inputTokens:record.promptTokens,outputTokens:record.completionTokens});
 }catch(error){
  return save({status:error instanceof AppError&&error.code==='RECONCILIATION_CLAIM_LOST'?'unresolved':'failed',checkedAt:new Date().toISOString(),message:error instanceof AppError?error.message:'中转站账单查询失败，预留仍保留，请稍后查询或手动核对。'});
 }
}

export async function expireProviderQueries(){
 await costMaintenanceTransaction(async db=>{
  await db.query(`UPDATE model_reservations SET context=jsonb_set(context-'billingQueryClaim','{providerReconciliation}',(context->'providerReconciliation')||jsonb_build_object('status','unresolved','message','上次账单查询中断；预留仍保留，可在网页重新查询。','checkedAt',now())),history=history||jsonb_build_array(jsonb_build_object('at',now(),'source','billing-query','status','unresolved','note','中断的账单查询已停止，未释放费用')) WHERE status='uncertain' AND context->'providerReconciliation'->>'status'='querying' AND (context->'providerReconciliation'->>'checkedAt')::timestamptz<now()-interval '30 seconds'`);
 });
}

export class ProviderReconciliationService{
 private timer?:NodeJS.Timeout;private work:Promise<void>=Promise.resolve();private busy=false;private stopped=false;
 start(){this.timer=setInterval(()=>this.tick(),10000);this.timer.unref();this.tick();}
 private tick(){
  if(this.busy||this.stopped)return;this.busy=true;
  this.work=(async()=>{
   await expireProviderQueries();
   const rows=(await pool.query(`SELECT id FROM model_reservations WHERE status='uncertain' AND context->'billingRoute'->>'autoReconcile'='true'
    AND COALESCE((context->'providerReconciliation'->>'attempts')::int,0)<3
    AND COALESCE(context->'providerReconciliation'->>'automaticPaused','false')<>'true'
    AND (context->'providerReconciliation'->>'nextAttemptAt' IS NULL OR (context->'providerReconciliation'->>'nextAttemptAt')::timestamptz<now()) ORDER BY created_at LIMIT 5`)).rows;
   for(const row of rows){if(this.stopped)break;await queryProviderForCall(row.id,true);}
  })().catch(()=>{}).finally(()=>{this.busy=false;});
 }
 async close(){this.stopped=true;clearInterval(this.timer);await this.work;}
}
