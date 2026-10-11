import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import * as methods from '../services/agent-runtime/approved-skills.mjs';
const companySkills=(manifest:any,employee:any)=>(methods as any).companySkills(manifest,employee);

let pool:any,server:any,app:any,root:string,url:string,store:typeof import('../apps/api/src/knowledge-store.ts');
const reader={id:'reader',tools:['knowledge_search','knowledge_read'],knowledgeSpaceIds:['company']};
const other={id:'other',tools:['knowledge_search','knowledge_read'],knowledgeSpaceIds:[]};
async function api(path:string,body:unknown,method='POST'){const r=await fetch(url+path,{method,headers:{'content-type':'application/json'},body:JSON.stringify(body)});return {status:r.status,data:await r.json() as any};}
before(async()=>{
 root=await mkdtemp(join(tmpdir(),'company-capabilities-'));process.env.DATA_DIR=root;process.env.TRACE_ROOT=join(root,'runs');process.env.OBSIDIAN_VAULT=join(root,'vault');
 const db=await import('../apps/api/src/db.ts');pool=db.pool;await db.migrate();store=await import('../apps/api/src/knowledge-store.ts');
 await pool.query('INSERT INTO departments(id,data) VALUES($1,$2)',['department',{name:'研发',agents:[reader,other]}]);
 await pool.query("INSERT INTO knowledge_spaces(id,name,scope,agent_ids) VALUES('company','公司方法','company','[]')");
 const {createApp}=await import('../apps/api/src/app.ts');app=createApp();await app.locals.shutdown();server=app.listen(0,'127.0.0.1');await once(server,'listening');url='http://127.0.0.1:'+server.address().port+'/api';
});
after(async()=>{await app?.locals.shutdown();if(server)await new Promise<void>(r=>server.close(()=>r()));await pool?.end();if(root)await rm(root,{recursive:true,force:true});});

test('company methods are explicit, lazy, authorized and retain the original revision on recovery',async()=>{
 const body={spaceId:'company',title:'交付测试方法',content:'原始方法：运行独立测试，记录真实命令。\r\n不要预写成功。',source:{skillName:'delivery-check'}};
 const created=await api('/knowledge/documents',body);assert.equal(created.status,201,JSON.stringify(created));
 const snapshot=await store.knowledgeSnapshot([reader,other],'department');
 assert.equal(snapshot.documents[0].source.skillName,'delivery-check');
 const skills=companySkills(snapshot,reader);assert.equal(skills.length,1);assert.equal(skills[0].evidence.version,1);assert.ok(!JSON.stringify(snapshot).includes(body.content));
 assert.deepEqual(companySkills(snapshot,other),[]);assert.deepEqual(companySkills(snapshot,{...reader,tools:['knowledge_search']}),[]);
 const loaded=await store.queryKnowledge(snapshot,reader.id,'skill',created.data.id);assert.equal(loaded.content,body.content);
 assert.equal(await store.queryKnowledge(snapshot,other.id,'skill',created.data.id),undefined);
 const edited=await api('/knowledge/documents/'+created.data.id,{...body,content:'新的方法',version:1},'PUT');assert.equal(edited.status,200);
 assert.equal((await store.queryKnowledge(JSON.parse(JSON.stringify(snapshot)),reader.id,'skill',created.data.id)).content,body.content);
 const ordinary=await api('/knowledge/documents',{spaceId:'company',title:'普通资料',content:'资料不是指令。'});assert.equal(ordinary.status,201);
 const fresh=await store.knowledgeSnapshot([reader],'department');assert.equal(companySkills(fresh,reader).length,1);
 assert.equal(await store.queryKnowledge(fresh,reader.id,'skill',ordinary.data.id),undefined);
 await pool.query('UPDATE knowledge_revisions SET sha256=$1 WHERE document_id=$2 AND version=1',['bad',created.data.id]);
 await assert.rejects(store.queryKnowledge(snapshot,reader.id,'skill',created.data.id),/版本缺失|完整|校验/);
});

test('method publication rejects unsafe names and oversized bodies while ordinary documents remain usable',async()=>{
 for(const input of [{skillName:'../secret',content:'text'},{skillName:'a'.repeat(81),content:'text'},{skillName:'method',content:'x'.repeat(16001)},{skillName:'method',content:'   '}]){
  const r=await api('/knowledge/documents',{spaceId:'company',title:'无效方法',content:input.content,source:{skillName:input.skillName}});assert.ok(r.status>=400,JSON.stringify(r));
 }
 assert.equal((await api('/knowledge/documents',{spaceId:'company',title:'较长普通资料',content:'x'.repeat(16001)})).status,201);
});
