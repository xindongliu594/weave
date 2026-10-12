import {PGlite} from '@electric-sql/pglite';
import {performance} from 'node:perf_hooks';
import {createHash,randomBytes} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync,openSync,closeSync,statSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createServer} from 'node:net';
import {cpus,totalmem} from 'node:os';
import assert from 'node:assert/strict';
import {tokenize} from '../../../../services/agent-runtime/knowledge.mjs';
process.env.DATABASE_URL='postgres://unused:unused@127.0.0.1:1/unused';
const {queryKnowledge}=await import('../../../../apps/api/src/knowledge-store.ts');
const {pool}=await import('../../../../apps/api/src/db.ts');
const root=resolve('.data/retrieval-compare-20261012');
const output=resolve('docs/validation/evidence/retrieval-comparison-2026-10-12');mkdirSync(output,{recursive:true});
const hash=(s:string|Buffer)=>createHash('sha256').update(s).digest('hex');
const bindingOnly=process.argv.includes('--binding-check');
function validateHits(hits:any[],lookup:Map<string,any>,manifest:any){
 const allowed=new Set(manifest.documents.filter((doc:any)=>manifest.agentDocuments.reader.includes(doc.documentId)).map((doc:any)=>doc.documentId+':'+doc.version));
 for(const hit of hits){const source=lookup.get(hit.id);assert.ok(source);assert.equal(hit.documentId,source.documentId);assert.equal(hit.version,source.version);assert.equal(hit.content,source.content);assert.ok(allowed.has(source.documentId+':'+source.version));}
}
const bindingManifest={documents:[{documentId:'allowed',version:1},{documentId:'other',version:1}],agentDocuments:{reader:['allowed','other']}};
const safe={id:'safe',documentId:'allowed',version:1,content:'fixed'},privateHit={id:'private',documentId:'private',version:1,content:'secret'},newHit={id:'new',documentId:'allowed',version:2,content:'new'};
const bindingLookup=new Map([safe,privateHit,newHit].map(item=>[item.id,item]));
validateHits([safe],bindingLookup,bindingManifest);
for(const bad of [{...safe,documentId:'other'},{...safe,version:2},{...safe,content:'changed'},privateHit,newHit])assert.throws(()=>validateHits([bad],bindingLookup,bindingManifest));
const provenance=JSON.parse(readFileSync(join(root,'provenance.json'),'utf8'));
assert.equal(hash(readFileSync(join(root,'meilisearch.exe'))),provenance.meilisearch.sha256);
const original=readFileSync('apps/api/src/knowledge-store.ts','utf8');
assert.ok(original.includes('import { tokenize, searchKnowledge, chunkDocument }'));
const sourceUrl=pathToFileURL(resolve('apps/api/src/knowledge-store.ts'));
const adapted=original.replace(/from '(\.\.?\/[^']+)'/g,(_all,relative)=>'from '+JSON.stringify(new URL(relative,sourceUrl).href))
 .replace('import { tokenize, searchKnowledge, chunkDocument }','import { searchKnowledge, chunkDocument }')
 + '\nimport { jiebaTokenize as tokenize } from "./jieba-tokenizer.mjs";\n';
