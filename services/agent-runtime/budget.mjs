import { LlmError } from '@deepseek-ai/dsh-llm';
const over=(left,right)=>left-right>Number.EPSILON*Math.max(Math.abs(left),Math.abs(right))*8;
const reached=(left,right)=>!over(right,left);

// Reservations and counters are changed synchronously before fetch, so concurrent employees
// cannot both spend the same remaining allowance. Actual receipts are recorded even on overrun.
export class ExecutionBudget {
  constructor({maxBudget,priorSpend=0,maxModelCalls=100,priorModelCalls=0,tasks=[],maxTaskModelCalls=40,taskUsage={},taskCallCeilings,onEvent}) {
    if(taskCallCeilings!==undefined){
      const invalid=()=>new LlmError('恢复阶段的累计调用上限无效','INVALID_TASK_CALL_CEILING');
      if(!taskCallCeilings||typeof taskCallCeilings!=='object'||Array.isArray(taskCallCeilings)||!Object.keys(taskCallCeilings).length)throw invalid();
      for(const [id,limit] of Object.entries(taskCallCeilings)){
        const task=tasks.find(task=>task.id===id);
        if(!task||!Number.isSafeInteger(limit)||limit<1||limit>Math.min(task.maxModelCalls??maxTaskModelCalls,maxModelCalls))throw invalid();
      }
    }
    this.run={scope:'project',limit:maxBudget+priorSpend,spent:priorSpend,reserved:0,calls:priorModelCalls,maxCalls:maxModelCalls,warnings:new Set()};
    this.tasks=new Map(tasks.map(task=>[task.id,{scope:'task',taskId:task.id,employeeId:task.assigneeId,limit:task.maxBudget??this.run.limit,
      spent:taskUsage[task.id]?.cost??0,reserved:taskUsage[task.id]?.reserved??0,calls:taskUsage[task.id]?.calls??0,
      maxCalls:Math.min(task.maxModelCalls??maxTaskModelCalls,taskCallCeilings&&Object.hasOwn(taskCallCeilings,task.id)?taskCallCeilings[task.id]:Infinity),warnings:new Set()}]));
    this.onEvent=onEvent;
  }
  emit(bucket,kind,extra={}) {
    this.onEvent?.({kind,scope:bucket.scope,taskId:bucket.taskId,spent:bucket.spent,reserved:bucket.reserved,limit:bucket.limit,calls:bucket.calls,maxCalls:bucket.maxCalls,...extra});
  }
  warnings(bucket) {
    for(const threshold of [70,90,100])if(reached(bucket.spent,bucket.limit*threshold/100)&&!bucket.warnings.has(threshold)) {
      bucket.warnings.add(threshold);this.emit(bucket,'warning',{threshold});
    }
  }
  fail(bucket,code,message) { this.emit(bucket,'stopped',{code,message});throw new LlmError(message,code); }
  // A preview uses the exact admission gates without creating warnings,
  // stopped events, reservations or calls. It is never an admission ticket.
  peekAvailable(attribution={},fallback=false) { return this.checkAvailable(attribution,fallback,false); }
  available(attribution={},fallback=false) { return this.checkAvailable(attribution,fallback,true); }
  checkAvailable(attribution,fallback,notify) {
    const reject=(bucket,code,message)=>{if(notify)this.fail(bucket,code,message);throw new LlmError(message,code);};
    const task=attribution.taskId?this.tasks.get(attribution.taskId):undefined;
    if(this.tasks.size&&attribution.taskId&&!task)reject(this.run,'TASK_BUDGET_UNKNOWN','模型请求没有可核对的任务预算');
    if(task&&task.employeeId&&attribution.employeeId!==task.employeeId)reject(task,'TASK_BUDGET_IDENTITY','模型请求的员工与批准的任务负责人不一致');
    const buckets=[this.run,...(task?[task]:[])];
    for(const bucket of buckets) {
      if(notify)this.warnings(bucket);
      if(fallback&&reached(bucket.spent,bucket.limit*.9))reject(bucket,'BUDGET_RETRY_DISABLED','费用已达到预算的 90%，停止自动切换模型或重试');
      if(bucket.calls>=bucket.maxCalls)reject(bucket,task===bucket?'TASK_TURN_LIMIT':'TURN_LIMIT',task===bucket?'此员工在该任务的模型调用次数已达上限':'项目方案的模型调用次数已达上限');
      if(reached(bucket.spent,bucket.limit)||over(bucket.spent+bucket.reserved,bucket.limit))reject(bucket,task===bucket?'TASK_BUDGET_EXCEEDED':'BUDGET_EXCEEDED',task===bucket?'本次请求预留将超过任务费用上限':'模型请求的保守预留将超过本次运行预算');
    }
    return Math.max(0,Math.min(...buckets.map(bucket=>bucket.limit-bucket.spent-bucket.reserved)));
  }
  reserve(amount,attribution={},fallback=false) {
    const task=attribution.taskId?this.tasks.get(attribution.taskId):undefined;
    if(this.tasks.size&&attribution.taskId&&!task)this.fail(this.run,'TASK_BUDGET_UNKNOWN','模型请求没有可核对的任务预算');
    if(task&&task.employeeId&&attribution.employeeId!==task.employeeId)this.fail(task,'TASK_BUDGET_IDENTITY','模型请求的员工与批准的任务负责人不一致');
    const buckets=[this.run,...(task?[task]:[])];
    for(const bucket of buckets) {
      this.warnings(bucket);
      if(fallback&&reached(bucket.spent,bucket.limit*.9))this.fail(bucket,'BUDGET_RETRY_DISABLED','费用已达到预算的 90%，停止自动切换模型或重试');
      if(bucket.calls>=bucket.maxCalls)this.fail(bucket,task===bucket?'TASK_TURN_LIMIT':'TURN_LIMIT',task===bucket?'此员工在该任务的模型调用次数已达上限':'项目方案的模型调用次数已达上限');
      if(reached(bucket.spent,bucket.limit)||over(bucket.spent+bucket.reserved+amount,bucket.limit))
        this.fail(bucket,task===bucket?'TASK_BUDGET_EXCEEDED':'BUDGET_EXCEEDED',task===bucket?'本次请求预留将超过任务费用上限':'模型请求的保守预留将超过本次运行预算');
    }
    for(const bucket of buckets){bucket.reserved+=amount;bucket.calls++;}
    let held=true;
    const release=()=>{if(held){for(const bucket of buckets)bucket.reserved=Math.max(0,bucket.reserved-amount);held=false;}};
    return {release,settle:cost=>{release();for(const bucket of buckets)bucket.spent+=cost;},check:()=>{
      for(const bucket of buckets){this.warnings(bucket);if(over(bucket.spent,bucket.limit))this.fail(bucket,task===bucket?'TASK_BUDGET_EXCEEDED':'BUDGET_EXCEEDED','供应方实际用量超过预算，费用已记录，停止后续执行');}
    }};
  }
}
