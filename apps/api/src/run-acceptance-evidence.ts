import {checkpointTasks} from './handoff-checkpoints.ts';
import {collectAcceptanceChecks} from '../../../services/agent-runtime/acceptance-checks.mjs';
import {canonicalEvidence,verifiedRecoveredReceipt,type RunLineageEvidence} from '../../../packages/contracts/run-lineage-evidence.ts';

/** Read-only projection. No new assertions are written into historical runs. */
export function runAcceptanceEvidence(run:any,lineage:RunLineageEvidence):NonNullable<RunLineageEvidence['acceptance']>{
 const states=checkpointTasks(run.events,run.snapshot),rows:NonNullable<RunLineageEvidence['acceptance']>['rows']=[];
 for(const task of run.snapshot.tasks??[]){
  const state=states.get(task.id),attemptId=state?.attemptId??state?.attempt_id;
  const local=run.events.findLast((event:any)=>event.type==='handoff/accepted'&&event.data?.taskId===task.id&&event.data.attemptId===attemptId&&event.data.runId===run.id)?.data;
  const inherited=attemptId&&verifiedRecoveredReceipt(lineage,run.id,run.snapshot,task.id,attemptId);
  const receipt=state?.status==='completed'?(local??inherited?.receipt):undefined;
  const computed=receipt&&collectAcceptanceChecks(task,receipt.commands??[],receipt.workspaceRevision);
  const verified=run.integrity==='ok'&&receipt&&canonicalEvidence(computed)===canonicalEvidence(receipt.acceptanceChecks);
  for(const [criterionIndex,criterion] of (task.acceptanceCriteria??[]).entries()){
   const check=task.acceptanceChecks?.find((item:any)=>item.criterionIndex===criterionIndex);
   const result=verified&&computed.find((item:any)=>item.criterionIndex===criterionIndex);
   const last=run.events.findLast((event:any)=>event.type==='handoff/command-observed'&&event.data?.taskId===task.id&&event.data.attemptId===attemptId&&event.data.command===check?.command)?.data;
   const attempted=check&&last&&collectAcceptanceChecks(task,[last],last.workspaceRevision).find((item:any)=>item.criterionIndex===criterionIndex);
   rows.push({taskId:task.id,criterionIndex,criterion,command:check?.command??null,
    status:result?.status??(attempted?.status==='failed'?'failed':check&&['blocked','failed'].includes(state?.status)?'blocked':'unverified'),
    reason:result?.reason??(!check?'旧方案未定义此项命令映射':run.integrity!=='ok'?'档案完整性未通过':attempted?.status==='failed'?attempted.reason:check&&['blocked','failed'].includes(state?.status)?'节点受阻，请查看运行失败与审批记录':'等待匹配的正式交接凭据'),
    sourceRunId:verified?receipt.runId:null,attemptId:attemptId??null,workspaceRevision:verified?receipt.workspaceRevision:null});
  }
 }
 return {runId:run.id,planVersion:run.snapshot.planVersion,rows};
}