writeFileSync(join(root,'knowledge-store-jieba.ts'),adapted);
writeFileSync(join(root,'jieba-tokenizer.mjs'),`import {createRequire} from 'node:module';
 const require=createRequire(import.meta.url);const {Jieba}=require('./node_modules/@node-rs/jieba');const {dict}=require('./node_modules/@node-rs/jieba/dict');
 const jieba=Jieba.withDict(dict);
 export function jiebaTokenize(text){return [...new Set(jieba.cutForSearch(text.toLowerCase().normalize('NFKC'),true).filter(word=>/^(?:[a-z0-9_]{2,}|[\\p{Script=Han}]+)$/u.test(word)))];}
`);
const {jiebaTokenize}=await import(pathToFileURL(join(root,'jieba-tokenizer.mjs')).href);
const {queryKnowledge:jiebaQuery}=await import(pathToFileURL(join(root,'knowledge-store-jieba.ts')).href);
const stats=(times:number[])=>{const values=[...times].sort((a,b)=>a-b);return {samples:values.length,medianMs:values[Math.floor(values.length/2)],p95Ms:values[Math.ceil(values.length*.95)-1],maxMs:values.at(-1)};};
const pause=(ms:number)=>new Promise(r=>setTimeout(r,ms));
const reservation=createServer();reservation.listen(0,'127.0.0.1');await once(reservation,'listening');
const port=(reservation.address() as any).port;await new Promise<void>(r=>reservation.close(()=>r()));
const key=randomBytes(32).toString('hex'),base='http://127.0.0.1:'+port;
const log=openSync(join(root,'meilisearch-private.log'),'a');
const child=spawn(join(root,'meilisearch.exe'),['--http-addr','127.0.0.1:'+port,'--db-path',join(root,'isolated-index'),'--max-indexing-memory','256MiB','--max-indexing-threads','2','--no-analytics'],{cwd:root,windowsHide:true,stdio:['ignore',log,log],env:{...process.env,MEILI_MASTER_KEY:key,MEILI_ENV:'production'}});
closeSync(log);
let exited=false;child.once('exit',()=>{exited=true;});
async function request(path:string,method='GET',body?:any){
 const response=await fetch(base+path,{method,headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(20000)});
 const value=await response.json();if(!response.ok)throw Error('Isolated Meilisearch HTTP '+response.status+': '+JSON.stringify(value));return value as any;
}
async function task(value:any){
 const deadline=performance.now()+120000;
 while(performance.now()<deadline){const status=await request('/tasks/'+value.taskUid);if(status.status==='succeeded')return status;if(status.status==='failed')throw Error(JSON.stringify(status.error));await pause(100);}
 throw Error('Isolated indexing task exceeded bounded deadline');
}
async function database(chunks:any[],documents:any[],split:(s:string)=>string[]){
 const pg=new PGlite();await pg.waitReady;
 await pg.exec(`CREATE TABLE knowledge_revisions(document_id text,version int,content text,sha256 text,PRIMARY KEY(document_id,version));
 CREATE TABLE knowledge_chunks(id text PRIMARY KEY,document_id text,version int,line_start int,line_end int,content text,tokens jsonb);
 CREATE INDEX knowledge_chunks_document ON knowledge_chunks(document_id,version);CREATE INDEX knowledge_chunks_tokens ON knowledge_chunks USING gin(tokens);`);
 await pg.query(`INSERT INTO knowledge_revisions SELECT "documentId",version,content,sha256 FROM jsonb_to_recordset($1) AS x("documentId" text,version int,content text,sha256 text)`,[JSON.stringify(documents)]);
 for(let i=0;i<chunks.length;i+=250)await pg.query(`INSERT INTO knowledge_chunks SELECT id,"documentId",version,"lineStart","lineEnd",content,tokens FROM jsonb_to_recordset($1) AS x(id text,"documentId" text,version int,"lineStart" int,"lineEnd" int,content text,tokens jsonb)`,[JSON.stringify(chunks.slice(i,i+250).map(c=>({...c,tokens:split(c.content)})))]);
 await pg.exec('ANALYZE knowledge_revisions; ANALYZE knowledge_chunks;');
 let verification:any;
 const db:any={query:async(sql:string,params:any[])=>{const result=await pg.query(sql,params);if(sql.includes('SELECT x."documentId" FROM refs'))verification={sql,params};return {rows:result.rows,rowCount:result.rows.length};}};
 return {pg,db,verify:async()=>{assert.ok(verification);const v=await pg.query(verification.sql,verification.params);assert.equal(v.rows.length,0);}};
}
function corpus(size:number){
 const chunks:any[]=[],documents:any[]=[],topics=['库存调整','退款金额','部署回滚','员工权限'];
 for(let d=0;d<size/20;d++){
  const id='doc-'+d,parts=[];
  for(let k=0;k<20;k++){
   const number=d*20+k,text=(topics[number%4]+' 验收流程 '+(number%100===0?'needleomega ':'')+'步骤检查 ').repeat(4)+'说明材料'.repeat(400)+' '+number;
   const chunk={id:hash(id+':'+k),documentId:id,version:1,lineStart:k+1,lineEnd:k+1,content:text};chunks.push(chunk);parts.push(chunk);
  }
  const content=parts.map(c=>c.content).join('\n');documents.push({documentId:id,version:1,title:id,spaceId:'authorized',source:{},sha256:hash(content),chunkCount:20,content});
 }
 addDocument(chunks,documents,'private',1,'privateonlyzeta');addDocument(chunks,documents,'doc-0',2,'latestonlyomega');addDocument(chunks,documents,'deleted',1,'deletedonlytheta');
 return {chunks,documents};
}
function addDocument(chunks:any[],documents:any[],id:string,version:number,content:string){documents.push({documentId:id,version,title:id,spaceId:'authorized',source:{},sha256:hash(content),chunkCount:1,content});chunks.push({id:hash(id+':version-'+version+':single'),documentId:id,version,lineStart:1,lineEnd:1,content});}
const results:any={checkedAt:new Date().toISOString(),platform:process.platform,node:process.version,cpu:cpus()[0].model,memoryBytes:totalmem(),versions:{meilisearch:provenance.meilisearch.version,jieba:'2.0.4'},concurrency:1,meilisearchIndexingThreads:2,modelCalls:0,sourceHashes:{originalStore:hash(original),isolatedJiebaStore:hash(adapted)},scale:[],quality:[],limitations:['Synthetic corpus and sequential warmed queries, not employee acceptance or concurrent throughput.','PGlite SQL versus native Meilisearch loopback HTTP; engines are different.','Meilisearch verified timing includes the same original database version check plus original result-content/scope validation.','Jieba isolated store changes only the tokenizer import and stored tokens; SQL/ranking are original.','No vector embedding, reranker or paid inference; no production configuration changed.']};
writeFileSync(join(output,'provenance.json'),JSON.stringify(provenance,null,2));
const save=()=>writeFileSync(join(output,bindingOnly?'binding-check-results.json':'comparison-results.json'),JSON.stringify(results,null,2));
async function compare(label:string,data:any,queries:any[],quality=false){
 const {chunks,documents}=data,refs=documents.filter((d:any)=>d.documentId!=='private'&&d.documentId!=='deleted'&&d.version===1);
 const manifest:any={format:'document-versions-v2',documents:refs.map(({content,...r}:any)=>r),agentDocuments:{reader:refs.map((d:any)=>d.documentId),denied:[]},retrieval:{mode:'keyword'}};
 const originalDb=await database(chunks,documents,tokenize),jiebaDb=await database(chunks,documents,jiebaTokenize);
 try{
  const index='compare-'+label;await task(await request('/indexes','POST',{uid:index,primaryKey:'id'}));
  await task(await request('/indexes/'+index+'/settings','PATCH',{searchableAttributes:['content'],filterableAttributes:['versionKey'],typoTolerance:{enabled:false}}));
  const lookup=new Map(chunks.map((c:any)=>[c.id,c]));
  const importStart=performance.now();
  await task(await request('/indexes/'+index+'/documents','POST',chunks.map((c:any)=>({...c,versionKey:c.documentId+':'+c.version}))));
  const importMs=performance.now()-importStart;
  const filter='versionKey IN '+JSON.stringify(refs.map((d:any)=>d.documentId+':'+d.version));
  const pgSearch=(query:string)=>queryKnowledge(manifest,'reader','search',query,6,originalDb.db);
  const jSearch=(query:string)=>jiebaQuery(manifest,'reader','search',query,6,jiebaDb.db);
  await pgSearch('needleomega');
  async function meili(query:string,strict:boolean,verified=true){
   if(verified)await originalDb.verify();
   const response=await request('/indexes/'+index+'/search','POST',{q:query,limit:6,filter,matchingStrategy:strict?'all':'last',attributesToRetrieve:['id','documentId','version','content']});
   validateHits(response.hits,lookup,manifest);
   return response.hits;
  }
  const methods:any={original:pgSearch,jieba:jSearch,meilisearchVerified:(q:string)=>meili(q,false),meilisearchStrictVerified:(q:string)=>meili(q,true)};
  for(const method of Object.values(methods) as any[]){for(const denied of ['privateonlyzeta','latestonlyomega','deletedonlytheta'])assert.equal((await method(denied)).length,0);}
  assert.equal((await queryKnowledge(manifest,'denied','search','needleomega',6,originalDb.db)).length,0);
  assert.equal((await jiebaQuery(manifest,'denied','search','needleomega',6,jiebaDb.db)).length,0);
  const measured:any[]=[];
  for(const item of queries){
   const query=typeof item==='string'?item:item.query,row:any={query,methods:{}};
   for(const [name,method] of Object.entries(methods) as any[]){
    const first=await method(query);for(let i=0;i<3;i++)await method(query);
    const times=[];for(let i=0;i<(quality?10:20);i++){const start=performance.now();await method(query);times.push(performance.now()-start);}
    row.methods[name]={...stats(times),returned:first.length,ids:first.map((c:any)=>c.id)};
    if(quality){const expected=new Set(item.expected),found=first.filter((c:any)=>expected.has(c.documentId)).length;
     row.methods[name].expectedDocumentIds=item.expected;row.methods[name].returnedDocumentIds=first.map((c:any)=>c.documentId);row.methods[name].relevantHits=found;
     row.methods[name].precisionReturned=first.length?found/first.length:expected.size?0:1;row.methods[name].recallAt6=expected.size?found/expected.size:null;row.methods[name].falsePositiveHits=first.length-found;}
   }
   const times=[];for(let i=0;i<20;i++){const start=performance.now();await meili(query,false,false);times.push(performance.now()-start);}row.meilisearchEngineOnly=stats(times);
   measured.push(row);console.log(JSON.stringify({stage:label,query,medianMs:Object.fromEntries(Object.entries(row.methods).map(([k,v]:any)=>[k,v.medianMs]))}));
  }
  const relationBytes=(await originalDb.pg.query(`SELECT sum(pg_total_relation_size(name::regclass))::bigint AS bytes FROM (VALUES ('knowledge_revisions'),('knowledge_chunks')) AS t(name)`)).rows[0];
  const jBytes=(await jiebaDb.pg.query(`SELECT sum(pg_total_relation_size(name::regclass))::bigint AS bytes FROM (VALUES ('knowledge_revisions'),('knowledge_chunks')) AS t(name)`)).rows[0];
  const meiliStats=await request('/stats');
  const result={label,authorizedChunks:refs.reduce((n:any,d:any)=>n+d.chunkCount,0),authorizedDocuments:refs.length,corpusHash:hash(chunks.map((c:any)=>c.id+':'+c.content).join('\n')),corpusUtf8Bytes:chunks.reduce((n:any,c:any)=>n+Buffer.byteLength(c.content),0),indexImportMs:importMs,originalDatabaseRelationBytes:relationBytes.bytes,jiebaDatabaseRelationBytes:jBytes.bytes,meilisearchStats:meiliStats,permissionAndPinnedVersionChecks:'passed',queries:measured};
  (quality?results.quality:results.scale).push(result);save();
  await task(await request('/indexes/'+index,'DELETE'));
 }finally{await originalDb.pg.close();await jiebaDb.pg.close();}
}
try{
 const deadline=performance.now()+30000;while(true){if(exited)throw Error('Isolated engine exited before ready; inspect private log');try{await request('/health');break;}catch{if(performance.now()>deadline)throw Error('Isolated engine readiness timed out');await pause(200);}}
 assert.equal((await request('/version')).pkgVersion,'1.54.3');
 if(!bindingOnly)for(const size of [1000,10000])await compare(String(size),corpus(size),['needleomega','库存调整','验收流程','zzznomatch']);
 const chunks:any[]=[],documents:any[]=[];
 for(const [id,text] of [['refund','订单退款：退款需要核验原订单，金额按整数分计算。'],['retire','设备退役：更新退役清单，登记处理日期。'],['style','产品款式：整理款式设计和颜色。'],['inventory','库存调整：入库与出库需更新库存数量。'],['permissions','调整员工权限：授权变更需要审批。'],['deploy','部署回滚：发布失败后回滚到已确认版本。'],['config','部署配置：上线前检查环境变量和端口。'],['testing','检索测试方法：先读取验收方法再独立测试。']])addDocument(chunks,documents,id,1,text);
 addDocument(chunks,documents,'private',1,'privateonlyzeta');addDocument(chunks,documents,'refund',2,'latestonlyomega');addDocument(chunks,documents,'deleted',1,'deletedonlytheta');
 await compare('quality',{chunks,documents},[{query:'退款',expected:['refund']},{query:'库存调整',expected:['inventory']},{query:'部署回滚',expected:['deploy']},{query:'zzznomatch',expected:[]},{query:'检索不存在的测试词zetaomega',expected:[]},{query:'退回订单金额',expected:['refund']}],true);
 results.completed=true;results.exactResultBindingSelfChecks=6;results.bindingOnly=bindingOnly;save();
}finally{
 if(!exited){const ended=once(child,'exit');child.kill();await ended;}
 results.helperStopped=exited;save();await pool.end();
}
