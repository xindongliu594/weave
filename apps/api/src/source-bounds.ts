import {createHash} from 'node:crypto';
import {z} from 'zod';
import {AppError} from './provider.ts';
import type {IdentityQueryExecutor} from './identity-schema.ts';
import {resolveRunDepartments} from './resource-authorization.ts';

const id=z.string().min(1).max(128).refine(value=>value===value.trim());
const digest=z.string().regex(/^[a-f0-9]{64}$/);
const version=z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const reference=z.discriminatedUnion('kind',[
  z.object({kind:z.literal('run'),id,version,sha256:digest}).strict(),
  z.object({kind:z.literal('file'),id,sha256:digest}).strict(),
  z.object({kind:z.literal('knowledge-revision'),id,version,sha256:digest}).strict(),
]);
const schema=z.object({requiredDepartmentIds:z.array(id).max(100),adminOnly:z.boolean(),private:z.boolean(),refs:z.array(reference).max(200)}).strict();
export type SourceBounds=z.infer<typeof schema>;
export type SourceReference=SourceBounds['refs'][number];
const failure=(message:string,status=422)=>new AppError(status,message,'SOURCE_BOUNDS_INVALID');
export const sourceHash=(value:string)=>createHash('sha256').update(value).digest('hex');
const refKey=(ref:SourceReference)=>JSON.stringify([ref.kind,ref.id,'version' in ref?ref.version:null]);
export function parseSourceBounds(value:unknown):SourceBounds {
  const parsed=schema.safeParse(value);
  if(!parsed.success)throw failure('来源约束格式无效');
  const refs=new Map<string,SourceReference>();
  for(const ref of parsed.data.refs){const key=refKey(ref),prior=refs.get(key);if(prior&&prior.sha256!==ref.sha256)throw failure('来源固定版本的摘要冲突');refs.set(key,ref);}
  return {...parsed.data,requiredDepartmentIds:[...new Set(parsed.data.requiredDepartmentIds)].sort(),refs:[...refs.values()].sort((a,b)=>refKey(a).localeCompare(refKey(b)))};
}
export function combineSourceBounds(values:SourceBounds[]):SourceBounds {
  const items=values.map(parseSourceBounds);
  // Validate the combined size too: provenance must remain bounded at each derivation.
  const refs=new Map<string,SourceReference>();
  for(const item of items)for(const ref of item.refs){const key=refKey(ref),old=refs.get(key);if(old&&old.sha256!==ref.sha256)throw failure('来源固定版本的摘要冲突');refs.set(key,ref);}
  return parseSourceBounds({requiredDepartmentIds:[...new Set(items.flatMap(item=>item.requiredDepartmentIds))],adminOnly:items.some(item=>item.adminOnly),private:items.some(item=>item.private),refs:[...refs.values()]});
}
/** This option describes a persisted restricted target, never the caller's role. */
export function assertTargetContainsSources(targetDepartmentIds:string[],value:SourceBounds,options:{targetAdminOnly?:boolean}={}):void {
  const bounds=parseSourceBounds(value),target=new Set(z.array(id).max(100).parse(targetDepartmentIds));
  if(bounds.private||bounds.requiredDepartmentIds.some(department=>!target.has(department))||(bounds.adminOnly&&!options.targetAdminOnly))throw failure('目标不能放宽来源的部门、私有或管理员限制');
}

