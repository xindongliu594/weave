import type pg from 'pg';
import {AppError} from './provider.ts';

const protectedTables=['human_users','department_memberships','human_sessions','human_session_lifecycles','oidc_login_transactions','identity_bootstrap','human_audit_events','audit_outbox','audit_run_projection'];

/** Caller holds the restore transaction. Until preserving import exists, never clear enterprise history. */
export async function assertBackupDestinationClear(db:Pick<pg.PoolClient,'query'>){
 try{
  // NOWAIT avoids deadlocks with identity issuance; acquired locks prevent a check/clear race.
  await db.query('LOCK TABLE '+protectedTables.join(',')+' IN SHARE ROW EXCLUSIVE MODE NOWAIT');
 }catch(error:any){
  if(error.code==='55P03')throw new AppError(409,'身份或审计正在变更，请保留当前数据并稍后检查。','BACKUP_DESTINATION_BUSY');
  throw error;
 }
 const queries=protectedTables.filter(table=>table!=='identity_bootstrap').map(table=>'EXISTS(SELECT 1 FROM '+table+')');
 queries.push('EXISTS(SELECT 1 FROM identity_bootstrap WHERE version<>1 OR expected_fingerprint IS NOT NULL OR activated_at IS NOT NULL OR consumed_by IS NOT NULL OR consumed_at IS NOT NULL OR closed_at IS NOT NULL OR closed_reason IS NOT NULL)');
 const {rows}=await db.query('SELECT '+queries.join(' OR ')+' AS protected');
 if(rows[0]?.protected!==false)throw new AppError(409,'目标环境已有企业身份或审计历史，当前恢复方式不能保留这些记录，未替换数据；请使用隔离目录验证备份。','BACKUP_DESTINATION_PROTECTED');
}
