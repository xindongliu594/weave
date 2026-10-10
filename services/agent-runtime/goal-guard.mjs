import { assertGoalContract, goalTaskContext } from '../../packages/contracts/goal-contract.mjs';

/** An independent host copy fences mutable sessions and recovery summaries. */
export class GoalGuard {
  constructor({snapshot,archive,onFailure}) {
    Object.assign(this,{snapshot,archive,onFailure});
    this.expected=structuredClone(snapshot.goalContract);this.started=new Set();
    this.check('start');
    if(this.expected)archive.append('goal/anchored',{...this.expected,planVersion:snapshot.planVersion});
  }
  block(error,point,taskId) {
    if(!this.failure){
      this.failure=error;
      this.archive.append('goal/blocked',{point,taskId,sha256:this.expected?.sha256,message:error.message,code:error.code??'GOAL_BOUNDARY_VIOLATION'});
      this.onFailure?.(error);
    }
    return this.failure;
  }
  check(point,taskId) {
    if(this.failure)throw this.failure;
    try{return assertGoalContract(this.snapshot,this.expected);}
    catch(error){throw this.block(error,point,taskId);}
  }
  context(taskId){this.check('context',taskId);return goalTaskContext(this.snapshot,taskId);}
  nodeStarted(taskId,attemptId){
    if(!this.check('node-start',taskId))return;
    const key=taskId+':'+attemptId;
    if(!this.started.has(key)){this.started.add(key);this.archive.append('goal/node-started',{taskId,attemptId,sha256:this.expected.sha256});}
  }
  nodeAccepted(record){
    if(!this.check('handoff',record.taskId))return;
    this.archive.append('goal/node-checked',{taskId:record.taskId,attemptId:record.attemptId,sha256:this.expected.sha256,
      criteriaIds:this.context(record.taskId).criteria.map(item=>item.id),evidence:'handoff/accepted'});
  }
}
