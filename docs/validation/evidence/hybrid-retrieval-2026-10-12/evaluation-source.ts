// Isolated experiment only: import unchanged deployed modules and inject a fresh database.
import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
import {readFileSync,writeFileSync,openSync,closeSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {performance} from 'node:perf_hooks';
import {cpus,totalmem} from 'node:os';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createServer} from 'node:net';
import {PGlite} from '@electric-sql/pglite';
import {vector} from '@electric-sql/pglite-pgvector';

const root=resolve(process.env.EXPERIMENT_ROOT!);
assert.equal(root,'/home/jj/.local/share/weiwu/validation/hybrid-retrieval-20261012');
const release=process.env.WEIWU_RELEASE!;
process.env.DATABASE_URL='postgres://unused:unused@127.0.0.1:1/unused';
process.env.EMBEDDING_MODEL_DIR=join(root,'models');
const load=(file:string)=>import(pathToFileURL(join(release,file)).href);
const {chunkDocument}=await load('services/agent-runtime/knowledge.mjs');
const {queryKnowledge}=await load('apps/api/src/knowledge-store.ts');
const {indexChunks}=await load('apps/api/src/knowledge-vector.ts');
const {embedTexts,embeddingVersion,closeEmbedding}=await load('services/embedding/local.mjs');
const {pool}=await load('apps/api/src/db.ts');
const hash=(body:string|Buffer)=>createHash('sha256').update(body).digest('hex');
const input=JSON.parse(readFileSync(join(root,'knowledge-input-private.json'),'utf8'));
for(const d of input.documents)assert.equal(hash(d.content),d.sha256);
const ids=Object.fromEntries(input.documents.map((d:any)=>[d.title.startsWith('command')?'cli':'sum',d.documentId]));

// Fix expectations before running any embedding or search. No threshold fitted on these queries.
const cases={
  approvedMethods:[
    {query:'退出码与标准输出',expected:[ids.cli],kind:'literal'},
    {query:'启动终端程序后如何判断成功还是失败',expected:[ids.cli],kind:'paraphrase'},
    {query:'CLI 错误参数',expected:[ids.cli],kind:'mixed'},
    {query:'整数加法',expected:[ids.sum],kind:'literal'},
    {query:'两个有符号的整型数相加应检查哪些情况',expected:[ids.sum],kind:'paraphrase'},
    {query:'sum 正数负数零的测试',expected:[ids.sum],kind:'mixed'},
    {query:'zzznomatch',expected:[],kind:'no-answer'},
    {query:'跨租户读取别人的客户资料如何验证',expected:[],kind:'no-answer'},
    {query:'小数相加的舍入误差如何验收',expected:[],kind:'no-answer'}
  ],
  synthetic:[
    {query:'退款',expected:['refund'],kind:'literal'},
    {query:'库存调整',expected:['inventory'],kind:'literal'},
    {query:'部署回滚',expected:['deploy'],kind:'literal'},
    {query:'zzznomatch',expected:[],kind:'no-answer'},
    {query:'检索不存在的测试词zetaomega',expected:[],kind:'no-answer'},
    {query:'退回订单金额',expected:['refund'],kind:'paraphrase'},
    {query:'把货品放进仓库并扣减可用数量',expected:['inventory'],kind:'paraphrase'},
    {query:'上线失败后还原上一版',expected:['deploy'],kind:'paraphrase'},
    {query:'改变同事的访问授权',expected:['permissions'],kind:'paraphrase'},
    {query:'发布前确认环境变量和服务端口',expected:['config'],kind:'paraphrase'}
  ]
};
writeFileSync(join(root,'predeclared-cases.json'),JSON.stringify(cases,null,2)+'\n');
const stats=(times:number[])=>{const v=[...times].sort((a,b)=>a-b);return {samples:v.length,medianMs:v[Math.floor(v.length/2)],p95Ms:v[Math.ceil(v.length*.95)-1],maxMs:v.at(-1)};};
const sources=['services/embedding/local.mjs','services/embedding/model-lock.json','services/agent-runtime/knowledge.mjs','apps/api/src/knowledge-store.ts','apps/api/src/knowledge-vector.ts'];
const results:any={startedAt:new Date().toISOString(),node:process.version,platform:process.platform,cpu:cpus()[0].model,memoryBytes:totalmem(),concurrency:1,samplesPerQuery:5,limit:3,semanticRatio:0.5,embeddingVersion,modelCalls:0,
  sourceHashes:Object.fromEntries(sources.map(f=>[f,hash(readFileSync(join(release,f)))])),
  evaluatorSha256:hash(readFileSync(join(root,'evaluation-source.ts'))),caseSha256:hash(readFileSync(join(root,'predeclared-cases.json'))),
  provenance:{model:JSON.parse(readFileSync(join(root,'model-download.json'),'utf8')),meilisearch:JSON.parse(readFileSync(join(root,'meili-download.json'),'utf8'))},
  corpora:[],guards:[],limitations:['Two approved test methods are not a representative company corpus. Synthetic topics are reported separately.',
    'Tiny corpus, sequential warm tests; P95 is the maximum of five observations. No concurrency or scale throughput claim.',
    'PGlite WASM SQL versus native Meilisearch loopback HTTP; not production PostgreSQL.',
    'Keyword indexes content only; vectors include title plus content, matching the current application. This affects cross-channel quality.',
    'End-to-end hybrid time includes fresh local query embedding and pinned version checks. No paid model or reranker.',
    'Meilisearch filter and result binding are experiment adapters, not a production integration.',
    'No relevance rejection threshold; nearest-vector results do not prove the source contains an answer.']};
