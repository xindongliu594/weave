import { defineTool } from '@deepseek-ai/dsh-tools';
import { searchKnowledge } from './knowledge.mjs';
export function employeeFor(agent,snapshot,captainId){
  if(agent?.id===captainId)return snapshot.agents.find(a=>a.role==='manager');
  const descriptor=agent?.session.snapshotEvents().find(e=>e.type==='subagent/descriptor');
  const name=descriptor?.data?.label?.split(':').at(-1);
  return snapshot.agents.find(a=>a.id===name);
}
export function installProductTools(ctx,{snapshot,archive,sandbox,gate,requestApproval,captainId,queryKnowledge}){
  const string={type:'string',required:true};
  const tools=[
    ['artifact_write','写入文本交付物。新文件可直接写；修改已有文件必须先 filesystem 读取，再传入读取时的 sha256 为 expectedSha256，冲突时重新读取合并。',{path:string,content:string,expectedSha256:{type:'string'}}],
    ['filesystem','读取隔离工作区中的文件，不能读取宿主机。',{path:string}],
    ['terminal','申请在无网络、无宿主机挂载的受限容器内运行命令，等待用户批准。',{command:string}],
    ['terminal_test','申请在受限容器内执行测试命令，等待用户批准。',{command:string}],
    ['knowledge_search','检索员工获授权的运行时知识快照，返回可引用的文档版本和行号。',{query:string}],
    ['knowledge_read','读取已授权知识快照的指定切片。',{chunkId:string}],
  ];
  const disposers=tools.map(([name,description,parameters])=>ctx.tools.register(defineTool({name,description,parameters,output:{schema:{type:'json'},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},async execute(args,exec){
    const employee=employeeFor(exec.agent,snapshot,captainId());
    if(!employee||!employee.tools.includes(name))throw Error('TOOL_PERMISSION_DENIED: 此员工没有该工具权限');
    if(name.startsWith('knowledge_')){
      const chunks=snapshot.knowledge?.[employee.id]??[];
      if(snapshot.knowledge?.format==='document-versions-v2'&&!queryKnowledge)throw Error('KNOWLEDGE_SERVICE_UNAVAILABLE: 历史版本检索服务不可用');
      const result=queryKnowledge?await queryKnowledge(snapshot.knowledge,employee.id,name==='knowledge_search'?'search':'read',String(name==='knowledge_search'?args.query:args.chunkId).slice(0,1000)):
        name==='knowledge_search'?searchKnowledge(chunks,String(args.query).slice(0,1000)):chunks.find(c=>c.id===args.chunkId);
      if(!result)throw Error('知识切片不存在或未授权');
      archive.append('knowledge/citation',{agentId:employee.id,query:args.query,sources:(Array.isArray(result)?result:[result]).map(c=>({documentId:c.documentId,version:c.version,chunkId:c.id,title:c.title,lineStart:c.lineStart,lineEnd:c.lineEnd,sha256:c.sha256,source:c.source}))},{sessionId:exec.agent.id});return result;
    }
    if(name==='terminal'||name==='terminal_test'){
      if(!requestApproval)throw Error('审批服务不可用');
      args={...args,expectedWorkspaceRevision:sandbox.revision()};
      await requestApproval({runId:archive.id,agentId:employee.id,tool:name,arguments:args},exec.signal);
    }
    const release=await gate.acquire(exec.signal);
    try{const result=await sandbox.execute(name,args,exec.signal);archive.append('artifact/updated',{agentId:employee.id,files:result.artifacts});return result;}finally{release();}
  }})));
  return ()=>disposers.reverse().forEach(dispose=>dispose());
}
