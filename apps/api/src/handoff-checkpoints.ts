import { inspectArtifact } from '../../../services/agent-runtime/handoff.mjs';
import { taskContractErrors } from '../../../packages/contracts/task-contracts.mjs';
import { ancestors } from '../../../services/agent-runtime/checkpoint-context.mjs';

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
  const records = new Map<string,any>();
  for (const [id, task] of completed) {
    const contract = snapshot.tasks.find((item:any)=>item.id===id);
    if(!contract)throw Error(`检查点任务 ${id} 不在批准方案中`);
    const attemptId=task.attempt_id??task.attemptId;
    const accepted = events.findLast(event=>event.type==='handoff/accepted'&&event.data.taskId===id&&event.data.attemptId===attemptId)?.data
      ?? snapshot.handoffCheckpoints?.find((record:any)=>record.taskId===id&&record.attemptId===attemptId);
    if ((contract?.outputs?.length || ['implementation','repair','review','requirements'].includes(contract?.kind)) && !accepted) throw Error(`任务 ${id} 缺少宿主交付物验收记录，不能跳过，请完整重试`);
    if (accepted) records.set(id,accepted);
    if (!accepted) records.set(id,{taskId:id,attemptId:attemptId??`checkpoint:${id}`,inputs:[],outputs:[],commands:[]});
    if (['review','requirements'].includes(contract?.kind)&&task.verdict!=='pass') throw Error(`任务 ${id} 缺少通过的审查结论，不能恢复`);
    for(const dependency of contract?.dependencies??[])if(!completed.has(dependency))throw Error(`任务 ${id} 的前置 ${dependency} 尚未完成，不能跳过`);
  }
  // A later completed writer may intentionally replace a predecessor's file.
  // Keep both historical seals but validate the newest version still in use.
  for (const [id,record] of records) {
    const contract=snapshot.tasks.find((task:any)=>task.id===id);
    for(const output of contract.outputs??[]) {
      const seal=record.outputs?.find((file:any)=>file.path===output.path);
      if(!seal)throw Error(`产物 ${output.path} 缺少验收版本`);
      const replaced=snapshot.tasks.some((task:any)=>task.id!==id&&completed.has(task.id)&&ancestors(snapshot.tasks,task.id).has(id)&&task.outputs?.some((file:any)=>file.path===output.path));
      if(!replaced&&inspectArtifact(root,output).sha256!==seal.sha256)throw Error(`产物 ${output.path} 已变化，不能沿用原验收版本`);
    }
  }
  const remaining = snapshot.tasks.filter((task:any)=>!completed.has(task.id));
  for (const task of remaining) {
    for (const input of task.inputs??[]) {
      if (!input.producerTaskId || completed.has(input.producerTaskId) || records.has(input.producerTaskId)) {
        const output = input.producerTaskId ? records.get(input.producerTaskId)?.outputs.find((file:any)=>file.path===input.path) : undefined;
        const expected = output?.sha256??input.sha256;
        if (!expected || (input.sha256&&output&&input.sha256!==output.sha256)) throw Error(`输入 ${input.path} 没有匹配的已验收版本`);
        if (inspectArtifact(root,input).sha256!==expected) throw Error(`输入 ${input.path} 已变化，不能沿用原验收版本`);
      }
    }
  }
  const checkpoints=[...records.values()];
  const errors=taskContractErrors(snapshot.tasks,snapshot.agents,checkpoints);
  if(errors.length)throw Error(errors.join('；'));
  return checkpoints;
}

/** Use the newest native task per approved ID, including repair/review mappings.
 * An older completed implementation cannot hide a still-running repair. */
export function checkpointTasks(events:any[], snapshot:any={}) {
  const mapping=new Map<string,string>();
  for(const event of events.filter(event=>event.type==='run/task-mapping'))for(const item of event.data.tasks??[])mapping.set(item.task_id,item.seed_id);
  const latest=events.findLast(event=>['team/checkpoint','team/snapshot'].includes(event.type))?.data.tasks??[];
  const current=new Map<string,any>((snapshot.recovery?.completed??[]).map((task:any)=>[task.taskId,{...task,status:'completed'}]));
  // Iterate mapping order: a later repair supersedes the original task even if
  // the native status response happens to order tasks differently.
  for(const [nativeId,id] of mapping){const task=latest.find((task:any)=>(task.id??task.task_id)===nativeId);if(task)current.set(id,task);}
  return current;
}
export function completedTasks(events:any[],snapshot:any={}) {return new Map([...checkpointTasks(events,snapshot)].filter(([,task])=>task.status==='completed'));}
