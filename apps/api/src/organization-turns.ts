import type pg from 'pg';
import {randomUUID} from 'node:crypto';
import {AppError} from './provider.ts';
import {shareCostMaintenance} from './cost-control.ts';
import type {FailedDraft} from './organization-failed-draft.ts';

const stale=()=>new AppError(409,'本轮方案已被后续讨论替代，请查看最新回复后再确认','ORGANIZATION_PREVIEW_STALE');
/** Serialize only turn admission/publication, never hold a transaction across a model call. */
export async function beginOrganizationTurn(pool:pg.Pool,conversationId:string,previousPreviewId?:string){
 const client=await pool.connect(),turnId=randomUUID();
 try{
  await client.query('BEGIN');await shareCostMaintenance(client);
  await client.query("UPDATE organization_conversations SET failed_draft=NULL WHERE failed_draft->>'expiresAt' <= $1",[new Date().toISOString()]);
  await client.query('INSERT INTO organization_conversations(id,turn_id) VALUES($1,$2) ON CONFLICT(id) DO NOTHING',[conversationId,turnId]);
  const current=(await client.query('SELECT * FROM organization_conversations WHERE id=$1 FOR UPDATE',[conversationId])).rows[0];
  await client.query("UPDATE organization_previews SET data=jsonb_set(data,'{supersededBy}',to_jsonb($2::text)) WHERE id=ANY($1::text[]) AND project_id IS NULL",[[current.preview_id,previousPreviewId].filter(Boolean),turnId]);
  // Admission may still fail before provider dispatch. Keep correction material
  // until this turn returns a reply, instead of consuming it before the request.
  await client.query('UPDATE organization_conversations SET turn_id=$2,preview_id=NULL,updated_at=now() WHERE id=$1',[conversationId,turnId]);
  await client.query('COMMIT');return {conversationId,turnId,previousFailedDraft:current.failed_draft};
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}

export async function saveOrganizationFailure(pool:pg.Pool,turn:{conversationId:string;turnId:string},draft:FailedDraft|null){
 const client=await pool.connect();
 try{
  await client.query('BEGIN');await shareCostMaintenance(client);await assertOrganizationTurn(client,turn);
  await client.query('UPDATE organization_conversations SET failed_draft=$2 WHERE id=$1',[turn.conversationId,draft]);
  await client.query('COMMIT');
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}

/** Caller owns a transaction; lock order is conversation then preview for both paths. */
export async function assertOrganizationTurn(client:pg.PoolClient,turn:{conversationId:string;turnId:string},previewId?:string){
 const row=(await client.query('SELECT * FROM organization_conversations WHERE id=$1 FOR UPDATE',[turn.conversationId])).rows[0];
 if(!row||row.turn_id!==turn.turnId||previewId&&row.preview_id!==previewId)throw stale();
}
