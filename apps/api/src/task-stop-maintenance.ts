import {createHash} from 'node:crypto';
import {isDeepStrictEqual as same} from 'node:util';
import type pg from 'pg';
import express from 'express';
import {taskStopMaintenanceSchema,taskStopKeySchema,taskStopReconcileInputSchema,type TaskStopMaintenanceV1,type TaskStopMaintenanceScope,type TaskStopMaintenanceReasonCode} from '../../../packages/contracts/task-stop-maintenance.ts';
import {decodeTaskAcceptedStop,type TaskAcceptedStopRecord} from './task-accepted-stop-state.ts';
import {checkpointContract,checkpointDigest,validateTaskCheckpointRefs} from '../../../services/agent-runtime/step-checkpoints.mjs';
import {acceptedVerificationRevision} from './handoff-checkpoints.ts';
import {readRun} from '../../../services/agent-runtime/trace-store.mjs';
import {assertAcceptanceChecks} from '../../../services/agent-runtime/acceptance-checks.mjs';
import {assertHandoffReport} from '../../../packages/contracts/handoff-report.mjs';
import {TaskAcceptedStopLifecycle} from './task-accepted-stop.ts';
import type {SandboxMaintenance} from './storage-lifecycle.ts';

export type TaskStopProjectionInput={run:any;rows:readonly any[];archive:any;operations?:readonly any[];rowsTruncated?:boolean};
const display=(runId:unknown,locator:unknown)=>createHash('sha256').update(JSON.stringify(['task-stop-maintenance-v1',taskStopKeySchema.shape.runId.safeParse(runId).success?runId:null,locator])).digest('hex');
const ordered=(v:any):any=>Array.isArray(v)?v.map(ordered):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().filter(k=>v[k]!==undefined).map(k=>[k,ordered(v[k])])):v;
const digest=(v:any)=>createHash('sha256').update(JSON.stringify(ordered(v))).digest('hex');
const keyOf=(row:any)=>taskStopKeySchema.safeParse({runId:row?.run_id,taskId:row?.task_id,attemptId:row?.attempt_id,generation:row?.generation});
const keyText=(key:any)=>JSON.stringify([key.runId,key.taskId,key.attemptId,key.generation]);
const uuid=taskStopReconcileInputSchema.shape.sandboxId,sha=taskStopReconcileInputSchema.shape.workspaceRevision;
const invalid=()=>{throw Error('TASK_STOP_EVIDENCE_INVALID');};
function pending(runId:unknown,reasonCode:TaskStopMaintenanceReasonCode,count=1):TaskStopMaintenanceV1{
 return {version:1,state:'pending',scopes:[{state:'unverified',displayKey:display(runId,'aggregate'),reasonCode,unresolvedCount:Math.max(1,Math.min(128,count)),canReconcile:false}]};
}
function unverified(runId:string,key:any,row:any,reasonCode:TaskStopMaintenanceReasonCode):TaskStopMaintenanceScope{
 return {state:'unverified',displayKey:display(runId,['scope',keyText(key)]),reasonCode,canReconcile:false,key,...(uuid.safeParse(row?.sandbox_identity?.sandboxId).success?{sandboxId:row.sandbox_identity.sandboxId}:{})};
}
function archiveValid(run:any,archive:any){
 try{return archive?.integrity==='ok'&&archive.id===run.id&&archive.snapshot?.projectId===run.project_id&&archive.snapshot.planVersion===run.project_version&&same(snapshotMetadata(archive.snapshot),snapshotMetadata(run.snapshot))&&Array.isArray(archive.events)&&archive.events.length>0&&archive.events.length<=100000&&archive.events.every((event:any,index:number)=>event?.seq===index+1&&boundedEvent(event))&&archive.events[0].type==='run/created'&&sha.safeParse(archive.events[0].data?.snapshotSha256).success;}catch{return false;}
}
function boundedEvent(event:any){
 if(event.type==='run/task-mapping')return Array.isArray(event.data?.tasks)&&event.data.tasks.length<=256;
 if(event.type==='team/checkpoint')return Array.isArray(event.data?.tasks)&&event.data.tasks.length<=256&&Array.isArray(event.data?.members)&&event.data.members.length<=64;
 if(event.type==='handoff/accepted')return Array.isArray(event.data?.commands)&&event.data.commands.length<=1024&&Array.isArray(event.data?.inputs)&&event.data.inputs.length<=128&&Array.isArray(event.data?.outputs)&&event.data.outputs.length<=128;
 return true;
}
function ambiguousNativeLocators(events:any[]){
 const mappings=new Map<string,string>(),text=taskStopKeySchema.shape.taskId;
 for(const event of events){
  if(event.type==='team/checkpoint')for(const items of [event.data.tasks,event.data.members]){
   if(items.some((item:any)=>!text.safeParse(item?.id).success)||new Set(items.map((item:any)=>item.id)).size!==items.length)return true;
  }
  if(event.type==='run/task-mapping'){
   const seen=new Set<string>();
   for(const item of event.data.tasks){
    if(!text.safeParse(item?.task_id).success||!text.safeParse(item?.seed_id).success||seen.has(item.task_id)||mappings.has(item.task_id)&&mappings.get(item.task_id)!==item.seed_id)return true;
    seen.add(item.task_id);mappings.set(item.task_id,item.seed_id);
   }
  }
 }
 return false;
}
function mappedNative(events:any[],taskId:string,cursor=Infinity){
 const mappings=new Map<string,string>();
 for(const event of events)if(event.seq<=cursor&&event.type==='run/task-mapping')for(const item of event.data.tasks)mappings.set(item.task_id,item.seed_id);
 let native:string|undefined;for(const [nativeId,approvedId] of mappings)if(approvedId===taskId)native=nativeId;
 return native;
}
function snapshotMetadata(snapshot:any){
 return {projectId:snapshot.projectId,planVersion:snapshot.planVersion,executionProfile:snapshot.executionProfile??'legacy-run-v1',executionTarget:snapshot.executionTarget??null,knowledge:snapshot.knowledge??null,agents:(snapshot.agents??[]).map((agent:any)=>({id:agent.id,tools:agent.tools})),tasks:(snapshot.tasks??[]).map((task:any)=>({id:task.id}))};
}
/** Metadata consistency is deliberately cheaper than the effect path's full object verification. */
function evidence(run:any,row:any,archive:any,operations:readonly any[],key:any,marker?:TaskAcceptedStopRecord){
 const events=archive.events,scope=row.scope_metadata,target=run.snapshot.executionTarget;
 if(!['active','retired','unknown'].includes(row.phase)||!uuid.safeParse(row.sandbox_identity?.sandboxId).success||typeof row.sandbox_identity.localWorkspace!=='string'||!row.sandbox_identity.localWorkspace||
  !['principal','session_id','runtime_task_id'].every(k=>typeof row[k]==='string'&&row[k].length>0&&row[k].length<=240)||!['contract_hash','permission_hash','capability_hash'].every(k=>sha.safeParse(row[k]).success)||
  !Array.isArray(run.snapshot.tasks)||run.snapshot.tasks.length>50||!run.snapshot.tasks.some((task:any)=>task.id===key.taskId)||row.contract?.id!==key.taskId||row.contract.assignee!==row.principal||checkpointContract(run.snapshot,row.contract)!==row.contract_hash||
  target?.kind!=='local'||!uuid.safeParse(target.deviceId).success||!uuid.safeParse(target.grantId).success||target.backend?.kind!=='openshell'||!sha.safeParse(target.backend.fingerprint).success||
  scope?.profile!=='task-attempt-openshell-v1'||!same(scope.key,key)||scope.capabilityHash!==row.capability_hash||!same(scope.inputOrigins,row.input_origins))invalid();
 const binding=scope.workspace?.binding;
 if(!binding||binding.projectId!==run.project_id||binding.planVersion!==run.project_version||binding.runId!==key.runId||binding.taskId!==key.taskId||binding.attemptId!==key.attemptId||binding.generation!==key.generation||binding.assigneeId!==row.principal||binding.contractHash!==row.contract_hash||binding.permissionHash!==row.permission_hash)invalid();
 const accepts=events.filter((event:any)=>event.type==='handoff/accepted'&&same(event.data?.taskExecution?.key,key));
 if(accepts.length!==1)invalid();const acceptedEvent=accepts[0],accepted=acceptedEvent.data;
 if(accepted.taskId!==key.taskId||accepted.attemptId!==key.attemptId||accepted.taskExecution.capabilityHash!==row.capability_hash)invalid();
 const workspaceRevision=acceptedVerificationRevision({...run.snapshot,id:run.id},accepted,key.taskId,key.attemptId);
 const checkpoints=events.filter((event:any)=>event.type==='step/checkpoint'&&event.data?.version===2&&same(event.data.key,key)&&event.data.boundary?.trigger==='node-accepted'&&event.seq>acceptedEvent.seq);
 if(checkpoints.length!==1)invalid();const checkpointEvent=checkpoints[0],cp=checkpointEvent.data;
 const {sha256:recordHash,...metadata}=cp;
 const {id,version,runId:checkpointRun,boundary,files,receipts,sha256,...refs}=cp;
 if(!uuid.safeParse(id).success||checkpointRun!==run.id||recordHash!==checkpointDigest(metadata)||!same(files,refs.workManifest)||!Array.isArray(receipts)||receipts.length>1024)invalid();
 validateTaskCheckpointRefs(refs,{runId:run.id,taskId:key.taskId,attemptId:key.attemptId});
 const boundaryEvent=events[boundary.eventCursor-1];
 if(boundary.taskId!==key.taskId||boundary.attemptId!==key.attemptId||boundary.sessionId!==row.session_id||boundary.contractHash!==checkpointContract(run.snapshot,row.contract,refs)||!sha.safeParse(boundary.environment).success||
  boundaryEvent?.type!=='step/boundary'||boundaryEvent.taskId!==key.taskId||boundaryEvent.attemptId!==key.attemptId||boundaryEvent.sessionId!==row.session_id||boundaryEvent.data?.taskId!==key.taskId||boundaryEvent.data.attemptId!==key.attemptId||boundaryEvent.data.trigger!=='node-accepted'||!(acceptedEvent.seq<boundaryEvent.seq&&boundaryEvent.seq<checkpointEvent.seq))invalid();
 const native=mappedNative(events,key.taskId,checkpointEvent.seq);
 if(native!==row.runtime_task_id||!events.some((event:any)=>event.seq>checkpointEvent.seq&&event.type==='team/checkpoint'&&event.data?.tasks?.some((task:any)=>task.id===native&&task.assignee===row.principal&&task.attemptId===key.attemptId&&task.status==='completed')&&event.data?.members?.some((member:any)=>member.id===row.session_id&&member.name===row.principal&&member.status!=='removed')))invalid();
 if(workspaceRevision!==checkpointDigest(refs.workManifest)||refs.canonical.revision!==accepted.workspaceRevision||scope.workRevision!==refs.canonical.revision||refs.scopeHash!==scope.workspace.scopeHash||refs.capabilityHash!==row.capability_hash||!same(refs.inputOrigins,row.input_origins)||!same(refs.inputManifest,scope.workspace.inputManifest)||!refs.lastMerge)invalid();
 for(const command of row.contract.verify??[]){const actual=accepted.commands.findLast((entry:any)=>entry.command===command),exit=row.contract.acceptanceChecks?.find((entry:any)=>entry.command===command)?.expectedExitCode??0;if(!actual||actual.exitCode!==exit||actual.workspaceRevision!==workspaceRevision)invalid();}
 if(row.contract.acceptanceChecks!==undefined&&!same(assertAcceptanceChecks(row.contract,accepted.commands,workspaceRevision),accepted.acceptanceChecks))invalid();
 assertHandoffReport(row.contract,accepted.employeeReport);
 if(!same(accepted.outputs.map((file:any)=>file.path).sort(),(row.contract.outputs??[]).map((file:any)=>file.path).sort())||accepted.inputs.length!==refs.inputOrigins.length)invalid();
 for(const output of accepted.outputs){const file=refs.workManifest.find((entry:any)=>entry.path===output.path);if(!file||file.sha256!==output.sha256||file.size!==output.size)invalid();}
 for(const input of refs.inputOrigins){const seal=accepted.inputs.find((entry:any)=>entry.path===input.path),file=refs.inputManifest.find((entry:any)=>entry.path===input.path);if(!seal||seal.sha256!==input.sha256||seal.size!==file?.size)invalid();}
 const original=operations.filter((operation:any)=>operation.id===refs.lastMerge.operationId);
 const commits=Array.isArray(row.committed_receipts)?row.committed_receipts.filter((commit:any)=>commit.receipt?.operationId===refs.lastMerge.operationId):[];
 if(original.length!==1||commits.length!==1)invalid();const operation=original[0],commit=commits[0],receipt=refs.lastMerge;
 if(operation.run_id!==run.id||operation.device_id!==target.deviceId||operation.grant_id!==target.grantId||operation.status!=='completed'||operation.started!==true||operation.claim_bound!==true||operation.result_ok!==true||operation.merge_state!=='committed'||
  !same(operation.scope_key,key)||operation.scope_hash!==receipt.scopeHash||operation.workspace_revision!==workspaceRevision||operation.sandbox_id!==row.sandbox_identity.sandboxId||operation.local_workspace!==row.sandbox_identity.localWorkspace||!sha.safeParse(operation.merge_digest).success||!same(operation.merge_receipt,receipt)||
  !sha.safeParse(operation.before_work_revision).success||!same(operation.task_execution,{profile:refs.profile,key,scopeHash:receipt.scopeHash,operationId:operation.id,beforeWorkRevision:operation.before_work_revision,afterWorkRevision:workspaceRevision})||commit.scope?.workRevision!==receipt.beforeRevision||
  !same(commit.receipt,{profile:refs.profile,key,scopeHash:receipt.scopeHash,operationId:operation.id,beforeWorkRevision:receipt.beforeRevision,afterWorkRevision:receipt.afterRevision})||commit.scope?.profile!==refs.profile||!same(commit.scope.key,key)||commit.scope.capabilityHash!==row.capability_hash||!same(commit.scope.inputOrigins,row.input_origins))invalid();
 if(marker){const {identity,proof}=marker;
  if(!same(identity.key,key)||identity.sandboxId!==row.sandbox_identity.sandboxId||identity.workspaceRevision!==workspaceRevision||proof.runtimeTaskId!==row.runtime_task_id||proof.principal!==row.principal||proof.sessionId!==row.session_id||proof.contractHash!==row.contract_hash||proof.permissionHash!==row.permission_hash||proof.capabilityHash!==row.capability_hash||proof.deviceId!==target.deviceId||proof.grantId!==target.grantId||proof.fingerprint!==target.backend.fingerprint||
   proof.accepted.seq!==acceptedEvent.seq||proof.accepted.digest!==digest(acceptedEvent)||proof.checkpoint.id!==cp.id||proof.checkpoint.sha256!==cp.sha256||proof.checkpoint.seq!==checkpointEvent.seq||proof.originalOperationId!==operation.id||proof.originalMergeDigest!==operation.merge_digest)invalid();
 }
 return workspaceRevision;
}

