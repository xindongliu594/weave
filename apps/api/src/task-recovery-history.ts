import {createHash} from 'node:crypto';
import {isProxy} from 'node:util/types';
import {AppError} from './provider.ts';

// Pure fact projection only. No database/lock, eligibility, provenance or current
// permission proof is obtained here. In particular an unknown operation remains
// in this digest and MUST still block the future live-source admission helper.
// Input must be an explicit current-schema projection, not SELECT * or archived
// portable rows (which deliberately omit original claim tokens).
const runFields='id project_id project_version status error created_at started_at finished_at attempt parent_run_id cancel_requested department_ids lease_owner lease_until snapshot canonical_workspace requested_by_user_id authorized_by_user_id authorized_epoch authority_kind authority_department_ids source_bounds'.split(' ');
const scopeFields='run_id task_id attempt_id generation principal session_id runtime_task_id contract_hash permission_hash capability_hash contract input_origins committed_outputs sandbox_identity scope work_revision phase accepted_stop'.split(' ');
const operationFields='id run_id device_id grant_id approval_id status started deadline created_at finished_at merge_state payload result late_result merge_record merge_rejection claim_token lease_owner executor_kind effect_intent effect_state effect_version parent_operation_id evidence_records'.split(' ');
const runHashed=new Set(['lease_owner','snapshot']);
const operationHashed=new Set(['payload','result','late_result','merge_record','merge_rejection','claim_token','lease_owner','effect_intent','evidence_records']);
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const invalid=():never=>{throw new AppError(409,'任务恢复历史投影无效或超出支持范围','TASK_RECOVERY_HISTORY_INVALID');};
const hash=(text:string)=>createHash('sha256').update(text,'utf8').digest('hex');
const bytes=(a:string,b:string)=>Buffer.compare(Buffer.from(a,'utf8'),Buffer.from(b,'utf8'));

// The first supported slice is bounded, never truncated: 64 MiB encoded input,
// depth 64, 250k nodes and 4096 rows per collection. Inspect own descriptors
// before reading values; JSON.stringify alone would execute/drop invalid data.
function strictJson(value:unknown):string {
 let nodes=0,remaining=64*1024*1024;
 const seen=new Set<object>();
 const account=(encoded:string):string=>{remaining-=Buffer.byteLength(encoded,'utf8');if(remaining<0)invalid();return encoded;};
 function copy(item:unknown,depth:number):string {
  if(++nodes>250000||depth>64)invalid();
  if(item===null||typeof item==='boolean')return account(JSON.stringify(item));
  if(typeof item==='string'){if(Buffer.byteLength(item,'utf8')>remaining)invalid();return account(JSON.stringify(item));}
  if(typeof item==='number'){if(!Number.isFinite(item)||Object.is(item,-0))invalid();return account(JSON.stringify(item));}
  if(typeof item!=='object'||isProxy(item)||seen.has(item))return invalid();
  const array=Array.isArray(item),proto=Object.getPrototypeOf(item);
  if(proto!==(array?Array.prototype:Object.prototype))invalid();
  if(array&&item.length>250000-nodes)invalid();
  const keys=Reflect.ownKeys(item);
  if(keys.length>250000||array&&(keys.length!==item.length+1||!keys.includes('length')))invalid();
  seen.add(item);
  account(array?'[]':'{}');
  const pairs=new Map<string,string>();
  for(const key of keys){
   if(array&&key==='length')continue;
   if(typeof key!=='string')return invalid();
   if(array&&(!/^(0|[1-9][0-9]*)$/.test(key)||Number(key)>=item.length))invalid();
   const descriptor=Object.getOwnPropertyDescriptor(item,key)!;
   if(!descriptor.enumerable||!('value' in descriptor))invalid();
   if(pairs.size)account(',');
   if(!array)account(JSON.stringify(key)+':');
   pairs.set(key,copy(descriptor.value,depth+1));
  }
  seen.delete(item);
  const encoded=array?'['+Array.from({length:item.length},(_,i)=>pairs.get(String(i))).join(',')+']':
   '{'+[...pairs.keys()].sort().map(key=>JSON.stringify(key)+':'+pairs.get(key)).join(',')+'}';
  return encoded;
 }
 return copy(value,0);
}
function shape(row:any,fields:string[]):void {
 if(!row||Array.isArray(row)||typeof row!=='object'||Object.keys(row).length!==fields.length||fields.some(key=>!Object.hasOwn(row,key)))invalid();
}
function text(value:any,nullable=false):void {
 if(nullable&&value===null)return;
 if(typeof value!=='string'||!value.length||value.trim()!==value||/[\p{Cc}\p{Cs}]/u.test(value))invalid();
}
function integer(value:any,minimum=0):void {if(!Number.isSafeInteger(value)||value<minimum)invalid();}
function strings(value:any,nullable=false):void {
 if(nullable&&value===null)return;
 if(!Array.isArray(value))invalid();for(const item of value)text(item);
}
function timestamp(value:any,nullable=false):void {
 if(nullable&&value===null)return;
 if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(value))invalid();
 const millis=value.slice(0,23)+'Z',date=new Date(millis);
 if(!Number.isFinite(date.getTime())||date.toISOString()!==millis)invalid();
}
function project(row:Record<string,any>,fields:string[],hashed:Set<string>):Record<string,any> {
 return Object.fromEntries(fields.map(field=>hashed.has(field)?[field+'_digest',hash(strictJson(row[field]))]:[field,row[field]]));
}

