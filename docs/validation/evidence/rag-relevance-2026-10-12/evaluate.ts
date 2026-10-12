import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,openSync,closeSync} from 'node:fs';
import {createHash,randomBytes} from 'node:crypto';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {performance} from 'node:perf_hooks';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import {createServer} from 'node:net';
import {PGlite} from '@electric-sql/pglite';
import {vector} from '@electric-sql/pglite-pgvector';
import {applyGate,chooseThreshold,relevant} from './gates.mjs';

const root='/home/jj/.local/share/weiwu/validation/rag-relevance-20261012';
const previous='/home/jj/.local/share/weiwu/validation/hybrid-retrieval-20261012';
const release='/home/jj/.local/share/weiwu/releases/weiwu-reuse-cycle10-20261011';
const phase=process.argv[2];assert.ok(['calibration','holdout'].includes(phase));
const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const json=(name:string)=>JSON.parse(readFileSync(join(root,name),'utf8'));
const definitions=json('cases.json');
assert.ok(!definitions.calibration.some((a:any)=>definitions.holdout.some((b:any)=>a.intent===b.intent||a.query===b.query)));
process.env.DATABASE_URL='postgres://unused:unused@127.0.0.1:1/unused';
process.env.EMBEDDING_MODEL_DIR=join(previous,'models');
const load=(file:string)=>import(pathToFileURL(join(release,file)).href);
const {chunkDocument}=await load('services/agent-runtime/knowledge.mjs');
const {queryKnowledge}=await load('apps/api/src/knowledge-store.ts');
const {indexChunks}=await load('apps/api/src/knowledge-vector.ts');
const {embeddingVersion,embedTexts,closeEmbedding}=await load('services/embedding/local.mjs');
const {pool}=await load('apps/api/src/db.ts');
const casesHash=hash(readFileSync(join(root,'cases.json')));
const sourceFiles=['evaluate.ts','gates.mjs','rerank-worker.py'];
const sourceHashes=Object.fromEntries(sourceFiles.map(f=>[f,hash(readFileSync(join(root,f)))]));
const frozen=phase==='holdout'?json('thresholds.json'):null;
if(frozen){assert.equal(frozen.casesHash,casesHash);assert.deepEqual(frozen.sourceHashes,sourceHashes);}
const result:any={phase,startedAt:new Date().toISOString(),casesHash,sourceHashes,embeddingVersion,queries:[],guards:[],modelCalls:0,nodePeakRssBytes:0};
const save=()=>writeFileSync(join(root,phase+'-results-private.json'),JSON.stringify(result,null,2)+'\n');
const pause=(ms:number)=>new Promise(r=>setTimeout(r,ms));
const log=openSync(join(root,'helpers-private.log'),'a');
const started=performance.now();
const worker=spawn(join(root,'venv/bin/python'),[join(root,'rerank-worker.py')],{stdio:['pipe','pipe',log],env:{...process.env,HF_HUB_OFFLINE:'1',TRANSFORMERS_OFFLINE:'1',TOKENIZERS_PARALLELISM:'false'}});
const lines=createInterface({input:worker.stdout});
const ready=once(lines,'line');
const reservation=createServer();reservation.listen(0,'127.0.0.1');await once(reservation,'listening');
const port=(reservation.address() as any).port;await new Promise<void>(r=>reservation.close(()=>r()));
const key=randomBytes(32).toString('hex'),base='http://127.0.0.1:'+port;
const meili=spawn(join(previous,'meilisearch'),['--http-addr','127.0.0.1:'+port,'--db-path',join(root,'meili-'+phase),'--max-indexing-memory','256MiB','--max-indexing-threads','2','--no-analytics'],
  {stdio:['ignore',log,log],env:{...process.env,MEILI_MASTER_KEY:key,MEILI_ENV:'production'}});closeSync(log);