/** Read-only metadata projection. It does not establish device facts or grant effects. */
export function projectTaskStopMaintenance({run,rows,archive,operations=[],rowsTruncated=false}:TaskStopProjectionInput):TaskStopMaintenanceV1{
 if(run?.snapshot&&(run.snapshot.executionProfile??'legacy-run-v1')==='legacy-run-v1')return taskStopMaintenanceSchema.parse({version:1,state:'not-applicable',scopes:[]});
 if(!taskStopKeySchema.shape.runId.safeParse(run?.id).success||run.snapshot.executionProfile!=='task-attempt-openshell-v1')return pending(run?.id,'TASK_STOP_UNVERIFIED',rows.length);
 if(rowsTruncated||rows.length>128||operations.length>1024||archive?.events?.length>100000||run.snapshot.tasks?.length>50)return pending(run.id,'TASK_STOP_LIMIT',rows.length);
 const keys=rows.map(row=>keyOf(row));
 if(keys.some(parsed=>!parsed.success||parsed.data.runId!==run.id))return pending(run.id,'TASK_STOP_IDENTITY_INVALID',rows.length);
 if(new Set(keys.map(parsed=>parsed.success&&keyText(parsed.data))).size!==rows.length)return pending(run.id,'TASK_STOP_AMBIGUOUS',rows.length);
 const validArchive=archiveValid(run,archive),accepts=validArchive?archive.events.filter((event:any)=>event.type==='handoff/accepted'):[];
 if(validArchive&&ambiguousNativeLocators(archive.events))return pending(run.id,'TASK_STOP_AMBIGUOUS',rows.length);
 if(accepts.length>128)return pending(run.id,'TASK_STOP_LIMIT',accepts.length);
 const acceptedKeys=accepts.map((event:any)=>taskStopKeySchema.safeParse(event.data?.taskExecution?.key));
 if(acceptedKeys.some((parsed:any)=>!parsed.success||parsed.data.runId!==run.id)||new Set(acceptedKeys.map((parsed:any)=>parsed.success&&keyText(parsed.data))).size!==accepts.length)return pending(run.id,'TASK_STOP_AMBIGUOUS',accepts.length);
 const approved=Array.isArray(run.snapshot.tasks)?run.snapshot.tasks:[];
 if(approved.some((task:any)=>!taskStopKeySchema.shape.taskId.safeParse(task?.id).success)||new Set(approved.map((task:any)=>task.id)).size!==approved.length)return pending(run.id,'TASK_STOP_AMBIGUOUS',approved.length);
 if(!rows.length&&!validArchive)return pending(run.id,'TASK_STOP_ARCHIVE_UNAVAILABLE');
 const scopes:TaskStopMaintenanceScope[]=rows.map(row=>{
  const parsed=keyOf(row);if(!parsed.success)return pending(run.id,'TASK_STOP_IDENTITY_INVALID').scopes[0];
  const key=parsed.data;if(!validArchive)return unverified(run.id,key,row,'TASK_STOP_ARCHIVE_UNAVAILABLE');
  let marker:TaskAcceptedStopRecord|undefined;
  try{if(row.accepted_stop!==null)marker=decodeTaskAcceptedStop(row.accepted_stop);}catch{return unverified(run.id,key,row,'TASK_STOP_MARKER_INVALID');}
  try{
   const workspaceRevision=evidence(run,row,archive,operations,key,marker);
   const current=mappedNative(archive.events,key.taskId);
   const historical=row.phase==='retired'||current!==row.runtime_task_id;
   return {key,sandboxId:row.sandbox_identity.sandboxId,workspaceRevision,state:marker?.state??'no-intent',...(marker?{stopId:marker.identity.stopId}:{}),...(marker?.state==='stopped'?{}:{reasonCode:marker?({prepared:'TASK_STOP_PREPARED',dispatching:'TASK_STOP_DISPATCHING',unknown:'TASK_STOP_UNKNOWN'} as const)[marker.state]:historical?'TASK_STOP_SCOPE_RETIRED':'TASK_STOP_NO_INTENT'}),canReconcile:!!marker&&marker.state!=='stopped'};
  }catch{return unverified(run.id,key,row,'TASK_STOP_EVIDENCE_INVALID');}
 });
 const present=new Set(keys.map(parsed=>parsed.success&&keyText(parsed.data))),missingAccepted:Array<{taskId:string;attemptId:string;native:string|undefined}>=[];
 for(let index=0;index<acceptedKeys.length;index++){
  const parsed=acceptedKeys[index];
  if(parsed.success&&!present.has(keyText(parsed.data))){scopes.push(unverified(run.id,parsed.data,undefined,'TASK_STOP_SCOPE_MISSING'));missingAccepted.push({taskId:parsed.data.taskId,attemptId:parsed.data.attemptId,native:mappedNative(archive.events,parsed.data.taskId,accepts[index].seq)});}
 }
 for(const task of approved){
  const native=validArchive?mappedNative(archive.events,task.id):undefined;
  const current=validArchive?archive.events.findLast((event:any)=>event.type==='team/checkpoint')?.data.tasks?.find((item:any)=>item.id===native):undefined;
  const represented=native!==undefined&&current?.attemptId!==undefined&&missingAccepted.some(locator=>locator.taskId===task.id&&locator.native===native&&locator.attemptId===current.attemptId);
  if(!represented&&!rows.some(row=>row.task_id===task.id&&row.phase==='active'&&row.runtime_task_id===native&&row.attempt_id===current?.attemptId))scopes.push({state:'unverified',displayKey:display(run.id,['approved',task.id]),reasonCode:'TASK_STOP_SCOPE_MISSING',canReconcile:false});
 }
 if(scopes.length>128)return pending(run.id,'TASK_STOP_LIMIT',scopes.length);
 if(!scopes.length)return pending(run.id,'TASK_STOP_SCOPE_MISSING');
 return taskStopMaintenanceSchema.parse({version:1,state:scopes.every(scope=>scope.state==='stopped')?'stopped':'pending',scopes});
}

