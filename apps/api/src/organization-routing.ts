import type pg from 'pg';
import {departmentSchema,permissionChecks,orchestrationPatterns,orchestrationPatternErrors,type Agent,type Plan,type Policy} from '../../../packages/contracts/index.ts';
import {organizationCandidateV2Schema,type OrganizationCandidateV2} from '../../../packages/contracts/organization.ts';
import {deliveryCriteriaErrors} from '../../../packages/contracts/orchestration.ts';
import {buildProjectTeam} from './collaboration.ts';
import {AppError} from './provider.ts';

type Database=Pick<pg.PoolClient,'query'>;
type DepartmentRow={id:string;version:number;data:{name:string;description:string;agents:Agent[]}};
export async function loadOrganizationCatalog(db:Database,policy:Policy){
 const ids=policy.allowedDepartmentIds??[];
 const rows:DepartmentRow[]=ids.length?(await db.query('SELECT id,version,data FROM departments WHERE id=ANY($1::text[]) AND deleted_at IS NULL ORDER BY id LIMIT 21',[ids])).rows:[];
 return {catalogTruncated:rows.length>20,departments:rows.slice(0,20).map(d=>({id:d.id,version:d.version,name:d.data.name,description:d.data.description.slice(0,500),agents:d.data.agents.map(a=>({id:a.id,name:a.name,role:a.role,title:a.title,modelId:a.modelId,tools:a.tools.filter(t=>policy.allowedTools?.includes(t))}))}))};
}

export async function resolveOrganizationCandidate(raw:OrganizationCandidateV2,policy:Policy,db:Database){
 const candidate=organizationCandidateV2Schema.parse(raw),target=candidate.target;
 let department:ReturnType<typeof departmentSchema.parse>,sourceDepartmentVersions:{id:string;version:number}[]=[];
 if(target.kind==='new'){
  department=target.department;
  if(department.dailyBudget!==undefined||department.agents.some(a=>a.sourceDepartmentId||a.sourceAgentId||a.fallbackModelId||a.browserOrigins?.length||a.mcpConnections?.length||a.knowledgeSpaceIds?.length||a.tools.some(t=>['browser_read','mcp_call_readonly'].includes(t))))throw new AppError(422,'新部门方案不能额外设置来源、知识、浏览器、MCP 或每日预算','ORGANIZATION_SCOPE_DENIED');
 }else{
  const selected=[{id:target.departmentId,version:target.departmentVersion},...target.collaboratingAgents.map(a=>({id:a.departmentId,version:a.departmentVersion}))];
  if(selected.some(d=>!policy.allowedDepartmentIds?.includes(d.id)))throw new AppError(422,'参与部门不在本次授权范围','ORGANIZATION_SCOPE_DENIED');
  if(new Set(target.collaboratingAgents.map(a=>a.departmentId+'\0'+a.agentId)).size!==target.collaboratingAgents.length)throw new AppError(422,'借用员工不能重复','COLLABORATOR_INVALID');
  const rows:DepartmentRow[]=(await db.query('SELECT id,version,data FROM departments WHERE id=ANY($1::text[]) AND deleted_at IS NULL ORDER BY id',[selected.map(d=>d.id)])).rows;
  for(const item of selected)if(!rows.some(row=>row.id===item.id&&row.version===item.version))throw new AppError(409,'来源部门版本已变化或已归档，请重新生成方案','ORGANIZATION_SOURCE_CHANGED');
  const primary=rows.find(d=>d.id===target.departmentId)!;
  const team=await buildProjectTeam(primary,target.collaboratingAgents,db,target.primaryAgentIds);
  // Resolve against the exact versions used to build the team, including a concurrent edit.
  for(const d of team.departments)if(!selected.some(s=>s.id===d.id&&s.version===d.version))throw new AppError(409,'来源部门版本已变化，请重新生成方案','ORGANIZATION_SOURCE_CHANGED');
  sourceDepartmentVersions=team.departments.map(d=>({id:d.id,version:d.version}));
  department={name:primary.data.name,description:primary.data.description,agents:team.agents.map(a=>({...a,
   tools:a.tools.filter(t=>policy.allowedTools?.includes(t)),knowledgeSpaceIds:(a.knowledgeSpaceIds??[]).filter(id=>policy.allowedKnowledgeSpaceIds?.includes(id)),
   ...(!policy.allowedTools?.includes('browser_read')?{browserOrigins:[]}:{}),...(!policy.allowedTools?.includes('mcp_call_readonly')?{mcpConnections:[]}:{}),
  }))};
 }
 if(department.agents.length>policy.maxAgents)throw new AppError(422,'团队人数超过本次人数上限','COLLABORATOR_LIMIT');
 if(permissionChecks(department.agents,policy).some(c=>!c.pass))throw new AppError(422,'员工模型或能力超出本次授权范围','ORGANIZATION_SCOPE_DENIED');
 const plan:Plan={agents:department.agents,rationale:candidate.rationale,tasks:candidate.tasks,orchestration:candidate.orchestration,deliveryCriteria:candidate.deliveryCriteria};
 const errors=[...new Set([...deliveryCriteriaErrors(plan),...orchestrationPatternErrors(plan)])];if(errors.length)throw new AppError(422,errors.join('；'),'ORGANIZATION_CHAT_PLAN_INVALID');
 return {kind:'organization-v2' as const,candidate,department,plan,sourceDepartmentVersions};
}

