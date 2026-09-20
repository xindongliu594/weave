import type pg from 'pg';
import { pool } from './db.ts';
import { AppError } from './provider.ts';
import { tokenize, searchKnowledge } from '../../../services/agent-runtime/knowledge.mjs';

type Database = Pick<pg.PoolClient, 'query'>;
type DocumentVersion = { documentId: string; version: number; title: string; spaceId: string; sha256: string; source: Record<string,unknown>; chunkCount: number };
export type KnowledgeManifest = { format: 'document-versions-v2'; documents: DocumentVersion[]; agentDocuments: Record<string,string[]> };
const permission = `(s.scope='company' OR (s.department_id=$1 AND (s.scope='department' OR s.agent_ids ? $2)))`;

export async function validateKnowledgeGrants(agents:any[], departmentId:string, db:Database=pool) {
  // Lock grants in a stable order when called inside approval's transaction.
  for (const agent of [...agents].sort((a,b)=>a.id.localeCompare(b.id))) {
    const ids = [...new Set<string>(agent.knowledgeSpaceIds??[])].sort();
    if (!ids.length) continue;
    const allowed = (await db.query(`SELECT s.id FROM knowledge_spaces s WHERE s.id=ANY($3::text[])
      AND s.deleted_at IS NULL AND ${permission} ORDER BY s.id FOR SHARE`, [departmentId,agent.employeeId??agent.id,ids])).rows.map(r=>r.id);
    const invalid = ids.filter(id=>!allowed.includes(id));
    if (invalid.length) throw new AppError(422,`${agent.name??agent.employeeId??agent.id} 的知识授权已失效或不属于该员工：${invalid.join('、')}。请修改方案后重新批准。`,'KNOWLEDGE_GRANT_INVALID');
  }
}