/** Trusted in-process reader injection only; HTTP supplies no archive, proof or callback. */
export async function readTaskStopMaintenance({db,traceRoot,runId,readArchive=readRun}:{db:Pick<pg.PoolClient,'query'>;traceRoot:string;runId:string;readArchive?:(root:string,id:string)=>any}):Promise<TaskStopMaintenanceV1>{
 if(!taskStopKeySchema.shape.runId.safeParse(runId).success)return pending(undefined,'TASK_STOP_IDENTITY_INVALID');
 try{
  const run=(await db.query(`SELECT id,project_id,project_version,jsonb_build_object(
   'projectId',snapshot->'projectId','planVersion',snapshot->'planVersion','executionProfile',snapshot->'executionProfile',
   'executionTarget',snapshot->'executionTarget','knowledge',snapshot->'knowledge',
   'agents',(SELECT jsonb_agg(jsonb_build_object('id',agent->'id','tools',agent->'tools')) FROM (SELECT agent FROM jsonb_array_elements(snapshot->'agents') agent LIMIT 7) bounded_agents),
   'tasks',(SELECT jsonb_agg(jsonb_build_object('id',task->'id')) FROM (SELECT task FROM jsonb_array_elements(snapshot->'tasks') task LIMIT 51) bounded_tasks)
  ) AS snapshot FROM project_runs WHERE id=$1`,[runId])).rows[0];
  if(!run)return pending(runId,'TASK_STOP_SCOPE_MISSING');
  if((run.snapshot.executionProfile??'legacy-run-v1')==='legacy-run-v1')return projectTaskStopMaintenance({run,rows:[],archive:null});
  const rows=(await db.query(`SELECT run_id,task_id,attempt_id,generation,principal,session_id,runtime_task_id,
   contract_hash,permission_hash,capability_hash,contract,input_origins,sandbox_identity,phase,accepted_stop,
   jsonb_build_object('profile',scope->'profile','key',scope->'key','workRevision',scope->'workRevision',
    'capabilityHash',scope->'capabilityHash','inputOrigins',scope->'inputOrigins',
    'workspace',jsonb_build_object('binding',scope->'workspace'->'binding','scopeHash',scope->'workspace'->'scopeHash','inputManifest',scope->'workspace'->'inputManifest')) AS scope_metadata,
   (SELECT jsonb_agg(jsonb_build_object('receipt',item->'receipt','scope',jsonb_build_object(
    'profile',item->'scope'->'profile','key',item->'scope'->'key','workRevision',item->'scope'->'workRevision',
    'capabilityHash',item->'scope'->'capabilityHash','inputOrigins',item->'scope'->'inputOrigins')))
    FROM (SELECT item FROM jsonb_array_elements(committed_outputs) item LIMIT 1025) bounded_commits) AS committed_receipts
   FROM task_attempt_workspaces WHERE run_id=$1 ORDER BY task_id,attempt_id,generation LIMIT 129`,[runId])).rows;
  if(rows.length>128)return pending(runId,'TASK_STOP_LIMIT',rows.length);
  let archive:any=null;try{archive=readArchive(traceRoot,runId);}catch{}
  if(archive?.events?.length>100000)return pending(runId,'TASK_STOP_LIMIT',rows.length);
  const ids=new Set<string>();
  for(const row of rows)if(uuid.safeParse(row.accepted_stop?.proof?.originalOperationId).success)ids.add(row.accepted_stop.proof.originalOperationId);
  for(const event of Array.isArray(archive?.events)?archive.events:[])if(event.type==='step/checkpoint'&&event.data?.boundary?.trigger==='node-accepted'&&uuid.safeParse(event.data?.lastMerge?.operationId).success)ids.add(event.data.lastMerge.operationId);
  if(ids.size>1024||rows.some(row=>row.committed_receipts?.length>1024))return pending(runId,'TASK_STOP_LIMIT',ids.size);
  const operations=ids.size?(await db.query(`SELECT id,run_id,device_id,grant_id,status,started,
   (claim_token IS NOT NULL AND result->>'claimToken'=claim_token) AS claim_bound,result->'ok' AS result_ok,merge_state,
   payload->'taskScope'->'key' AS scope_key,payload->'taskScope'->'workspace'->>'scopeHash' AS scope_hash,
   payload->'executionScope'->>'expectedWorkRevision' AS before_work_revision,
   result->'result'->>'workspaceRevision' AS workspace_revision,result->'result'->'execution'->>'sandboxId' AS sandbox_id,
   result->'result'->>'localWorkspace' AS local_workspace,merge_record->>'digest' AS merge_digest,
   merge_record->'receipt' AS merge_receipt,result->'result'->'taskExecution' AS task_execution
   FROM local_operations WHERE run_id=$1 AND id=ANY($2::text[]) ORDER BY id LIMIT 1025`,[runId,[...ids].sort()])).rows:[];
  return projectTaskStopMaintenance({run,rows,archive,operations});
 }catch{return pending(runId,'TASK_STOP_UNVERIFIED');}
}

