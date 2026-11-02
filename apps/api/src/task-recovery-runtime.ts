import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {isDeepStrictEqual} from 'node:util';
import type pg from 'pg';
import {readRun,redact} from '../../../services/agent-runtime/trace-store.mjs';
import {decodeTaskRecoveryEvidence} from './task-recovery-state.ts';
import {readCommittedCanonical} from './task-canonical.ts';
import {verifyRecoveryCommitChain} from './task-recovery-provenance.ts';
import {AppError} from './provider.ts';

const {canonicalManifest}=createRequire(import.meta.url)('../../desktop/local-executor.cjs');
const hash=(value:any)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const denied=(message:string):never=>{throw new AppError(409,message,'TASK_RECOVERY_RUNTIME_INVALID');};

/** The caller holds the usual project/run locks for effects. Reads may fail
 * closed during concurrent changes. No source-lock upgrade or archive repair. */
export async function assertTaskRecoveryRuntime(db:Pick<pg.PoolClient,'query'>,traceRoot:string,run:any){
 const actual=(await db.query('SELECT *,task_evidence::text AS task_evidence_text FROM project_runs WHERE id=$1',[run.id])).rows[0];
 if(!actual||!['id','project_id','project_version','parent_run_id','snapshot','canonical_workspace','task_evidence'].every(key=>isDeepStrictEqual(actual[key],run[key])))denied('运行来源或成果在读取期间发生变化');
 if(!actual.snapshot.recovery&&!actual.snapshot.handoffCheckpoints?.length){
  if(actual.task_evidence_text!==null)denied('普通运行含未知恢复证据');return null;
 }
 if(actual.snapshot.executionProfile!=='task-attempt-openshell-v1'||actual.task_evidence_text===null)denied('恢复尚未完成可信初始化');
 const initialization=decodeTaskRecoveryEvidence(JSON.parse(actual.task_evidence_text)).recoveryInitialization;
 if(!initialization)return denied('恢复初始化记录缺失');
 const source=initialization.source,cp=source.sourceCheckpoint,snapshot=actual.snapshot;
 if(initialization.childRunId!==actual.id||actual.parent_run_id!==source.sourceRunId||snapshot.recovery.sourceRunId!==source.sourceRunId||
  snapshot.approval?.kind!=='resume'||snapshot.approval.parentRunId!==source.sourceRunId||snapshot.resumedFrom!==source.sourceRunId||
  !isDeepStrictEqual(snapshot.recovery.workspaceCheckpoint,{id:cp.id,runId:source.sourceRunId,sha256:cp.sha256})||
  actual.project_id!==source.authority.projectId||actual.project_version!==source.authority.planVersion||snapshot.resourceRevision!==source.authority.resourceRevision)denied('初始化与批准的来源身份不符');
 if(snapshot.recovery.version!==1||!Array.isArray(snapshot.recovery.completed)||!Array.isArray(snapshot.completedCheckpoints)||!Array.isArray(snapshot.handoffCheckpoints))denied('恢复执行需要完整团队完成状态与原验收，文件初始化不能单独启动团队');
 const archived=readRun(traceRoot,actual.id),fixed:any=archived?.snapshot;
 if(!archived||archived.integrity!=='ok'||!fixed||!Number.isFinite(Date.parse(fixed.createdAt))||
  !isDeepStrictEqual(fixed,{...(redact(snapshot) as any),id:actual.id,createdAt:fixed.createdAt,formatVersion:1})||
  archived.events[0]?.type!=='run/created'||archived.events.filter(event=>event.type==='run/created').length!==1)return denied('恢复 SQL 快照与原始档案不同');
 const markers=archived.events.filter(event=>event.type==='task/recovery-initialized');
 if(markers.length!==1||!isDeepStrictEqual(markers[0].data,{version:1,sourceKey:'task-recovery-initialized:'+actual.id,initialization}))denied('恢复初始化尚未完整记录或档案记录冲突');
 const initialCanonical=readCommittedCanonical(traceRoot,{...actual,canonical_workspace:initialization.initialHead}),currentCanonical=readCommittedCanonical(traceRoot,actual);
 const scopes=(await db.query('SELECT * FROM task_attempt_workspaces WHERE run_id=$1 ORDER BY task_id,attempt_id,generation LIMIT 4097',[actual.id])).rows;
 const operations=(await db.query('SELECT * FROM local_operations WHERE run_id=$1 ORDER BY created_at,id LIMIT 4097',[actual.id])).rows;
 if(scopes.length>4096||operations.length>4096)denied('恢复运行历史超出支持范围');
 if(currentCanonical.ref.mergeId===null){
  if(!isDeepStrictEqual(actual.canonical_workspace,initialization.initialHead)||operations.some(row=>row.merge_state==='committed'))denied('恢复初始成果与 SQL 初始化不同');
 }else{
  const chain=verifyRecoveryCommitChain(traceRoot,actual,scopes,operations,source.authority.backend);
  if(!isDeepStrictEqual(chain.initial.ref,initialCanonical.ref))denied('后续提交没有连接原恢复根');
 }
 const seedManifest=canonicalManifest(initialization.initialHead.manifest.filter(file=>initialization.readPaths.includes(file.path)));
 if(seedManifest.length!==initialization.readPaths.length||hash(seedManifest)!==initialization.checkpointWorkRevision)denied('恢复工作基线不能从固定根重建');
 const contract=snapshot.tasks?.find((task:any)=>task.id===cp.key.taskId);
 if(!contract)denied('恢复任务不在批准方案中');
 const selectedSeed={version:1 as const,initializationDigest:initialization.digest,sourceCheckpoint:cp,workRevision:initialization.checkpointWorkRevision};
 const seedOutputs=seedManifest.filter((file:any)=>initialization.writePaths.includes(file.path)&&!contract.inputs.some((input:any)=>input.path===file.path)).map((file:any)=>({...file,origin:{path:file.path,runId:cp.key.runId,taskId:cp.key.taskId,attemptId:cp.key.attemptId,acceptedRevision:selectedSeed.workRevision,checkpointId:cp.id}}));
 const retained:any[]=snapshot.handoffCheckpoints??[];
 const ids=new Set();
 for(const accepted of retained){
  const key=accepted.taskExecution?.key;
  if(!key||accepted.runId!==source.sourceRunId||key.runId!==accepted.runId||key.taskId!==accepted.taskId||key.attemptId!==accepted.attemptId||!Number.isSafeInteger(key.generation)||key.generation<1||ids.has(key.taskId)||key.taskId===cp.key.taskId)denied('保留验收的原始身份不完整或重复');
  ids.add(key.taskId);
  for(const file of [...(accepted.inputs??[]),...(accepted.outputs??[])]){const current=currentCanonical.ref.manifest.find(row=>row.path===file.path);if(!current||current.sha256!==file.sha256||current.size!==file.size)denied('已验收成果或固定输入已被改变');}
 }
 const completed=snapshot.completedCheckpoints,restored=snapshot.recovery.completed.map((task:any)=>task.taskId);
 if(completed.length!==ids.size||new Set(completed).size!==ids.size||completed.some((id:string)=>!ids.has(id))||restored.length!==ids.size||new Set(restored).size!==ids.size||restored.some((id:string)=>!ids.has(id)))denied('恢复团队完成状态与原验收不一致');
 return {initialization,initialCanonical,currentCanonical,retained,selectedSeed,seedOutputs};
}
