import { inspectArtifact } from '../../../services/agent-runtime/handoff.mjs';
import { taskContractErrors } from '../../../packages/contracts/task-contracts.mjs';

/** Retain only host seals belonging to the exact completed attempt in the archive. */
export function resumeHandoff(snapshot:any, events:any[], completed:Map<string,any>, root:string) {
  if (events.some(event=>event.type==='quality/rework-created'))
    throw Error('自动返工改变了原生任务身份，暂不能跳过检查点；请检查产物后完整重试，费用和调用上限继续累积');
  const records = new Map<string,any>((snapshot.handoffCheckpoints??[]).map((record:any)=>[record.taskId,record]));
  for (const [id, task] of completed) {
    const contract = snapshot.tasks.find((item:any)=>item.id===id);
    const accepted = events.findLast(event=>event.type==='handoff/accepted'&&event.data.taskId===id&&event.data.attemptId===(task.attempt_id??task.attemptId))?.data;
    if (contract?.outputs?.length && !accepted) throw Error(`任务 ${id} 缺少宿主交付物验收记录，不能跳过，请完整重试`);
    if (accepted) records.set(id,accepted);
  }
  const remaining = snapshot.tasks.filter((task:any)=>!completed.has(task.id));
  for (const task of remaining) {
    if ([task.reviewedTaskId,task.sourceTaskId].some(id=>id&&completed.has(id))) throw Error('质量审查或修复需要保留原任务身份；此运行请完整重试，或修改方案后重新批准');
    for (const input of task.inputs??[]) {
      if (!input.producerTaskId || completed.has(input.producerTaskId) || records.has(input.producerTaskId)) {
        const output = input.producerTaskId ? records.get(input.producerTaskId)?.outputs.find((file:any)=>file.path===input.path) : undefined;
        const expected = output?.sha256??input.sha256;
        if (!expected || (input.sha256&&output&&input.sha256!==output.sha256)) throw Error(`输入 ${input.path} 没有匹配的已验收版本`);
        if (inspectArtifact(root,input).sha256!==expected) throw Error(`输入 ${input.path} 已变化，不能沿用原验收版本`);
      }
    }
  }
  const tasks=remaining.map((task:any)=>({...task,dependencies:task.dependencies.filter((id:string)=>!completed.has(id))}));
  const checkpoints=[...records.values()];
  const errors=taskContractErrors(tasks,snapshot.agents,checkpoints);
  if(errors.length)throw Error(errors.join('；'));
  return checkpoints;
}
