import type pg from 'pg';
import { pool } from './db.ts';
import { AppError } from './provider.ts';
import { createHash } from 'node:crypto';
import type { Plan } from '../../../packages/contracts/index.ts';
import { tokenize, searchKnowledge, chunkDocument } from '../../../services/agent-runtime/knowledge.mjs';
import { vectorCandidates,fuseKnowledge } from './knowledge-vector.ts';
import { embeddingVersion } from '../../../services/embedding/local.mjs';
import {assertTargetContainsSources,combineSourceBounds,readKnowledgeRevisionBounds,readRunBounds,rootSourceBounds,validateSourceBounds,type SourceBounds} from './source-bounds.ts';
import {visibleKnowledgeRevisionQuery,safeSourceQuery} from './resource-authorization.ts';
import {administrative,type FileConsumerAuthority} from './project-route-access.ts';

type Database = Pick<pg.PoolClient, 'query'>;
/** Called within the document write transaction; provenance is a server argument, never a body field. */
export async function knowledgeRevisionSourceBounds(db:Database,target:{documentId:string;version:number;spaceId:string;sourceRunId?:string},trustedBounds?:SourceBounds):Promise<SourceBounds> {
  const space=(await db.query('SELECT scope,department_id FROM knowledge_spaces WHERE id=$1 AND deleted_at IS NULL FOR SHARE',[target.spaceId])).rows[0];
  if(!space)throw new AppError(404,'知识库不存在');
  const items=[trustedBounds===undefined?rootSourceBounds():await validateSourceBounds(db,trustedBounds)];
  if(target.version>1)items.push(await readKnowledgeRevisionBounds(db,target.documentId,target.version-1));
  if(target.sourceRunId)items.push(await readRunBounds(db,target.sourceRunId));
  const sourceBounds=combineSourceBounds(items);
  if(space.scope==='employee'){
    // Existing administrator edits remain private. A new private redistribution target is not implemented.
    if(trustedBounds!==undefined||target.sourceRunId)throw new AppError(422,'暂不支持向员工私有空间派生资料','SOURCE_BOUNDS_INVALID');
    return combineSourceBounds([sourceBounds,{...rootSourceBounds(),private:true,requiredDepartmentIds:space.department_id?[space.department_id]:[]}]);
  }
  if(space.scope!=='company'&&space.scope!=='department')throw new AppError(422,'知识空间范围无效','SOURCE_BOUNDS_INVALID');
  const departments=space.scope==='department'&&space.department_id?[space.department_id]:[];
  if(space.scope==='department'&&!departments.length)throw new AppError(422,'知识空间缺少部门','SOURCE_BOUNDS_INVALID');
  assertTargetContainsSources(departments,sourceBounds,{targetAdminOnly:sourceBounds.adminOnly});
  return combineSourceBounds([sourceBounds,{requiredDepartmentIds:departments,adminOnly:space.scope==='company',private:false,refs:[]}]);
}
type DocumentVersion = { documentId: string; version: number; title: string; spaceId: string; sha256: string; source: Record<string,unknown>; chunkCount: number;sourceBounds?:SourceBounds };
export type KnowledgeAuthority=FileConsumerAuthority;
type ImportedSource={sourceBounds?:SourceBounds;sourceFile?:{snapshotId:string;path:string;sha256:string}};
export type KnowledgeManifest = { format: 'document-versions-v2'; documents: DocumentVersion[]; agentDocuments: Record<string,string[]>; sourceTarget?:{departmentIds:string[];adminOnly:boolean};retrieval?:{mode:'keyword'|'hybrid';embeddingVersion?:string}; runInputs?:({documentId:string;title:string;agentIds:string[];skillName?:string;chunks:any[]}&ImportedSource)[] };
export async function validateKnowledgeGrants(agents:any[], departmentId:string, db:Database=pool) {
  // Lock grants in a stable order when called inside approval's transaction.
  for (const agent of [...agents].sort((a,b)=>a.id.localeCompare(b.id))) {
    const ids = [...new Set<string>(agent.knowledgeSpaceIds??[])].sort();
    if (!ids.length) continue;
    const agentDepartmentId=agent.sourceDepartmentId??agent.departmentId??departmentId;
    const employeeId=agent.sourceAgentId??agent.knowledgeEmployeeId??agent.employeeId??agent.id;
    const allowed = (await db.query(`SELECT s.id FROM knowledge_spaces s WHERE s.id=ANY($3::text[])
      AND s.deleted_at IS NULL AND (s.scope='company' OR (s.department_id=$1 AND (s.scope='department' OR s.agent_ids ? $2))) ORDER BY s.id FOR SHARE`, [agentDepartmentId,employeeId,ids])).rows.map(r=>r.id);
    const invalid = ids.filter(id=>!allowed.includes(id));
    if (invalid.length) throw new AppError(422,`${agent.name??agent.employeeId??agent.id} 的知识授权已失效或不属于该员工：${invalid.join('、')}。请修改方案后重新批准。`,'KNOWLEDGE_GRANT_INVALID');
  }
}

