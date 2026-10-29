import type pg from 'pg';
import type {EnterpriseBackupV2} from './enterprise-backup-schema.ts';
import {AppError} from './provider.ts';
import {createHash,randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import type {Principal} from './identity-types.ts';
import {principalKey} from './identity-types.ts';
import {loadHumanPrincipal,lockIdentityAdministration} from './identity-store.ts';
import {appendAudit,auditActor} from './audit-events.ts';

type Database=Pick<pg.PoolClient,'query'>;
export type RestoreDb=Database;
type RestoreResource='native'|'mcp'|'device'|'schedule'|'contract';
const resourceKinds:RestoreResource[]=['native','mcp','device','schedule','contract'];
const emptyResources=():Record<RestoreResource,string[]>=>({native:[],mcp:[],device:[],schedule:[],contract:[]});
function validResources(value:any):value is Record<RestoreResource,string[]>{return value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===resourceKinds.length&&resourceKinds.every(kind=>Array.isArray(value[kind])&&value[kind].every((id:any)=>typeof id==='string')&&new Set(value[kind]).size===value[kind].length);}

/** Target-local state only. An active label is insufficient: its original
 * receipt, generation and successful human activation audit must also agree. */
export async function readRestoreAdmission(db:Database){
 const {rows}=await db.query(`SELECT m.*,r.database_id AS receipt_database_id,
  r.previous_generation::text,r.next_generation::text,r.manifest_sha256,
  a.database_id AS local_database_id,a.generation::text AS local_generation,a.enterprise_restore_operation_id::text AS expected_enterprise_operation_id,
  EXISTS(SELECT 1 FROM human_audit_events e WHERE e.schema_version=2 AND e.action='backup.restore'
   AND e.resource_type='backup' AND e.resource_id=m.operation_id::text AND e.actor_kind='human'
   AND e.actor_user_id=m.activated_by AND e.outcome='success' AND e.changes->>'state'='restored'
   AND e.changes->>'sha256'=m.input_digest AND e.occurred_at>=m.restored_at) AS activation_audit_verified
  FROM backup_restore_anchor a LEFT JOIN enterprise_restore_admission m ON true
  LEFT JOIN backup_restore_receipts r ON r.operation_id=m.operation_id LIMIT 2`);
 if(rows.length!==1)return {status:'inconsistent',verified:false} as const;
 const row=rows[0],hex=/^[a-f0-9]{64}$/;
 if(row.operation_id===null&&row.expected_enterprise_operation_id===null)return null;
 const generations=typeof row.previous_generation==='string'&&/^\d+$/.test(row.previous_generation)&&typeof row.next_generation==='string'&&/^\d+$/.test(row.next_generation)&&BigInt(row.previous_generation)+1n===BigInt(row.next_generation);
 const receiptVerified=row.expected_enterprise_operation_id===row.operation_id&&hex.test(row.input_digest??'')&&hex.test(row.manifest_sha256??'')&&generations&&row.local_generation===row.next_generation&&row.receipt_database_id===row.local_database_id&&!!row.restored_at&&validResources(row.pending_resources);
 const verified=row.status==='active'&&receiptVerified&&!!row.activated_by&&!!row.activated_at&&row.activation_audit_verified===true;
 return {...row,receiptVerified,verified};
}
export async function restoreExecutionBlocked(db:Database){const state=await readRestoreAdmission(db);return state!==null&&!state.verified;}
export async function assertRestoreExecutionAdmitted(db:Database):Promise<void>{
 const state=await readRestoreAdmission(db);if(state===null||state.verified)return;
 if(state.status==='quarantined')throw new AppError(409,'恢复环境处于隔离状态，请重新登录并完成恢复核对后再执行。','BACKUP_RESTORED_ENVIRONMENT_QUARANTINED');
 throw new AppError(409,'恢复的激活记录或回执尚未通过核对，执行已阻止。','BACKUP_RESTORE_RECONCILIATION_REQUIRED');
}
export async function restoreResourcePending(db:Database,kind:RestoreResource,id:string):Promise<boolean>{
 const state=await readRestoreAdmission(db);if(state===null)return false;
 if(!('pending_resources' in state)||!validResources(state.pending_resources))throw new AppError(409,'恢复资源授权记录不完整，执行已阻止。','BACKUP_RESTORE_RECONCILIATION_REQUIRED');
 return state.pending_resources[kind].includes(id);
}
export async function assertRestoredResourceAdmitted(db:Database,kind:RestoreResource,id:string):Promise<void>{
 await assertRestoreExecutionAdmitted(db);
 if(await restoreResourcePending(db,kind,id))throw new AppError(409,'恢复的此版本资源尚未重新授权，请在目标环境核对并配置。','BACKUP_RESOURCE_REAUTHORIZATION_REQUIRED');
}
/** Only called by existing authenticated administration actions, after their
 * own validation. Exact version acknowledgement cannot revive other versions. */
export async function acknowledgeRestoredResourceIn(db:Database,kind:RestoreResource,id:string):Promise<void>{
 await assertRestoreExecutionAdmitted(db);
 if(await restoreResourcePending(db,kind,id))await db.query('UPDATE enterprise_restore_admission SET pending_resources=jsonb_set(pending_resources,ARRAY[$1],(pending_resources->$1)-$2)',[kind,id]);
}
/** Caller owns a transaction and the physical restore verification fence. This
 * function validates the target login and records activation atomically. */
export async function activateRestoredEnvironmentIn(db:Database,principal:Principal,input:{operationId:string;inputDigest:string}):Promise<void>{
 for(const lock of [918274,918275])await db.query(`SELECT pg_advisory_xact_lock(${lock})`);
 await db.query('SELECT operation_id FROM enterprise_restore_admission ORDER BY operation_id FOR UPDATE');
 const state=await readRestoreAdmission(db);
 if(!state||!('operation_id' in state)||state.operation_id!==input.operationId||state.input_digest!==input.inputDigest)throw new AppError(409,'恢复操作或备份摘要已变化，请重新核对。','BACKUP_ACTIVATION_INPUT_CHANGED');
 if(!state.receiptVerified||(state.status==='active'&&!state.verified))throw new AppError(409,'恢复回执尚未核对，不能激活。','BACKUP_RESTORE_RECONCILIATION_REQUIRED');
 const denied=()=>new AppError(403,'请使用原身份提供方的当前管理员账户，在目标环境重新登录。','BACKUP_ACTIVATION_REAUTHENTICATION_REQUIRED');
 try{principalKey(principal);}catch{throw denied();}
 if(principal.kind!=='human'||principal.orgRole!=='admin')throw denied();
 await lockIdentityAdministration(db);
 if(state.source_issuer!==null){if(principal.issuer!==state.source_issuer)throw denied();}
 else{
  const bootstrap=(await db.query('SELECT * FROM identity_bootstrap WHERE id=1')).rows[0];
  if(state.source_bootstrap_virgin!==true||!bootstrap?.expected_fingerprint||bootstrap.closed_at||bootstrap.consumed_by!==principal.userId||!bootstrap.activated_at||!bootstrap.consumed_at||new Date(bootstrap.activated_at)<new Date(state.restored_at)||new Date(bootstrap.consumed_at)<new Date(state.restored_at))throw denied();
 }
 await db.query('SELECT id FROM human_users WHERE id=$1 FOR UPDATE',[principal.userId]);
 const life=(await db.query('SELECT family_sid FROM human_session_lifecycles WHERE sid=$1',[principal.sessionId])).rows[0];if(!life)throw denied();
 // Match the session store's family-root-first lock order used by logout/rotate.
 const root=(await db.query('SELECT * FROM human_session_lifecycles WHERE sid=$1 FOR UPDATE',[life.family_sid])).rows[0];
 const current=(await db.query('SELECT * FROM human_session_lifecycles WHERE sid=$1',[principal.sessionId])).rows[0],now=new Date();
 if(!root||!current||root.sid!==root.family_sid||current.family_sid!==root.sid||root.family_revoked_at||current.revoked_at||new Date(current.valid_until)<=now||new Date(root.retain_until)<=now)throw denied();
 const session=(await db.query('SELECT sess FROM human_sessions WHERE sid=$1 AND expire>clock_timestamp()',[principal.sessionId])).rows[0];
 const reference=session?.sess?.human,fresh=reference&&reference.sessionId===principal.sessionId&&new Date(reference.createdAt)>=new Date(state.restored_at)&&new Date(reference.authenticatedAt)>=new Date(state.restored_at);
 if(!fresh||!isDeepStrictEqual(await loadHumanPrincipal(db,reference,now),principal))throw denied();
 if(state.verified)return;
 const eventId=randomUUID(),requestId=randomUUID();
 await appendAudit(db,{eventId,action:'backup.restore',actor:auditActor(principal),
  correlation:{correlationId:requestId,requestId},resource:{type:'backup',id:input.operationId,departmentIds:[]},outcome:'success',
  authority:{decisionId:eventId,checkedAt:now.toISOString(),policyVersion:'enterprise-restore-v1',principalKey:principalKey(principal),departmentIds:[],membershipVersions:[],grantVersions:[],permissionSha256:createHash('sha256').update(JSON.stringify({userId:principal.userId,epoch:principal.sessionEpoch,operationId:input.operationId,inputDigest:input.inputDigest})).digest('hex')},
  changes:{backupId:input.operationId,sha256:input.inputDigest,state:'restored'}});
 await db.query("UPDATE enterprise_restore_admission SET status='active',activated_by=$1,activated_at=clock_timestamp() WHERE operation_id=$2",[principal.userId,input.operationId]);
}
/** Target-local control data, excluded from every portable backup. */
export async function migrateEnterpriseRestoreAdmission(db:Database){
 await db.query(`CREATE TABLE IF NOT EXISTS enterprise_restore_admission(
  operation_id uuid PRIMARY KEY,input_digest text UNIQUE NOT NULL,
  status text NOT NULL CHECK(status IN ('quarantined','active')),source_issuer text,
  activated_by text,activated_at timestamptz,restored_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  pending_resources jsonb NOT NULL DEFAULT '{"native":[],"mcp":[],"device":[],"schedule":[],"contract":[]}',
  source_bootstrap_virgin boolean NOT NULL DEFAULT false,
  CHECK((status='quarantined' AND activated_by IS NULL AND activated_at IS NULL)
    OR (status='active' AND activated_by IS NOT NULL AND activated_at IS NOT NULL))
 );ALTER TABLE enterprise_restore_admission ADD COLUMN IF NOT EXISTS restored_at timestamptz;
 ALTER TABLE enterprise_restore_admission ADD COLUMN IF NOT EXISTS pending_resources jsonb;
 ALTER TABLE enterprise_restore_admission ADD COLUMN IF NOT EXISTS source_bootstrap_virgin boolean NOT NULL DEFAULT false`);
}
export async function installRestoreAdmissionIn(db:Database,payload:EnterpriseBackupV2,operationId:string,inputDigest:string){
 const users=payload.tables.human_users,bootstrap=payload.tables.identity_bootstrap[0];
 const bootstrapUser=users.find(row=>row.id===bootstrap?.consumed_by);
 const issuers=[...new Set(users.filter(row=>row.status==='active'&&row.org_role==='admin').map(row=>row.issuer))];
 const sourceIssuer=bootstrapUser?.issuer??(issuers.length===1?issuers[0]:null);
 const virgin=users.length===0&&bootstrap?.expected_fingerprint===null&&bootstrap.activated_at===null&&bootstrap.consumed_at===null&&bootstrap.closed_at===null;
 const pending=emptyResources();pending.native=Object.keys(payload.nativePluginBundles);pending.mcp=payload.tables.mcp_connections.map(row=>JSON.stringify([row.id,row.version]));pending.device=payload.tables.local_devices.map(row=>String(row.id));pending.schedule=payload.tables.automation_schedules.map(row=>JSON.stringify([row.id,row.version]));pending.contract=payload.tables.tool_effect_contracts.map(row=>String(row.digest));
 await db.query("INSERT INTO enterprise_restore_admission(operation_id,input_digest,status,source_issuer,restored_at,pending_resources,source_bootstrap_virgin) VALUES($1,$2,'quarantined',$3,clock_timestamp(),$4,$5)",[operationId,inputDigest,sourceIssuer,pending,virgin]);
 if((await db.query('UPDATE backup_restore_anchor SET enterprise_restore_operation_id=$1 WHERE singleton=1 AND enterprise_restore_operation_id IS NULL RETURNING singleton',[operationId])).rows.length!==1)throw new AppError(409,'目标恢复锚点已变化，不能覆盖隔离记录。','BACKUP_RESTORE_RECONCILIATION_REQUIRED');
}
