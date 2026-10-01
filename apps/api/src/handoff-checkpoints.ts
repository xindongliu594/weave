import { inspectArtifact } from '../../../services/agent-runtime/handoff.mjs';
import { taskContractErrors } from '../../../packages/contracts/task-contracts.mjs';

/** Retain only host seals belonging to the exact completed attempt in the archive. */
export function resumeHandoff(snapshot:any, events:any[], completed:Map<string,any>, root:string) {
  // Collapse a rework graph only at an independently accepted boundary. A
  // half-finished repair/review must retain native identities and is not replayed.
  for (const event of events.filter(event=>event.type==='quality/rework-created')) {
    const review=snapshot.tasks.find((task:any)=>task.id===event.data.reviewTaskId);
    const source=review&&snapshot.tasks.find((task:any)=>task.id===review.reviewedTaskId);
    if (!review || !source || !Number.isInteger(event.data.round) || event.data.round<1 || event.data.round>(review.maxReworkRounds??0) ||
        !completed.has(source.id) || completed.get(review.id)?.verdict!=='pass')
      throw Error('返工尚未形成独立验收通过的检查点，请检查产物后完整重试，或重新批准方案');
    const reviewed=events.findLast(item=>item.type==='quality/reviewed'&&item.data.taskId===review.id&&item.data.attemptId===(completed.get(review.id).attempt_id??completed.get(review.id).attemptId));
    if(reviewed?.data.verdict!=='pass')throw Error('返工缺少宿主独立复验记录，不能跳过，请完整重试');
  }
  const records = new Map<string,any>((snapshot.handoffCheckpoints??[]).map((record:any)=>[record.taskId,record]));
  for (const [id, task] of completed) {
    const contract = snapshot.tasks.find((item:any)=>item.id===id);
    const accepted = events.findLast(event=>event.type==='handoff/accepted'&&event.data.taskId===id&&event.data.attemptId===(task.attempt_id??task.attemptId))?.data;
    if ((contract?.outputs?.length || ['implementation','repair','review','requirements'].includes(contract?.kind)) && !accepted) throw Error(`任务 ${id} 缺少宿主交付物验收记录，不能跳过，请完整重试`);
    if (accepted) {
      for(const output of contract?.outputs??[]) {
        const seal=accepted.outputs?.find((file:any)=>file.path===output.path);
        if(!seal||inspectArtifact(root,output).sha256!==seal.sha256)throw Error(`产物 ${output.path} 已变化，不能沿用原验收版本`);
      }
      records.set(id,accepted);
    }
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

/** Use the newest native task per approved ID, including repair/review mappings.
 * An older completed implementation cannot hide a still-running repair. */
export function completedTasks(events:any[]) {
  const mapping=new Map<string,string>();
  for(const event of events.filter(event=>event.type==='run/task-mapping'))for(const item of event.data.tasks??[])mapping.set(item.task_id,item.seed_id);
  const latest=events.findLast(event=>event.type==='team/checkpoint')?.data.tasks??events.findLast(event=>event.type==='team/snapshot')?.data.tasks??[];
  const current=new Map<string,any>();for(const task of latest){const id=mapping.get(task.id);if(id)current.set(id,task);}
  return new Map([...current].filter(([,task])=>task.status==='completed'));
}
