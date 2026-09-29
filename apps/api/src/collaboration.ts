import type pg from 'pg';
import type {Agent,Policy} from '../../../packages/contracts/index.ts';
import {AppError} from './provider.ts';
import {pool} from './db.ts';

type Database=Pick<pg.PoolClient,'query'>;
type DepartmentRow={id:string;version:number;data:{name:string;agents:Agent[]}};
export type CollaboratingAgent={departmentId:string;agentId:string};

export function sourceDepartmentId(agent:Partial<Agent>,primaryDepartmentId:string){return agent.sourceDepartmentId??primaryDepartmentId;}
export function sourceAgentId(agent:Partial<Agent>){return agent.sourceAgentId??agent.id!;}
export function participantDepartmentIds(agents:Partial<Agent>[],primaryDepartmentId:string){return [...new Set([primaryDepartmentId,...agents.map(a=>sourceDepartmentId(a,primaryDepartmentId))])];}

export function assertProjectProvenance(next:Agent[],current:Agent[]){
  const currentById=new Map(current.map(agent=>[agent.id,agent]));
  for(const agent of next){
    const before=currentById.get(agent.id);
    const beforeSource=before?.sourceDepartmentId||before?.sourceAgentId;
    const nextSource=agent.sourceDepartmentId||agent.sourceAgentId;
    if(beforeSource&&(agent.sourceDepartmentId!==before!.sourceDepartmentId||agent.sourceAgentId!==before!.sourceAgentId))throw new AppError(422,`${agent.name} 的原部门和员工身份不能在方案中修改`,'COLLABORATOR_PROVENANCE_CHANGED');
    if(nextSource&&!beforeSource)throw new AppError(422,'不能通过编辑方案新增或伪造部门员工来源；请新建跨部门项目','COLLABORATOR_PROVENANCE_CHANGED');
  }
}

export async function buildProjectTeam(primary:DepartmentRow,selections:CollaboratingAgent[],db:Database=pool):Promise<{agents:Agent[];departments:DepartmentRow[]}> {
  const unique=new Map<string,CollaboratingAgent>();
  for(const item of selections){
    if(item.departmentId===primary.id)throw new AppError(422,'主部门员工无需重复添加为协作员工','COLLABORATOR_INVALID');
    unique.set(item.departmentId+'\0'+item.agentId,item);
  }
  const departmentIds=[...new Set([...unique.values()].map(item=>item.departmentId))].sort();
  const rows=departmentIds.length?(await db.query('SELECT id,version,data FROM departments WHERE id=ANY($1::text[]) AND deleted_at IS NULL ORDER BY id',[departmentIds])).rows as DepartmentRow[]:[];
  const byId=new Map(rows.map(row=>[row.id,row]));
  const agents:Agent[]=primary.data.agents.map(agent=>({...agent,sourceDepartmentId:primary.id,sourceAgentId:agent.id}));
  for(const item of unique.values()){
    const department=byId.get(item.departmentId);
    if(!department)throw new AppError(422,'协作部门不存在或已归档','COLLABORATOR_INVALID');
    const employee=department.data.agents.find(agent=>agent.id===item.agentId);
    if(!employee)throw new AppError(422,`「${department.data.name}」中的协作员工已不存在`,'COLLABORATOR_INVALID');
    agents.push({...employee,id:`${department.id}::${employee.id}`,role:'member',sourceDepartmentId:department.id,sourceAgentId:employee.id});
  }
  if(agents.length>6)throw new AppError(422,'主部门与协作员工合计不能超过 6 人，请减少协作员工','COLLABORATOR_LIMIT');
  return {agents,departments:[primary,...rows]};
}

export async function validateProjectTeam(agents:Agent[],primaryDepartmentId:string,policy:Policy,db:Database=pool){
  const allowed=new Set(policy.allowedDepartmentIds??[primaryDepartmentId]);
  const departmentIds=participantDepartmentIds(agents,primaryDepartmentId);
  const outside=departmentIds.filter(id=>!allowed.has(id));
  if(outside.length)throw new AppError(422,'方案包含未由项目批准的协作部门','POLICY_DEPARTMENT_DENIED');
  const rows=(await db.query('SELECT id,version,data FROM departments WHERE id=ANY($1::text[]) AND deleted_at IS NULL ORDER BY id FOR SHARE',[departmentIds.sort()])).rows as DepartmentRow[];
  if(rows.length!==departmentIds.length)throw new AppError(409,'参与部门已归档，请恢复部门或创建新项目','DEPARTMENT_ARCHIVED');
  const byId=new Map(rows.map(row=>[row.id,row]));
  const pairs=new Set<string>();
  for(const agent of agents){
    if(agent.role==='manager'&&sourceDepartmentId(agent,primaryDepartmentId)!==primaryDepartmentId)throw new AppError(422,'项目经理必须来自主部门','COLLABORATOR_INVALID');
    if(!agent.sourceDepartmentId&&!agent.sourceAgentId)continue;
    if(!agent.sourceDepartmentId||!agent.sourceAgentId)throw new AppError(422,`${agent.name} 的员工来源不完整`,'COLLABORATOR_INVALID');
    const pair=agent.sourceDepartmentId+'\0'+agent.sourceAgentId;
    if(pairs.has(pair))throw new AppError(422,'同一位部门员工不能在方案中重复出现','COLLABORATOR_INVALID');pairs.add(pair);
    if(!byId.get(agent.sourceDepartmentId)?.data.agents.some(item=>item.id===agent.sourceAgentId))throw new AppError(409,`${agent.name} 已不在原部门，请修改方案后重新批准`,'COLLABORATOR_REMOVED');
  }
  return rows.map(row=>({id:row.id,name:row.data.name,version:row.version}));
}
