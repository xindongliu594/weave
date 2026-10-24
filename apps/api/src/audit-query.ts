import {createHash,randomUUID} from 'node:crypto';
import type pg from 'pg';
import {z} from 'zod';
import {identityText,principalKey,type Principal} from './identity-types.ts';
import {administrative,currentRoutePrincipal} from './project-route-access.ts';
import {appendAudit,auditActor} from './audit-events.ts';
import {summarizeAuditSource} from './audit-outbox.ts';
import {AppError} from './provider.ts';

const id=z.string().refine(value=>identityText(value,128));
const instant=z.iso.datetime({offset:true}).refine(value=>!value.includes('.')||/\.\d{1,6}(?:Z|[+-]\d{2}:\d{2})$/.test(value));
const querySchema=z.strictObject({runId:id.optional(),correlationId:id.optional(),outcome:z.enum(['success','denied','failure','unknown']).optional(),
 after:instant.optional(),before:instant.optional(),limit:z.string().regex(/^(?:[1-9]|[1-9][0-9]|100)$/).optional(),cursor:z.string().min(1).max(4096).optional()});
const cursorSchema=z.strictObject({v:z.literal(1),occurredAt:instant,idSha256:z.string().regex(/^[a-f0-9]{64}$/),
 after:instant,before:instant,filterSha256:z.string().regex(/^[a-f0-9]{64}$/)});
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const invalid=()=>new AppError(422,'审计查询条件无效，请重新选择时间或刷新第一页。','AUDIT_QUERY_INVALID');
// Date supplies UTC seconds; retain the input fraction that Date truncates to milliseconds.
function utcInstant(value:string|Date){const text=typeof value==='string'?value:value.toISOString();return new Date(text).toISOString().slice(0,19)+'.'+(text.match(/\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/)?.[1]??'').padEnd(6,'0')+'Z';}
function microseconds(value:string){return BigInt(Date.parse(value))*1000n+BigInt(value.slice(23,26));}

export function parseAuditQuery(value:unknown,principal:Principal,now=new Date()) {
 try {
  const query=querySchema.parse(value);
  let cursor:z.infer<typeof cursorSchema>|undefined;
  if(query.cursor){
   if(!/^[A-Za-z0-9_-]+$/.test(query.cursor))throw Error();
   const bytes=Buffer.from(query.cursor,'base64url');if(bytes.toString('base64url')!==query.cursor)throw Error();
   cursor=cursorSchema.parse(JSON.parse(bytes.toString('utf8')));
  }
  const before=utcInstant(query.before??cursor?.before??now);
  const after=utcInstant(query.after??cursor?.after??new Date(Date.parse(before)-7*86400000));
  const length=microseconds(before)-microseconds(after);if(length<0n||length>30n*86400000000n)throw Error();
  const limit=Number(query.limit??50),runId=query.runId??null,correlationId=query.correlationId??null,outcome=query.outcome??null;
  const filterSha256=digest({principal:principalKey(principal),after,before,limit,runId,correlationId,outcome});
  if(cursor&&(cursor.filterSha256!==filterSha256||cursor.after!==after||cursor.before!==before))throw Error();
  return {after,before,limit,runId,correlationId,outcome,filterSha256,cursor};
 } catch {throw invalid();}
}

export async function queryAuditEvents(pool:pg.Pool,principal:Principal|null,query:unknown,now=new Date()) {
 if(!principal)throw new AppError(401,'请先登录。','AUDIT_AUTH_REQUIRED');
 try{principalKey(principal);}catch{throw new AppError(401,'请重新登录。','AUDIT_AUTH_REQUIRED');}
 if(!administrative(principal))throw new AppError(403,'当前入口仅供管理员查询审计摘要。','AUDIT_ACCESS_DENIED');
 const filters=parseAuditQuery(query,principal,now);
 const client=await pool.connect();let discard=false,transaction=false;
 try {
  try{await client.query('BEGIN');transaction=true;}catch(error){discard=true;throw error;}
  await client.query("SET LOCAL statement_timeout='2000ms'");
  // Hold current identity through both the read and its audit; a historical session snapshot is insufficient.
  await currentRoutePrincipal(client,principal,true);
  const result=await client.query(`SELECT CASE WHEN octet_length(to_jsonb(a)::text)<=65536 THEN to_jsonb(a)
    ELSE jsonb_build_object('schema_version',a.schema_version,'canonical_payload',NULL) END AS source,
    encode(sha256(convert_to(a.id,'UTF8')),'hex') AS cursor_id_hash,
    to_char(a.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_time
    FROM human_audit_events a WHERE a.occurred_at >= $1::timestamptz AND a.occurred_at <= $2::timestamptz
    AND ($3::text IS NULL OR a.run_id=$3) AND ($4::text IS NULL OR a.correlation_id=$4)
    AND ($5::text IS NULL OR a.outcome=$5)
    AND ($6::timestamptz IS NULL OR (a.occurred_at,a.id)<($6::timestamptz,
      (SELECT anchor.id FROM human_audit_events anchor WHERE anchor.occurred_at=$6::timestamptz
        AND encode(sha256(convert_to(anchor.id,'UTF8')),'hex')=$7::text LIMIT 2)))
    ORDER BY a.occurred_at DESC,a.id DESC LIMIT $8`,
   [filters.after,filters.before,filters.runId,filters.correlationId,filters.outcome,filters.cursor?.occurredAt??null,filters.cursor?.idSha256??null,filters.limit+1]);
  const selected=result.rows.slice(0,filters.limit);
  const items=selected.map(row=>{
   try{return {...summarizeAuditSource(row.source),integrity:'verified' as const};}
   catch{return {sourceEventId:null,occurredAt:row.cursor_time,integrity:row.source.schema_version===1&&row.source.canonical_payload===null?'legacy-unverified' as const:'invalid' as const};}
  });
  const last=selected.at(-1),nextCursor=result.rows.length>filters.limit&&last?Buffer.from(JSON.stringify({v:1,occurredAt:last.cursor_time,idSha256:last.cursor_id_hash,
   after:filters.after,before:filters.before,filterSha256:filters.filterSha256})).toString('base64url'):null;
  const eventId=randomUUID(),policyVersion='audit-query-admin-v1';
  await appendAudit(client,{eventId,action:'audit.read',actor:auditActor(principal),
   authority:{decisionId:eventId,checkedAt:now.toISOString(),policyVersion,principalKey:principalKey(principal),departmentIds:[],membershipVersions:[],grantVersions:[],permissionSha256:digest({policyVersion,principal:principalKey(principal),epoch:principal.kind==='human'?principal.sessionEpoch:null})},
   correlation:{correlationId:eventId},resource:{type:'audit',id:'audit-summary-query',departmentIds:[]},outcome:'success',changes:{count:items.length,filterSha256:filters.filterSha256}});
  try{await client.query('COMMIT');transaction=false;}catch(error){discard=true;throw error;}
  return {items,nextCursor,range:{after:filters.after,before:filters.before}};
 } catch(error) {
  if(transaction)try{await client.query('ROLLBACK');transaction=false;}catch{discard=true;}
  throw error;
 } finally {client.release(discard?new Error('AUDIT_TRANSACTION_UNCONFIRMED'):undefined);}
}