export const rootSourceBounds=():SourceBounds=>({requiredDepartmentIds:[],adminOnly:true,private:false,refs:[]});
type Context={db:IdentityQueryExecutor;visiting:Set<string>;cache:Map<string,SourceBounds>;nodes:number};
const context=(db:IdentityQueryExecutor):Context=>({db,visiting:new Set(),cache:new Map(),nodes:0});
const invalid=(error:unknown)=>error instanceof AppError&&error.code==='SOURCE_BOUNDS_INVALID';
const restricted=():SourceBounds=>({...rootSourceBounds(),private:true});
async function validateReferences(ctx:Context,value:unknown):Promise<SourceBounds> {
  const bounds=parseSourceBounds(value),inherited:SourceBounds[]=[bounds];
  for(const ref of bounds.refs){
    const actual=await read(ctx,ref.kind,ref.id,'version' in ref?ref.version:undefined);
    const self=actual.refs.find(item=>refKey(item)===refKey(ref));
    if(!self||self.sha256!==ref.sha256)throw failure('来源固定版本或摘要已变化',409);
    inherited.push(actual);
  }
  return combineSourceBounds(inherited);
}
async function stored(ctx:Context,value:unknown):Promise<SourceBounds> {
  if(value===null)return rootSourceBounds();
  try{return await validateReferences(ctx,value);}catch(error){if(!invalid(error))throw error;return restricted();}
}
async function linkedRun(ctx:Context,runId:unknown,value:unknown):Promise<SourceBounds> {
  if(!id.safeParse(runId).success)return restricted();
  try{
    const bounds=await read(ctx,'run',runId as string);
    // A non-NULL persisted claim must explicitly bind the durable source link.
    if(value!==null&&!parseSourceBounds(value).refs.some(ref=>ref.kind==='run'&&ref.id===runId))return combineSourceBounds([bounds,restricted()]);
    return bounds;
  }catch(error){if(!invalid(error))throw error;return restricted();}
}
async function read(ctx:Context,kind:SourceReference['kind'],resourceId:string,resourceVersion?:number):Promise<SourceBounds> {
  if(!id.safeParse(resourceId).success||(kind==='knowledge-revision'&&!version.safeParse(resourceVersion).success))throw failure('来源标识无效');
  const key=JSON.stringify([kind,resourceId,resourceVersion??null]);
  if(ctx.visiting.has(key)||ctx.visiting.size>=32)throw failure('来源引用循环或层级超限');
  const cached=ctx.cache.get(key);if(cached)return cached;
  if(++ctx.nodes>200)throw failure('来源引用数量超限');
  ctx.visiting.add(key);
  try{
    let row:any,base:SourceBounds,ref:SourceReference,extra:SourceBounds[]=[];
    if(kind==='run'){
      row=(await ctx.db.query('SELECT project_version,snapshot::text AS body,source_bounds FROM project_runs WHERE id=$1',[resourceId])).rows[0];
      if(!row)throw failure('来源运行不存在',404);
      const departments=await resolveRunDepartments(ctx.db,resourceId);
      base={requiredDepartmentIds:departments??[],adminOnly:!departments,private:false,refs:[]};
      ref={kind,id:resourceId,version:row.project_version,sha256:sourceHash(row.body)};
    }else if(kind==='file'){
      row=(await ctx.db.query('SELECT files::text AS body,source_run_id,source_bounds FROM work_file_snapshots WHERE id=$1',[resourceId])).rows[0];
      if(!row)throw failure('来源素材不存在',404);
      base={...rootSourceBounds(),adminOnly:!row.source_run_id};
      ref={kind,id:resourceId,sha256:sourceHash(row.body)};
      if(row.source_run_id)extra.push(await linkedRun(ctx,row.source_run_id,row.source_bounds));
    }else{
      row=(await ctx.db.query(`SELECT r.content,r.sha256,r.source,r.source_bounds,d.deleted_at,s.deleted_at AS space_deleted,s.scope,s.department_id,
        EXISTS(SELECT 1 FROM departments department WHERE department.id=s.department_id AND department.deleted_at IS NULL) AS department_active
        FROM knowledge_revisions r JOIN knowledge_documents d ON d.id=r.document_id JOIN knowledge_spaces s ON s.id=d.space_id WHERE r.document_id=$1 AND r.version=$2`,[resourceId,resourceVersion])).rows[0];
      if(!row)throw failure('来源知识版本不存在',404);
      base={requiredDepartmentIds:row.department_id?[row.department_id]:[],adminOnly:row.scope!=='department'||!row.department_active||!!row.deleted_at||!!row.space_deleted,private:row.scope==='employee',refs:[]};
      ref={kind,id:resourceId,version:resourceVersion!,sha256:row.sha256};
      if(sourceHash(row.content)!==row.sha256)throw failure('来源知识正文摘要不符',409);
      if(row.source?.runId!==undefined)extra.push(await linkedRun(ctx,row.source.runId,row.source_bounds));
    }
    const result=combineSourceBounds([base,await stored(ctx,row.source_bounds),...extra,{...base,refs:[ref]}]);
    ctx.cache.set(key,result);return result;
  }finally{ctx.visiting.delete(key);}
}
/** Only callers holding the write transaction may turn these validated server-side bounds into a new row. */
export const validateSourceBounds=(db:IdentityQueryExecutor,value:unknown)=>validateReferences(context(db),value);
export const readRunBounds=(db:IdentityQueryExecutor,runId:string)=>read(context(db),'run',runId);
export const readFileBounds=(db:IdentityQueryExecutor,fileId:string)=>read(context(db),'file',fileId);
export const readKnowledgeRevisionBounds=(db:IdentityQueryExecutor,documentId:string,revision:number)=>read(context(db),'knowledge-revision',documentId,revision);

/** A candidate's main run is only one source; reuse evidence can name up to 100 contributing works. */
export async function readCandidateBounds(db:IdentityQueryExecutor,candidateId:string):Promise<SourceBounds> {
  const row=(await db.query('SELECT * FROM automation_knowledge_candidates WHERE id=$1',[candidateId])).rows[0];
  if(!row)throw failure('来源候选不存在',404);
  const ctx=context(db),revision=await validateReferences(ctx,{...rootSourceBounds(),adminOnly:false,refs:[{kind:'knowledge-revision',id:row.document_id,version:row.source_version,sha256:row.source_hash}]});
  const items=[revision,await read(ctx,'run',row.run_id),await stored(ctx,row.source_bounds)];
  if(row.reuse_evidence){
    const evidence=row.reuse_evidence,refs=evidence.workReferences??evidence.works;
    if(!Array.isArray(refs)||!refs.length||refs.length>100||refs.some((ref:any)=>!id.safeParse(ref?.runId).success))throw failure('候选来源工作引用无效');
    if(evidence.source&&(evidence.source.documentId!==row.document_id||evidence.source.version!==row.source_version||evidence.source.sha256!==row.source_hash))throw failure('候选固定来源不一致');
    for(const ref of refs)items.push(await read(ctx,'run',ref.runId));
  }
  return combineSourceBounds(items);
}
