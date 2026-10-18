import type pg from 'pg';
import {departmentSchema,permissionChecks,type Agent,type Plan,type Policy} from '../../../packages/contracts/index.ts';
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
 const errors=deliveryCriteriaErrors(plan);if(errors.length)throw new AppError(422,errors.join('；'),'ORGANIZATION_CHAT_PLAN_INVALID');
 return {kind:'organization-v2' as const,candidate,department,plan,sourceDepartmentVersions};
}

export const organizationRoutingInstructions='当启用任务组队时，candidate 必须为 schemaVersion:2；从 organizationCatalog 推荐适合的已有部门及员工，目录没有合适对象时提出 target.kind=new 的待确认部门。existing 只填目录 ID 和版本，主部门经理必须参加；借用员工任务负责人 ID 使用 departmentId::agentId，不复制或编造员工权限。协作模式 single/pipeline/parallel 只是建议，任务 DAG 按实际依赖生成。每条用户交付要求列入 deliveryCriteria，绑定产出任务、其后的检查任务和验收条目索引；需要独立核对时 independent=true，作者不能自验。经理等待必要检查再交付；没有合适能力要解释缺口。orchestration.rationale 解释选人和协作依据，不能声称命中了尚不存在的历史模板。';
