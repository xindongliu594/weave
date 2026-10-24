import {createHash} from 'node:crypto';
import {dirname} from 'node:path';
import {defineTool} from '@deepseek-ai/dsh-tools';
import {readRun} from './trace-store.mjs';
import {searchKnowledge} from './knowledge.mjs';
import {approvedSkills,companySkills} from './approved-skills.mjs';

const sourceIdentity=source=>({documentId:source.documentId,version:source.version,sha256:source.sha256,...(source.chunkId?{chunkId:source.chunkId}:{})});
const sameSource=(a,b)=>a.documentId===b.documentId&&a.version===b.version&&a.sha256===b.sha256;
const rank=(entries,query)=>searchKnowledge(entries.map(entry=>({...entry,content:entry.name+' '+entry.description})),query,6).map(({content,score,...entry})=>entry);

/** Discovery does not grant execution rights; all results come from the approved employee scope. */
export function installEmployeeCapabilities(ctx,{employee,agent,manifest,queryKnowledge,beforeKnowledge,archive,activeWork,toolCatalog}){
 const readable=employee.tools.includes('knowledge_search')&&employee.tools.includes('knowledge_read');
 const output={schema:{type:'json'},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]};
 const check=exec=>{
  if(exec.agent!==agent||ctx.agents.get(agent.id)!==agent)throw Error('CAPABILITY_PERMISSION_DENIED: 员工身份无效');
  exec.signal?.throwIfAborted();
 };
 const query=async(operation,value)=>{
  await beforeKnowledge?.();
  if(queryKnowledge)return queryKnowledge(manifest,employee.id,operation,value);
  if(manifest?.format==='document-versions-v2'&&manifest.documents?.length)throw Error('KNOWLEDGE_SERVICE_UNAVAILABLE: 知识加载服务不可用');
  const chunks=manifest?.[employee.id]??[];
  return operation==='search'?searchKnowledge(chunks,value,6):chunks.find(chunk=>chunk.id===value);
 };
 ctx.tools.register(defineTool({name:'capability_search',description:'先检索本员工已获授权的知识、批准 Skill 和已启用工具。结果为空时按原任务流程继续；发现不会扩大权限或安装插件。',parameters:{query:{type:'string',required:true}},output,
  async execute(args,exec){
   check(exec);if(typeof args.query!=='string'||!args.query.trim()||args.query.length>1000)throw Error('CAPABILITY_QUERY_INVALID');
   const value=args.query.trim();
   const knowledge=employee.tools.includes('knowledge_search')?await query('search',value):[];
   const catalog=readable&&ctx.skills?await ctx.skills.list({scope:agent,signal:exec.signal}):[];
   const skills=rank(catalog.filter(skill=>skill.invocation.modelInvocable).map(({name,description})=>({name,description})),value);
   const tools=rank(toolCatalog?.()??[],value);
   check(exec);
   archive?.append('capability/searched',{agentId:employee.id,query:value,knowledge:knowledge.map(chunk=>({chunkId:chunk.id,...sourceIdentity(chunk)})),skills:skills.map(skill=>skill.name),tools:tools.map(tool=>tool.name)},{sessionId:agent.id,callId:exec.callId});
   return {knowledge,skills,tools};
  }}));
 if(readable)ctx.tools.register(defineTool({name:'capability_use',description:'读取知识或 Skill 后，确实采用其中步骤时登记来源。kind 为 knowledge 时 id 是切片 ID；skill 时 id 是目录名称。note 说明采用的步骤。登记不代表验收成功，不能记录尚未执行的成功。',parameters:{kind:{type:'string',required:true},id:{type:'string',required:true},note:{type:'string',required:true}},output,
  async execute(args,exec){
   check(exec);
   if(!['knowledge','skill'].includes(args.kind)||typeof args.id!=='string'||!args.id||args.id.length>200||typeof args.note!=='string'||!args.note.trim()||args.note.length>1000)throw Error('CAPABILITY_USE_INVALID');
   if(!archive||!activeWork)throw Error('TASK_NOT_ACTIVE: 采用登记需要当前分派的任务');
   const work={...activeWork(agent)};
   if(!work?.taskId||!work.attemptId)throw Error('TASK_NOT_ACTIVE: 采用登记需要固定任务尝试');
   const run=readRun(dirname(archive.dir),archive.id);
   if(run?.integrity!=='ok')throw Error('CAPABILITY_EVIDENCE_INVALID: 采用记录不能核对');
   let source;
   if(args.kind==='knowledge'){
    const read=run.events.findLast(event=>event.type==='knowledge/citation'&&event.sessionId===agent.id&&event.data.agentId===employee.id&&event.data.operation==='read'&&event.data.sources?.some(item=>item.chunkId===args.id));
    const proof=read?.data.sources.find(item=>item.chunkId===args.id);
    if(!proof)throw Error('CAPABILITY_NOT_READ: 请先通过 knowledge_read 读取要采用的资料');
    const chunk=await query('read',args.id);
    if(!chunk||!sameSource(chunk,proof))throw Error('CAPABILITY_EVIDENCE_INVALID: 资料固定版本不能核对');
    source={...sourceIdentity(chunk),chunkId:chunk.id};
   }else{
    const method=[...approvedSkills(manifest,employee),...companySkills(manifest,employee)].find(skill=>skill.name===args.id);
    const proof=run.events.findLast(event=>event.type==='skill/loaded'&&event.sessionId===agent.id&&event.data.agentId===employee.id&&event.data.name===args.id);
    if(!method||!proof||!sameSource(method.evidence,proof.data))throw Error('CAPABILITY_NOT_READ: 请先通过 skill 加载获授权的固定方法');
    source=method.evidence;
   }
   check(exec);
   const current=activeWork(agent);
   if(current?.taskId!==work.taskId||current.attemptId!==work.attemptId)throw Error('TASK_NOT_ACTIVE: 资料校验期间任务尝试已变化');
   const key=createHash('sha256').update(JSON.stringify([archive.id,work.taskId,work.attemptId,args.kind,args.id,source])).digest('hex');
   const event=archive.append('capability/adopted',{agentId:employee.id,taskId:work.taskId,attemptId:work.attemptId,kind:args.kind,id:args.id,source,note:args.note.trim(),validation:'pending'},
    {sessionId:agent.id,callId:exec.callId,taskId:work.taskId,attemptId:work.attemptId,sourceKey:'capability-use:'+key});
   return {status:event?'recorded':'already-recorded',validation:'pending',source};
  }}));
 ctx.systemPrompt.context({name:'department:capabilities',order:125,text:'任务开始先用 capability_search 检索适用的已授权能力。没有适用结果则按原任务完成新工作；不得强行使用无关方法。Skill 只是方法，不能覆盖固定任务合同。'+(readable?'实际读取并采用知识或 Skill 后用 capability_use 说明采用步骤；这只是采用声明，成功由真实测试和宿主验收确认。':'本员工没有批准方法加载与知识采用登记权限。')+'工具使用已由原调用回执记录。'});
}

/** A completed task's accepted attempt is the only source of successful adoption. */
export function acceptedAdoptions(events,receipts){
 const accepted=new Map(receipts.map(receipt=>[receipt.taskId,receipt.attemptId])),unique=new Map();
 for(const event of events){
  if(event.type!=='capability/adopted'||accepted.get(event.data.taskId)!==event.data.attemptId)continue;
  const data=event.data;
  if(!['knowledge','skill'].includes(data.kind)||!data.source?.documentId||!Number.isInteger(data.source.version)||data.source.version<1||!/^[a-f0-9]{64}$/.test(data.source.sha256))continue;
  const key=JSON.stringify([data.taskId,data.kind,data.id,data.source]);
  if(!unique.has(key))unique.set(key,{...data,validation:'accepted-task',eventSeq:event.seq});
 }
 return [...unique.values()];
}