// Examples describe bindings only. Definitions, versions and hashes come from the
// contract registry; this planning catalog grants no execution or tool permission.
const bindingExamples={
 pipeline:{taskIds:['write','check','deliver']},
 parallel:{branchTaskIds:['a','b'],joinTaskId:'join'},
 router:{routeKey:'research',selectedTaskIds:['write','check','deliver']},
 orchestrator_workers:{workItems:[{id:'part_a',taskId:'a',objective:'与任务 a 的 objective 完全一致'},{id:'part_b',taskId:'b',objective:'与任务 b 的 objective 完全一致'}],joinTaskId:'join'},
 review_repair:{reviewTaskId:'review'},
 map_reduce:{manifest:[{id:'part_a',taskId:'a',input:{path:'input_a.txt',sha256:'a'.repeat(64)}},{id:'part_b',taskId:'b',input:{path:'input_b.txt',sha256:'b'.repeat(64)}}],reduceTaskId:'join'},
 proposal_review:{proposals:[{proposalTaskId:'a',critiqueTaskId:'critique_a'},{proposalTaskId:'b',critiqueTaskId:'critique_b'}],decisionTaskId:'decision'},
};
export const organizationOrchestrationCatalog=orchestrationPatterns.map(p=>({id:p.id,name:p.name,description:p.description,applicability:p.applicability,limits:p.limits,binding:p.binding,previewOnly:true,acceptance:'离线校验，待真实验收',templateExample:{schemaVersion:p.schemaVersion,id:p.id,version:p.version,definitionHash:p.definitionHash,...bindingExamples[p.id]}}));
export const organizationRoutingInstructions='当启用任务组队时，candidate 必须为 schemaVersion:2；从 organizationCatalog 推荐适合的已有部门及员工，目录没有合适对象时提出 target.kind=new 的待确认部门。existing 只填目录 ID 和版本，主部门经理必须参加；借用员工任务负责人 ID 使用 departmentId::agentId，不复制或编造员工权限。旧协作布局 single/pipeline/parallel 保持可用；可省略 orchestration.template 沿用旧路径。orchestrationCatalog 七种新模板本轮仅离线预览、待真实验收，保存和确认不授予执行权，普通批准或自动批准也不能执行。根据真实需要选模式或解释能力缺口，不能为凑模板增加工具或人数。选择模板时把 templateExample 中的引用版本和 definitionHash 原样填入 orchestration.template，按实际任务 ID 替换绑定例子，批准前冻结路由、拆分、分片和提案轮次；不运行时派生或条件跳过。基础任务数加每个独立合法返工入口批准轮数的两倍之和最多 50，每任务输入最多 40。review_repair 可预览 1..2 轮返工，仍不能执行。每条用户交付要求列入 deliveryCriteria，绑定产出任务、其后的检查任务和验收条目索引；存在 orchestration.template 时，每条 deliveryCriteria 都必须 independent=true，检查者与所有产出作者不同；无模板引用时沿用旧规则：需要独立核对时 independent=true，作者不能自验。经理等待必要检查再交付。orchestration.rationale 解释选人和协作依据，不能声称已经真实验收。';
