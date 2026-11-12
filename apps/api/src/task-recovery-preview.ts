import {isDeepStrictEqual} from 'node:util';
import type pg from 'pg';
import {readRun,redact} from '../../../services/agent-runtime/trace-store.mjs';
import {verifyRecoveryCommitChain,verifyRecoveryCheckpoint} from './task-recovery-provenance.ts';
import {verifyRecoveryScope} from './task-recovery-scope.ts';
import {assertNoUnresolvedTaskOperation} from './task-operation-admission.ts';
import {AppError} from './provider.ts';

/** Read-only diagnostics, never a source approval. POST recaptures under the
 * native source fence and original transaction before publishing any child. */
export async function previewTaskRecovery(db:Pick<pg.PoolClient,'query'>,traceRoot:string,runId:string,checkpointId?:string){
 const row=(await db.query('SELECT * FROM project_runs WHERE id=$1',[runId])).rows[0];
 const denied=(message:string):never=>{throw new AppError(409,message,'TASK_RECOVERY_PREVIEW_BLOCKED');};
 if(!checkpointId)denied('请选择一个未完成任务的步骤检查点，再核对恢复条件');
 if(!row||row.snapshot.executionProfile!=='task-attempt-openshell-v1'||row.parent_run_id||row.snapshot.recovery||row.task_evidence!==null||
  !['failed','interrupted','cancelled'].includes(row.status)||!row.finished_at||row.lease_owner!==null||row.lease_until!==null)denied('此预览只支持已停止并排空的原始任务运行');
 await assertNoUnresolvedTaskOperation(db,runId);
 const archive=readRun(traceRoot,runId),snapshot:any=archive?.snapshot;
 if(!archive||archive.integrity!=='ok'||!snapshot||!isDeepStrictEqual(snapshot,{...(redact(row.snapshot) as any),id:runId,createdAt:snapshot.createdAt,formatVersion:1}))return denied('运行快照与原始档案不一致');
 const scopes=(await db.query('SELECT * FROM task_attempt_workspaces WHERE run_id=$1 ORDER BY task_id,attempt_id,generation LIMIT 4097',[runId])).rows;
 const operations=(await db.query('SELECT * FROM local_operations WHERE run_id=$1 ORDER BY id LIMIT 4097',[runId])).rows;
 if(scopes.length>4096||operations.length>4096)denied('运行历史超过支持的预览范围');
 const source={...row,events:archive.events},chain=verifyRecoveryCommitChain(traceRoot,source,scopes,operations,row.snapshot.executionTarget?.backend);
 const selected=verifyRecoveryCheckpoint(traceRoot,source,archive.events,checkpointId!,chain),scope=verifyRecoveryScope({traceRoot,run:source,events:archive.events,chain,selected});
 return {selected,scope};
}
