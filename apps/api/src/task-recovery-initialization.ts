import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {join} from 'node:path';
import {existsSync} from 'node:fs';
import {createRequire} from 'node:module';
import type {ArchiveWriterManager} from '../../../services/agent-runtime/archive-writer-scope.mjs';
import {createRunArchive,openRunArchive,readRun,redact} from '../../../services/agent-runtime/trace-store.mjs';
import {assertArchivePlain,storeArchiveObjects,readArchiveObject} from '../../../services/agent-runtime/archive-objects.mjs';
import {readCommittedCanonical,materializeCommittedCanonical} from './task-canonical.ts';
import {verifyRecoveryCommitChain} from './task-recovery-provenance.ts';
import {withTaskRecoverySourceTransaction,captureTaskRecoverySourceIn,isTaskRecoveryCommitUnknown,type TaskRecoveryLocator} from './task-recovery-source.ts';
import {decodeTaskRecoveryInitialization,decodeTaskRecoveryEvidence,taskRecoveryApprovalDigest,taskRecoveryInitializationDigest,type TaskRecoveryInitialization} from './task-recovery-state.ts';
import {AppError} from './provider.ts';

const {canonicalManifest}=createRequire(import.meta.url)('../../desktop/local-executor.cjs');
type Facts=Awaited<ReturnType<typeof captureTaskRecoverySourceIn>>;
export type TaskRecoveryInitializationFault=(point:'blob-fsync'|'before-sql-commit'|'after-sql-commit'|'archive-append'|'cache-mirror')=>void;
const denied=(message:string,code='TASK_RECOVERY_INITIALIZATION_INVALID'):never=>{throw new AppError(409,message,code);};

function expectedInitialization(input:TaskRecoveryLocator,facts:Facts):TaskRecoveryInitialization{
 const candidate=facts.scope.candidate;
 const unsigned={version:1 as const,childRunId:input.childRunId,source:facts.source,approvalDigest:taskRecoveryApprovalDigest(facts.source),
  readPaths:facts.scope.currentScope.workspace.readPaths,writePaths:facts.scope.currentScope.workspace.writePaths,
  checkpointWorkRevision:createHash('sha256').update(JSON.stringify(canonicalManifest(facts.selected.refs.workManifest))).digest('hex'),
  plannerScopeHash:facts.scope.currentScope.workspace.scopeHash,
  delta:candidate.delta.map(({path,beforeSha256,afterSha256,size})=>({path,beforeSha256,afterSha256,size})),
  initialHead:{version:1 as const,revision:candidate.revision,manifest:candidate.manifest,mergeId:null,receipt:null}};
 return decodeTaskRecoveryInitialization({...unsigned,digest:taskRecoveryInitializationDigest(unsigned)});
}

function childArchive(writers:ArchiveWriterManager,facts:Facts){
 const child=facts.child,dir=join(writers.traceRoot,child.id);writers.assertWriter(child.id);
 if(!existsSync(dir))createRunArchive(writers.traceRoot,child.snapshot,{id:child.id});
 assertArchivePlain(dir,'directory');const stat=assertArchivePlain(join(dir,'snapshot.json'),'file');
 if(stat.size>8*1024*1024)denied('目标档案快照过大');
 const archived=readRun(writers.traceRoot,child.id),snapshot:any=archived?.snapshot;
 if(!archived||archived.integrity!=='ok'||!snapshot||snapshot.id!==child.id||snapshot.formatVersion!==1||!Number.isFinite(Date.parse(snapshot.createdAt))||
  !isDeepStrictEqual(snapshot,{...(redact(child.snapshot) as Record<string,unknown>),id:child.id,createdAt:snapshot.createdAt,formatVersion:1})||
  archived.events.filter(event=>event.type==='run/created').length!==1||archived.events[0]?.type!=='run/created')denied('目标档案与已批准 SQL 快照不同');
 return archived!;
}

/** The stored marker authenticates the starting point only after the original
 * source has been recaptured. An advanced head must prove its own live chain. */
function currentChild(writers:ArchiveWriterManager,facts:Facts,initialization:TaskRecoveryInitialization){
 const child=facts.child,actual=decodeTaskRecoveryEvidence(JSON.parse(child.task_evidence_text)).recoveryInitialization;
 if(!actual||!isDeepStrictEqual(actual,initialization))denied('目标初始化记录与完整来源批准不同');
 const current=readCommittedCanonical(writers.traceRoot,child);
 if(current.ref.mergeId===null){
  if(!isDeepStrictEqual(child.canonical_workspace,initialization.initialHead)||facts.childOperations.some(row=>row.merge_state==='committed'))denied('目标初始 head 与恢复记录不一致');
 }else{
  const chain=verifyRecoveryCommitChain(writers.traceRoot,child,facts.childScopes,facts.childOperations,initialization.source.authority.backend);
  const {version,receipt,...initialRef}=initialization.initialHead;
  if(!isDeepStrictEqual(chain.initial.ref,initialRef))denied('目标后续提交没有连接到原初始化版本');
 }
 return current;
}

