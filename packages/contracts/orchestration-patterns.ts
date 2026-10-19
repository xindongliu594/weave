import {z} from 'zod';
import type {Plan} from './index.ts';
import {isArtifactPath,taskContractErrors} from './task-contracts.mjs';
import {deliveryCriteriaErrors} from './orchestration.ts';

const taskId=z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/);
const ids=z.array(taskId).min(1).max(50);
const label=z.string().trim().min(1).max(80);
const sha256=z.string().regex(/^[a-f0-9]{64}$/);
const common={schemaVersion:z.literal(1),version:z.literal(1),definitionHash:sha256};
export const orchestrationTemplateSchema=z.discriminatedUnion('id',[
 z.object({...common,id:z.literal('pipeline'),taskIds:ids}).strict(),
 z.object({...common,id:z.literal('parallel'),branchTaskIds:ids.min(2),joinTaskId:taskId}).strict(),
 z.object({...common,id:z.literal('router'),routeKey:z.string().trim().min(1).max(200),selectedTaskIds:ids}).strict(),
 z.object({...common,id:z.literal('orchestrator_workers'),workItems:z.array(z.object({id:label,taskId,objective:z.string().trim().min(1).max(5000)}).strict()).min(1).max(50),joinTaskId:taskId}).strict(),
 z.object({...common,id:z.literal('review_repair'),reviewTaskId:taskId}).strict(),
 z.object({...common,id:z.literal('map_reduce'),manifest:z.array(z.object({id:label,taskId,input:z.object({path:z.string().refine(isArtifactPath,'需要工作区相对路径'),sha256}).strict()}).strict()).min(2).max(50),reduceTaskId:taskId}).strict(),
 z.object({...common,id:z.literal('proposal_review'),proposals:z.array(z.object({proposalTaskId:taskId,critiqueTaskId:taskId}).strict()).length(2),decisionTaskId:taskId}).strict(),
]);
export type OrchestrationTemplate=z.infer<typeof orchestrationTemplateSchema>;

const anthropic='https://www.anthropic.com/engineering/building-effective-agents';
const definitions=[
 {schemaVersion:1,id:'pipeline',version:1,name:'顺序交接',description:'批准前固定完整任务顺序，逐步交接产物。',sources:[anthropic],applicability:'有明确前后依赖的有限工作流。',limits:'绑定全部任务；相邻任务必须存在先后依赖。',binding:'taskIds: complete ordered task IDs'},
 {schemaVersion:1,id:'parallel',version:1,name:'并行协作',description:'独立分支完成后读取全部输出并汇总。',sources:[anthropic],applicability:'可以独立处理、最终共同验收的专业分支。',limits:'至少两个无相互依赖分支；汇总必须等待全部分支。',binding:'branchTaskIds, joinTaskId'},
 {schemaVersion:1,id:'router',version:1,name:'专业路由',description:'批准前固定选路及完整选中任务图。',sources:[anthropic,'https://docs.langchain.com/oss/javascript/langchain/multi-agent/router'],applicability:'规划时已能决定专业流程。',limits:'仅执行前选路；无运行时条件跳过。',binding:'routeKey, selectedTaskIds: complete task IDs'},
 {schemaVersion:1,id:'orchestrator_workers',version:1,name:'主管拆分',description:'批准前冻结工作项、目标和汇总节点。',sources:[anthropic],applicability:'规划阶段需要按目标拆分工作。',limits:'运行中不能派生团队或追加工作项；工作项互不依赖。',binding:'workItems: unique id/taskId/objective matching tasks, joinTaskId'},
 {schemaVersion:1,id:'review_repair',version:1,name:'评审返工',description:'复用既有独立实现审查与有界返工合同。',sources:[anthropic],applicability:'显式文件输入输出、范围和验证命令的实现工作。',limits:'独立实现审查入口批准 1..2 轮；不增加返工引擎。',binding:'reviewTaskId: valid implementation review with maxReworkRounds 1..2'},
 {schemaVersion:1,id:'map_reduce',version:1,name:'分片汇总',description:'批准前固定不可变分片输入并汇总全量输出。',sources:['https://docs.langchain.com/oss/javascript/langgraph/workflows-agents'],applicability:'对固定输入清单逐片处理并归并。',limits:'每分片恰好一个独立任务和一个固定输入；无运行中扩片。',binding:'manifest: unique id/taskId/input path+SHA256, reduceTaskId'},
 {schemaVersion:1,id:'proposal_review',version:1,name:'多方案评议',description:'两位作者独立提案、同步后各一次他人批评，经理依据全部产物裁定。',sources:['https://microsoft.github.io/autogen/stable/user-guide/core-user-guide/design-patterns/multi-agent-debate.html'],applicability:'需要保留两个方案及质疑证据的决策。',limits:'恰好两组提案/批评；固定一轮；结构不能证明语义独立。',binding:'proposals: two unique proposalTaskId/critiqueTaskId pairs, decisionTaskId'},
] as const;
// SHA256 of UTF-8 canonical JSON: recursively sort object keys, preserve array order,
// JSON.stringify primitives, no whitespace. Hash the definition only, never acceptance state.
const definitionHashes:Record<string,string>={
 pipeline:'0cd1d11b121853e58ee87462e1f3e27cacdf0dba1cd71d58a6a5423dc7bc67ec',
 parallel:'9b44fb625b6152ef70caebc99c4c852038c446f5db1e105076c6a9d8315917e6',
 router:'e9c031ad73f4d159b77d9c8e47edb06e52b453fc3b6d5cfe7c5318047f1171e8',
 orchestrator_workers:'fe27032661f27878aefa1d81c1283307bf7d1d71f6c8bcd6eb8399c7f1dc472b',
 review_repair:'b22a7e7072b0f1f77a27605ed017b6fb9dee1ea71a19de9ae062110c483382f9',
 map_reduce:'c45861dc3dce2979271c91f2f0517d6a801da1324ca6d30a927ad81f957e7651',
 proposal_review:'7c8a0bb95630082de16045e4bbce8b6a56c82df49ee7c4746d01ac63f52fcb5d',
};
function freeze<T>(value:T):T{
 if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;
}
export const orchestrationPatterns=freeze(definitions.map(definition=>({...definition,definition,definitionHash:definitionHashes[definition.id],status:'offline_verified' as const})));

