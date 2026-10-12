import {PGlite} from '@electric-sql/pglite';
import {performance} from 'node:perf_hooks';
import {createHash} from 'node:crypto';
import {writeFileSync,mkdirSync} from 'node:fs';
import {cpus,totalmem} from 'node:os';
import assert from 'node:assert/strict';
import {tokenize,searchKnowledge} from '../../../../services/agent-runtime/knowledge.mjs';
process.env.DATABASE_URL='postgres://unused:unused@127.0.0.1:1/unused';
const {queryKnowledge}=await import('../../../../apps/api/src/knowledge-store.ts');
const {pool}=await import('../../../../apps/api/src/db.ts');
const output=process.argv[2]??'docs/validation/evidence/retrieval-research-2026-10-12';mkdirSync(output,{recursive:true});
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
const stats=(values:number[])=>{const v=[...values].sort((a,b)=>a-b);return {samples:v.length,medianMs:v[Math.floor(v.length/2)],p95Ms:v[Math.ceil(v.length*.95)-1],maxMs:v.at(-1)};};
const results:any[]=[];
try{
 for(const size of [100,1000,10000]){
  const pg=new PGlite();await pg.waitReady;
  try{
   await pg.exec(`CREATE TABLE knowledge_revisions(document_id text,version int,content text,sha256 text,PRIMARY KEY(document_id,version));
    CREATE TABLE knowledge_chunks(id text PRIMARY KEY,document_id text,version int,line_start int,line_end int,content text,tokens jsonb);
    CREATE INDEX knowledge_chunks_document ON knowledge_chunks(document_id,version);
    CREATE INDEX knowledge_chunks_tokens ON knowledge_chunks USING gin(tokens);`);
   const chunks:any[]=[],docs:any[]=[],topics=['库存调整','退款金额','部署回滚','员工权限'];
   for(let d=0;d<size/20;d++){
    const id='doc-'+d,part:any[]=[];
    for(let k=0;k<20;k++){
     const number=d*20+k;
     const text=(topics[number%4]+' 验收流程 '+(number%100===0?'needleomega ':'')+'步骤检查 ').repeat(4)+'说明材料'.repeat(400)+' '+number;
     const chunk={id:hash(id+':'+k),documentId:id,version:1,lineStart:k+1,lineEnd:k+1,content:text,tokens:tokenize(text)};
     chunks.push(chunk);part.push(chunk);
    }
    const body=part.map(c=>c.content).join('\n');
    docs.push({documentId:id,version:1,title:id,spaceId:'authorized',sha256:hash(body),source:{},chunkCount:20,content:body});
   }
   await pg.query(`INSERT INTO knowledge_revisions SELECT "documentId",version,content,sha256 FROM jsonb_to_recordset($1) AS x("documentId" text,version int,content text,sha256 text)`,[JSON.stringify(docs)]);
   for(let i=0;i<chunks.length;i+=250)await pg.query(`INSERT INTO knowledge_chunks SELECT id,"documentId",version,"lineStart","lineEnd",content,tokens FROM jsonb_to_recordset($1) AS x(id text,"documentId" text,version int,"lineStart" int,"lineEnd" int,content text,tokens jsonb)`,[JSON.stringify(chunks.slice(i,i+250))]);
   await pg.query('INSERT INTO knowledge_revisions VALUES($1,1,$2,$3),($4,2,$5,$6)',['private','privateonlyzeta',hash('privateonlyzeta'),'doc-0','latestonlyomega',hash('latestonlyomega')]);
   await pg.query(`INSERT INTO knowledge_chunks VALUES('private-chunk','private',1,1,1,'privateonlyzeta',$1),('latest-chunk','doc-0',2,1,1,'latestonlyomega',$2)`,[JSON.stringify(tokenize('privateonlyzeta')),JSON.stringify(tokenize('latestonlyomega'))]);
   await pg.exec('ANALYZE knowledge_revisions; ANALYZE knowledge_chunks;');
   const manifest:any={format:'document-versions-v2',documents:docs.map(({content,...ref})=>ref),agentDocuments:{reader:docs.map(d=>d.documentId),denied:[]},retrieval:{mode:'keyword'}};
   let lastSearch:any;
   const db:any={query:async(sql:string,params:any[])=>{const result=await pg.query(sql,params);if(sql.includes('FROM authorized WHERE'))lastSearch={sql,params};return {rows:result.rows,rowCount:result.rows.length};}};
   const search=(q:string,agent='reader')=>queryKnowledge(manifest,agent,'search',q,6,db);
   assert.equal((await search('privateonlyzeta')).length,0);
   assert.equal((await search('latestonlyomega')).length,0);
   assert.equal((await search('needleomega','denied')).length,0);
   assert.ok((await search('needleomega')).every((c:any)=>c.version===1&&c.content.includes('needleomega')));
   const queries:any[]=[];
   for(const query of ['needleomega','库存调整','验收流程','zzznomatch']){
    const start=performance.now(),first=await search(query),firstLookupMs=performance.now()-start;
    for(let i=0;i<3;i++)await search(query);
    const times=[];for(let i=0;i<20;i++){const t=performance.now();const found=await search(query);times.push(performance.now()-t);assert.equal(found.length,first.length);}
    const plan=await pg.query('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) '+lastSearch.sql,lastSearch.params);
    writeFileSync(output+`/plan-${size}-${query}.json`,JSON.stringify(plan.rows,null,2));
    queries.push({query,returned:first.length,firstLookupMs,...stats(times)});
   }
   const catalog=chunks.slice(0,50).map(({id,content})=>({id,content:content.slice(0,150)}));
   const times=[];for(let i=0;i<20;i++){const t=performance.now();searchKnowledge(catalog,'库存调整',6);times.push(performance.now()-t);}
   const row={authorizedChunks:size,authorizedDocuments:docs.length,corpusUtf8Bytes:chunks.reduce((sum,c)=>sum+Buffer.byteLength(c.content),0),queries,catalog50:stats(times),permissionAndPinnedVersionChecks:'passed'};
   results.push(row);writeFileSync(output+'/local-results.json',JSON.stringify({checkedAt:new Date().toISOString(),platform:process.platform,node:process.version,cpu:cpus()[0].model,memoryBytes:totalmem(),engine:'actual queryKnowledge with injected fresh in-memory PGlite, existing GIN/document indexes',concurrency:1,modelCalls:0,limitations:['Synthetic corpus, repeated warm sequential queries; not JJ production throughput.','No HTTP, socket or network latency. No vector embedding/model cold start measured.'],results},null,2));
   console.log(JSON.stringify(row));
  }finally{await pg.close();}
 }
}finally{await pool.end();}
