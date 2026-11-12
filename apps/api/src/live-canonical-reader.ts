import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import type pg from 'pg';
import {AppError} from './provider.ts';
import {readCommittedCanonical,validateTaskOperationResult} from './task-canonical.ts';
import {assertNoUnresolvedTaskOperation} from './task-operation-admission.ts';
import {assertTaskRecoveryRuntime} from './task-recovery-runtime.ts';

export type LiveCanonical=ReturnType<typeof readCommittedCanonical>;
const blocked=(message:string):never=>{throw new AppError(409,message,'TASK_CANONICAL_INVALID');};
const ordered=(v:any):any=>Array.isArray(v)?v.map(ordered):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().filter(k=>v[k]!==undefined).map(k=>[k,ordered(v[k])])):v;
const digest=(v:any)=>createHash('sha256').update(JSON.stringify(ordered(v))).digest('hex');

/** Select once per action from an actual SQL run row; never repair or read the compatibility cache. */
export async function readLiveCanonical(db:Pick<pg.PoolClient,'query'>,traceRoot:string,row:any,archive:any):Promise<LiveCanonical|null>{
 const profile=row?.snapshot?.executionProfile??'legacy-run-v1',archivedProfile=archive?.snapshot?.executionProfile??'legacy-run-v1';
 if(profile!==archivedProfile)blocked('SQL 与运行档案的执行 profile 不一致');
 if(profile==='legacy-run-v1')return null;
 if(profile!=='task-attempt-openshell-v1')blocked('未知执行 profile，不能读取成果');
 if(!row||!archive||archive.integrity!=='ok'||row.id!==archive.id||row.project_id!==archive.snapshot.projectId||row.snapshot.planVersion!==archive.snapshot.planVersion)blocked('可信任务运行档案或 SQL 身份不完整');
 // parent_run_id is used by retry/resume only; a full retry may still start a
 // fresh live task run. Recovery ancestry itself needs the frozen source contract.
 if(row.snapshot.recovery||archive.snapshot.recovery||[row.snapshot,archive.snapshot].some(snapshot=>snapshot.resumedFrom&&snapshot.approval?.kind!=='retry')){
  const recovery=await assertTaskRecoveryRuntime(db,traceRoot,row);
  if(!recovery)return blocked('任务恢复来源尚未认证，当前不能读取成果');
  await assertNoUnresolvedTaskOperation(db,row.id);return recovery.currentCanonical;
 }
 let selected:LiveCanonical;
 try{selected=readCommittedCanonical(traceRoot,row);}catch(error){if(error instanceof AppError)throw error;return blocked('完整 canonical 对象缺失或损坏：'+(error as Error).message);}
 // A restored head cannot be certified by an empty live operation index. Until
 // initializer provenance is frozen, initial NULL-merge heads are unsupported.
 if(!selected.ref.mergeId)blocked('初始 canonical 尚无可核对的 live 提交来源');
 await assertNoUnresolvedTaskOperation(db,row.id);
 const operation=(await db.query('SELECT * FROM local_operations WHERE run_id=$1 AND id=$2',[row.id,selected.ref.mergeId])).rows[0],record=operation?.merge_record;
 if(!operation||operation.status!=='completed'||!operation.started||operation.merge_state!=='committed'||!operation.result?.ok||!record||record.version!==1||record.digest!==digest({...record,digest:undefined})||record.operationId!==operation.id||record.resultDigest!==digest(operation.result)||record.scopeDigest!==digest(operation.payload?.taskScope)||!isDeepStrictEqual(record.receipt,row.canonical_workspace.receipt)||!isDeepStrictEqual(record.after,selected.ref))blocked('完整 canonical 缺少原 live SQL committed 操作证明；恢复档案暂不支持');
 try{validateTaskOperationResult(operation,operation.result.result);}catch{return blocked('canonical 原操作结果不能认证');}
 return selected;
}
