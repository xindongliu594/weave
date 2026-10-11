import { Router } from 'express';
import { z } from 'zod';
import { randomUUID, createHash } from 'node:crypto';
import { pool } from './db.ts';
import { AppError } from './provider.ts';
import { ensureSpaceFolder, writeVaultDocument, archiveVaultDocument, syncObsidian, withVaultLock } from './obsidian.ts';
import { chunkDocument } from '../../../services/agent-runtime/knowledge.mjs';
const spaceSchema = z.object({ name: z.string().trim().min(1).max(100), scope: z.enum(['company','department','employee']), departmentId: z.string().nullable().optional(), agentIds: z.array(z.string()).max(6).default([]) });
const documentSchema = z.object({ spaceId: z.string(), title: z.string().trim().min(1).max(200), content: z.string().min(1).max(250000), version: z.number().int().positive().optional(), source: z.object({ runId: z.string().optional(), note: z.string().max(1000).optional(), skillName:z.string().max(80).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).optional() }).default({}) }).refine(input=>!input.source.skillName||(input.content.trim().length>0&&input.content.length<=16000),{message:'批准工作方法正文须非空且最多 16,000 字符',path:['content']});
export { knowledgeSnapshot, validateKnowledgeGrants } from './knowledge-store.ts';
import { searchAvailableKnowledge } from './knowledge-store.ts';
import { knowledgeIndexStatus,startKnowledgeIndex } from './knowledge-vector.ts';
import { embedTexts } from '../../../services/embedding/local.mjs';
import {acceptedWorkRecord} from './work-records.ts';
import {resolve} from 'node:path';
async function saveKnowledgeDocumentUnlocked(input:z.infer<typeof documentSchema>, id:string, isNew:boolean) {
  await syncObsidian();
  const client=await pool.connect();let version=1;
  try {
    await client.query('BEGIN');
    if(!(await client.query('SELECT id FROM knowledge_spaces WHERE id=$1 AND deleted_at IS NULL FOR SHARE',[input.spaceId])).rowCount)throw new AppError(404,'知识库不存在');
    if(isNew)await client.query('INSERT INTO knowledge_documents(id,space_id,title) VALUES($1,$2,$3)',[id,input.spaceId,input.title]);
    else {const result=await client.query('UPDATE knowledge_documents SET title=$1,version=version+1 WHERE id=$2 AND version=$3 AND space_id=$4 AND deleted_at IS NULL RETURNING version',[input.title,id,input.version,input.spaceId]);if(!result.rowCount)throw new AppError(409,'文档已更新，请刷新');version=result.rows[0].version;}
    await client.query('INSERT INTO knowledge_revisions(document_id,version,content,sha256,source) VALUES($1,$2,$3,$4,$5)',[id,version,input.content,createHash('sha256').update(input.content).digest('hex'),input.source]);
    for(const c of chunkDocument(id,version,input.content))await client.query('INSERT INTO knowledge_chunks(id,document_id,version,line_start,line_end,content,tokens) VALUES($1,$2,$3,$4,$5,$6,$7)',[c.id,id,version,c.lineStart,c.lineEnd,c.content,JSON.stringify(c.tokens)]);
    await client.query('COMMIT');
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
  await writeVaultDocument(id);return {id,version};
}
export const saveKnowledgeDocument=(input:unknown,id:string=randomUUID(),isNew=true)=>withVaultLock(()=>saveKnowledgeDocumentUnlocked(documentSchema.parse(input),id,isNew));

export function knowledgeRouter(traceRoot=resolve(process.env.TRACE_ROOT??'.data/runs')) {
  const router=Router();
  router.get('/knowledge/work-records',async(_req,res)=>res.json((await pool.query(`SELECT r.id AS "runId",r.project_id AS "projectId",r.snapshot->>'title' AS title,r.snapshot->>'planVersion' AS "planVersion",r.status,r.created_at AS "createdAt",p.department_id AS "departmentId" FROM project_runs r JOIN projects p ON p.id=r.project_id JOIN departments d ON d.id=p.department_id WHERE d.deleted_at IS NULL ORDER BY r.created_at DESC LIMIT 50`)).rows));
  router.get('/knowledge/work-records/:id',async(req,res)=>res.json(await acceptedWorkRecord(pool,traceRoot,z.uuid().parse(req.params.id))));
  router.post('/knowledge/work-records/:id/publish',async(req,res)=>withVaultLock(async()=>{
    const runId=z.uuid().parse(req.params.id),{spaceId}=z.object({spaceId:z.string().min(1)}).strict().parse(req.body);
    const record=await acceptedWorkRecord(pool,traceRoot,runId),space=(await pool.query('SELECT scope,department_id FROM knowledge_spaces WHERE id=$1 AND deleted_at IS NULL',[spaceId])).rows[0];
    if(!space||space.scope!=='department'||space.department_id!==record.departmentId)throw new AppError(422,'工作记录只能发布到来源部门的知识空间');
    if(!record.shareable)throw new AppError(422,'来源含员工定向资料，请先审查私有资料边界；不能直接发布为部门知识');
    const id='work-'+runId,existing=(await pool.query('SELECT d.space_id,d.deleted_at,r.sha256 FROM knowledge_documents d JOIN knowledge_revisions r ON r.document_id=d.id AND r.version=d.version WHERE d.id=$1',[id])).rows[0];
    if(existing){if(existing.deleted_at||existing.space_id!==spaceId||existing.sha256!==record.sha256)throw new AppError(409,'工作知识记录已编辑、归档或发布到另一空间，请查看原记录');return res.json({id,existing:true});}
    const quota=(await pool.query("SELECT count(DISTINCT d.id)::int AS count,coalesce(sum(octet_length(r.content)),0)::bigint AS bytes FROM knowledge_documents d JOIN knowledge_revisions r ON r.document_id=d.id WHERE d.id LIKE 'work-%'")).rows[0];
    if(quota.count>=500||Number(quota.bytes)+Buffer.byteLength(record.content)>8*1024*1024)throw new AppError(422,'工作知识登记达到 500 份或 8 MiB 限额；原记录及历史保留');
    const result=await saveKnowledgeDocumentUnlocked({spaceId,title:record.title,content:record.content,source:{runId,note:`已核验工作记录；项目 ${record.projectId} 方案 v${record.planVersion}；记录 SHA256 ${record.sha256}`}},id,true);
    res.status(201).json(result);
  }));
  router.get('/knowledge/retrieval',async(_req,res)=>{const row=(await pool.query('SELECT version,data FROM product_settings WHERE id=1')).rows[0];res.json({mode:row.data.knowledgeSearchMode??'keyword',version:row.version,...await knowledgeIndexStatus()});});
  router.put('/knowledge/retrieval',async(req,res)=>{
    const input=z.object({mode:z.enum(['keyword','hybrid']),version:z.number().int().positive()}).parse(req.body);
    if(input.mode==='hybrid')try{await embedTexts(['local readiness'],'query');}catch{throw new AppError(503,'本地语义模型缺失或不可用，请先运行模型安装脚本','EMBEDDING_NOT_READY');}
    const result=await pool.query("UPDATE product_settings SET data=data||jsonb_build_object('knowledgeSearchMode',$1::text),version=version+1 WHERE id=1 AND version=$2",[input.mode,input.version]);if(!result.rowCount)throw new AppError(409,'设置已变化，请刷新');
    if(input.mode==='hybrid')void startKnowledgeIndex();res.json({ok:true});
  });
  router.post('/knowledge/index',async(_req,res)=>{const state=await knowledgeIndexStatus();if(!state.installed)throw new AppError(503,'请先安装本地语义模型','EMBEDDING_NOT_READY');void startKnowledgeIndex();res.status(202).json({ok:true});});
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
  const save=saveKnowledgeDocument;
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
