import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import type pg from 'pg';
import type {IdentityQueryExecutor} from './identity-schema.ts';
import type {HumanPrincipal,Principal} from './identity-types.ts';
import {identityText} from './identity-types.ts';
import {AppError} from './provider.ts';
import {appendAudit,type AuditInput,type AuthorityEvidence} from './audit-events.ts';
import {lockDepartmentAuthority,lockActiveDepartments,currentRoutePrincipal,requireRunRoute} from './project-route-access.ts';
import {resolveRunDepartments,requireDepartments} from './resource-authorization.ts';
import {assertRestoreExecutionAdmitted} from './enterprise-restore-admission.ts';

export type RunEffect='resume'|'model'|'knowledge'|'tool'|'retry';
export type CurrentRunAuthority={principal:Principal;authority?:AuthorityEvidence;requestedByAuditId?:string};
// Provider imports the database's migration graph. Do not evaluate an AppError
// subclass while that graph is loading; create ordinary AppErrors at admission.
const denialAudits=new WeakMap<object,AuditInput>();
function deniedError(audit:AuditInput){
 const error=new AppError(403,'运行原批准人的权限已失效，请由有权人员重新批准新运行。','RUN_AUTHORITY_REVOKED');denialAudits.set(error,audit);return error;
}
const canonical=(ids:unknown):string[]|null=>Array.isArray(ids)&&ids.length>0&&ids.length<=100&&ids.every(id=>identityText(id,128))&&new Set(ids).size===ids.length?[...ids].sort():null;
/** Admission callers already own project→run. A read-only diagnostic must pass lock:false. */
export async function assertCurrentRunAuthority(db:IdentityQueryExecutor,runId:string,effect:RunEffect,{lock=true}:{lock?:boolean}={}):Promise<CurrentRunAuthority>{
 await assertRestoreExecutionAdmitted(db);
 const identity=(await db.query('SELECT project_id FROM project_runs WHERE id=$1',[runId])).rows[0];
 if(identity&&lock)await db.query('SELECT id FROM projects WHERE id=$1 FOR UPDATE',[identity.project_id]);
 const row=(await db.query(`SELECT * FROM project_runs WHERE id=$1${lock?' FOR UPDATE':''}`,[runId])).rows[0];
 const original=(await db.query("SELECT id FROM human_audit_events WHERE run_id=$1 AND action IN ('project.approve','run.recover') AND outcome='success' ORDER BY occurred_at,id LIMIT 1",[runId])).rows[0]?.id;
 const epoch=row?.authorized_epoch===null||row?.authorized_epoch===undefined?undefined:Number(row.authorized_epoch);
 const departments=canonical(row?.authority_department_ids)??[];
 const event=(state:'admitted'|'denied',authority?:AuthorityEvidence):AuditInput=>({eventId:randomUUID(),action:'run.authority',actor:{kind:'system',service:'run-coordinator'},
  ...(original?{requestedByAuditId:original}:{}),...(authority?{authority}:{}),correlation:{correlationId:randomUUID(),runId,...(identity?{projectId:identity.project_id}:{})},
  resource:{type:'run',id:runId,departmentIds:departments},outcome:state==='admitted'?'success':'denied',...(state==='denied'?{reasonCode:'authority-revoked' as const}:{}),
  changes:{effect,state,...(Number.isSafeInteger(epoch)&&epoch!>=0?{authorizedEpoch:epoch}:{})}} as AuditInput);
 const denied=()=>deniedError(event('denied'));
 if(!row||!identity||row.project_id!==identity.project_id)throw denied();
 // NULL is compatibility only in the explicitly selected local-owner mode.
 if((row.authority_kind===null||row.authority_kind==='local-owner')&&(process.env.WEIWU_AUTH_MODE??'legacy-local')==='legacy-local')return {principal:{kind:'local-owner'},requestedByAuditId:original};
 if(row.authority_kind!=='human'||!identityText(row.authorized_by_user_id,128)||!Number.isSafeInteger(epoch)||epoch!<0||!departments.length)throw denied();
 const user=(await db.query(`SELECT * FROM human_users WHERE id=$1${lock?' FOR UPDATE':''}`,[row.authorized_by_user_id])).rows[0];
 if(!user||user.status!=='active'||Number(user.session_epoch)!==epoch)throw denied();
 const principal:HumanPrincipal={kind:'human',userId:user.id,issuer:user.issuer,subject:user.subject,orgRole:user.org_role,sessionEpoch:epoch!,sessionId:'persisted-run-authority',authenticatedAt:new Date().toISOString()};
 let authority:AuthorityEvidence|undefined;
 try{
  if(lock){authority=await lockDepartmentAuthority(db,principal,departments,'operator');await lockActiveDepartments(db,departments);}
  else{await currentRoutePrincipal(db,principal);await requireDepartments(db,principal,departments,'operator');}
  const fixed=await resolveRunDepartments(db,runId),snapshot=row.snapshot;
  const actual=canonical([...(new Set([snapshot.departmentId,...(snapshot.agents??[]).map((agent:any)=>agent.sourceDepartmentId??snapshot.departmentId)]))]);
  if(!fixed||!isDeepStrictEqual(fixed,departments)||!isDeepStrictEqual(actual,departments)||!isDeepStrictEqual(canonical(snapshot.policy?.allowedDepartmentIds),departments))throw denied();
  const current=(await db.query('SELECT id,data FROM departments WHERE id=ANY($1::text[])',[departments])).rows;
  for(const agent of snapshot.agents){
   const employee=current.find(item=>item.id===(agent.sourceDepartmentId??snapshot.departmentId))?.data.agents?.find((item:any)=>item.id===(agent.sourceAgentId??agent.employeeId??agent.id));
   if(!employee||['tools','knowledgeSpaceIds','browserOrigins'].some(key=>(agent[key]??[]).some((value:string)=>!(employee[key]??[]).includes(value)))
    ||(agent.mcpConnections??[]).some((grant:any)=>!(employee.mcpConnections??[]).some((allowed:any)=>allowed.connectionId===grant.connectionId&&allowed.version===grant.version&&grant.tools.every((tool:string)=>allowed.tools.includes(tool)))))throw denied();
  }
  await requireRunRoute(db,principal,runId,'operator');
 }catch(error){if(error instanceof AppError&&denialAudits.has(error))throw error;if(error instanceof AppError&&[403,404,409,422].includes(error.status))throw denied();throw error;}
 if(lock&&authority)await appendAudit(db,event('admitted',authority));
 return {principal,authority,requestedByAuditId:original};
}

/** Call after the admission transaction and writer scope have returned a known failure. */
export async function recordRunAuthorityDenial(db:Pick<pg.Pool,'connect'>,error:unknown):Promise<void>{
 const audit=error&&typeof error==='object'?denialAudits.get(error):undefined;if(!audit)return;
 let client:pg.PoolClient|undefined,discard=false;
 try{client=await db.connect();await appendAudit(client,audit);}catch{discard=true;/* Audit failure never permits an effect. Preserve the original denial. */}
 finally{try{client?.release(discard);}catch{/* Preserve original denial. */}}
}
