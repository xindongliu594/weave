import {createHash,randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import type {Response} from 'express';
import type {IdentityQueryExecutor} from './identity-schema.ts';
import {principalKey,type Principal} from './identity-types.ts';
import {requireDepartments,requireResource,resolveProjectMaterialDepartments,visibleProjectMaterialQuery,safeSourceQuery,visibleSourceQuery,type DepartmentLevel} from './resource-authorization.ts';
import {readFileBounds,assertTargetContainsSources,type SourceBounds} from './source-bounds.ts';
import {redact} from '../../../services/agent-runtime/trace-store.mjs';
import {appendAudit,auditActor,type AuditAction,type AuditInput,type AuthorityEvidence} from './audit-events.ts';
import {AppError} from './provider.ts';

const concealed=()=>new AppError(404,'资源不存在或不可访问','RESOURCE_NOT_FOUND');
export const administrative=(principal:Principal)=>principal.kind==='local-owner'||principal.kind==='human'&&principal.orgRole==='admin';
export function httpPrincipal(res:Response):Principal{const principal=res.locals.principal;try{principalKey(principal);}catch{throw new AppError(401,'请重新登录');}return principal;}
/** Only old local service callers may omit an identity; enterprise consumers must bind one. */
export function knowledgePrincipal(principal?:Principal):Principal{
  if(principal){principalKey(principal);return principal;}
  if((process.env.WEIWU_AUTH_MODE??'legacy-local')==='legacy-local')return {kind:'local-owner'};
  throw new AppError(401,'知识消费缺少当前身份');
}
export async function currentRoutePrincipal(db:IdentityQueryExecutor,principal:Principal,lock=false){
  principalKey(principal);if(principal.kind==='local-owner')return;
  if(principal.kind!=='human')throw concealed();
  const row=(await db.query(`SELECT id FROM human_users WHERE id=$1 AND issuer=$2 AND subject=$3 AND status='active' AND org_role=$4 AND session_epoch=$5${lock?' FOR UPDATE':''}`,[principal.userId,principal.issuer,principal.subject,principal.orgRole,principal.sessionEpoch])).rows[0];
  if(!row)throw concealed();
}
/** Call after project/run locks, before department locks; identity mutation uses the same user→membership order. */
export async function lockDepartmentAuthority(db:IdentityQueryExecutor,principal:Principal,ids:string[],level:DepartmentLevel,approve=false):Promise<AuthorityEvidence>{
  await currentRoutePrincipal(db,principal,true);const departments=[...new Set(ids)].sort();
  const memberships=principal.kind==='human'?(await db.query('SELECT department_id,version FROM department_memberships WHERE user_id=$1 AND department_id=ANY($2::text[]) ORDER BY department_id FOR UPDATE',[principal.userId,departments])).rows:[];
  if(departments.length)await requireDepartments(db,principal,departments,level,{approve});else if(!administrative(principal))throw concealed();
  return {decisionId:randomUUID(),checkedAt:new Date().toISOString(),policyVersion:'project-routes-v1',principalKey:principalKey(principal),departmentIds:departments,
    membershipVersions:memberships.map(row=>({departmentId:row.department_id,version:row.version})),grantVersions:[],permissionSha256:createHash('sha256').update(JSON.stringify({principal:principalKey(principal),epoch:principal.kind==='human'?principal.sessionEpoch:null,departments,level,approve,memberships})).digest('hex')};
}
/** Retain active department state after actor/membership locks and before material writes. */
export async function lockActiveDepartments(db:IdentityQueryExecutor,ids:string[]):Promise<void>{
  const departments=[...new Set(ids)].sort();
  if(!departments.length)return;
  const locked=await db.query('SELECT id FROM departments WHERE id=ANY($1::text[]) AND deleted_at IS NULL ORDER BY id FOR SHARE',[departments]);
  if(locked.rows.length!==departments.length)throw concealed();
}
const noArray=(expression:string)=>`COALESCE(${expression},'[]'::jsonb)='[]'::jsonb`;
/** File selections are readable only through their fixed source closure. Knowledge remains closed. */
export const safePlanSql=(plan:string,policy:string)=>`jsonb_typeof(${plan})='object' AND ${noArray(`${plan}->'runInputs'`)}
  AND COALESCE(jsonb_typeof(${plan}->'knowledgeDocumentIds'),'array')='array'
  AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(${plan}->'knowledgeDocumentIds')='array' THEN ${plan}->'knowledgeDocumentIds' ELSE '[]'::jsonb END) selected
    WHERE NOT EXISTS(SELECT 1 FROM (${safeSourceQuery('knowledge-revision')}) source JOIN knowledge_documents document ON document.id=source.id AND document.version::text=source.version
      WHERE source.id=selected AND to_jsonb(source.departments) <@ (${policy}->'allowedDepartmentIds')))
  AND COALESCE(jsonb_typeof(${plan}->'workFileSelections'),'array')='array'
  AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(${plan}->'workFileSelections')='array' THEN ${plan}->'workFileSelections' ELSE '[]'::jsonb END) selection
    WHERE NOT EXISTS(SELECT 1 FROM (${safeSourceQuery('file')}) file WHERE file.id=selection->>'snapshotId'
      AND to_jsonb(file.departments) <@ (${policy}->'allowedDepartmentIds')))
  AND jsonb_typeof(${plan}->'agents')='array' AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(${plan}->'agents')='array' THEN ${plan}->'agents' ELSE '[]'::jsonb END) agent
    CROSS JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(agent->'knowledgeSpaceIds')='array' THEN agent->'knowledgeSpaceIds' ELSE '[]'::jsonb END) space_id
    WHERE NOT EXISTS(SELECT 1 FROM knowledge_spaces space WHERE space.id=space_id AND space.scope='department' AND space.deleted_at IS NULL AND (${policy}->'allowedDepartmentIds') ? space.department_id))`;
export const safeRunSql=(run:string)=>`${run}.id IN (SELECT id FROM (${safeSourceQuery('run')}) safe_run)`;
export const safeProjectSql=(project:string)=>`(${safePlanSql(`${project}.plan`,`${project}.policy`)}) AND NOT EXISTS(SELECT 1 FROM plan_versions history WHERE history.project_id=${project}.id AND (${safePlanSql('history.plan','history.policy')}) IS NOT TRUE)
  AND NOT EXISTS(SELECT 1 FROM project_runs prior WHERE prior.project_id=${project}.id AND (${safeRunSql('prior')}) IS NOT TRUE)`;
export function visibleProjectsQuery(principal:Principal,level:DepartmentLevel='viewer',parameterOffset=0){
  const visible=visibleProjectMaterialQuery(principal,level,{parameterOffset});
  return {text:`SELECT visible.id FROM (${visible.text}) visible JOIN projects safe ON safe.id=visible.id${administrative(principal)?'':` WHERE ${safeProjectSql('safe')}`}`,values:visible.values};
}
export async function requireProjectRoute(db:IdentityQueryExecutor,principal:Principal,id:string,level:DepartmentLevel,approve=false){
  const visible=visibleProjectMaterialQuery(principal,level,{approve});visible.values.push(id);
  if(!(await db.query(`SELECT id FROM (${visible.text}) visible WHERE id=$${visible.values.length}`,visible.values)).rows.length)throw concealed();
  if(!administrative(principal)&&!(await db.query(`SELECT p.id FROM projects p WHERE p.id=$1 AND ${safeProjectSql('p')}`,[id])).rows.length)throw concealed();
}
export async function requireRunRoute(db:IdentityQueryExecutor,principal:Principal,id:string,level:DepartmentLevel,approve=false){
  await requireResource(db,principal,{kind:'run',id},level,{approve});
  if(!administrative(principal)&&!(await db.query(`SELECT r.id FROM project_runs r WHERE r.id=$1 AND ${safeRunSql('r')}`,[id])).rows.length)throw concealed();
}
export async function requireFileRoute(db:IdentityQueryExecutor,principal:Principal,id:string,level:DepartmentLevel='viewer'){
  const visible=visibleSourceQuery(principal,'file',level);visible.values.push(id);
  if(!(await db.query(`SELECT id FROM (${visible.text}) visible WHERE id=$${visible.values.length}`,visible.values)).rows.length)throw concealed();
}
export type FileConsumerAuthority={principal:Principal;targetDepartmentIds:string[];targetAdminOnly?:boolean};
export async function authorizeFileSelection(db:IdentityQueryExecutor,id:string,authority?:FileConsumerAuthority):Promise<SourceBounds>{
  if(!authority&&(process.env.WEIWU_AUTH_MODE??'legacy-local')!=='legacy-local')throw concealed();
  const principal:Principal=authority?.principal??{kind:'local-owner'};
  await requireFileRoute(db,principal,id);
  const bounds=await readFileBounds(db,id);
  if(authority)assertTargetContainsSources(authority.targetDepartmentIds,bounds,{targetAdminOnly:authority.targetAdminOnly===true&&administrative(principal)});
  return bounds;
}
/** Check database ownership before calling this after an archive read. */
export function assertRunArchiveBinding(principal:Principal,row:any,run:any){
  if(!run)throw new AppError(404,'运行不存在');
  if(administrative(principal))return;
  const fixed=redact({id:row.id,createdAt:run.snapshot.createdAt,formatVersion:1,...row.snapshot});
  if(!fixed||typeof fixed!=='object'||Array.isArray(fixed))throw new AppError(409,'运行档案与固定数据库版本不一致','RUN_ARCHIVE_INVALID');
  const expected={...fixed,id:row.id};
  if(run.integrity!=='ok'||!isDeepStrictEqual(run.snapshot,expected))throw new AppError(409,'运行档案与固定数据库版本不一致','RUN_ARCHIVE_INVALID');
}
export async function lockProjectAuthority(db:IdentityQueryExecutor,principal:Principal,project:any,level:DepartmentLevel='operator',approve=false){
  const departments=await resolveProjectMaterialDepartments(db,project.id);
  if(!departments&&!administrative(principal))throw concealed();
  const evidence=await lockDepartmentAuthority(db,principal,departments??[project.department_id],level,approve);
  await requireProjectRoute(db,principal,project.id,level,approve);return evidence;
}
/** Reconstruct a durable approval, never a browser session or a body-supplied actor. */
export async function persistedProjectPrincipal(db:IdentityQueryExecutor,row:any):Promise<Principal>{
  if(row.authority_kind==='human'){
    const user=(await db.query('SELECT * FROM human_users WHERE id=$1 FOR UPDATE',[row.authorized_by_user_id])).rows[0];
    if(!user||user.status!=='active'||Number(user.session_epoch)!==Number(row.authorized_epoch)||row.authorized_epoch===null)throw concealed();
    return {kind:'human',userId:user.id,issuer:user.issuer,subject:user.subject,orgRole:user.org_role,sessionEpoch:Number(row.authorized_epoch),sessionId:'persisted-project-authority',authenticatedAt:new Date().toISOString()};
  }
  if((row.authority_kind==='local-owner'||row.authority_kind===null)&&(process.env.WEIWU_AUTH_MODE??'legacy-local')==='legacy-local')return {kind:'local-owner'};
  throw concealed();
}
export async function authorizeProjectMessage(db:IdentityQueryExecutor,message:any,project:any){
  const principal=await persistedProjectPrincipal(db,message),evidence=await lockProjectAuthority(db,principal,project);
  if(message.authority_kind!==null&&!isDeepStrictEqual(message.authority_department_ids,evidence.departmentIds))throw concealed();
}
export function assertMemberPlan(principal:Principal,plan:any){
  if(administrative(principal))return;
  if(plan.runInputs?.length)throw new AppError(403,'直接输入的成员来源保护尚未开放','RESOURCE_SOURCE_RESTRICTED');
}
/** A project-wide union is not a grant to move one employee's powers to another. */
export function assertMemberAgentGrants(principal:Principal,next:any[],before:any[]){
  if(administrative(principal))return;
  const original=new Map(before.map(agent=>[agent.id,agent]));
  for(const agent of next){
    const previous=original.get(agent.id),models=previous?[previous.modelId,previous.fallbackModelId].filter(Boolean):[];
    if(!previous||agent.sourceDepartmentId!==previous.sourceDepartmentId||agent.sourceAgentId!==previous.sourceAgentId
      ||[agent.modelId,agent.fallbackModelId].filter(Boolean).some(id=>!models.includes(id))
      ||['tools','knowledgeSpaceIds','browserOrigins'].some(key=>(agent[key]??[]).some((value:string)=>!(previous[key]??[]).includes(value)))
      ||(agent.mcpConnections??[]).some((grant:any)=>!(previous.mcpConnections??[]).some((allowed:any)=>allowed.connectionId===grant.connectionId&&allowed.version===grant.version&&grant.tools.every((tool:string)=>allowed.tools.includes(tool)))))
      throw new AppError(403,'员工模型、工具和连接授权扩展需要管理员批准','PROJECT_GRANT_ADMIN_REQUIRED');
  }
}
export function assertMemberPolicy(principal:Principal,next:any,before:any){
  if(administrative(principal))return;
  if(next.maxBudget>before.maxBudget||next.maxModelCalls>(before.maxModelCalls??0)||next.maxTaskModelCalls>(before.maxTaskModelCalls??0)
    ||!isDeepStrictEqual(next.executionTarget,before.executionTarget)||next.mode!==before.mode
    ||['allowedModelIds','allowedTools','allowedKnowledgeSpaceIds','allowedDepartmentIds'].some(key=>(next[key]??[]).some((value:string)=>!(before[key]??[]).includes(value))))throw new AppError(403,'预算与权限扩展需要管理员批准','RESOURCE_BUDGET_ADMIN_REQUIRED');
}
export async function assertMemberCreation(db:IdentityQueryExecutor,principal:Principal,departments:string[],policy:any,agents:any[]){
  if(administrative(principal))return;assertMemberPlan(principal,{agents});
  const rows=(await db.query('SELECT data FROM departments WHERE id=ANY($1::text[])',[departments])).rows;
  if(rows.length!==departments.length||rows.some(row=>!Number.isFinite(row.data.dailyBudget)||policy.maxBudget>row.data.dailyBudget))throw new AppError(403,'新项目须使用管理员已分配的部门预算','RESOURCE_BUDGET_ADMIN_REQUIRED');
  const allowed={...policy,mode:undefined,executionTarget:undefined,allowedDepartmentIds:departments,allowedModelIds:agents.flatMap(agent=>[agent.modelId,agent.fallbackModelId].filter(Boolean)),allowedTools:agents.flatMap(agent=>agent.tools),allowedKnowledgeSpaceIds:agents.flatMap(agent=>agent.knowledgeSpaceIds??[])};
  assertMemberPolicy(principal,policy,allowed);
}
export function assertManagerDepartmentChange(principal:Principal,before:any,after:any){
  if(administrative(principal))return;
  const grants=(data:any)=>({dailyBudget:data.dailyBudget,agents:data.agents.map((agent:any)=>Object.fromEntries(['id','modelId','fallbackModelId','tools','knowledgeSpaceIds','browserOrigins','mcpConnections','sourceDepartmentId','sourceAgentId'].map(key=>[key,agent[key]]))).sort((a:any,b:any)=>a.id.localeCompare(b.id))});
  if(!isDeepStrictEqual(grants(before),grants(after)))throw new AppError(403,'部门经理只能修改本部门非财务配置；预算、模型和工具授权需管理员','DEPARTMENT_GRANT_ADMIN_REQUIRED');
}
export function employeeRestoreAllowed(principal:Principal,current:any,agent:any){
  if(administrative(principal))return true;
  const existing=current.agents??[],models=existing.flatMap((item:any)=>[item.modelId,item.fallbackModelId].filter(Boolean));
  return [agent.modelId,agent.fallbackModelId].filter(Boolean).every(value=>models.includes(value))
    &&['tools','knowledgeSpaceIds','browserOrigins','mcpConnections'].every(key=>(agent[key]??[]).every((value:unknown)=>existing.some((item:any)=>(item[key]??[]).some((allowed:unknown)=>isDeepStrictEqual(value,allowed)))))
    &&!agent.sourceDepartmentId&&!agent.sourceAgentId;
}
export async function routeAudit(db:IdentityQueryExecutor,principal:Principal,authority:AuthorityEvidence,action:AuditAction,id:string,changes:Record<string,unknown>,correlation:{projectId?:string;runId?:string}={}){
  const eventId=randomUUID(),requestId=randomUUID(),type=action.startsWith('department.')?'department':action.startsWith('employee.')?'employee':action.startsWith('run.')?'run':'project';
  await appendAudit(db,{eventId,action,actor:auditActor(principal),authority,correlation:{correlationId:requestId,requestId,...correlation},resource:{type,id,departmentIds:authority.departmentIds},outcome:'success',changes} as AuditInput);
}

export async function migrateProjectRoutes(db:IdentityQueryExecutor){
  await db.query(`ALTER TABLE manager_messages ADD COLUMN IF NOT EXISTS authorized_by_user_id text REFERENCES human_users(id);
    ALTER TABLE manager_messages ADD COLUMN IF NOT EXISTS authorized_epoch bigint CHECK(authorized_epoch BETWEEN 0 AND 9007199254740991);
    ALTER TABLE manager_messages ADD COLUMN IF NOT EXISTS authority_kind text CHECK(authority_kind IN ('human','local-owner'));
    ALTER TABLE manager_messages ADD COLUMN IF NOT EXISTS authority_department_ids text[];`);
}
