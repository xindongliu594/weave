import {join} from 'node:path';
import {readRun} from '../../../services/agent-runtime/trace-store.mjs';
import {readStepCheckpoint,validateInheritedEvidence} from '../../../services/agent-runtime/step-checkpoints.mjs';

// Acceptance-only stop. It never supplies a model reply, employee file or test result.
export function atStepBoundary(original,{root,projectId,taskId,command,onBoundary}) {
 return async function(runId,data,signal){
  const run=readRun(root,runId);
  if(run?.snapshot.projectId!==projectId)return original.call(this,runId,data,signal);
  if(run.integrity!=='ok')throw Error('CHECKPOINT_ACCEPTANCE_ARCHIVE_INVALID');
  if(run.events.some(event=>event.type==='handoff/accepted'&&event.data.taskId===taskId))throw Error('CHECKPOINT_ACCEPTANCE_BOUNDARY_MISSED');
  const event=run.events.findLast(event=>event.type==='step/checkpoint'&&event.data?.boundary?.taskId===taskId);
  const receipt=event?.data.receipts?.findLast(entry=>entry.command===command);
  if(!receipt||receipt.exitCode!==0)return original.call(this,runId,data,signal);
  const saved=readStepCheckpoint({root,runId,checkpointId:event.data.id});
  const reference={id:saved.id,runId,sha256:saved.sha256};
  const task=(run.snapshot.approvedTasks??run.snapshot.tasks).find(task=>task.id===taskId);
  const proof=validateInheritedEvidence({root,reference,snapshot:run.snapshot,task,workspace:join(root,runId,'artifacts'),environment:saved.boundary.environment});
  if(!proof.reusable||!proof.evidenceRefs.some(entry=>entry.command===command))throw Error('CHECKPOINT_ACCEPTANCE_NOT_REUSABLE: '+proof.reasons.join(','));
  signal.throwIfAborted();
  onBoundary({runId,taskId,heldRequestId:data.id,heldTaskId:data.taskId,reference,eventCount:run.eventCount,receipt:proof.evidenceRefs.find(entry=>entry.command===command)});
  await new Promise((_,reject)=>{signal.addEventListener('abort',()=>reject(signal.reason),{once:true});if(signal.aborted)reject(signal.reason);});
 };
}