/** Mounted only behind the existing admin authentication and CSRF gates. */
export function taskStopMaintenanceRouter(traceRoot:string,service:{traceRoot:string;owner:string},provider?:()=>SandboxMaintenance|undefined){
 const router=express.Router();
 router.post('/runs/:id/task-stops/reconcile',async(req,res)=>{
  const parsed=taskStopReconcileInputSchema.safeParse(req.body);
  if(!parsed.success||!taskStopKeySchema.shape.runId.safeParse(req.params.id).success)return res.status(422).json({code:'VALIDATION_ERROR',message:'原停止请求格式不正确'});
  if(parsed.data.key.runId!==req.params.id)return res.status(409).json({code:'TASK_STOP_IDENTITY_MISMATCH',message:'原停止请求与运行身份不同'});
  const controller=new AbortController(),abort=()=>controller.abort(),closed=()=>{if(!res.writableEnded)abort();};
  req.once('aborted',abort);res.once('close',closed);if(req.aborted)abort();
  try{
   await new TaskAcceptedStopLifecycle(parsed.data.key.runId,service,provider).reconcileExact(parsed.data,controller.signal);
   const {pool}=await import('./db.ts');
   const maintenance=await readTaskStopMaintenance({db:pool,traceRoot,runId:parsed.data.key.runId});
   return res.json({maintenance,replayed:false});
  }catch(error){
   const code=(error as {code?:unknown})?.code;
   if(code==='TASK_STOP_RECONCILIATION_REQUIRED')return res.status(409).json({code,message:'没有可核对的原停止记录'});
   if(code==='TASK_STOP_IDENTITY_MISMATCH')return res.status(409).json({code,message:'原停止请求与持久身份不同'});
   if(code==='TASK_STOP_UNAVAILABLE')return res.status(409).json({code,message:'原停止维护尚未连接可信执行器'});
   return res.status(409).json({code:'TASK_ACCEPTED_STOP_UNRESOLVED',message:'原停止事实尚未取得可验证的回执',reasonCode:'TASK_STOP_UNKNOWN'});
  }finally{req.removeListener('aborted',abort);res.removeListener('close',closed);}
 });
 return router;
}
