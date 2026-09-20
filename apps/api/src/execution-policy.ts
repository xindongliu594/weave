import {bindPolicy,permissionChecks,type Agent,type Policy} from '../../../packages/contracts/index.ts';
import {AppError} from './provider.ts';
import {pool} from './db.ts';
import type pg from 'pg';
import {validateKnowledgeGrants} from './knowledge-store.ts';
export function assertPolicy(agents:Agent[],policy:Policy){
 const invalid=permissionChecks(agents,policy).filter(c=>!c.pass);
 if(invalid.length)throw new AppError(422,invalid.map(c=>c.label).join('、')+'不包含方案请求的权限；请先编辑项目策略或移除超范围配置','POLICY_PERMISSION_DENIED');
}
export function assertPlanningModel(id:string,policy:Policy){
 if(!policy.allowedModelIds?.includes(id))throw new AppError(422,'规划模型不在项目允许范围内，请先编辑项目策略','POLICY_MODEL_DENIED');
}
export async function assertRunAuthorization(row:any,db:Pick<pg.PoolClient,'query'>=pool){
 const project=(await db.query('SELECT version,department_id FROM projects WHERE id=$1',[row.project_id])).rows[0];
 if(!project||project.version!==row.project_version)throw new AppError(409,'项目已有新方案，请批准当前版本，不能恢复旧版本','RUN_REAPPROVAL_REQUIRED');
 if(!(await db.query('SELECT id FROM departments WHERE id=$1 AND deleted_at IS NULL FOR SHARE',[project.department_id])).rowCount)throw new AppError(409,'部门已归档，请先恢复部门并重新批准','DEPARTMENT_ARCHIVED');
 if(!Array.isArray(row.snapshot.agents)||!row.snapshot.agents.length)throw new AppError(422,'运行快照缺少员工授权，请重新批准','RUN_REAPPROVAL_REQUIRED');
 assertPolicy(row.snapshot.agents,bindPolicy(row.snapshot.policy,row.snapshot.agents));
 await validateKnowledgeGrants(row.snapshot.agents,project.department_id,db);
}
export {bindPolicy};
