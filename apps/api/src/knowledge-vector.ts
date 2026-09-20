import type pg from 'pg';
import { pool } from './db.ts';
import { AppError } from './provider.ts';
import { embedTexts,embeddingVersion,embeddingStatus } from '../../../services/embedding/local.mjs';
type Database=Pick<pg.PoolClient,'query'>;
async function embed(texts:string[],kind:'query'|'passage'='passage'){
 try{return await embedTexts(texts,kind);}catch{throw new AppError(503,'本地语义模型无法运行或文件校验失败，请检查安装；未切换到其他模型或外部 API。','EMBEDDING_NOT_READY');}
}
export const authorizedChunks=`WITH refs AS (SELECT * FROM jsonb_to_recordset($1) AS x("documentId" text,version int,title text,"spaceId" text,sha256 text,source jsonb)),
 authorized AS MATERIALIZED (SELECT c.id,c.document_id AS "documentId",c.version,c.line_start AS "lineStart",c.line_end AS "lineEnd",c.content,c.tokens,x.title,x."spaceId",x.sha256,x.source
 FROM refs x JOIN knowledge_chunks c ON c.document_id=x."documentId" AND c.version=x.version)`;
export async function indexChunks(chunks:any[],db:Database=pool){
 for(let offset=0;offset<chunks.length;offset+=16){
  const batch=chunks.slice(offset,offset+16);
  const found=(await db.query(`SELECT chunk_id,title FROM knowledge_embeddings WHERE model_version=$1 AND chunk_id=ANY($2::text[])`,[embeddingVersion,batch.map(c=>c.id)])).rows;
  const missing=batch.filter(c=>!found.some(e=>e.chunk_id===c.id&&e.title===c.title));if(!missing.length)continue;
  const vectors=await embed(missing.map(c=>c.title+'\n'+c.content));
  for(let i=0;i<missing.length;i++)await db.query('INSERT INTO knowledge_embeddings(chunk_id,model_version,title,embedding) VALUES($1,$2,$3,$4::public.vector) ON CONFLICT DO NOTHING',[missing[i].id,embeddingVersion,missing[i].title,JSON.stringify(vectors[i])]);
 }
}
export async function vectorCandidates(refs:any[],inputs:any[],query:string,limit:number,db:Database=pool){
 if(!embeddingStatus().installed)throw new AppError(503,'本地语义模型尚未安装，请在知识库页查看准备方式','EMBEDDING_NOT_READY');
 const encoded=JSON.stringify(refs);
 // Index only authorized immutable revisions. No global nearest-neighbor query followed by filtering.
 while(true){const missing=(await db.query(`${authorizedChunks} SELECT a.* FROM authorized a LEFT JOIN knowledge_embeddings e ON e.chunk_id=a.id AND e.model_version=$2 AND e.title=a.title WHERE e.chunk_id IS NULL ORDER BY a.id LIMIT 16`,[encoded,embeddingVersion])).rows;if(!missing.length)break;await indexChunks(missing,db);}
 await indexChunks(inputs,db);
 const [vector]=await embed([query],'query'),wire=JSON.stringify(vector);
 const rows=(await db.query(`${authorizedChunks} SELECT a.id,a."documentId",a.version,a."lineStart",a."lineEnd",a.content,a.title,a."spaceId",a.sha256,a.source,
  1-(e.embedding OPERATOR(public.<=>) $3::public.vector) AS "vectorScore"
  FROM authorized a JOIN knowledge_embeddings e ON e.chunk_id=a.id AND e.model_version=$2 AND e.title=a.title
  ORDER BY e.embedding OPERATOR(public.<=>) $3::public.vector,a.id LIMIT $4`,[encoded,embeddingVersion,wire,limit])).rows;
 const inputScores=inputs.length?(await db.query(`SELECT e.chunk_id,1-(e.embedding OPERATOR(public.<=>) $3::public.vector) AS score
 FROM jsonb_to_recordset($1) AS x(id text,title text) JOIN knowledge_embeddings e ON e.chunk_id=x.id AND e.title=x.title AND e.model_version=$2
 ORDER BY e.embedding OPERATOR(public.<=>) $3::public.vector,e.chunk_id LIMIT $4`,[JSON.stringify(inputs.map(c=>({id:c.id,title:c.title}))),embeddingVersion,wire,limit])).rows:[];
 return [...rows,...inputScores.map(e=>{const {tokens:_tokens,...chunk}=inputs.find(c=>c.id===e.chunk_id);return {...chunk,vectorScore:Number(e.score)};})].sort((a,b)=>b.vectorScore-a.vectorScore||a.id.localeCompare(b.id)).slice(0,limit);
}
export function fuseKnowledge(lexical:any[],semantic:any[],limit:number){
 const results=new Map<string,any>();
 // Reciprocal rank fusion combines incomparable lexical and cosine scores without a fabricated probability.
 for(const [channel,rows] of [['keyword',lexical],['vector',semantic]] as const)rows.forEach((row,index)=>{
  const current=results.get(row.id)??{...row,score:0,matchedBy:[],embeddingVersion};
  current.score+=1/(60+index+1);current.matchedBy.push(channel);
  if(channel==='keyword')current.keywordScore=row.score;else current.vectorScore=row.vectorScore;
  results.set(row.id,current);
 });
 return [...results.values()].sort((a,b)=>b.score-a.score||a.id.localeCompare(b.id)).slice(0,limit);
}
let indexing:Promise<void>|undefined,indexError:string|undefined;
export function startKnowledgeIndex(){
 if(indexing)return indexing;
 indexing=(async()=>{
  indexError=undefined;
  while(true){const missing=(await pool.query(`SELECT c.id,c.content,d.title FROM knowledge_documents d JOIN knowledge_spaces s ON s.id=d.space_id JOIN knowledge_chunks c ON c.document_id=d.id AND c.version=d.version
   LEFT JOIN knowledge_embeddings e ON e.chunk_id=c.id AND e.model_version=$1 AND e.title=d.title WHERE d.deleted_at IS NULL AND s.deleted_at IS NULL AND e.chunk_id IS NULL ORDER BY c.id LIMIT 16`,[embeddingVersion])).rows;
   if(!missing.length)break;await indexChunks(missing);
  }
 })().catch(()=>{indexError='本地索引未完成，请检查模型文件后重试。';}).finally(()=>{indexing=undefined;});
 return indexing;
}
export async function knowledgeIndexStatus(){
 const row=(await pool.query(`SELECT count(*)::int AS total,count(e.chunk_id)::int AS indexed FROM knowledge_documents d JOIN knowledge_spaces s ON s.id=d.space_id JOIN knowledge_chunks c ON c.document_id=d.id AND c.version=d.version
 LEFT JOIN knowledge_embeddings e ON e.chunk_id=c.id AND e.model_version=$1 AND e.title=d.title WHERE d.deleted_at IS NULL AND s.deleted_at IS NULL`,[embeddingVersion])).rows[0];
 return {...embeddingStatus(),...row,running:!!indexing,error:indexError??null};
}
export async function waitKnowledgeIndex(){await indexing;}
