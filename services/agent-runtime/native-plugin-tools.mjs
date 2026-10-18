import { nativeFileAccess, nativeToolBinding } from './native-capabilities.mjs';
import { employeeFor } from './product-tools.mjs';

/** Only definitions cross the Host boundary; native plugin bodies run remotely. */
export function installNativePluginTools(ctx, {snapshot,archive,sandbox,gate,captainId,handoff,activeWork,supervisor,goal}) {
 const disposers=[];
 for(const binding of snapshot.nativeCapabilities??[])for(const tool of binding.manifest.tools){
  nativeToolBinding(snapshot,tool.name);
  disposers.push(ctx.tools.register({name:tool.name,description:tool.description+' 使用工作区相对路径；遵守批准的输入输出合同。',parameters:tool.parameters,
   output:{schema:{type:'object',additionalProperties:true},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},
   async execute(args,exec){
    const employee=exec.agent&&employeeFor(exec.agent,snapshot,captainId());
    if(!employee?.tools.includes(tool.name)||ctx.agents.get(exec.agent.id)!==exec.agent)throw Error('TOOL_PERMISSION_DENIED: 员工未获此原生工具授权');
    const access=nativeFileAccess(tool,args),ref={sessionId:exec.agent.id,callId:exec.callId};
    const leave=supervisor?.enter(exec.agent.id,'waiting_capacity');let release;
    try{release=await gate.acquire(exec.signal);}finally{leave?.();}
    try{
     const invoke=async()=>{
      goal?.check('tool-dispatch');supervisor?.check();
      const work=activeWork(exec.agent);let dispatched=false,known=false;
      try{
       let before;
       for(const path of access.read)before=handoff.beforeFile(work.taskId,work.attemptId,'filesystem',{path});
       for(const path of access.write)before=handoff.beforeFile(work.taskId,work.attemptId,'artifact_write',{path});
       before??=handoff.beforeFile(work.taskId,work.attemptId,tool.name,args);
       archive.append('runtime/operation-start',{name:tool.name,arguments:args,pluginId:binding.id},ref);
       dispatched=true;
       const result=await sandbox.execute('native_plugin',{toolName:tool.name,arguments:args,expectedWorkspaceRevision:sandbox.revision()},exec.signal,
        {agentId:employee.id,employeeId:employee.employeeId,sessionId:exec.agent.id,callId:exec.callId,taskId:work.taskId,attemptId:work.attemptId});
       known=true;archive.append('runtime/operation-finished',{name:tool.name,pluginId:binding.id},ref);
       if(result.pluginId!==binding.id||result.toolName!==tool.name)throw Error('NATIVE_RECEIPT_MISMATCH');
       handoff.observe(work.taskId,work.attemptId,tool.name,args,result,before,ref);
       archive.append('artifact/updated',{agentId:employee.id,files:result.artifacts},{...ref,taskId:work.taskId,attemptId:work.attemptId});
       archive.append('capability/tool-used',{agentId:employee.id,name:tool.name,pluginId:binding.id,package:binding.manifest.package,version:binding.manifest.version,isError:result.nativeResult.isError},ref);
       if(result.nativeResult.isError)throw Error('NATIVE_TOOL_FAILED: '+(result.nativeResult.error?.message??'原生插件返回失败'));
       return {value:result.nativeResult.value,artifacts:result.artifacts,workspaceRevision:result.workspaceRevision,pluginId:binding.id};
      }catch(error){
       if(error.notExecuted&&dispatched)archive.append('runtime/operation-finished',{name:tool.name,notExecuted:true},ref);
       if(dispatched&&!known&&!error.notExecuted)archive.append('runtime/outcome-unknown',{name:tool.name,callId:exec.callId,arguments:args,message:error.message},ref);
       archive.append('runtime/operation-failed',{name:tool.name,code:error.code??error.name,message:error.message},ref);
       if(dispatched)handoff.invalidateCommands(work.taskId,work.attemptId);
       throw handoff.block(work.taskId,work.attemptId,error);
      }
     };
     return await handoff.exclusive(exec.signal,invoke);
    }finally{release();}
   }}));
 }
 return ()=>disposers.reverse().forEach(dispose=>dispose());
}
