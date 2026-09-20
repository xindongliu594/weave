import { Router } from 'express';
import { z } from 'zod';
import { randomUUID, createHash } from 'node:crypto';
import { pool } from './db.ts';
import { AppError } from './provider.ts';
import { ensureSpaceFolder, writeVaultDocument, archiveVaultDocument, syncObsidian, withVaultLock } from './obsidian.ts';
import { chunkDocument } from '../../../services/agent-runtime/knowledge.mjs';
const spaceSchema = z.object({ name: z.string().trim().min(1).max(100), scope: z.enum(['company','department','employee']), departmentId: z.string().nullable().optional(), agentIds: z.array(z.string()).max(6).default([]) });
const documentSchema = z.object({ spaceId: z.string(), title: z.string().trim().min(1).max(200), content: z.string().min(1).max(250000), version: z.number().int().positive().optional(), source: z.object({ runId: z.string().optional(), note: z.string().max(1000).optional() }).default({}) });
export { knowledgeSnapshot, validateKnowledgeGrants } from './knowledge-store.ts';
import { searchAvailableKnowledge } from './knowledge-store.ts';
export function knowledgeRouter() {
  const router=Router();
  router.get('/knowledge/spaces',async(_req,res)=>res.json((await pool.query('SELECT id,name,scope,department_id AS "departmentId",agent_ids AS "agentIds",version,vault_folder AS "vaultFolder" FROM knowledge_spaces WHERE deleted_at IS NULL ORDER BY name')).rows));
  router.post('/knowledge/spaces',async(req,res)=>{
    const input=spaceSchema.parse(req.body),id=randomUUID();
    if(input.scope!=='company' && !input.departmentId) throw new AppError(422,'部门/员工知识库必须指定部门');
    if(input.departmentId) {
      const d=(await pool.query('SELECT data FROM departments WHERE id=$1 AND deleted_at IS NULL',[input.departmentId])).rows[0];
      if(!d || input.agentIds.some(id=>!d.data.agents.some((a:any)=>a.id===id))) throw new AppError(422,'部门或员工不存在');
    }
    if(input.scope==='employee'&&!input.agentIds.length) throw new AppError(422,'请选择私有知识库的员工');
    await pool.query('INSERT INTO knowledge_spaces(id,name,scope,department_id,agent_ids) VALUES($1,$2,$3,$4,$5)',[id,input.name,input.scope,input.departmentId??null,JSON.stringify(input.agentIds)]); await ensureSpaceFolder(id); res.status(201).json({id});
  });
  router.delete('/knowledge/spaces/:id',async(req,res)=>{const result=await pool.query('UPDATE knowledge_spaces SET deleted_at=now(),version=version+1 WHERE id=$1 AND version=$2 AND deleted_at IS NULL',[req.params.id,z.number().int().positive().parse(req.body.version)]);if(!result.rowCount)throw new AppError(409,'知识库版本已变化');res.json({ok:true});});
  router.get('/knowledge/documents',async(req,res)=>res.json((await pool.query(`SELECT d.id,d.space_id AS "spaceId",d.title,d.version,r.sha256,r.content,r.source,d.vault_path AS "vaultPath",d.created_at AS "createdAt" FROM knowledge_documents d JOIN knowledge_revisions r ON r.document_id=d.id AND r.version=d.version WHERE d.deleted_at IS NULL AND ($1::text IS NULL OR d.space_id=$1) ORDER BY d.created_at DESC`,[req.query.spaceId??null])).rows));
  async function saveUnlocked(input:z.infer<typeof documentSchema>, id:string, isNew:boolean) {
    await syncObsidian();
    const client=await pool.connect();
    try {
      await client.query('BEGIN');
      if(!(await client.query('SELECT id FROM knowledge_spaces WHERE id=$1 AND deleted_at IS NULL FOR SHARE',[input.spaceId])).rowCount)throw new AppError(404,'知识库不存在');
      let version=1;
      if(isNew)await client.query('INSERT INTO knowledge_documents(id,space_id,title) VALUES($1,$2,$3)',[id,input.spaceId,input.title]);
      else {const result=await client.query('UPDATE knowledge_documents SET title=$1,version=version+1 WHERE id=$2 AND version=$3 AND space_id=$4 AND deleted_at IS NULL RETURNING version',[input.title,id,input.version,input.spaceId]);if(!result.rowCount)throw new AppError(409,'文档已更新，请刷新');version=result.rows[0].version;}
      await client.query('INSERT INTO knowledge_revisions(document_id,version,content,sha256,source) VALUES($1,$2,$3,$4,$5)',[id,version,input.content,createHash('sha256').update(input.content).digest('hex'),input.source]);
      for(const c of chunkDocument(id,version,input.content))await client.query('INSERT INTO knowledge_chunks(id,document_id,version,line_start,line_end,content,tokens) VALUES($1,$2,$3,$4,$5,$6,$7)',[c.id,id,version,c.lineStart,c.lineEnd,c.content,JSON.stringify(c.tokens)]);
      await client.query('COMMIT');await writeVaultDocument(id);return {id,version};
    }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
  }
  const save=(input:z.infer<typeof documentSchema>,id:string,isNew:boolean)=>withVaultLock(()=>saveUnlocked(input,id,isNew));
  router.post('/knowledge/documents',async(req,res)=>res.status(201).json(await save(documentSchema.parse(req.body),randomUUID(),true)));
  router.put('/knowledge/documents/:id',async(req,res)=>res.json(await save(documentSchema.parse(req.body),String(req.params.id),false)));
  router.get('/knowledge/documents/:id/versions',async(req,res)=>res.json((await pool.query('SELECT version,content,sha256,source,created_at AS "createdAt" FROM knowledge_revisions WHERE document_id=$1 ORDER BY version DESC',[req.params.id])).rows));
  router.delete('/knowledge/documents/:id',async(req,res)=>withVaultLock(async()=>{const r=await pool.query('UPDATE knowledge_documents SET deleted_at=now(),version=version+1 WHERE id=$1 AND version=$2 AND deleted_at IS NULL',[req.params.id,z.number().int().positive().parse(req.body.version)]);if(!r.rowCount)throw new AppError(409,'文档版本已变化');await archiveVaultDocument(String(req.params.id));res.json({ok:true});}));
  router.post('/knowledge/search',async(req,res)=>{
    const input=z.object({query:z.string().trim().min(1).max(1000),departmentId:z.string(),agentId:z.string()}).parse(req.body);
    const department=(await pool.query('SELECT data FROM departments WHERE id=$1 AND deleted_at IS NULL',[input.departmentId])).rows[0];
    const agent=department?.data.agents.find((a:any)=>a.id===input.agentId);
    if(!agent)throw new AppError(404,'员工不存在');
    res.json(await searchAvailableKnowledge(input.departmentId,agent,input.query));
  });
  return router;
}
