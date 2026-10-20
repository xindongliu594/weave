import {isDeepStrictEqual} from 'node:util';
const denied=(code,message)=>Object.assign(Error(code+': '+message),{code,notExecuted:true});
export const taskSandboxEnabled=snapshot=>snapshot.executionProfile==='task-attempt-openshell-v1';
export function taskScopeBinding(scope){return{profile:scope.profile,key:{runId:scope.key.runId,taskId:scope.key.taskId,attemptId:scope.key.attemptId,generation:scope.key.generation},scopeHash:scope.workspace.scopeHash,workRevision:scope.workRevision};}
export function assertTaskScopeBinding(approved,current){if(!isDeepStrictEqual(approved,current))throw denied('TASK_SCOPE_CHANGED','批准期间任务或工作版本已变化，请重新申请批准');}
/** Recheck after approval/capacity awaits, before transport or native body dispatch. */
export function taskInvocationGuard(ctx,exec,snapshot){
 if(!taskSandboxEnabled(snapshot))return()=>{};
 const fields=['name','agent','arguments','callId','token','rootCallId','parent','deferContext','concludeTurn'],values=fields.map(field=>exec[field]),definition=ctx.tools.get(exec.name,exec.agent);
 return()=>{if(!definition||fields.some((field,index)=>exec[field]!==values[index])||ctx.tools.get(exec.name,exec.agent)!==definition)throw denied('TASK_TOOL_BINDING_CHANGED','等待期间工具定义或调用身份已变化');};
}

/** Called behind the existing Handoff mutex; model arguments never supply identity. */
export async function prepareTaskTool({snapshot,sandbox,handoff,activeWork,archive,agent,employee,signal,checkpointPhase='before-tool'}){
 if(!taskSandboxEnabled(snapshot))return{work:handoff?activeWork(agent):undefined};
 if(!handoff||typeof sandbox.prepareTask!=='function'||!agent||!employee)throw denied('TASK_SCOPE_REQUIRED','任务沙箱或可信员工上下文未就绪');
 const work=activeWork(agent),binding=work.executionBinding;
 handoff.assertCheckpointReady?.(work.taskId,work.attemptId,binding?.generation);
 const context={agentId:employee.id,sessionId:agent.id,taskId:work.taskId,attemptId:work.attemptId,generation:binding?.generation};
 if(!binding||!Number.isSafeInteger(binding.generation)||binding.generation<1||binding.runId!==archive.id||binding.agentId!==context.agentId||binding.sessionId!==context.sessionId||binding.taskId!==context.taskId||binding.attemptId!==context.attemptId)throw denied('TASK_SCOPE_REQUIRED','缺少当前注册的任务凭证');
 const scope=await sandbox.prepareTask(context,signal);signal.throwIfAborted();
 const current=activeWork(agent),next=current.executionBinding;
 if(current.taskId!==context.taskId||current.attemptId!==context.attemptId||next?.runId!==archive.id||next?.taskId!==context.taskId||next?.attemptId!==context.attemptId||next?.generation!==context.generation||next?.agentId!==context.agentId||next?.sessionId!==context.sessionId||scope?.profile!==snapshot.executionProfile||!isDeepStrictEqual(scope.key,{runId:archive.id,taskId:context.taskId,attemptId:context.attemptId,generation:context.generation})||!/^[a-f0-9]{64}$/.test(scope.workRevision)||!/^[a-f0-9]{64}$/.test(scope.workspace?.scopeHash))throw denied('TASK_SCOPE_CHANGED','注册期间任务分派或 scope 已变化');
 handoff.bindExecutionScope(work.taskId,work.attemptId,scope);
 const prepared={work:current,scope,context,executionScope:taskScopeBinding(scope)};
 await prepareTaskCheckpoint({snapshot,sandbox,handoff,activeWork,archive,agent,employee,signal,prepared,phase:checkpointPhase});return prepared;
}

/** Private barrier: refs never become employee context or a tool result. */
export async function prepareTaskCheckpoint({snapshot,sandbox,handoff,activeWork,archive,agent,employee,signal,prepared,phase='boundary',operationId}){
 if(!taskSandboxEnabled(snapshot))return;
 if(typeof sandbox.prepareCheckpoint!=='function'||typeof handoff?.bindCheckpoint!=='function')throw denied('TASK_CHECKPOINT_REQUIRED','Trusted checkpoint API unavailable');
 const work=prepared?.work??activeWork(agent),binding=work.executionBinding;
 const context=prepared?.context??{agentId:employee.id,sessionId:agent.id,taskId:work.taskId,attemptId:work.attemptId,generation:binding?.generation};
 if(phase==='after-tool'&&(typeof operationId!=='string'||!operationId))throw denied('TASK_CHECKPOINT_REQUIRED','Original operation identity missing');
 handoff.assertCheckpointReady?.(context.taskId,context.attemptId,context.generation);
 try{
 const refs=await sandbox.prepareCheckpoint(context,signal,{phase,...(operationId?{operationId}:{})});signal.throwIfAborted();
 const current=activeWork(agent),next=current.executionBinding;
 if(current.taskId!==context.taskId||current.attemptId!==context.attemptId||next?.generation!==context.generation||next?.runId!==archive.id||next?.sessionId!==context.sessionId||next?.agentId!==context.agentId)throw denied('TASK_SCOPE_CHANGED','Assignment changed during checkpoint preparation');
 handoff.bindCheckpoint(context.taskId,context.attemptId,refs,{sessionId:context.sessionId});
 }catch(error){handoff.failCheckpoint?.(context.taskId,context.attemptId,context.generation,error);throw error;}
}
