import { assertGoalContract } from '../../../packages/contracts/goal-contract.mjs';
import { AppError } from './provider.ts';

/** Compatibility for the old Host that treated a rejected, unexecuted read as
 * goal drift. Require its entire adjacent host receipt; a message alone never
 * grants recovery. No record is changed and no forbidden path is opened. */
function deniedReadReceipt(snapshot:any,events:any[],index:number) {
 const blocked=events[index],start=events[index-1],failure=events[index+1],handoff=events[index+2],result=events[index+3];
 const task=snapshot.tasks?.find((task:any)=>task.id===blocked.data.taskId),path=start?.data?.arguments?.path;
 const mapping=new Map(events.slice(0,index).filter(event=>event.type==='run/task-mapping')
  .flatMap(event=>(event.data.tasks??[]).map((row:any)=>[row.task_id,row.seed_id])));
 return task&&typeof path==='string'&&task.inputs!==undefined&&!task.inputs.some((input:any)=>input.path===path)&&
  !(task.outputs??[]).some((output:any)=>output.path===path)&&blocked.data.point==='file-scope'&&
  blocked.data.sha256===snapshot.goalContract?.sha256&&blocked.data.message==='UNDECLARED_INPUT: '+path&&
  start.type==='tool/start'&&start.data.name==='filesystem'&&typeof start.callId==='string'&&typeof start.sessionId==='string'&&
  failure?.type==='runtime/operation-failed'&&failure.data.name==='filesystem'&&failure.data.classification==='blocked'&&
  ['Error','UNDECLARED_INPUT'].includes(failure.data.code)&&failure.data.message===blocked.data.message&&handoff?.type==='handoff/blocked'&&handoff.data.taskId===task.id&&
  handoff.data.message===blocked.data.message&&result?.type==='tool/result'&&result.data.name==='filesystem'&&
  result.data.result?.isError===true&&result.data.result.value===undefined&&
  result.data.result.error?.message==='HANDOFF_BLOCKED: '+task.id+': '+blocked.data.message&&
  (mapping.get(result.taskId)??result.taskId)===task.id&&typeof handoff.data.attemptId==='string'&&
  result.attemptId===handoff.data.attemptId&&
  [failure,result].every(event=>event.callId===start.callId&&event.sessionId===start.sessionId)&&
  [start,blocked,failure,handoff,result].every((event,offset)=>event.seq===start.seq+offset);
}

export function assertGoalRecovery(snapshot:any,run:any) {
 try {
  const expected=snapshot.goalContract??run?.snapshot?.goalContract;
  assertGoalContract(snapshot,expected);
  if(expected){
   if(!run)throw Error('GOAL_CONTRACT_CHANGED: 原目标档案缺失，请检查备份或重新制定方案');
   assertGoalContract(run.snapshot,expected);
   const blocked=run.events.find((event:any,index:number)=>event.type==='goal/blocked'&&
    !(run.integrity==='ok'&&deniedReadReceipt(snapshot,run.events,index)));
   if(blocked)throw new AppError(409,'目标边界检查已暂停此运行：'+blocked.data.message+'；请重新制定并批准方案','GOAL_REPLAN_REQUIRED');
  }
 }catch(error){
  if(error instanceof AppError)throw error;
  throw new AppError(409,(error as Error).message,'GOAL_CONTRACT_CHANGED');
 }
}