export function summarizeTaskRecoveryHistory(input:unknown):{digest:string;history:Record<string,any>} {
 try {
  // A detached strict JSON copy also prevents later caller mutation from changing
  // the projection while preserving SQL NULL and the original JSON value types.
  const value=JSON.parse(strictJson(input));shape(value,['run','scopes','operations']);
  const {run,scopes,operations}=value;
  shape(run,runFields);
  if(typeof run.id!=='string'||typeof run.project_id!=='string'||!UUID.test(run.id)||!UUID.test(run.project_id))invalid();
  integer(run.project_version,1);integer(run.attempt,1);text(run.status);
  if(run.error!==null&&typeof run.error!=='string'||typeof run.cancel_requested!=='boolean')invalid();
  timestamp(run.created_at);for(const key of ['started_at','finished_at','lease_until'])timestamp(run[key],true);
  for(const key of ['parent_run_id','lease_owner','requested_by_user_id','authorized_by_user_id','authority_kind'])text(run[key],true);
  strings(run.department_ids);strings(run.authority_department_ids,true);
  if(run.authorized_epoch!==null){
   if(typeof run.authorized_epoch==='string'){
    if(!/^(0|[1-9][0-9]*)$/.test(run.authorized_epoch))invalid();
    run.authorized_epoch=Number(run.authorized_epoch);
   }
   integer(run.authorized_epoch);
  }
  if(!Array.isArray(scopes)||!Array.isArray(operations)||scopes.length>4096||operations.length>4096)invalid();
  const scopeKeys=new Set<string>(),operationKeys=new Set<string>();
  for(const row of scopes){
   shape(row,scopeFields);if(row.run_id!==run.id)invalid();integer(row.generation,1);
   for(const key of ['task_id','attempt_id','principal','session_id','runtime_task_id','phase'])text(row[key]);
   for(const key of ['contract_hash','permission_hash','capability_hash'])if(typeof row[key]!=='string'||!/^[a-f0-9]{64}$/.test(row[key]))invalid();
   if(row.work_revision!==null&&(typeof row.work_revision!=='string'||!/^[a-f0-9]{64}$/.test(row.work_revision)))invalid();
   const key=JSON.stringify([row.task_id,row.attempt_id,row.generation]);if(scopeKeys.has(key))invalid();scopeKeys.add(key);
  }
  for(const row of operations){
   shape(row,operationFields);if(row.run_id!==run.id||typeof row.id!=='string'||!UUID.test(row.id)||operationKeys.has(row.id))invalid();operationKeys.add(row.id);
   for(const key of ['device_id','grant_id','approval_id','merge_state','claim_token','lease_owner','effect_state','parent_operation_id'])text(row[key],true);
   text(row.status);text(row.executor_kind);integer(row.effect_version);
   if(typeof row.started!=='boolean'||!Array.isArray(row.evidence_records))invalid();
   timestamp(row.created_at);timestamp(row.deadline);timestamp(row.finished_at,true);
  }
  scopes.sort((a:any,b:any)=>bytes(a.task_id,b.task_id)||bytes(a.attempt_id,b.attempt_id)||a.generation-b.generation);
  operations.sort((a:any,b:any)=>bytes(a.created_at,b.created_at)||bytes(a.id,b.id));
  const history={kind:'task-live-source-history',version:1,run:project(run,runFields,runHashed),
   scopes,operations:operations.map((row:any)=>project(row,operationFields,operationHashed))};
  return {history,digest:hash(strictJson(history))};
 }catch{return invalid();}
}