/** Private server entry. It never enqueues or replays employee/tool/model work.
 * The original source is read-only for the entire copy / SQL publication window. */
export async function initializeLiveTaskRecovery(writers:ArchiveWriterManager,input:TaskRecoveryLocator,signal:AbortSignal,fault?:TaskRecoveryInitializationFault){
 let published=false,copied=false;
 const outcome=await writers.withRecoverySource(input.sourceRunId,input.childRunId,async()=>{
  writers.assertWriter(input.childRunId);
  type Result={initialization:TaskRecoveryInitialization;currentHead:ReturnType<typeof readCommittedCanonical>['ref'];existing:boolean};
  let value:Result;
  try{
   value=await withTaskRecoverySourceTransaction(writers,input,signal,async(facts,db)=>{
    const initialization=expectedInitialization(input,facts);childArchive(writers,facts);
    if(facts.initialized){const current=currentChild(writers,facts,initialization);return {initialization,currentHead:current.ref,existing:true};}
    copied=true;
    storeArchiveObjects(join(writers.traceRoot,input.childRunId),facts.scope.candidate.files.map(file=>{
     const content=Buffer.from(file.content,'base64');return {sha256:createHash('sha256').update(content).digest('hex'),size:content.length,content};
    }),{afterFsync:()=>fault?.('blob-fsync')});
    for(const entry of initialization.initialHead.manifest)readArchiveObject(join(writers.traceRoot,input.childRunId,'checkpoint-objects'),entry);
    // All source SQL/archive/permission pins are re-read in the same guarded
    // transaction after physical copy, rather than trusting an earlier result.
    const after=await captureTaskRecoverySourceIn(writers,input,db,signal);
    if(!isDeepStrictEqual(after.source,facts.source)||!isDeepStrictEqual(expectedInitialization(input,after),initialization)||after.child.task_evidence_text!==facts.child.task_evidence_text)denied('复制后来源、权限或目标已变化');
    signal.throwIfAborted();fault?.('before-sql-commit');
    const evidence={version:1,recoveryInitialization:initialization,sourceHistory:null};
    const changed=await db.query('UPDATE project_runs SET canonical_workspace=$1,task_evidence=$2 WHERE id=$3 AND canonical_workspace IS NULL AND task_evidence IS NOT DISTINCT FROM $4::jsonb RETURNING id',[initialization.initialHead,evidence,input.childRunId,facts.child.task_evidence_text]);
    if(changed.rowCount!==1)denied('目标初始化 CAS 冲突');
    const {version,receipt,...ref}=initialization.initialHead;return {initialization,currentHead:ref,existing:false};
   });
   published=true;
  }catch(error){
   if(!isTaskRecoveryCommitUnknown(error)){
    // Validation before any object write is a known harmless refusal. Physical
    // writer failures still latch in the registered archive mutation helpers.
    if(!copied)return {ok:false as const,error};
    throw error;
   }
   // COMMIT outcome unknown: discard was already performed by the original
   // transaction. Only observe on a new connection; never repeat the UPDATE.
   value=await withTaskRecoverySourceTransaction(writers,input,signal,async facts=>{
    if(!facts.initialized)denied('提交应答丢失，独立核对未见初始化；保留现场，不自动重放','TASK_RECOVERY_COMMIT_UNCONFIRMED');
    const initialization=expectedInitialization(input,facts),current=currentChild(writers,facts,initialization);
    return {initialization,currentHead:current.ref,existing:true};
   });published=true;
  }
  try{
   fault?.('after-sql-commit');
   // Re-read the authoritative current head before repairing cache. This never
   // mirrors initialHead after the child has advanced.
   await withTaskRecoverySourceTransaction(writers,input,signal,async facts=>{
    const current=currentChild(writers,facts,value.initialization),archive=childArchive(writers,facts);
    const sourceKey='task-recovery-initialized:'+input.childRunId,data={version:1,sourceKey,initialization:value.initialization};
    const events=archive.events.filter(event=>event.type==='task/recovery-initialized'&&event.data.sourceKey===sourceKey);
    if(events.length>1||events.some(event=>!isDeepStrictEqual(event.data,data)))denied('目标初始化事件与原 SQL 记录冲突');
    if(!events.length){fault?.('archive-append');openRunArchive(writers.traceRoot,input.childRunId).append('task/recovery-initialized',data);}
    fault?.('cache-mirror');materializeCommittedCanonical({traceRoot:writers.traceRoot,writers},facts.child);
    value.currentHead=current.ref;
   });
  }catch(error){
   // Publication is durable. A known post-commit reporting failure is returned
   // without reinitializing; native mutation failures still keep their latch.
   if(published){writers.assertWriter(input.childRunId);return {ok:false as const,error};}throw error;
  }
  return {ok:true as const,value};
 },{signal});
 if(!outcome.ok)throw outcome.error;return outcome.value;
}
