import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {z} from 'zod';
import type pg from 'pg';
import type {TaskAttemptKey} from '../../../packages/contracts/index.ts';
import {AppError} from './provider.ts';

const uuid=z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
const sha=z.string().regex(/^[a-f0-9]{64}$/);
const text=(max=240)=>z.string().min(1).max(max).refine(value=>value.trim()===value&&!/[\x00-\x1f\x7f]/.test(value));
const positive=z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const key=z.strictObject({runId:uuid,taskId:text(),attemptId:text(),generation:positive});
const identity=z.strictObject({version:z.literal(1),stopId:uuid,key,sandboxId:uuid,workspaceRevision:sha,proofDigest:sha});
const proof=z.strictObject({
 accepted:z.strictObject({seq:positive,digest:sha}),checkpoint:z.strictObject({id:uuid,sha256:sha,seq:positive}),
 originalOperationId:uuid,originalMergeDigest:sha,runtimeTaskId:text(),principal:text(),sessionId:text(),
 contractHash:sha,permissionHash:sha,capabilityHash:sha,deviceId:uuid,grantId:uuid,fingerprint:sha,
});
const iso=z.string().refine(value=>{const time=Date.parse(value);return Number.isFinite(time)&&new Date(time).toISOString()===value;});
const lastError=z.strictObject({code:text(120),message:text(2048)});
const result=identity.extend({phase:z.literal('stopped'),replayed:z.literal(false)});
const common={version:z.literal(1),identity,proof,preparedAt:iso,digest:sha};
const record=z.discriminatedUnion('state',[
 z.strictObject({...common,state:z.literal('prepared')}),
 z.strictObject({...common,state:z.literal('dispatching'),dispatchedAt:iso}),
 z.strictObject({...common,state:z.literal('unknown'),dispatchedAt:iso.optional(),lastError:lastError.optional()}),
 z.strictObject({...common,state:z.literal('stopped'),dispatchedAt:iso,confirmedAt:iso,result}),
]);
export type TaskAcceptedStopRecord=z.infer<typeof record>;
export type TaskAcceptedStopIdentity=z.infer<typeof identity>;
const ordered=(value:any):any=>Array.isArray(value)?value.map(ordered):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,ordered(value[key])])):value;
const digest=(value:any)=>createHash('sha256').update(JSON.stringify(ordered(value))).digest('hex');
const invalid=():never=>{throw new AppError(409,'已验收任务停止记录损坏，必须核对原记录','TASK_ACCEPTED_STOP_INVALID');};

/** Private persisted codec; structure and digests do not prove acceptance or a device effect. */
export function decodeTaskAcceptedStop(value:unknown):TaskAcceptedStopRecord{
 try{
  const encoded=JSON.stringify(value);
  if(typeof encoded!=='string'||Buffer.byteLength(encoded)>32*1024)return invalid();
  const parsed=record.parse(value);
  if(parsed.identity.proofDigest!==digest({kind:'task-accepted-stop-proof',version:1,proof:parsed.proof})||
   parsed.digest!==digest({kind:'task-accepted-stop',version:1,identity:parsed.identity,proof:parsed.proof}))return invalid();
  if('dispatchedAt' in parsed&&parsed.dispatchedAt!==undefined&&Date.parse(parsed.dispatchedAt)<Date.parse(parsed.preparedAt)||
   parsed.state==='stopped'&&(Date.parse(parsed.confirmedAt)<Date.parse(parsed.dispatchedAt)||!isDeepStrictEqual(parsed.result,{...parsed.identity,phase:'stopped',replayed:false})))return invalid();
  return parsed;
 }catch{return invalid();}
}

/** Ordinary admission only, under the existing project -> run locks. No lifecycle exemption. */
export async function assertTaskAcceptedStopAdmission(db:Pick<pg.PoolClient,'query'>,runId:string,requested:TaskAttemptKey){
 const rows=(await db.query('SELECT run_id,task_id,attempt_id,generation,accepted_stop FROM task_attempt_workspaces WHERE run_id=$1 AND accepted_stop IS NOT NULL FOR UPDATE',[runId])).rows;
 const markers=rows.map(row=>{
  const marker=decodeTaskAcceptedStop(row.accepted_stop);
  if(!isDeepStrictEqual(marker.identity.key,{runId:row.run_id,taskId:row.task_id,attemptId:row.attempt_id,generation:row.generation})||row.run_id!==runId)return invalid();
  return marker;
 });
 if(markers.some(marker=>marker.state!=='stopped'))throw new AppError(409,'存在未决任务停止，必须核对原沙箱','TASK_ACCEPTED_STOP_UNRESOLVED');
 if(markers.some(marker=>isDeepStrictEqual(marker.identity.key,requested)))throw new AppError(409,'已验收停止的任务已封存，不能再次执行','TASK_ACCEPTED_STOP_SEALED');
}