const children=[worker,meili],ended=new Set();children.forEach(p=>p.once('exit',()=>ended.add(p.pid)));
const databases:any[]=[];
async function request(path:string,method='GET',body?:any){const r=await fetch(base+path,{method,headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(20000)});const v=await r.json();assert.ok(r.ok,'Meili '+r.status+': '+JSON.stringify(v));return v;}
async function task(value:any){const end=performance.now()+120000;while(performance.now()<end){const s=await request('/tasks/'+value.taskUid);if(s.status==='succeeded')return;if(s.status==='failed')throw Error(JSON.stringify(s.error));await pause(100);}throw Error('Index deadline');}
async function bounded<T>(promise:Promise<T>,ms=60000):Promise<T>{let timer:any;try{return await Promise.race([promise,new Promise<T>((_,reject)=>{timer=setTimeout(()=>reject(Error('Worker deadline')),ms);})]);}finally{clearTimeout(timer);}}
let sequence=0;
async function rerank(query:string,hits:any[]){
  const id=++sequence,next=bounded(once(lines,'line'));
  worker.stdin.write(JSON.stringify({id,query,passages:hits.map(h=>({id:h.id,text:h.title+'\n'+h.content}))})+'\n');
  const [line]=await next as any,response=JSON.parse(line);assert.equal(response.id,id);
  result.workerPeakRssKiB=Math.max(result.workerPeakRssKiB??0,response.peakRssKiB);
  assert.equal(response.rows.length,hits.length);
  return response.rows.map((r:any)=>{const original=hits.find(h=>h.id===r.id);assert.ok(original);return {...original,score:Number(r.score),pairTokens:r.pairTokens,truncated:r.truncated};});
}
function add(documents:any[],chunks:any[],name:string,ref:any,content:string){
  const body=chunkDocument(ref.documentId,ref.version,content),doc={title:name,spaceId:'synthetic',source:{type:'synthetic'},...ref,content,sha256:hash(content),chunkCount:body.length,name};
  documents.push(doc);chunks.push(...body.map((c:any)=>({...c,title:doc.title,spaceId:doc.spaceId,sha256:doc.sha256,source:doc.source})));
}
async function prepare(label:string){
  const documents:any[]=[],chunks:any[]=[];
  if(label==='methods'){
    const input=JSON.parse(readFileSync(join(previous,'knowledge-input-private.json'),'utf8'));
    for(const d of input.documents){assert.equal(hash(d.content),d.sha256);add(documents,chunks,d.title.startsWith('command')?'cli':'sum',d,d.content);}
  }else{
    for(const [name,text] of [['refund','订单退款：退款需要核验原订单，金额按整数分计算。'],['retire','设备退役：更新退役清单，登记处理日期。'],['style','产品款式：整理款式设计和颜色。'],['inventory','库存调整：入库与出库需更新库存数量。'],['permissions','调整员工权限：授权变更需要审批。'],['deploy','部署回滚：发布失败后回滚到已确认版本。'],['config','部署配置：上线前检查环境变量和端口。'],['testing','检索测试方法：先读取验收方法再独立测试。'],['long','通用参考说明，'.repeat(440)+'末尾独有验收步骤：执行尾部状态码ZK73确认。']])add(documents,chunks,name,{documentId:name,version:1},text);
  }
  const allowed=documents.map(({content,...d})=>d);
  const sentinel=definitions.calibration.concat(definitions.holdout).map((c:any)=>c.query).join('\n');
  add(documents,chunks,'private',{documentId:'private',version:1},sentinel);
  add(documents,chunks,'newer',{documentId:allowed[0].documentId,version:2},sentinel);
  add(documents,chunks,'deleted',{documentId:'deleted',version:1},sentinel);
  const pg=await PGlite.create({extensions:{vector}});databases.push(pg);
  await pg.exec(`CREATE EXTENSION vector;CREATE TABLE knowledge_revisions(document_id text,version int,content text,sha256 text,PRIMARY KEY(document_id,version));
    CREATE TABLE knowledge_chunks(id text PRIMARY KEY,document_id text,version int,line_start int,line_end int,content text,tokens jsonb);
    CREATE TABLE knowledge_embeddings(chunk_id text,model_version text,title text,embedding vector(384),PRIMARY KEY(chunk_id,model_version));`);
  for(const d of documents)await pg.query('INSERT INTO knowledge_revisions VALUES($1,$2,$3,$4)',[d.documentId,d.version,d.content,d.sha256]);
  for(const c of chunks)await pg.query('INSERT INTO knowledge_chunks VALUES($1,$2,$3,$4,$5,$6,$7)',[c.id,c.documentId,c.version,c.lineStart,c.lineEnd,c.content,JSON.stringify(c.tokens)]);
  const db:any={query:async(sql:string,params?:any[])=>{const r=await pg.query(sql,params);return {rows:r.rows,rowCount:r.rows.length};}};
  await indexChunks(chunks,db);
  const vectors=new Map((await pg.query('SELECT chunk_id,embedding::text AS v FROM knowledge_embeddings')).rows.map((r:any)=>[r.chunk_id,JSON.parse(r.v)]));
  await task(await request('/indexes','POST',{uid:label,primaryKey:'id'}));
  await task(await request('/indexes/'+label+'/settings','PATCH',{searchableAttributes:['content'],filterableAttributes:['documentId','version'],typoTolerance:{enabled:false},embedders:{e5:{source:'userProvided',dimensions:384}}}));
  await task(await request('/indexes/'+label+'/documents','POST',chunks.map(({tokens,...c})=>({...c,_vectors:{e5:vectors.get(c.id)}}))));
  function scope(regression=false){
    const refs=regression?allowed.filter(d=>d.name!=='long'):allowed;
    return {refs,manifest:{format:'document-versions-v2',documents:refs,agentDocuments:{reader:refs.map(d=>d.documentId),denied:[]},retrieval:{mode:'hybrid',embeddingVersion}},
      filter:refs.map(d=>`(documentId = ${JSON.stringify(d.documentId)} AND version = ${d.version})`).join(' OR ')};
  }
  function bind(hits:any[],refs:any[]){
    for(const h of hits){const c=chunks.find(c=>c.id===h.id),d=refs.find(d=>d.documentId===h.documentId&&d.version===h.version);assert.ok(c&&d,'Unapproved hit');
      for(const key of ['documentId','version','content','title','spaceId','sha256'])assert.equal(h[key],c[key],'Binding '+key);
    }
    return hits;
  }
  async function verify(refs:any[]){
    const r=await pg.query(`WITH refs AS (SELECT * FROM jsonb_to_recordset($1) AS x("documentId" text,version int,sha256 text,"chunkCount" int))
      SELECT x."documentId" FROM refs x LEFT JOIN knowledge_revisions r ON r.document_id=x."documentId" AND r.version=x.version
      WHERE r.sha256 IS DISTINCT FROM x.sha256 OR x."chunkCount"<>(SELECT count(*) FROM knowledge_chunks c WHERE c.document_id=x."documentId" AND c.version=x.version) LIMIT 1`,[JSON.stringify(refs)]);
    assert.equal(r.rows.length,0,'Pinned revision missing');
  }
  async function meiliSearch(query:string,threshold:number|undefined,regression=false){
    const {refs,filter}=scope(regression);await verify(refs);const [v]=await embedTexts([query],'query');
    const response=await request('/indexes/'+label+'/search','POST',{q:query,vector:v,hybrid:{embedder:'e5',semanticRatio:.5},matchingStrategy:'all',filter,limit:20,showRankingScore:true,
      ...(threshold===undefined?{}:{rankingScoreThreshold:threshold}),attributesToRetrieve:['id','documentId','version','content','title','spaceId','sha256']});
    return bind(response.hits.map((h:any)=>({...h,score:Number(h._rankingScore)})),refs);
  }
  return {label,allowed,chunks,pg,db,scope,bind,verify,meiliSearch};
}
async function collect(config:any,example:any,gates?:any){
  const {refs,manifest}=config.scope(!!example.regression);
  const target={...example,expected:example.expected.map((name:string)=>config.allowed.find((d:any)=>d.name===name)?.documentId??name)};
  const engines:any={},timings:any={};let start=performance.now();
  engines.original=config.bind(await queryKnowledge({...manifest,retrieval:{mode:'keyword'}},'reader','search',example.query,3,config.db),refs);timings.original=performance.now()-start;
  start=performance.now();const rrf=config.bind(await queryKnowledge(manifest,'reader','search',example.query,20,config.db),refs);const localTime=performance.now()-start;
  engines.localRrf=rrf.slice(0,3);timings.localRrf=localTime;
  const e5=rrf.map((h:any)=>({...h,score:Number(h.vectorScore)}));
  engines.e5Gate=gates?applyGate(e5,gates.e5Gate.threshold):e5;timings.e5Gate=localTime;
  start=performance.now();const meili=await config.meiliSearch(example.query,undefined,!!example.regression);const meiliTime=performance.now()-start;
  engines.meiliRaw=meili.slice(0,3);timings.meiliRaw=meiliTime;
  if(gates){start=performance.now();engines.meiliGate=(await config.meiliSearch(example.query,gates.meiliGate.threshold,!!example.regression)).slice(0,3);timings.meiliGate=performance.now()-start;
    assert.deepEqual(engines.meiliGate.map((h:any)=>h.id),applyGate(meili,gates.meiliGate.threshold).map((h:any)=>h.id),'Meili threshold API differs from calibration');}
  else {engines.meiliGate=meili;timings.meiliGate=meiliTime;}
  start=performance.now();const ranked=config.bind(await rerank(example.query,rrf),refs),workerTime=performance.now()-start;
  engines.flashRaw=ranked.slice(0,3);timings.flashRaw=localTime+workerTime;
  engines.flashGate=gates?applyGate(ranked,gates.flashGate.threshold):ranked;timings.flashGate=localTime+workerTime;
  result.nodePeakRssBytes=Math.max(result.nodePeakRssBytes,process.memoryUsage().rss);
  return {example:target,engines,timings,truncatedCandidates:ranked.filter((h:any)=>h.truncated).length,maxPairTokens:Math.max(0,...ranked.map((h:any)=>h.pairTokens))};
}
function metrics(hits:any[],e:any){const rank=hits.findIndex(h=>relevant(h,e)),correct=hits.filter(h=>relevant(h,e)).length;return {returned:hits.length,relevant:correct,top1Correct:rank===0,reciprocalRank:rank<0?0:1/(rank+1),noAnswerFalse:e.expected.length===0&&hits.length>0};}
try{
  const [line]=await bounded(ready);result.workerReady=JSON.parse(line as string);result.workerStartupWallMs=performance.now()-started;
  const deadline=performance.now()+30000;while(true){assert.ok(!ended.has(meili.pid));try{await request('/health');break;}catch{if(performance.now()>deadline)throw Error('Meili readiness deadline');await pause(200);}}
  assert.equal((await request('/version')).pkgVersion,'1.54.3');
  result.indexStartedAt=new Date().toISOString();const configs:any={};for(const label of ['methods','synthetic'])configs[label]=await prepare(label);result.indexFinishedAt=new Date().toISOString();
  if(phase==='calibration'){
    const observations:any[]=[];
    for(const example of definitions.calibration){observations.push(await collect(configs[example.corpus],example));console.log(JSON.stringify({phase,processed:observations.length,total:definitions.calibration.length}));}
    const thresholds:any={};for(const name of ['e5Gate','meiliGate','flashGate'])thresholds[name]=chooseThreshold(observations.map(o=>({...o.example,hits:o.engines[name]})));
    const value={frozenAt:new Date().toISOString(),casesHash,sourceHashes,objective:'Maximize calibration (positive Top1 + no-answer specificity)/2; ties: recall, fewer irrelevant hits, higher threshold',thresholds};
    writeFileSync(join(root,'thresholds.json'),JSON.stringify(value,null,2)+'\n');result.thresholds=thresholds;result.calibrationQueries=observations.map(o=>({intent:o.example.intent,engines:Object.fromEntries(Object.entries(o.engines).map(([name,hits]:any)=>[name,metrics(name.endsWith('Gate')?applyGate(hits,thresholds[name].threshold):hits,o.example)]))}));
  }else{
    result.frozenThresholdsSha256=hash(readFileSync(join(root,'thresholds.json')));result.thresholds=frozen.thresholds;
    const old=JSON.parse(readFileSync(join(previous,'predeclared-cases.json'),'utf8'));
    const regression=[...old.approvedMethods.map((e:any,i:number)=>({...e,corpus:'methods',intent:'regression-methods-'+i,regression:true,expected:e.expected.map((id:string)=>configs.methods.allowed.find((d:any)=>d.documentId===id)?.name??id)})),...old.synthetic.map((e:any,i:number)=>({...e,corpus:'synthetic',intent:'regression-synthetic-'+i,regression:true}))];
    const examples=[...definitions.holdout,...regression];
    for(const example of examples){
      const trials:any[]=[];const count=example.regression?1:5;
      await collect(configs[example.corpus],example,frozen.thresholds);
      for(let repeat=0;repeat<count;repeat++)trials.push(await collect(configs[example.corpus],example,frozen.thresholds));
      const first=trials[0];for(const trial of trials)for(const name of Object.keys(first.engines))assert.deepEqual(trial.engines[name].map((h:any)=>h.id),first.engines[name].map((h:any)=>h.id),'Nondeterministic ranking');
      result.queries.push({corpus:example.corpus,intent:example.intent,regression:!!example.regression,partialSupport:!!example.partialSupport,expectedCount:example.expected.length,truncatedCandidates:first.truncatedCandidates,maxPairTokens:first.maxPairTokens,
        engines:Object.fromEntries(Object.keys(first.engines).map(name=>[name,{...metrics(first.engines[name],first.example),timesMs:trials.map(t=>t.timings[name])}]))});save();
      console.log(JSON.stringify({phase,processed:result.queries.length,total:examples.length}));
    }
  }
  for(const config of Object.values(configs) as any[]){
    const {manifest,refs}=config.scope();assert.deepEqual(await queryKnowledge(manifest,'denied','search','库存',3,config.db),[]);
    assert.equal(await queryKnowledge(manifest,'denied','read',config.chunks[0].id,3,config.db),undefined);
    const sample=config.chunks[0];config.bind([sample],refs);for(const patch of [{documentId:'private'},{version:2},{content:sample.content+'tampered'},{sha256:'x'},{id:'unknown'}])assert.throws(()=>config.bind([{...sample,...patch}],refs));
    result.guards.push({corpus:config.label,check:'scopeAndFiveTamperedBindings',passed:true});
    await config.pg.query('DELETE FROM knowledge_revisions WHERE document_id=$1 AND version=1',[config.allowed[0].documentId]);
    await assert.rejects(queryKnowledge(manifest,'reader','search','库存',3,config.db),/版本缺失/);
    await assert.rejects(config.meiliSearch('库存',frozen?.thresholds.meiliGate.threshold),/Pinned revision missing/);
    result.guards.push({corpus:config.label,check:'missingPinnedRevisionRejected',passed:true});
  }
  result.completed=true;
}catch(error){result.completed=false;result.error=String(error);throw error;}
finally{
  worker.stdin.end();for(const child of children){if(!ended.has(child.pid)){const end=once(child,'exit');child.kill();const done=await Promise.race([end.then(()=>true),pause(5000).then(()=>false)]);if(!done){child.kill('SIGKILL');await end;}}}
  result.helpersStopped=children.every(c=>ended.has(c.pid));result.finishedAt=new Date().toISOString();save();
  for(const pg of databases)await pg.close();await closeEmbedding();await pool.end();
}
