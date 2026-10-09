import {createHash} from 'node:crypto';
import {statSync} from 'node:fs';
import {resolve} from 'node:path';
import {Router} from 'express';
import {z} from 'zod';
import {AppError} from './provider.ts';
import {completedTasks} from './handoff-checkpoints.ts';
import {readRun,redact} from '../../../services/agent-runtime/trace-store.mjs';
import {nodeTestCounts} from '../../../services/agent-runtime/run-evidence.mjs';
import {canonicalEvidence,handoffSealValue,sameHandoffSeal,type RunLineageEvidence,type RecoveredReceipt} from '../../../packages/contracts/run-lineage-evidence.ts';

type Database={query:(sql:string,args?:any[])=>Promise<{rows:any[]}>};
type Loaders={run:(id:string)=>any;operations:(runId:string,ids:string[])=>Promise<any[]>};
const MAX_DEPTH=16,MAX_TASKS=200,MAX_COMMANDS=200,MAX_OUTPUT_BYTES=256*1024;
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const attempt=(value:any)=>value?.attemptId??value?.attempt_id;
const contracts=(run:any)=>run.snapshot.approvedTasks??run.snapshot.tasks??[];
const assert=(value:any,code:string)=>{if(!value)throw Error(code);};
const messages:Record<string,string>={LINEAGE_INVALID:'恢复来源链缺失、循环、超限或版本不一致，不能沿用未核对证据。',
 SEAL_INVALID:'恢复任务的原始宿主交接凭据未能完整核对。',COMMAND_UNAVAILABLE:'历史测试的操作关联或完整输出未能核对；原始运行记录保留。'};

/** Read-only ancestry proof. Follow only sealed recovery links; never search by
 * title, follow a receipt into an unrelated run, or promote summary prose. */