export async function knowledgeSnapshot(agents:any[], departmentId:string, db?:Database):Promise<KnowledgeManifest> {
  if (!db) {
    const client=await pool.connect();
    try { await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ'); const manifest=await knowledgeSnapshot(agents,departmentId,client); await client.query('COMMIT'); return manifest; }
    catch(error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  await validateKnowledgeGrants(agents,departmentId,db);
  const documents=new Map<string,DocumentVersion>(), agentDocuments:Record<string,string[]>=Object.fromEntries(agents.map(a=>[a.id,[]]));
  // One MVCC statement sees the same corpus for the whole team, including newly imported documents.
  const rows=(await db.query(`SELECT a.id AS "agentId",d.id AS "documentId",d.version,d.title,d.space_id AS "spaceId",r.sha256,r.source,
      (SELECT count(*)::int FROM knowledge_chunks c WHERE c.document_id=d.id AND c.version=d.version) AS "chunkCount"
    FROM jsonb_to_recordset($2) AS a(id text,"employeeId" text,"knowledgeSpaceIds" text[])
    JOIN knowledge_spaces s ON s.id=ANY(a."knowledgeSpaceIds")
    JOIN knowledge_documents d ON d.space_id=s.id
    JOIN knowledge_revisions r ON r.document_id=d.id AND r.version=d.version
    WHERE d.deleted_at IS NULL AND s.deleted_at IS NULL
      AND (s.scope='company' OR (s.department_id=$1 AND (s.scope='department' OR s.agent_ids ? a."employeeId")))
    ORDER BY d.id,a.id FOR SHARE OF d,s`,[departmentId,JSON.stringify(agents.map(a=>({id:a.id,employeeId:a.employeeId??a.id,knowledgeSpaceIds:a.knowledgeSpaceIds??[]})))])).rows;
  for (const {agentId,...doc} of rows) { agentDocuments[agentId].push(doc.documentId); documents.set(doc.documentId,doc as DocumentVersion); }
  // Store references, not a truncated copy of the corpus. Revisions are immutable and included in backups.
  return {format:'document-versions-v2',documents:[...documents.values()],agentDocuments};
}

function references(manifest:KnowledgeManifest,agentId:string) {
  const allowed=new Set(manifest.agentDocuments[agentId]??[]);
  return manifest.documents.filter(doc=>allowed.has(doc.documentId));
}

async function verifyVersions(refs:DocumentVersion[],db:Database) {
  if (!refs.length) return;
  const missing=(await db.query(`WITH refs AS (SELECT * FROM jsonb_to_recordset($1) AS x("documentId" text,version int,sha256 text,"chunkCount" int))
    SELECT x."documentId" FROM refs x LEFT JOIN knowledge_revisions r ON r.document_id=x."documentId" AND r.version=x.version
    WHERE r.sha256 IS DISTINCT FROM x.sha256 OR x."chunkCount"<>(SELECT count(*) FROM knowledge_chunks c WHERE c.document_id=x."documentId" AND c.version=x.version)
    LIMIT 1`,[JSON.stringify(refs)])).rowCount;
  if (missing) throw new AppError(409,'运行引用的知识版本缺失或不完整，请恢复包含该版本的备份；不会替换为当前笔记。','KNOWLEDGE_VERSION_MISSING');
}

/** Permissions are fixed by the approved manifest before any ranking or chunk lookup. */
export async function queryKnowledge(snapshot:any,agentId:string,operation:'search'|'read',value:string,limit=6,db:Database=pool):Promise<any> {
  if (snapshot?.format!=='document-versions-v2') {
    const chunks=Array.isArray(snapshot?.[agentId])?snapshot[agentId]:[];
    return operation==='search'?searchKnowledge(chunks,value,limit):chunks.find((chunk:any)=>chunk.id===value);
  }
  const refs=references(snapshot,agentId);
  if (!refs.length) return operation==='search'?[]:undefined;
  await verifyVersions(refs,db);
  const terms=tokenize(value);
  if (operation==='search'&&!terms.length) return [];
  const rows=(await db.query(`WITH refs AS (SELECT * FROM jsonb_to_recordset($1) AS x("documentId" text,version int,title text,"spaceId" text,sha256 text,source jsonb)),
    authorized AS (
      SELECT c.id,c.document_id AS "documentId",c.version,c.line_start AS "lineStart",c.line_end AS "lineEnd",c.content,c.tokens,x.title,x."spaceId",x.sha256,x.source
      FROM refs x JOIN knowledge_chunks c ON c.document_id=x."documentId" AND c.version=x.version
    )
    SELECT id,"documentId",version,"lineStart","lineEnd",content,title,"spaceId",sha256,source${operation==='search'?`,
      (SELECT count(*) FROM unnest($2::text[]) term WHERE tokens ? term)::float8 / sqrt(GREATEST(1,jsonb_array_length(tokens))*cardinality($2::text[])::float8)
      + CASE WHEN strpos(lower(content),lower($3))>0 THEN 1 ELSE 0 END AS score`:''}
    FROM authorized WHERE ${operation==='search'?'tokens ?| $2::text[]':'id=$2'}
    ORDER BY ${operation==='search'?'score DESC,':''} id LIMIT ${operation==='search'?'$4':'$3'}`,
    operation==='search'?[JSON.stringify(refs),terms,value,Math.min(20,Math.max(1,limit))]:[JSON.stringify(refs),value,1])).rows;
  return operation==='search'?rows:rows[0];
}

export async function searchAvailableKnowledge(departmentId:string,agent:any,query:string) {
  // Interactive search uses the current authorized versions; run tools use their stored manifest.
  const granted=(await pool.query(`SELECT s.id FROM knowledge_spaces s WHERE s.deleted_at IS NULL AND s.id=ANY($3::text[]) AND ${permission}`,
    [departmentId,agent.id,agent.knowledgeSpaceIds??[]])).rows.map(row=>row.id);
  const manifest=await knowledgeSnapshot([{...agent,knowledgeSpaceIds:granted}],departmentId);
  return queryKnowledge(manifest,agent.id,'search',query);
}
