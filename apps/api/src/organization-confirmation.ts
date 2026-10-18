import type pg from 'pg';
import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {z} from 'zod';
import {bindPolicy,policySchema,validatePlan,type Model} from '../../../packages/contracts/index.ts';
import {taskContractErrors} from '../../../packages/contracts/task-contracts.mjs';
import {resolveOrganizationCandidate} from './organization-routing.ts';
import {assertPolicy} from './execution-policy.ts';
import {plannedAcceptanceErrors} from './execution-prompt.ts';
import {shareCostMaintenance} from './cost-control.ts';
import {AppError} from './provider.ts';
import {assertOrganizationTurn} from './organization-turns.ts';

export async function confirmOrganizationDraft(client:pg.PoolClient,previewId:string,previewVersion:number){
 await client.query('BEGIN');
 try{
  await shareCostMaintenance(client);
  const observed=(await client.query('SELECT data,project_id FROM organization_previews WHERE id=$1',[previewId])).rows[0];
  if(observed?.data.conversationId&&!observed.project_id)await assertOrganizationTurn(client,observed.data,previewId);
  const preview=(await client.query('SELECT * FROM organization_previews WHERE id=$1 FOR UPDATE',[previewId])).rows[0];
  if(!preview||preview.data.kind!=='organization-v2')throw new AppError(404,'任务组队草案不存在','ORGANIZATION_PREVIEW_NOT_FOUND');
  const draft=preview.data;
  if(draft.previewVersion!==previewVersion)throw new AppError(409,'草案版本已变化，请重新查看','VERSION_CONFLICT');
  if(preview.project_id&&draft.confirmation){await client.query('COMMIT');return {...draft.confirmation,existing:true};}
  if(preview.project_id||draft.supersededBy)throw new AppError(409,'该草案已保存或已被后续需求替代，请查看最新方案','ORGANIZATION_PREVIEW_STALE');
  const policy=policySchema.parse(draft.policy),requirement=z.string().trim().min(10).max(50000).parse(draft.requirement);
  if(draft.costAccounting!=='conversation')throw new AppError(409,'草案计费来源不匹配，请重新整理方案','PLANNING_PREVIEW_MISMATCH');
  // Lock all source rows in a stable order before re-resolving any employee grant.
  const ids=(draft.sourceDepartmentVersions??[]).map((d:any)=>d.id).sort();
  if(ids.length)await client.query('SELECT id FROM departments WHERE id=ANY($1::text[]) ORDER BY id FOR SHARE',[ids]);
  const resolved=await resolveOrganizationCandidate(draft.candidate,policy,client);
  if(!isDeepStrictEqual(resolved.plan,draft.plan))throw new AppError(409,'员工配置或方案已变化，请重新生成草案','ORGANIZATION_SOURCE_CHANGED');
  const departmentId=resolved.candidate.target.kind==='existing'?resolved.candidate.target.departmentId:randomUUID();
  const departmentVersion=resolved.candidate.target.kind==='existing'?resolved.candidate.target.departmentVersion:1;
  const plan=resolved.plan;
  if(resolved.candidate.target.kind==='new')plan.agents=plan.agents.map(a=>({...a,roleVersion:1}));
  const bound=bindPolicy({...policy,allowedDepartmentIds:[...new Set([...(policy.allowedDepartmentIds??[]),departmentId])]},plan.agents,departmentId);
  assertPolicy(plan.agents,bound);
  const rows=(await client.query('SELECT id,data,version,status,capabilities FROM models WHERE deleted_at IS NULL')).rows;
  const models:Model[]=rows.map(r=>({...r.data,id:r.id,version:r.version,status:r.status,capabilities:r.capabilities}));
  const validation=validatePlan(plan,bound,models,false),errors=[...validation.errors,...taskContractErrors(plan.tasks,plan.agents),...plannedAcceptanceErrors(plan.tasks)];
  if(errors.length)throw new AppError(422,'方案暂不能保存：'+[...new Set(errors)].join('；'),'ORGANIZATION_CHAT_PLAN_INVALID');
  if(resolved.candidate.target.kind==='new')await client.query('INSERT INTO departments(id,data) VALUES($1,$2)',[departmentId,{...resolved.department,agents:plan.agents}]);
  const projectId=randomUUID();
  await client.query('INSERT INTO projects(id,department_id,department_version,department_name,requirement,policy,plan,source) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[projectId,departmentId,departmentVersion,resolved.department.name,requirement,bound,plan,'model']);
  await client.query('INSERT INTO plan_versions(project_id,version,plan,policy) VALUES($1,1,$2,$3)',[projectId,plan,bound]);
  const confirmation={departmentId,projectId,departmentVersion,projectVersion:1};
  await client.query('UPDATE organization_previews SET project_id=$1,department_id=$2,data=$3 WHERE id=$4',[projectId,departmentId,{...draft,confirmation},previewId]);
  await client.query('INSERT INTO activity(id,kind,title) VALUES($1,$2,$3)',[randomUUID(),'project',`确认「${resolved.department.name}」任务组队方案并创建项目`]);
  await client.query('COMMIT');return {...confirmation,existing:false};
 }catch(error){await client.query('ROLLBACK');throw error;}
}
