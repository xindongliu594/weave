import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import pg from 'pg';
import {chunkDocument} from '../services/agent-runtime/knowledge.mjs';
import {embeddingVersion,embedTexts,closeEmbedding} from '../services/embedding/local.mjs';
const base=process.env.DATABASE_URL??'postgres://agent_department:local-development-only@127.0.0.1:55432/agent_department';
const admin=new pg.Pool({connectionString:base}),schema='hybrid_'+Date.now();
let pool:pg.Pool,app:any,server:any,url:string,dir:string,store:typeof import('../apps/api/src/knowledge-store.ts'),vectors:typeof import('../apps/api/src/knowledge-vector.ts');
const manager={id:'manager',name:'经理',role:'manager',knowledgeSpaceIds:['shared']};
const other={id:'other',name:'员工',role:'member',knowledgeSpaceIds:['private']};
async function call(path:string,method='GET',body?:any){const r=await fetch(url+path,{method,headers:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return{status:r.status,data:await r.json() as any};}
async function document(id:string,space:string,content:string){
 await pool.query('INSERT INTO knowledge_documents(id,space_id,title) VALUES($1,$2,$1)',[id,space]);
 await pool.query('INSERT INTO knowledge_revisions(document_id,version,content,sha256) VALUES($1,1,$2,$3)',[id,content,createHash('sha256').update(content).digest('hex')]);
 for(const c of chunkDocument(id,1,content))await pool.query('INSERT INTO knowledge_chunks(id,document_id,version,line_start,line_end,content,tokens) VALUES($1,$2,1,$3,$4,$5,$6)',[c.id,id,c.lineStart,c.lineEnd,c.content,JSON.stringify(c.tokens)]);
}
before(async()=>{
 // This suite intentionally exercises the real pinned local embedding model, with no model API.
 process.env.EMBEDDING_MODEL_DIR=process.env.EMBEDDING_MODEL_DIR??resolve('.data/embedding-models');
 await admin.query('CREATE SCHEMA '+schema);const dbURL=new URL(base);dbURL.searchParams.set('options','-c search_path='+schema);process.env.DATABASE_URL=dbURL.toString();
 dir=await mkdtemp(join(tmpdir(),'hybrid-'));process.env.DATA_DIR=dir;process.env.TRACE_ROOT=join(dir,'runs');process.env.OBSIDIAN_VAULT=join(dir,'vault');
 const db=await import('../apps/api/src/db.ts');pool=db.pool;await db.migrate();store=await import('../apps/api/src/knowledge-store.ts');vectors=await import('../apps/api/src/knowledge-vector.ts');
 const {createApp}=await import('../apps/api/src/app.ts');app=createApp();await app.locals.shutdownBackground();server=app.listen(0,'127.0.0.1');await once(server,'listening');url='http://127.0.0.1:'+server.address().port+'/api';
 await pool.query('INSERT INTO departments(id,data) VALUES($1,$2)',['department',{name:'Hybrid fixture',agents:[manager,other]}]);
 await pool.query("INSERT INTO knowledge_spaces(id,name,scope,department_id,agent_ids) VALUES('shared','Shared','company',NULL,'[]'),('private','Private','employee','department','[\"other\"]')");
 await document('cars','shared','Car crash reporting: contact the police and photograph vehicle damage.');
 await document('account','shared','忘记密码后可通过注册邮箱重置口令。');
 await document('cooking','shared','午餐提供蔬菜和米饭。Fresh fruit is available for dessert.');
 await document('secret','private','automobile collision and 如何找回登录账号 confidential exact-match private instructions');
});
after(async()=>{await app?.locals.shutdown();await closeEmbedding();if(server)await new Promise<void>(r=>server.close(()=>r()));await pool?.end();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();if(dir)await rm(dir,{recursive:true,force:true});});

test('real local vectors recover English and Chinese paraphrases with authorization before ranking',async()=>{
 const keyword=await store.knowledgeSnapshot([manager,other],'department');
 assert.deepEqual(await store.queryKnowledge(keyword,'manager','search','automobile collision'),[]);
 assert.deepEqual(await store.queryKnowledge(keyword,'manager','search','如何找回登录账号'),[]);
 const status=(await call('/knowledge/retrieval')).data;assert.equal(status.installed,true);
 assert.equal((await call('/knowledge/retrieval','PUT',{mode:'hybrid',version:status.version})).status,200);
 await vectors.waitKnowledgeIndex();const indexed=(await call('/knowledge/retrieval')).data;assert.equal(indexed.indexed,indexed.total);assert.equal(indexed.running,false);
 const manifest=await store.knowledgeSnapshot([manager,other],'department');assert.equal(manifest.retrieval?.embeddingVersion,embeddingVersion);
 const savedFetch=globalThis.fetch;globalThis.fetch=async()=>{throw Error('Unexpected network during retrieval');};
 try{
  const english=await store.queryKnowledge(manifest,'manager','search','automobile collision');assert.equal(english[0].documentId,'cars',JSON.stringify(english.map((c:any)=>[c.documentId,c.vectorScore])));assert.ok(english[0].matchedBy.includes('vector'));
  const both=await store.queryKnowledge(manifest,'manager','search','Car crash');assert.equal(both[0].documentId,'cars');assert.deepEqual(both[0].matchedBy,['keyword','vector']);assert.equal(both[0].embeddingVersion,embeddingVersion);
  const chinese=await store.queryKnowledge(manifest,'manager','search','如何找回登录账号');assert.equal(chinese[0].documentId,'account',JSON.stringify(chinese.map((c:any)=>[c.documentId,c.vectorScore])));
  assert.ok([...english,...chinese].every(c=>c.documentId!=='secret'));
  const foreign=(await pool.query("SELECT id FROM knowledge_chunks WHERE document_id='secret'")).rows[0].id;
  assert.equal(await store.queryKnowledge(manifest,'manager','read',foreign),undefined);
  assert.deepEqual(await store.queryKnowledge(manifest,'invented','search','automobile collision'),[]);
  assert.equal((await store.queryKnowledge(manifest,'other','search','automobile collision'))[0].documentId,'secret');
  assert.deepEqual(await store.queryKnowledge(keyword,'manager','search','automobile collision'),[],'old snapshots retain lexical mode');
 }finally{globalThis.fetch=savedFetch;}
 const sharedOnly=await store.knowledgeSnapshot([manager],'department',undefined,[]);
 const withInput=store.attachRunInputs(sharedOnly,[{id:'brief',title:'临时说明',content:'A broken vehicle must be photographed after a car crash.',agentIds:['manager']}],[manager],'run-one');
 assert.equal((await store.queryKnowledge(withInput,'manager','search','automobile collision'))[0].source.type,'run-input');
 assert.deepEqual(await store.queryKnowledge(sharedOnly,'manager','search','automobile collision'),[]);
 assert.deepEqual(await store.queryKnowledge(withInput,'other','search','automobile collision'),[]);
 const before=(await pool.query('SELECT count(*)::int AS n FROM knowledge_embeddings')).rows[0].n;
 await store.queryKnowledge(manifest,'manager','search','automobile collision');assert.equal((await pool.query('SELECT count(*)::int AS n FROM knowledge_embeddings')).rows[0].n,before,'same frozen vectors are reused');
 const backup=await call('/backup/export','POST',{password:'hybrid-backup-fixture'});assert.equal(backup.status,200);
 await pool.query('DELETE FROM knowledge_embeddings');
 assert.equal((await call('/backup/restore','POST',{password:'hybrid-backup-fixture',backup:backup.data,confirmation:'RESTORE'})).status,200);
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM knowledge_embeddings')).rows[0].n,before);
 assert.equal((await store.queryKnowledge(manifest,'manager','search','automobile collision'))[0].documentId,'cars');
 const modelDir=process.env.EMBEDDING_MODEL_DIR;process.env.EMBEDDING_MODEL_DIR=join(dir,'missing');
 try{await assert.rejects(store.queryKnowledge(manifest,'manager','search','cars'),e=>(e as any).code==='EMBEDDING_NOT_READY');assert.equal((await store.queryKnowledge(keyword,'manager','search','Car crash'))[0].documentId,'cars');}
 finally{process.env.EMBEDDING_MODEL_DIR=modelDir;}
 await assert.rejects(store.queryKnowledge({...manifest,retrieval:{mode:'hybrid',embeddingVersion:'different-model'}},'manager','search','cars'),e=>(e as any).code==='EMBEDDING_VERSION_MISMATCH');
});

test('long passages include their tail and local vectors are normalized',async()=>{
 const prefix='普通资料。'.repeat(60);
 const [first,second]=await embedTexts([prefix+'汽车相撞后记录车辆损坏。'.repeat(30),prefix+'晚餐制作蔬菜汤和米饭。'.repeat(30)]);
 assert.equal(first.length,384);assert.ok(Math.abs(Math.hypot(...first)-1)<1e-6);
 assert.ok(first.reduce((n,x,i)=>n+(x-second[i])**2,0)>.005,'suffix beyond the first model window affects its embedding');
});