type PatternPlan=Pick<Plan,'tasks'|'agents'|'orchestration'|'deliveryCriteria'>;
function registered(template:unknown){
 const result=orchestrationTemplateSchema.safeParse(template);
 if(!result.success)return undefined;
 return orchestrationPatterns.find(p=>p.id===result.data.id&&p.version===result.data.version&&p.definitionHash===result.data.definitionHash);
}
export function orchestrationPatternSummary(template:unknown):{name:string;version:number;status:string}{
 const pattern=registered(template);
 return pattern?{name:pattern.name,version:pattern.version,status:'offline_verified · 待真实验收'}:{name:'未知模板引用',version:0,status:'不可执行：模板引用无效'};
}
export function orchestrationExecutionErrors(plan:Pick<Plan,'orchestration'>):string[]{
 if(plan.orchestration?.template===undefined)return [];
 const summary=orchestrationPatternSummary(plan.orchestration.template);
 return [`${summary.name} v${summary.version}：待真实验收，当前模板仅供离线预览，不可执行`];
}

/** Frozen graph validation only; it grants neither capabilities nor execution approval. */
export function orchestrationPatternErrors(plan:PatternPlan):string[]{
 const raw=plan.orchestration?.template;if(raw===undefined)return [];
 const parsed=orchestrationTemplateSchema.safeParse(raw);
 if(!parsed.success||!registered(raw))return ['编排模板引用、版本或 definitionHash 无效'];
 const template=parsed.data,errors:string[]=[],byId=new Map(plan.tasks.map(t=>[t.id,t]));
 const fail=(message:string)=>errors.push(`${template.id}: ${message}`);
 const upstream=(id:string)=>{const found=new Set<string>(),pending=[...(byId.get(id)?.dependencies??[])];while(pending.length){const key=pending.pop()!;if(found.has(key))continue;found.add(key);pending.push(...(byId.get(key)?.dependencies??[]));}return found;};
 const bound=(values:string[])=>{if(new Set(values).size!==values.length)fail('任务绑定重复或歧义');for(const id of values)if(!byId.has(id))fail(`绑定任务 ${id} 不存在`);};
 const complete=(values:string[])=>{bound(values);if(values.length!==plan.tasks.length||plan.tasks.some(t=>!values.includes(t.id)))fail('冻结绑定必须覆盖完整任务图');};
 const readsAll=(consumerId:string,producerIds:string[])=>{
  const consumer=byId.get(consumerId),ancestors=upstream(consumerId);
  for(const id of producerIds){
   if(!ancestors.has(id)||id===consumerId)fail(`${consumerId} 必须等待 ${id}`);
   for(const output of byId.get(id)?.outputs??[])if(!consumer?.inputs?.some(i=>i.path===output.path&&i.producerTaskId===id&&!i.sha256))fail(`${consumerId} 必须读取 ${id} 的全部输出 ${output.path}`);
  }
 };
 const independent=(values:string[])=>{for(const id of values)for(const other of values)if(id!==other&&upstream(id).has(other))fail(`分支 ${id}/${other} 必须互不依赖`);};
 const join=(branches:string[],joinId:string)=>{bound([...branches,joinId]);independent(branches);readsAll(joinId,branches);};
 const layout=plan.orchestration!.pattern;
 if(template.id==='pipeline'?layout!=='pipeline':['parallel','map_reduce','proposal_review'].includes(template.id)?layout!=='parallel':!['pipeline','parallel'].includes(layout))fail('模板与协作布局不兼容');
 if(plan.agents.length>6||new Set(plan.agents.map(a=>a.id)).size!==plan.agents.length||plan.agents.filter(a=>a.role==='manager').length!==1)fail('团队必须有唯一经理且最多 6 人');
 if(plan.tasks.length>50||byId.size!==plan.tasks.length)fail('任务必须唯一且最多 50 个');
 for(const task of plan.tasks){
  if((task.inputs?.length??0)>40)fail(`${task.id} 输入最多 40 项`);
  if(task.dependencies.some(id=>!byId.has(id))||!plan.agents.some(a=>a.id===task.assigneeId))fail(`${task.id} 负责人或依赖不存在`);
  if(upstream(task.id).has(task.id))fail(`${task.id} 依赖存在环`);
 }
 // validatePlan supplies the context-aware grant checks; patterns check structure only.
 errors.push(...taskContractErrors(plan.tasks),...deliveryCriteriaErrors(plan));
 if(!plan.deliveryCriteria?.length||plan.deliveryCriteria.some(c=>!c.independent))fail('必须声明独立交付检查与经理验收');
 // User delivery criteria define the products to review; QA/manager evidence
 // files must not recursively create another independent review obligation.
 const reworkSources=new Set<string>();let rounds=0;
 for(const task of plan.tasks)if(task.kind==='review'&&task.maxReworkRounds&&byId.get(task.reviewedTaskId??'')?.kind==='implementation'&&!reworkSources.has(task.reviewedTaskId!)){
  reworkSources.add(task.reviewedTaskId!);rounds+=task.maxReworkRounds;
 }
 if(plan.tasks.length+2*rounds>50)fail('基础任务加全部批准返工展开后不能超过 50 个节点');
 switch(template.id){
  case 'pipeline':complete(template.taskIds);for(let i=1;i<template.taskIds.length;i++)if(!upstream(template.taskIds[i]).has(template.taskIds[i-1]))fail('顺序绑定必须符合完整任务先后依赖');break;
  case 'parallel':join(template.branchTaskIds,template.joinTaskId);break;
  case 'router':complete(template.selectedTaskIds);break;
  case 'orchestrator_workers':
   if(new Set(template.workItems.map(w=>w.id)).size!==template.workItems.length)fail('工作项 ID 重复');
   for(const item of template.workItems)if(byId.get(item.taskId)?.objective!==item.objective)fail(`工作项 ${item.id} 目标与冻结任务不一致`);
   join(template.workItems.map(w=>w.taskId),template.joinTaskId);break;
  case 'review_repair':{
   bound([template.reviewTaskId]);const review=byId.get(template.reviewTaskId);
   if(review?.kind!=='review'||!review.maxReworkRounds||review.maxReworkRounds<1||review.maxReworkRounds>2||byId.get(review.reviewedTaskId??'')?.kind!=='implementation')fail('返工绑定必须为批准 1..2 轮的合法独立实现审查入口');break;
  }
  case 'map_reduce':
   if(new Set(template.manifest.map(m=>m.id)).size!==template.manifest.length||new Set(template.manifest.map(m=>m.input.path)).size!==template.manifest.length)fail('分片 ID 或输入路径重复或歧义');
   for(const item of template.manifest){const inputs=byId.get(item.taskId)?.inputs;if(inputs?.length!==1||inputs[0].path!==item.input.path||inputs[0].sha256!==item.input.sha256||inputs[0].producerTaskId)fail(`分片 ${item.id} 必须恰好绑定该不可变输入`);}
   join(template.manifest.map(m=>m.taskId),template.reduceTaskId);break;
  case 'proposal_review':{
   const proposals=template.proposals.map(p=>p.proposalTaskId),critics=template.proposals.map(p=>p.critiqueTaskId);
   bound([...proposals,...critics,template.decisionTaskId]);independent(proposals);
   if(new Set(proposals.map(id=>byId.get(id)?.assigneeId)).size!==2)fail('两位提案者必须不同');
   for(const pair of template.proposals){readsAll(pair.critiqueTaskId,proposals);if(byId.get(pair.proposalTaskId)?.assigneeId===byId.get(pair.critiqueTaskId)?.assigneeId)fail('每个提案必须由他人批评');}
   if(byId.get(template.decisionTaskId)?.assigneeId!==plan.agents.find(a=>a.role==='manager')?.id)fail('裁决必须由经理承担');
   readsAll(template.decisionTaskId,[...proposals,...critics]);break;
  }
 }
 return [...new Set(errors)];
}
