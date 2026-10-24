import { before,after,test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import pg from 'pg';
import { chunkDocument,searchKnowledge } from '../services/agent-runtime/knowledge.mjs';
import { createRunArchive } from '../services/agent-runtime/trace-store.mjs';

const base=process.env.DATABASE_URL??'postgres://agent_department:local-development-only@127.0.0.1:55432/agent_department';
const admin=new pg.Pool({connectionString:base}),schema='knowledge_'+Date.now();
let app:any,server:any,pool:pg.Pool,url:string,dir:string,store:typeof import('../apps/api/src/knowledge-store.ts');
const manager={id:'manager',role:'manager',knowledgeSpaceIds:['company']},other={id:'other',role:'member',knowledgeSpaceIds:[]};
const allChunks:any[]=[];
async function revision(id:string,version:number,content:string) {
  const hash=createHash('sha256').update(content).digest('hex'),source={type:'obsidian',vaultPath:'company/'+id+'.md'};
  await pool.query('INSERT INTO knowledge_revisions(document_id,version,content,sha256,source) VALUES($1,$2,$3,$4,$5)',[id,version,content,hash,source]);
  const chunks=chunkDocument(id,version,content);
  await pool.query(`INSERT INTO knowledge_chunks(id,document_id,version,line_start,line_end,content,tokens)
    SELECT id,"documentId",version,"lineStart","lineEnd",content,tokens FROM jsonb_to_recordset($1)
    AS x(id text,"documentId" text,version int,"lineStart" int,"lineEnd" int,content text,tokens jsonb)`,[JSON.stringify(chunks)]);
  return chunks.map(c=>({...c,sha256:hash,source,title:id,spaceId:'company'}));
}
before(async()=>{
  await admin.query('CREATE SCHEMA '+schema);
  const database=new URL(base);database.searchParams.set('options','-c search_path='+schema);process.env.DATABASE_URL=database.toString();
  dir=await mkdtemp(join(tmpdir(),'knowledge-'));process.env.DATA_DIR=dir;process.env.TRACE_ROOT=join(dir,'runs');process.env.OBSIDIAN_VAULT=join(dir,'vault');
  const db=await import('../apps/api/src/db.ts');pool=db.pool;await db.migrate();store=await import('../apps/api/src/knowledge-store.ts');
  const {createApp}=await import('../apps/api/src/app.ts');app=createApp();await app.locals.shutdownBackground();
  server=app.listen(0,'127.0.0.1');await once(server,'listening');url='http://127.0.0.1:'+server.address().port+'/api';
  await pool.query('INSERT INTO departments(id,data) VALUES($1,$2)',['department',{name:'测试部门',agents:[manager,other]}]);
  await pool.query(`INSERT INTO knowledge_spaces(id,name,scope,department_id,agent_ids) VALUES
    ('company','Company','company',NULL,'[]'),('private','Private','employee','department','["other"]')`);
  for(let i=0;i<4;i++) {
    const id='large-'+i;
    await pool.query('INSERT INTO knowledge_documents(id,space_id,title) VALUES($1,$2,$1)',[id,'company']);
    const lines=Array.from({length:90},(_,n)=>(i===3&&n===89?'needleomega rollback procedure':'ordinary reference')+' '+('x'.repeat(1550)));
    allChunks.push(...await revision(id,1,lines.join('\n')));
  }
  await pool.query("INSERT INTO knowledge_documents(id,space_id,title) VALUES('foreign','private','Secret')");
  await revision('foreign',1,'needleomega rollback procedure private secret');
});
after(async()=>{await app?.locals.shutdown();if(server)await new Promise<void>(r=>server.close(()=>r()));await pool?.end();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();if(dir)await rm(dir,{recursive:true,force:true});});

test('full corpus retrieval covers late chunks, stays permission scoped and pins compact immutable versions',async()=>{
  assert.ok(allChunks.length>300);assert.ok(Buffer.byteLength(allChunks.map(c=>c.content).join(''))>160000);
  const manifest=await store.knowledgeSnapshot([manager,other],'department');
  assert.equal(manifest.format,'document-versions-v2');assert.equal(manifest.documents.length,4);
  assert.equal(manifest.documents.reduce((n,d)=>n+d.chunkCount,0),allChunks.length);
  assert.ok(JSON.stringify(manifest).length<5000,'snapshots keep references instead of hundreds of KB of corpus');
  const found=await store.queryKnowledge(manifest,manager.id,'search','needleomega');
  assert.equal(found.length,1);assert.equal(found[0].documentId,'large-3');assert.equal(found[0].lineStart,90);
  assert.deepEqual(await store.queryKnowledge(manifest,other.id,'search','needleomega'),[]);
  const foreign=(await pool.query("SELECT id FROM knowledge_chunks WHERE document_id='foreign'")).rows[0].id;
  assert.equal(await store.queryKnowledge(manifest,manager.id,'read',foreign),undefined);
  const mapped=await store.knowledgeSnapshot([{...other,id:'employee-2',employeeId:'other',knowledgeSpaceIds:['private']}],'department');
  assert.equal((await store.queryKnowledge(mapped,'employee-2','read',foreign)).documentId,'foreign');
  assert.equal(await store.queryKnowledge(mapped,'other','read',foreign),undefined,'the runtime identity must match the approved manifest');
  const legacy={manager:[allChunks[0]]};
  assert.equal((await store.queryKnowledge(legacy,'manager','read',allChunks[0].id)).content,allChunks[0].content);
  assert.equal(await store.queryKnowledge(legacy,'other','read',allChunks[0].id),undefined);
  const ranked=await store.queryKnowledge(manifest,manager.id,'search','rollback procedure');
  assert.equal(ranked[0].id,searchKnowledge(allChunks,'rollback procedure')[0].id);
  assert.equal(ranked[0].score,searchKnowledge(allChunks,'rollback procedure')[0].score);
  const interactive=await fetch(url+'/knowledge/search',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({departmentId:'department',agentId:'manager',query:'needleomega'})});
  assert.equal(interactive.status,200);assert.equal((await interactive.json() as any[])[0].id,found[0].id);

  await revision('large-3',2,'replacement information');
  await pool.query("UPDATE knowledge_documents SET version=2,title='Renamed' WHERE id='large-3'");
  await pool.query("UPDATE knowledge_spaces SET deleted_at=now() WHERE id='company'");
  const old=await store.queryKnowledge(manifest,manager.id,'read',found[0].id);
  assert.equal(old.version,1);assert.equal(old.title,'large-3');assert.equal(old.content,found[0].content);
  assert.equal((await store.queryKnowledge(manifest,manager.id,'search','needleomega'))[0].version,1);
  await assert.rejects(store.knowledgeSnapshot([manager],'department'),/知识授权已失效/);

  // Citation reads require a persisted resource anchor, including for an explicit local owner.
  await pool.query("INSERT INTO projects(id,department_id,department_version,department_name,requirement,policy,plan,source) VALUES('citation-project','department',1,'Fixture','Fixed citation',$1,$2,'manual')",[{allowedDepartmentIds:['department']},{agents:[manager],tasks:[]}]);
  const fixed={projectId:'citation-project',planVersion:1,departmentId:'department',knowledge:manifest,agents:[manager]},archive=createRunArchive(join(dir,'runs'),fixed);
  await pool.query("INSERT INTO project_runs(id,project_id,project_version,status,snapshot,department_ids) VALUES($1,'citation-project',1,'completed',$2,ARRAY['department'])",[archive.id,fixed]);
  archive.append('knowledge/citation',{agentId:manager.id,sources:[{documentId:old.documentId,version:old.version,chunkId:old.id,sha256:old.sha256}]});
  const citation=await fetch(url+'/runs/'+archive.id+'/citations/'+old.id);
  assert.equal(citation.status,200);assert.equal((await citation.json() as any).content,old.content);
  assert.equal((await fetch(url+'/runs/'+archive.id+'/citations/'+allChunks[0].id)).status,404);
  assert.equal((await fetch(url+'/runs/'+archive.id+'/citations/'+foreign)).status,404);

  const password='knowledge-backup-fixture';
  const exported=await fetch(url+'/backup/export',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password})});
  assert.equal(exported.status,200);const backup=await exported.json();
  await pool.query('DELETE FROM knowledge_chunks WHERE id=$1',[old.id]);
  await assert.rejects(store.queryKnowledge(manifest,manager.id,'search','needleomega'),e=>(e as any).code==='KNOWLEDGE_VERSION_MISSING');
  assert.equal((await fetch(url+'/runs/'+archive.id+'/citations/'+old.id)).status,409);
  const restored=await fetch(url+'/backup/restore',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password,backup,confirmation:'RESTORE'})});
  assert.equal(restored.status,200,await restored.text());
  const restoredCitation=await fetch(url+'/runs/'+archive.id+'/citations/'+old.id);
  assert.equal(restoredCitation.status,200);assert.equal((await restoredCitation.json() as any).content,old.content);
});