const save=()=>writeFileSync(join(root,'evaluation-results.json'),JSON.stringify(results,null,2)+'\n');
assert.equal(hash(readFileSync(join(root,'meilisearch'))),results.provenance.meilisearch.sha256);
const reservation=createServer();reservation.listen(0,'127.0.0.1');await once(reservation,'listening');
const port=(reservation.address() as any).port;await new Promise<void>(r=>reservation.close(()=>r()));
const key=randomBytes(32).toString('hex'),base='http://127.0.0.1:'+port;
const log=openSync(join(root,'meilisearch-private.log'),'a');
const child=spawn(join(root,'meilisearch'),['--http-addr','127.0.0.1:'+port,'--db-path',join(root,'isolated-index'),'--max-indexing-memory','256MiB','--max-indexing-threads','2','--no-analytics'],
  {cwd:root,stdio:['ignore',log,log],env:{...process.env,MEILI_MASTER_KEY:key,MEILI_ENV:'production'}});
closeSync(log);
let exited=false;child.once('exit',()=>{exited=true;});
const pause=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function request(path:string,method='GET',body?:any){
  const response=await fetch(base+path,{method,headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(20000)});
  const value=await response.json();assert.ok(response.ok,'Isolated HTTP '+response.status+': '+JSON.stringify(value));return value;
}
async function task(value:any){
  const end=performance.now()+120000;
  while(performance.now()<end){const s=await request('/tasks/'+value.taskUid);if(s.status==='succeeded')return;if(s.status==='failed')throw Error(JSON.stringify(s.error));await pause(100);}
  throw Error('Isolated indexing deadline exceeded');
}
function add(documents:any[],chunks:any[],ref:any,content:string){
  const body=chunkDocument(ref.documentId,ref.version,content);
  const doc={title:ref.documentId,spaceId:'synthetic',source:{type:'synthetic'},...ref,content,sha256:hash(content),chunkCount:body.length};
  documents.push(doc);chunks.push(...body.map((c:any)=>({...c,title:doc.title,spaceId:doc.spaceId,sha256:doc.sha256,source:doc.source})));
}
async function compare(label:keyof typeof cases){
  const documents:any[]=[],chunks:any[]=[];
  if(label==='approvedMethods')for(const d of input.documents)add(documents,chunks,d,d.content);
  else for(const [documentId,content] of [['refund','订单退款：退款需要核验原订单，金额按整数分计算。'],['retire','设备退役：更新退役清单，登记处理日期。'],['style','产品款式：整理款式设计和颜色。'],['inventory','库存调整：入库与出库需更新库存数量。'],['permissions','调整员工权限：授权变更需要审批。'],['deploy','部署回滚：发布失败后回滚到已确认版本。'],['config','部署配置：上线前检查环境变量和端口。'],['testing','检索测试方法：先读取验收方法再独立测试。']])add(documents,chunks,{documentId,version:1},content);
  const allowed=documents.map(({content,...d})=>d);
  const sentinel='privateonlyzeta latestonlyomega deletedonlytheta 退出码与标准输出 终端程序 整数加法 退款 库存调整 部署回滚';
  add(documents,chunks,{documentId:'private',version:1},sentinel);
  add(documents,chunks,{documentId:allowed[0].documentId,version:2},sentinel);
  add(documents,chunks,{documentId:'deleted',version:1},sentinel);
  const manifest:any={format:'document-versions-v2',documents:allowed,agentDocuments:{reader:allowed.map(d=>d.documentId),denied:[]},retrieval:{mode:'keyword'}};
  const hybrid={...manifest,retrieval:{mode:'hybrid',embeddingVersion}};
  const pg=await PGlite.create({extensions:{vector}});
  await pg.exec(`CREATE EXTENSION vector;
    CREATE TABLE knowledge_revisions(document_id text,version int,content text,sha256 text,PRIMARY KEY(document_id,version));
    CREATE TABLE knowledge_chunks(id text PRIMARY KEY,document_id text,version int,line_start int,line_end int,content text,tokens jsonb);
    CREATE INDEX chunk_tokens ON knowledge_chunks USING gin(tokens);
    CREATE TABLE knowledge_embeddings(chunk_id text,model_version text,title text,embedding vector(384),PRIMARY KEY(chunk_id,model_version));`);
  for(const d of documents)await pg.query('INSERT INTO knowledge_revisions VALUES($1,$2,$3,$4)',[d.documentId,d.version,d.content,d.sha256]);
  for(const c of chunks)await pg.query('INSERT INTO knowledge_chunks VALUES($1,$2,$3,$4,$5,$6,$7)',[c.id,c.documentId,c.version,c.lineStart,c.lineEnd,c.content,JSON.stringify(c.tokens)]);
  const db:any={query:async(sql:string,params?:any[])=>{const r=await pg.query(sql,params);return {rows:r.rows,rowCount:r.rows.length};}};
  const report:any={label,documents:allowed.map(({documentId,version,sha256}:any)=>({documentId,version,sha256})),sentinelCount:3,queries:[],engines:{}};
  results.corpora.push(report);save();
  const index=label.toLowerCase();
  try{
    const started=performance.now();await indexChunks(chunks,db);report.vectorIndexMs=performance.now()-started;
    const allVectors=(await pg.query('SELECT chunk_id,embedding::text AS vector FROM knowledge_embeddings')).rows as any[];
    const vectors=new Map(allVectors.map(r=>[r.chunk_id,JSON.parse(r.vector)]));
    await task(await request('/indexes','POST',{uid:index,primaryKey:'id'}));
    const meiliStarted=performance.now();
    await task(await request('/indexes/'+index+'/settings','PATCH',{searchableAttributes:['content'],filterableAttributes:['documentId','version'],typoTolerance:{enabled:false},embedders:{e5:{source:'userProvided',dimensions:384}}}));
    await task(await request('/indexes/'+index+'/documents','POST',chunks.map(({tokens,...c})=>({...c,_vectors:{e5:vectors.get(c.id)}}))));
    report.meiliImportMs=performance.now()-meiliStarted;
    const refs=JSON.stringify(allowed),filter=allowed.map(d=>`(documentId = ${JSON.stringify(d.documentId)} AND version = ${d.version})`).join(' OR ');
    async function verify(){
      const r=await pg.query(`WITH refs AS (SELECT * FROM jsonb_to_recordset($1) AS x("documentId" text,version int,sha256 text,"chunkCount" int))
        SELECT x."documentId" FROM refs x LEFT JOIN knowledge_revisions r ON r.document_id=x."documentId" AND r.version=x.version
        WHERE r.sha256 IS DISTINCT FROM x.sha256 OR x."chunkCount"<>(SELECT count(*) FROM knowledge_chunks c WHERE c.document_id=x."documentId" AND c.version=x.version) LIMIT 1`,[refs]);
      assert.equal(r.rows.length,0,'Pinned revision missing');
    }
    function bind(rows:any[]){
      for(const hit of rows){const original=chunks.find(c=>c.id===hit.id),ref=allowed.find(d=>d.documentId===hit.documentId&&d.version===hit.version);
        assert.ok(original&&ref,'Unapproved or unknown result');
        for(const field of ['documentId','version','content','lineStart','lineEnd','title','spaceId','sha256'])assert.deepEqual(hit[field],original[field],'Binding mismatch '+field);
        assert.equal(hit.sha256,ref.sha256);
      }
      return rows;
    }
    const engines:any={
      original:(query:string)=>queryKnowledge(manifest,'reader','search',query,3,db),
      localRrf:(query:string)=>queryKnowledge(hybrid,'reader','search',query,3,db),
      meiliStrict:async(query:string)=>{await verify();return (await request('/indexes/'+index+'/search','POST',{q:query,matchingStrategy:'all',filter,limit:3,attributesToRetrieve:['id','documentId','version','content','lineStart','lineEnd','title','spaceId','sha256']})).hits;},
      meiliHybrid:async(query:string)=>{await verify();const [v]=await embedTexts([query],'query');return (await request('/indexes/'+index+'/search','POST',{q:query,vector:v,hybrid:{embedder:'e5',semanticRatio:0.5},matchingStrategy:'all',filter,limit:3,attributesToRetrieve:['id','documentId','version','content','lineStart','lineEnd','title','spaceId','sha256']})).hits;}
    };
    for(const c of cases[label]){
      const row:any={...c,engines:{}};
      for(const [name,search] of Object.entries(engines) as any){
        bind(await search(c.query));const times:number[]=[];let hits:any[]=[];
        for(let repeat=0;repeat<5;repeat++){const start=performance.now();hits=bind(await search(c.query));times.push(performance.now()-start);}
        const found=hits.map(h=>h.documentId),rank=found.findIndex(id=>c.expected.includes(id)),relevant=found.filter(id=>c.expected.includes(id)).length;
        row.engines[name]={documents:found,timing:stats(times),returned:found.length,relevant,reciprocalRank:rank<0?0:1/(rank+1),top1Correct:c.expected.length>0&&c.expected.includes(found[0]),falseHits:c.expected.length===0?found.length:0};
      }
      report.queries.push(row);save();
    }
    for(const name of Object.keys(engines)){
      const positives=report.queries.filter((r:any)=>r.expected.length),negatives=report.queries.filter((r:any)=>!r.expected.length),p=positives.map((r:any)=>r.engines[name]),n=negatives.map((r:any)=>r.engines[name]);
      report.engines[name]={positiveQueries:p.length,top1Hits:p.filter((r:any)=>r.top1Correct).length,mrr:p.reduce((a:number,r:any)=>a+r.reciprocalRank,0)/p.length,
        returned:p.reduce((a:number,r:any)=>a+r.returned,0),relevant:p.reduce((a:number,r:any)=>a+r.relevant,0),positiveQueryRecall:p.filter((r:any)=>r.relevant>0).length/p.length,
        noAnswerQueries:n.length,noAnswerFalseHits:n.reduce((a:number,r:any)=>a+r.falseHits,0),noAnswerFalseQueries:n.filter((r:any)=>r.falseHits>0).length,
        medianOfQueryMediansMs:stats(report.queries.map((r:any)=>r.engines[name].timing.medianMs)).medianMs};
    }
    for(const query of ['privateonlyzeta','latestonlyomega','deletedonlytheta'])for(const [name,search] of Object.entries(engines) as any){bind(await search(query));results.guards.push({label,engine:name,check:query,passed:true});}
    assert.deepEqual(await queryKnowledge(manifest,'denied','search','整数加法',3,db),[]);
    assert.deepEqual(await queryKnowledge(hybrid,'denied','search','整数加法',3,db),[]);
    results.guards.push({label,check:'ungrantedEmployee',passed:true});
    const sample=chunks.find(c=>c.documentId===allowed[0].documentId&&c.version===1)!;
    bind([sample]);for(const patch of [{documentId:'private'},{version:2},{content:sample.content+'tampered'},{sha256:'0'.repeat(64)},{id:'unknown'},{title:'changed'}])assert.throws(()=>bind([{...sample,...patch}]));
    results.guards.push({label,check:'sixTamperedResultBindings',passed:true});
    await pg.query('DELETE FROM knowledge_revisions WHERE document_id=$1 AND version=1',[allowed[0].documentId]);
    await assert.rejects(queryKnowledge(manifest,'reader','search','退款',3,db),/版本缺失/);
    await assert.rejects(queryKnowledge(hybrid,'reader','search','退款',3,db),/版本缺失/);
    await assert.rejects(engines.meiliStrict('退款'),/Pinned revision missing/);
    await assert.rejects(engines.meiliHybrid('退款'),/Pinned revision missing/);
    results.guards.push({label,check:'missingPinnedRevisionRejectedByAllFour',passed:true});
    await task(await request('/indexes/'+index,'DELETE'));
  }finally{await pg.close();save();}
}
try{
  const deadline=performance.now()+30000;
  while(true){if(exited)throw Error('Isolated Meilisearch exited before ready');try{await request('/health');break;}catch{if(performance.now()>deadline)throw Error('Isolated readiness timeout');await pause(200);}}
  assert.equal((await request('/version')).pkgVersion,'1.54.3');
  const started=performance.now();await embedTexts(['local warmup'],'query');results.embeddingColdStartMs=performance.now()-started;
  for(const label of ['approvedMethods','synthetic'] as const){await compare(label);console.log(JSON.stringify({label,completed:true,engines:results.corpora.at(-1).engines}));}
  results.completed=true;
}catch(error){results.completed=false;results.error=String(error);throw error;}
finally{
  if(!exited){const ended=once(child,'exit');child.kill();const stopped=await Promise.race([ended.then(()=>true),pause(5000).then(()=>false)]);if(!stopped){child.kill('SIGKILL');await ended;}}
  results.helperStopped=exited;results.finishedAt=new Date().toISOString();save();await closeEmbedding();await pool.end();
}
