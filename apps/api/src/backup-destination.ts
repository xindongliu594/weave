import type pg from 'pg';
import {AppError} from './provider.ts';

const protectedTables=['human_users','department_memberships','human_sessions','human_session_lifecycles','oidc_login_transactions','identity_bootstrap','human_audit_events','audit_outbox','audit_run_projection','tool_effect_contracts','enterprise_restore_admission'];
const approvalDecisionFields=['decided_by_user_id','decided_epoch','decision_actor_kind','decision_request_id','decision_reason','decision_audit_id'];

/** Caller holds the transaction. Take these locks before the export's first data read. */
async function assertIdentityHistoryEmpty(db:Pick<pg.PoolClient,'query'>,purpose:'export'|'restore'){
 try{
  // NOWAIT avoids deadlocks with identity issuance; acquired locks prevent a check/clear race.
  await db.query('LOCK TABLE '+[...protectedTables,'backup_restore_anchor'].join(',')+' IN SHARE ROW EXCLUSIVE MODE NOWAIT');
 }catch(error:any){
  if(error.code==='55P03')throw new AppError(409,'身份或审计正在变更，请保留当前数据并稍后检查。',purpose==='export'?'BACKUP_SOURCE_BUSY':'BACKUP_DESTINATION_BUSY');
  throw error;
 }
 const queries=protectedTables.filter(table=>table!=='identity_bootstrap').map(table=>'EXISTS(SELECT 1 FROM '+table+')');
 queries.push('EXISTS(SELECT 1 FROM identity_bootstrap WHERE version<>1 OR expected_fingerprint IS NOT NULL OR activated_at IS NOT NULL OR consumed_by IS NOT NULL OR consumed_at IS NOT NULL OR closed_at IS NOT NULL OR closed_reason IS NOT NULL)');
 queries.push('EXISTS(SELECT 1 FROM backup_restore_anchor WHERE enterprise_restore_operation_id IS NOT NULL)');
 const {rows}=await db.query('SELECT '+queries.join(' OR ')+' AS protected');
 if(rows[0]?.protected!==false){
  if(purpose==='export')throw new AppError(409,'当前在线备份仅支持本机业务数据，不能完整保存企业身份、授权与审计记录，因此未生成备份。企业完整备份与隔离恢复仍需专门验证。','BACKUP_SOURCE_IDENTITY_UNSUPPORTED');
  throw new AppError(409,'目标环境已有企业身份或审计历史，当前恢复方式不能保留这些记录，未替换数据；请使用隔离目录验证备份。','BACKUP_DESTINATION_PROTECTED');
 }
}

/** Until preserving import exists, never clear enterprise history. */
export async function assertBackupDestinationClear(db:Pick<pg.PoolClient,'query'>){await assertIdentityHistoryEmpty(db,'restore');}
export async function assertBackupSourcePortable(db:Pick<pg.PoolClient,'query'>){
 await assertIdentityHistoryEmpty(db,'export');
 const {rows}=await db.query(`SELECT EXISTS(SELECT 1 FROM project_runs WHERE requested_by_user_id IS NOT NULL
   OR authorized_by_user_id IS NOT NULL OR authorized_epoch IS NOT NULL OR authority_kind NOT IN ('local-owner'))
   OR EXISTS(SELECT 1 FROM manager_messages WHERE authorized_by_user_id IS NOT NULL OR authorized_epoch IS NOT NULL
   OR authority_kind NOT IN ('local-owner'))
   OR EXISTS(SELECT 1 FROM tool_approvals WHERE ${approvalDecisionFields.map(field=>field+' IS NOT NULL').join(' OR ')}) AS unsupported`);
 if(rows[0]?.unsupported!==false)throw identityDependencyError();
}

function identityDependencyError(){return new AppError(422,'备份包含依赖企业身份或授权的记录，当前业务备份格式无法完整恢复这些依赖，未替换数据。','BACKUP_IDENTITY_DEPENDENCIES_UNSUPPORTED');}

/** Business-only v1 cannot reconstitute identities, approval epochs or automation authority. */
export function assertBusinessBackupPortable(tables:Record<string,unknown>){
 const hasIdentity=protectedTables.some(name=>Array.isArray(tables[name])&&(tables[name] as unknown[]).length>0);
 const hasAuthority=['project_runs','manager_messages'].some(name=>Array.isArray(tables[name])&&(tables[name] as any[]).some(row=>row&&(
  row.requested_by_user_id!=null||row.authorized_by_user_id!=null||row.authorized_epoch!=null||
  (row.authority_kind!=null&&row.authority_kind!=='local-owner')
 )));
 const hasDecision=Array.isArray(tables.tool_approvals)&&(tables.tool_approvals as any[]).some(row=>row&&approvalDecisionFields.some(field=>row[field]!=null));
 if(hasIdentity||hasAuthority||hasDecision)throw identityDependencyError();
}