export async function collectRunLineageEvidence(current:any,load:Loaders):Promise<RunLineageEvidence>{
 const response:RunLineageEvidence={version:1,runId:current.id,projectId:current.snapshot?.projectId,planVersion:current.snapshot?.planVersion,
  sourceRunId:current.snapshot?.recovery?.sourceRunId??null,status:'none',receipts:[],tests:[],issues:[]};
 const recovery=current.snapshot?.recovery;
 if(!recovery)return response;
 const runs:any[]=[current],seen=new Set([current.id]);
 try{
  assert(current.integrity==='ok'&&recovery.version===1&&typeof response.projectId==='string'&&Number.isSafeInteger(response.planVersion),'LINEAGE_INVALID');
  const approved=contracts(current);assert(approved.length>0&&approved.length<=MAX_TASKS&&new Set(approved.map((t:any)=>t.id)).size===approved.length,'LINEAGE_INVALID');
  let next=recovery.sourceRunId;
  while(next){
   assert(z.uuid().safeParse(next).success&&!seen.has(next)&&runs.length<=MAX_DEPTH,'LINEAGE_INVALID');seen.add(next);
   const source=load.run(next);
   assert(source&&source.id===next&&source.integrity==='ok'&&source.snapshot.projectId===response.projectId&&source.snapshot.planVersion===response.planVersion&&
    canonicalEvidence(contracts(source))===canonicalEvidence(approved),'LINEAGE_INVALID');
   runs.push(source);assert(!source.snapshot.recovery||source.snapshot.recovery.version===1,'LINEAGE_INVALID');next=source.snapshot.recovery?.sourceRunId;
  }
 }catch{response.status='unavailable';response.issues.push({code:'LINEAGE_INVALID',message:messages.LINEAGE_INVALID});return response;}
 const completed=recovery.completed;
 if(!Array.isArray(completed)||completed.length>MAX_TASKS||new Set(completed.map((t:any)=>t.taskId)).size!==completed.length){response.status='unavailable';response.issues.push({code:'SEAL_INVALID',message:messages.SEAL_INVALID});return response;}
 let commandCount=0;
 for(const done of completed){
  let proof:RecoveredReceipt,source:any;
  try{
   const id=done.taskId,contract=contracts(current).find((task:any)=>task.id===id),seals=current.snapshot.handoffCheckpoints?.filter((seal:any)=>seal.taskId===id&&seal.attemptId===attempt(done))??[];
   assert(contract&&typeof attempt(done)==='string'&&seals.length===1,'SEAL_INVALID');const seal=seals[0];
   const sourceIndex=runs.findIndex(run=>run.id===seal.runId);assert(sourceIndex>0,'SEAL_INVALID');source=runs[sourceIndex];
   for(const inherited of runs.slice(0,sourceIndex)){
    const carried=inherited.snapshot.recovery?.completed?.filter((task:any)=>task.taskId===id&&attempt(task)===attempt(done))??[];
    const records=inherited.snapshot.handoffCheckpoints?.filter((entry:any)=>entry.taskId===id&&entry.attemptId===attempt(done))??[];
    assert(carried.length===1&&records.length===1&&sameHandoffSeal(records[0],seal),'SEAL_INVALID');
    assert(Array.isArray(seal.outputs)&&seal.outputs.every((output:any)=>inherited.snapshot.recovery.files?.some((file:any)=>file.state==='accepted'&&file.producerTaskId===id&&file.path===output.path&&file.sha256===output.sha256&&file.size===output.size)),'SEAL_INVALID');
   }
   const state=completedTasks(source.events,source.snapshot).get(id);
   assert(state&&attempt(state)===attempt(done),'SEAL_INVALID');
   const original=source.events.filter((event:any)=>event.type==='handoff/accepted'&&event.data.runId===source.id&&event.data.taskId===id&&event.data.attemptId===attempt(done));
   assert(original.length===1&&sameHandoffSeal(original[0].data,seal),'SEAL_INVALID');
   const arrays=['inputs','outputs'];
   for(const key of arrays){
    const declared=contract[key]??[],observed=seal[key];
    assert(Array.isArray(observed)&&observed.length===declared.length&&new Set(observed.map((file:any)=>file.path)).size===observed.length&&
     declared.every((file:any)=>observed.some((actual:any)=>actual.path===file.path&&/^[a-f0-9]{64}$/i.test(actual.sha256??'')&&Number.isSafeInteger(actual.size)&&actual.size>=0&&(!file.sha256||file.sha256===actual.sha256))),'SEAL_INVALID');
   }
   proof={taskId:id,attemptId:attempt(done),sourceRunId:source.id,acceptanceSeq:original[0].seq,receipt:handoffSealValue(original[0].data)};
   response.receipts.push(proof);
  }catch{response.issues.push({taskId:done.taskId,code:'SEAL_INVALID',message:messages.SEAL_INVALID});continue;}
  // Only accepted attempt observations enter the inherited test list. Unknown,
  // cancelled or late operations cannot be substituted for a completed receipt.
  const commands=proof.receipt.commands??[];
  if(!Array.isArray(commands)||commands.length>MAX_COMMANDS){response.issues.push({taskId:proof.taskId,code:'COMMAND_UNAVAILABLE',message:messages.COMMAND_UNAVAILABLE});continue;}
  for(const command of commands){
   if(command.evidence?.tool!=='terminal_test')continue;
   if(commandCount>=MAX_COMMANDS){response.issues.push({taskId:proof.taskId,code:'COMMAND_UNAVAILABLE',message:messages.COMMAND_UNAVAILABLE});break;}
   try{
    assert(++commandCount<=MAX_COMMANDS,'COMMAND_UNAVAILABLE');
    const e=command.evidence,op=e.operation,approval=e.approval;
    assert(typeof command.command==='string'&&e.version===1&&e.runId===source.id&&op?.status==='available'&&approval?.status==='available'&&z.uuid().safeParse(op.operationId).success&&
     typeof e.callId==='string'&&typeof e.sessionId==='string'&&Number.isSafeInteger(command.observationSeq)&&command.observationSeq<proof.acceptanceSeq&&
     /^[a-f0-9]{64}$/i.test(command.workspaceRevision??'')&&command.workspaceRevision===proof.receipt.workspaceRevision,'COMMAND_UNAVAILABLE');
    const observed=source.events.find((event:any)=>event.seq===command.observationSeq);
    const assignee=contracts(source).find((task:any)=>task.id===proof.taskId)?.assignee;
    const sameLinks=(event:any)=>event?.data?.operationId===op.operationId&&event.data.name==='terminal_test'&&event.data.taskId===proof.taskId&&event.data.attemptId===proof.attemptId&&event.data.callId===e.callId&&event.data.sessionId===e.sessionId&&event.data.approvalId===approval.approvalId&&event.data.agentId===assignee;
    const queued=source.events.filter((event:any)=>event.type==='local/operation-queued'&&sameLinks(event)),finished=source.events.filter((event:any)=>event.type==='local/operation-finished'&&sameLinks(event));
    assert(observed?.type==='handoff/command-observed'&&observed.data.taskId===proof.taskId&&observed.data.attemptId===proof.attemptId&&
     canonicalEvidence({...observed.data,taskId:undefined,attemptId:undefined})===canonicalEvidence({...command,observationSeq:undefined})&&
     queued.length===1&&finished.length===1&&queued[0].seq===op.queuedSeq&&finished[0].seq===op.finishedSeq&&op.queuedSeq<op.finishedSeq&&op.finishedSeq<command.observationSeq,'COMMAND_UNAVAILABLE');
    const rows=await load.operations(source.id,[op.operationId]);assert(rows.length===1,'COMMAND_UNAVAILABLE');
    const row=rows[0],context=row.payload?.context,result=row.result?.result??row.result;
    assert(row.id===op.operationId&&row.runId===source.id&&row.status==='completed'&&row.started===true&&row.payload.name==='terminal_test'&&
     row.payload.arguments?.command===command.command&&row.payload.arguments.expectedWorkspaceRevision===command.workspaceRevision&&context?.taskId===proof.taskId&&context?.attemptId===proof.attemptId&&
     context?.callId===e.callId&&context?.sessionId===e.sessionId&&context?.approvalId===approval.approvalId&&context?.agentId===assignee&&row.result?.ok===true&&
     result.exitCode===command.exitCode&&typeof result.output==='string'&&e.output?.status==='available'&&e.output.complete===true&&
     result.outputTruncated!==true&&result.truncated!==true&&Buffer.byteLength(result.output)<=MAX_OUTPUT_BYTES&&
     Buffer.byteLength(result.output)===e.output.bytes&&hash(result.output)===e.output.sha256,'COMMAND_UNAVAILABLE');
    response.tests.push({taskId:proof.taskId,attemptId:proof.attemptId,sourceRunId:source.id,operationId:row.id,command:String(redact(command.command)),exitCode:result.exitCode,
     output:String(redact(result.output)),outputSha256:e.output.sha256,workspaceRevision:command.workspaceRevision,observationSeq:command.observationSeq,acceptanceSeq:proof.acceptanceSeq,
     nodeTests:nodeTestCounts(command.command,result.output,true)});
   }catch{response.issues.push({taskId:proof.taskId,code:'COMMAND_UNAVAILABLE',message:messages.COMMAND_UNAVAILABLE});}
  }
 }
 response.status=response.issues.length?'partial':'verified';return response;
}

