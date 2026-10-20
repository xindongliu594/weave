import {bindPolicy,permissionChecks,type Agent,type Policy} from '../../../packages/contracts/index.ts';
import {AppError} from './provider.ts';
import {pool} from './db.ts';
import type pg from 'pg';
import {validateKnowledgeGrants} from './knowledge-store.ts';
import {validateProjectTeam} from './collaboration.ts';
import {localTarget} from './local-execution.ts';
import {assertNativeCapabilities} from './native-capabilities.ts';
export type ExecutionMode='legacy'|'enterprise';
export function executionMode(env:NodeJS.ProcessEnv=process.env):ExecutionMode{
 const mode=env.WEIWU_EXECUTION_MODE??'legacy';
 if(mode!=='legacy'&&mode!=='enterprise')throw new AppError(422,'WEIWU_EXECUTION_MODE 必须为 legacy 或 enterprise','EXECUTION_MODE_INVALID');
 return mode;
}
export function executionProfileForApproval(snapshot:any,mode:ExecutionMode=executionMode()){
 if(mode==='legacy')return 'legacy-run-v1' as const;
 if(snapshot.executionTarget?.kind!=='local'||snapshot.executionTarget.backend?.kind!=='openshell'||!snapshot.tasks?.length||snapshot.tasks.some((t:any)=>!Array.isArray(t.inputs)||!Array.isArray(t.outputs)||!Array.isArray(t.inScope)||!Array.isArray(t.outOfScope)))throw new AppError(422,'企业执行需要本机 OpenShell 和完整任务合同','ENTERPRISE_EXECUTION_REQUIRED');
 return 'task-attempt-openshell-v1' as const;
}
export function assertExecutionProfile(snapshot:any,mode:ExecutionMode=executionMode()){
 if(snapshot.executionProfile==='task-attempt-openshell-v1'&&snapshot.recovery)throw new AppError(422,'任务沙箱恢复链路尚未完成，请保留原恢复记录','TASK_RECOVERY_UNAVAILABLE');
 if(snapshot.executionProfile==='task-attempt-openshell-v1')throw new AppError(422,'任务沙箱执行、提交及成果消费者链路尚未完成，禁止启动','TASK_EXECUTION_UNAVAILABLE');
 if(mode==='enterprise'||snapshot.executionProfile!==undefined&&snapshot.executionProfile!=='legacy-run-v1')throw new AppError(422,'此执行模式不能运行旧执行快照，请重新批准','EXECUTION_PROFILE_DENIED');
}
export function assertPolicy(agents:Agent[],policy:Policy){
 const invalid=permissionChecks(agents,policy).filter(c=>!c.pass);
 if(invalid.length)throw new AppError(422,invalid.map(c=>c.label).join('、')+'不包含方案请求的权限；请先编辑项目策略或移除超范围配置','POLICY_PERMISSION_DENIED');
}
export function assertPlanningModel(id:string,policy:Policy){
 if(!policy.allowedModelIds?.includes(id))throw new AppError(422,'规划模型不在项目允许范围内，请先编辑项目策略','POLICY_MODEL_DENIED');
}
export async function assertRunAuthorization(row:any,db:Pick<pg.PoolClient,'query'>=pool,{requireLocalOnline=true}:{requireLocalOnline?:boolean}={}){
 assertExecutionProfile(row.snapshot);
 return assertCurrentRunPermissions(row,db,{requireLocalOnline});
}
/** Current permissions only. Launching/executing still requires assertRunAuthorization's profile gate. */
export async function assertCurrentRunPermissions(row:any,db:Pick<pg.PoolClient,'query'>=pool,{requireLocalOnline=true}:{requireLocalOnline?:boolean}={}){
 const project=(await db.query('SELECT version,department_id FROM projects WHERE id=$1',[row.project_id])).rows[0];
 if(!project||project.version!==row.project_version)throw new AppError(409,'项目已有新方案，请批准当前版本，不能恢复旧版本','RUN_REAPPROVAL_REQUIRED');
 if(!Array.isArray(row.snapshot.agents)||!row.snapshot.agents.length)throw new AppError(422,'运行快照缺少员工授权，请重新批准','RUN_REAPPROVAL_REQUIRED');
 const policy=bindPolicy(row.snapshot.policy,row.snapshot.agents,project.department_id);
 assertPolicy(row.snapshot.agents,policy);
 await validateProjectTeam(row.snapshot.agents,project.department_id,policy,db);
 await validateKnowledgeGrants(row.snapshot.agents,project.department_id,db);
 await assertNativeCapabilities(row.snapshot,db);
 if(row.snapshot.policy.executionTarget?.kind==='local'){
  const target=await localTarget(row.snapshot.policy,row.snapshot.agents,db,false);
  if(row.snapshot.executionTarget?.deviceId!==target.deviceId||row.snapshot.executionTarget?.grantId!==target.grantId||row.snapshot.executionTarget?.platform!==target.platform)throw new AppError(409,'本机运行的设备快照不一致，请重新批准','LOCAL_GRANT_CHANGED');
  if(requireLocalOnline)await localTarget(row.snapshot.policy,row.snapshot.agents,db);
 }
}
export {bindPolicy};