export async function knowledgeSnapshot(agents:any[], departmentId:string, db?:Database,documentIds?:string[],authority?:KnowledgeAuthority):Promise<KnowledgeManifest> {
  if(!authority&&(process.env.WEIWU_AUTH_MODE??'legacy-local')!=='legacy-local')throw new AppError(401,'知识选用需要可信当前身份');
  if (!db) {
    const client=await pool.connect();
    try { await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ'); const manifest=await knowledgeSnapshot(agents,departmentId,client,documentIds,authority); await client.query('COMMIT'); return manifest; }
    catch(error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  await validateKnowledgeGrants(agents,departmentId,db);
  const documents=new Map<string,DocumentVersion>(), agentDocuments:Record<string,string[]>=Object.fromEntries(agents.map(a=>[a.id,[]]));
  const visible=authority?visibleKnowledgeRevisionQuery(authority.principal,'viewer',{parameterOffset:2}):null;
  const targetIndex=3+(visible?.values.length??0);
  // One MVCC statement sees the same corpus for the whole team, including newly imported documents.
  const rows=(await db.query(`SELECT a.id AS "agentId",d.id AS "documentId",d.version,d.title,d.space_id AS "spaceId",r.sha256,r.source,r.source_bounds AS "sourceBounds",
      (SELECT count(*)::int FROM knowledge_chunks c WHERE c.document_id=d.id AND c.version=d.version) AS "chunkCount"
    FROM jsonb_to_recordset($1) AS a(id text,"departmentId" text,"employeeId" text,"knowledgeSpaceIds" text[])
    JOIN knowledge_spaces s ON s.id=ANY(a."knowledgeSpaceIds")
    JOIN knowledge_documents d ON d.space_id=s.id
    JOIN knowledge_revisions r ON r.document_id=d.id AND r.version=d.version
    WHERE d.deleted_at IS NULL AND s.deleted_at IS NULL AND ($2::text[] IS NULL OR d.id=ANY($2::text[]))
      ${visible?`AND (d.id,r.version::text) IN (SELECT id,version FROM (${visible.text}) visible WHERE ${administrative(authority!.principal)?'TRUE':`departments <@ $${targetIndex}::text[]`})`:''}
      AND (s.scope='company' OR (s.department_id=a."departmentId" AND (s.scope='department' OR s.agent_ids ? a."employeeId")))
    ORDER BY d.id,a.id FOR SHARE OF d,s`,[JSON.stringify(agents.map(a=>({id:a.id,departmentId:a.sourceDepartmentId??a.departmentId??departmentId,employeeId:a.sourceAgentId??a.knowledgeEmployeeId??a.employeeId??a.id,knowledgeSpaceIds:a.knowledgeSpaceIds??[]}))),documentIds??null,...(visible?.values??[]),...(visible&&!administrative(authority!.principal)?[authority!.targetDepartmentIds]:[])])).rows;
  for (const {agentId,...doc} of rows) { agentDocuments[agentId].push(doc.documentId); documents.set(doc.documentId,doc as DocumentVersion); }
  if(documentIds?.some(id=>!documents.has(id)))throw new AppError(422,'本次选用的资料已归档、缺失或没有员工获授权，请更新资料范围后重新批准。','KNOWLEDGE_SCOPE_INVALID');
  // Store references, not a truncated copy of the corpus. Revisions are immutable and included in backups.
  const settings=(await db.query('SELECT data FROM product_settings WHERE id=1')).rows[0]?.data;
  return {format:'document-versions-v2',documents:[...documents.values()],agentDocuments,...(authority?{sourceTarget:{departmentIds:authority.targetDepartmentIds,adminOnly:authority.targetAdminOnly===true&&administrative(authority.principal)}}:{}),retrieval:settings?.knowledgeSearchMode==='hybrid'?{mode:'hybrid',embeddingVersion}:{mode:'keyword'}};
}

/** Run inputs are immutable snapshot data, never imported into the shared Vault or its index. */
export function attachRunInputs(manifest:KnowledgeManifest,inputs:(NonNullable<Plan['runInputs']>[number]&ImportedSource)[]|undefined,agents:any[],runId:string) {
  if(!inputs?.length)return manifest;
  return {...manifest,runInputs:inputs.map(input=>{
    const documentId=`run:${runId}:${input.id}`,sha256=createHash('sha256').update(input.content).digest('hex');
    const agentIds=input.agentIds.map(id=>agents.find(a=>(a.employeeId??a.id)===id)?.id);
    if(agentIds.some(id=>!id))throw new AppError(422,'本次资料授权员工不存在','KNOWLEDGE_SCOPE_INVALID');
    // A method is one exact immutable body, reused by knowledge reads and the
    // official Skill loader. Do not keep a second copy or reconstruct split lines.
    const chunks=input.skillName?[{id:createHash('sha256').update(`${documentId}:1:skill:${sha256}`).digest('hex'),documentId,version:1,lineStart:1,lineEnd:input.content.split('\n').length,content:input.content}]:chunkDocument(documentId,1,input.content);
    return {documentId,title:input.title,agentIds,...(input.skillName?{skillName:input.skillName}:{}),...(input.sourceBounds?{sourceBounds:input.sourceBounds}:{}),...(input.sourceFile?{sourceFile:input.sourceFile}:{}),chunks:chunks.map(chunk=>({...chunk,tokens:tokenize(input.title+' '+chunk.content),title:input.title,sha256,spaceId:`run:${runId}`,source:{type:'run-input',runId,inputId:input.id}}))};
  })};
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
export async function queryKnowledge(snapshot:any,agentId:string,operation:'search'|'read'|'skill',value:string,limit=6,db:Database=pool):Promise<any> {
  if(operation==='search'&&!value.trim())return [];
  if (snapshot?.format!=='document-versions-v2') {
    if((process.env.WEIWU_AUTH_MODE??'legacy-local')!=='legacy-local')throw new AppError(403,'旧知识快照缺少固定目标范围','SOURCE_BOUNDS_INVALID');
    if(operation==='skill')return undefined;
    const chunks=Array.isArray(snapshot?.[agentId])?snapshot[agentId]:[];
    return operation==='search'?searchKnowledge(chunks,value,limit):chunks.find((chunk:any)=>chunk.id===value);
  }
  const refs=references(snapshot,agentId);
  if(snapshot.sourceTarget){
    const target=snapshot.sourceTarget;
    if(!Array.isArray(target.departmentIds)||typeof target.adminOnly!=='boolean')throw new AppError(422,'知识目标范围无效','SOURCE_BOUNDS_INVALID');
    if(!target.adminOnly&&refs.length){
      const allowed=(await db.query(`SELECT id,version FROM (${safeSourceQuery('knowledge-revision')}) source WHERE source.departments <@ $1::text[]`,[target.departmentIds])).rows;
      if(refs.some(ref=>!allowed.some(row=>row.id===ref.documentId&&row.version===String(ref.version))))throw new AppError(422,'知识来源不能在目标运行读取','SOURCE_BOUNDS_INVALID');
    }
    for(const input of snapshot.runInputs??[]){if(!input.agentIds?.includes(agentId))continue;if(!input.sourceBounds&&!target.adminOnly)throw new AppError(422,'运行资料缺少来源约束','SOURCE_BOUNDS_INVALID');if(input.sourceBounds){assertTargetContainsSources(target.departmentIds,input.sourceBounds,{targetAdminOnly:target.adminOnly});assertTargetContainsSources(target.departmentIds,await validateSourceBounds(db,input.sourceBounds),{targetAdminOnly:target.adminOnly});}}
  }else if((process.env.WEIWU_AUTH_MODE??'legacy-local')!=='legacy-local')throw new AppError(403,'旧知识快照缺少固定目标范围','SOURCE_BOUNDS_INVALID');
  if(operation==='skill'){
    const ref=refs.find(doc=>doc.documentId===value&&typeof doc.source?.skillName==='string');
    if(!ref)return undefined;
    await verifyVersions([ref],db);
    const row=(await db.query('SELECT content FROM knowledge_revisions WHERE document_id=$1 AND version=$2 AND sha256=$3',[ref.documentId,ref.version,ref.sha256])).rows[0];
    if(!row||!row.content.trim()||row.content.length>16000||createHash('sha256').update(row.content).digest('hex')!==ref.sha256)throw new AppError(409,'批准工作方法的固定版本正文校验失败','APPROVED_SKILL_INVALID');
    return {...ref,content:row.content};
  }
  const hybrid=operation==='search'&&snapshot.retrieval?.mode==='hybrid';
  if(hybrid&&snapshot.retrieval.embeddingVersion!==embeddingVersion)throw new AppError(409,'本次运行使用不同的语义索引版本，请恢复对应模型后检索。','EMBEDDING_VERSION_MISMATCH');
  const count=Math.min(20,Math.max(1,limit)),candidateCount=hybrid?20:count;
  // Filter authorization before ranking, including inputs only assigned to one team member.
  const inputChunks=(snapshot.runInputs??[]).filter((doc:any)=>doc.agentIds.includes(agentId)).flatMap((doc:any)=>doc.chunks);
  const inputResults=operation==='search'?searchKnowledge(inputChunks,value,candidateCount):inputChunks.find((c:any)=>c.id===value);
  if (!refs.length&&!hybrid) return inputResults;
  if(!refs.length&&!inputChunks.length)return [];
  await verifyVersions(refs,db);
  if(operation==='read'&&inputResults)return inputResults;
  const terms=tokenize(value);
  if (operation==='search'&&!terms.length&&!hybrid) return [];
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
    operation==='search'?[JSON.stringify(refs),terms,value,candidateCount]:[JSON.stringify(refs),value,1])).rows;
  if(operation==='read')return rows[0];
  const lexical=[...rows,...inputResults].sort((a,b)=>b.score-a.score||a.id.localeCompare(b.id)).slice(0,candidateCount);
  return hybrid?fuseKnowledge(lexical,await vectorCandidates(refs,inputChunks,value,candidateCount,db),count):lexical;
}

export async function searchAvailableKnowledge(departmentId:string,agent:any,query:string,authority?:KnowledgeAuthority) {
  // Interactive search uses the current authorized versions; run tools use their stored manifest.
  const granted=(await pool.query(`SELECT s.id FROM knowledge_spaces s WHERE s.deleted_at IS NULL AND s.id=ANY($3::text[]) AND (s.scope='company' OR (s.department_id=$1 AND (s.scope='department' OR s.agent_ids ? $2)))`,
    [departmentId,agent.id,agent.knowledgeSpaceIds??[]])).rows.map(row=>row.id);
  const manifest=await knowledgeSnapshot([{...agent,knowledgeSpaceIds:granted}],departmentId,undefined,undefined,authority);
  return queryKnowledge(manifest,agent.id,'search',query);
}