export function runLineageEvidenceRouter(database:Database,traceRoot:string){
 const router=Router();
 router.get('/runs/:id/lineage-evidence',async(req,res)=>{
  const id=z.uuid().parse(req.params.id);z.object({}).strict().parse(req.query);
  const row=(await database.query('SELECT project_id,project_version FROM project_runs WHERE id=$1',[id])).rows[0];
  if(!row)throw new AppError(404,'正式运行不存在');
  let total=0;
  const load=(runId:string)=>{
   z.uuid().parse(runId);
   for(const name of ['snapshot.json','events.jsonl']){const size=statSync(resolve(traceRoot,runId,name)).size;total+=size;if(total>64*1024*1024)throw Error('LINEAGE_ARCHIVE_LIMIT');}
   return readRun(traceRoot,runId);
  };
  let current:any;
  try{current=load(id);}catch{throw new AppError(409,'运行档案缺失或超出证据读取上限','LINEAGE_ARCHIVE_UNAVAILABLE');}
  if(!current||current.snapshot.projectId!==row.project_id||current.snapshot.planVersion!==row.project_version)throw new AppError(409,'运行档案与正式项目版本不一致','LINEAGE_ARCHIVE_UNAVAILABLE');
  const data=await collectRunLineageEvidence(current,{run:load,operations:async(runId,ids)=>(await database.query('SELECT id,run_id AS "runId",status,started,payload,result FROM local_operations WHERE run_id=$1 AND id=ANY($2::text[])',[runId,ids])).rows});
  res.json(data);
 });
 return router;
}
