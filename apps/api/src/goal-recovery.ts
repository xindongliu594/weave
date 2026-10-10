import { assertGoalContract } from '../../../packages/contracts/goal-contract.mjs';
import { AppError } from './provider.ts';

export function assertGoalRecovery(snapshot:any,run:any) {
 try {
  const expected=snapshot.goalContract??run?.snapshot?.goalContract;
  assertGoalContract(snapshot,expected);
  if(expected){
   if(!run)throw Error('GOAL_CONTRACT_CHANGED: 原目标档案缺失，请检查备份或重新制定方案');
   assertGoalContract(run.snapshot,expected);
   const blocked=run.events.findLast((event:any)=>event.type==='goal/blocked');
   if(blocked)throw new AppError(409,'目标边界检查已暂停此运行：'+blocked.data.message+'；请重新制定并批准方案','GOAL_REPLAN_REQUIRED');
  }
 }catch(error){
  if(error instanceof AppError)throw error;
  throw new AppError(409,(error as Error).message,'GOAL_CONTRACT_CHANGED');
 }
}
