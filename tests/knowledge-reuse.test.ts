import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {createRunArchive} from '../services/agent-runtime/trace-store.mjs';
import {inspectArtifact} from '../services/agent-runtime/handoff.mjs';
import {AutomationLearningService} from '../apps/api/src/automation-learning.ts';

const isolated=process.env.SIMULATED_INTEGRATION==='pglite',department=randomUUID(),space=randomUUID();
let root:string,url:string,db:any,server:any,doc:any,work1:any,work2:any;
const api=async(path:string,method='GET',body?:unknown)=>{const response=await fetch(url+path,{method,headers:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return {status:response.status,data:await response.json() as any};};
const agent={id:'reader',name:'夹具员工',tools:['knowledge_search','knowledge_read','filesystem','artifact_write'],knowledgeSpaceIds:[space]};
before(async()=>{
 if(!isolated)return;
 root=mkdtempSync(join(tmpdir(),'knowledge-reuse-'));process.env.DATA_DIR=root;process.env.TRACE_ROOT=join(root,'runs');process.env.OBSIDIAN_VAULT=join(root,'vault');
 const mod=await import('../apps/api/src/db.ts');db=mod.pool;await mod.migrate();
 await db.query('INSERT INTO departments(id,data) VALUES($1,$2)',[department,{name:'隔离统计验证',agents:[agent]}]);
 await db.query("INSERT INTO knowledge_spaces(id,name,scope,department_id,agent_ids) VALUES($1,'部门方法','department',$2,'[]')",[space,department]);
 const {createApp}=await import('../apps/api/src/app.ts');const app=createApp();await app.locals.shutdown();server=app.listen(0,'127.0.0.1');await once(server,'listening');url='http://127.0.0.1:'+(server.address() as any).port+'/api';
 const saved=(await api('/knowledge/documents','POST',{spaceId:space,title:'方法夹具',content:'先列出边界条件，再检查预期结果。',source:{skillName:'boundary-check'}})).data;
 doc=(await api('/knowledge/documents')).data.find((row:any)=>row.id===saved.id);assert.match(doc.sha256,/^[a-f0-9]{64}$/);
});
async function work(options:any={}){
 const project=options.project??randomUUID(),runId=randomUUID(),source=options.doc??doc;
 if(!options.project)await db.query('INSERT INTO projects(id,department_id,department_version,department_name,requirement,policy,plan,source) VALUES($1,$2,1,$3,$4,$5,$6,$7)',[project,department,'隔离统计验证','协议夹具，不是模型验收',{maxBudget:1},{agents:[],tasks:[]},'manual']);
 const snapshot:any={mode:'product',projectId:project,departmentId:department,planVersion:1,title:'夹具工作',requirement:'协议夹具，不是模型验收',approval:{fixture:true},agents:[agent],knowledge:{format:'document-versions-v2',documents:[{documentId:source.id,version:source.version,title:'方法夹具',spaceId:space,sha256:source.sha256}],agentDocuments:{reader:[source.id]}},tasks:[{id:'task',kind:'work',assigneeId:'reader',subject:'夹具检查',dependencies:[],outputs:[{path:'result.md'}]}],...(options.private?{agents:[agent,{...agent,id:'other'}],importedFiles:[{path:'private.txt',agentIds:['reader']}]}:{}),...(options.resumed?{resumedFrom:options.resumed}:{} )};
 if(options.secretDoc){snapshot.agents=[{...agent,knowledgeSpaceIds:[space,options.secretDoc.spaceId]}];snapshot.knowledge.documents.push({documentId:options.secretDoc.id,version:options.secretDoc.version,spaceId:options.secretDoc.spaceId,sha256:options.secretDoc.sha256,title:options.secretDoc.title});snapshot.knowledge.agentDocuments.reader.push(options.secretDoc.id);}
 const archive=createRunArchive(join(root,'runs'),snapshot,{id:runId}),files=join(root,'runs',runId,'artifacts');mkdirSync(files,{recursive:true});writeFileSync(join(files,'result.md'),'测试夹具，不能作为员工交付。');
 if(!options.readOnly)for(const attemptId of options.failedOnly?['failed']:['failed','accepted','accepted'])archive.append('capability/adopted',{agentId:'reader',taskId:'task',attemptId,kind:'skill',id:'method',source:{documentId:source.id,version:source.version,sha256:source.sha256},note:options.note??'实际采用边界条件检查步骤',validation:'pending'});
 archive.append('knowledge/citation',{agentId:'reader',operation:'read',sources:[{documentId:source.id,version:source.version,sha256:source.sha256}]});
 archive.append('run/task-mapping',{tasks:[{task_id:'t1',seed_id:'task'}]});archive.append('handoff/accepted',{runId,taskId:'task',attemptId:'accepted',inputs:[],outputs:[inspectArtifact(files,{path:'result.md'})],commands:[]});archive.append('team/checkpoint',{tasks:[{id:'t1',status:'completed',attemptId:'accepted'}]});archive.append('run/finished',{status:'completed'});
 await db.query("INSERT INTO project_runs(id,project_id,project_version,attempt,status,snapshot) VALUES($1,$2,1,$3,'completed',$4)",[runId,project,options.project?2:1,snapshot]);
 return {runId,project,snapshot,files};
}
test('distinct accepted works aggregate fixed sources while retries, reads and failed attempts do not count',{skip:!isolated},async()=>{
 work1=await work();work2=await work();await work({project:work1.project,resumed:work1.runId});await work({readOnly:true});await work({failedOnly:true});
 const sealed=await api('/knowledge/work-records/'+work1.runId);assert.equal(sealed.status,200,JSON.stringify(sealed.data));assert.equal(sealed.data.adoptions.length,1);
 const response=await api('/knowledge/reuse?departmentId='+department);assert.equal(response.status,200,JSON.stringify(response.data));
 assert.equal(response.data.groups.length,1,JSON.stringify(response.data));assert.equal(response.data.groups[0].successWorkCount,2);assert.equal(response.data.groups[0].works.length,2);
 assert.equal(response.data.groups[0].source.version,1);assert.equal(response.data.groups[0].works[0].efficiency.comparison,null,'missing comparable baseline stays unverified');
});
test('fixed versions remain separate and private or changed archives cannot seed public statistics',{skip:!isolated},async()=>{
 await api('/knowledge/documents/'+doc.id,'PUT',{spaceId:space,title:'方法夹具',version:1,content:'新版增加反例。',source:{skillName:'boundary-check'}});const v2=(await api('/knowledge/documents')).data.find((row:any)=>row.id===doc.id);await work({doc:v2});await work({private:true});const bad=await work();writeFileSync(join(bad.files,'result.md'),'changed');
 const response=await api('/knowledge/reuse?departmentId='+department);assert.equal(response.status,200);assert.deepEqual(response.data.groups.map((g:any)=>g.source.version).sort(),[1,2]);assert.equal(response.data.groups.find((g:any)=>g.source.version===1).successWorkCount,2);assert.ok(response.data.omissions.some((o:any)=>o.code==='PRIVATE_WORK'));assert.ok(response.data.omissions.some((o:any)=>o.code==='INVALID_WORK'));
});
test('background reuse candidates use configurable thresholds and do not overwrite reviewed content',{skip:!isolated},async()=>{
 const service=new AutomationLearningService(db,{traceRoot:join(root,'runs'),clock:()=>new Date('2030-01-01T00:00:00Z')});await service.tick();
 assert.equal((await api('/automation/knowledge-candidates')).data.length,0,'default is three different successful works');
 await db.query("UPDATE product_settings SET data=data||'{\"reuseMinSuccessfulWorks\":2}'::jsonb WHERE id=1");
 const restarted=new AutomationLearningService(db,{traceRoot:join(root,'runs')});await restarted.tick();await restarted.tick();
 let rows=(await api('/automation/knowledge-candidates')).data;assert.equal(rows.length,1);assert.equal(rows[0].reuseEvidence.successWorkCount,2);assert.equal(rows[0].sourceVersion,1);
 const candidate=rows[0];assert.equal((await api('/automation/knowledge-candidates/'+candidate.id,'PUT',{version:candidate.version,title:'人工审查标题',content:'人工审查正文'})).status,200);
 const again=new AutomationLearningService(db,{traceRoot:join(root,'runs')});await again.tick();rows=(await api('/automation/knowledge-candidates')).data;assert.equal(rows.length,1);assert.equal(rows[0].content,'人工审查正文');
});
test('manual candidates are preserved and automatic candidates respect a bounded storage quota',{skip:!isolated},async()=>{
 const saved=(await api('/knowledge/documents','POST',{spaceId:space,title:'手工来源',content:'手工来源步骤'})).data;
 const source=(await api('/knowledge/documents')).data.find((row:any)=>row.id===saved.id),first=await work({doc:source});await work({doc:source});
 const manual=await api('/automation/knowledge-candidates','POST',{runId:first.runId,documentId:source.id});assert.equal(manual.status,201);
 const original=(await api('/automation/knowledge-candidates')).data.find((row:any)=>row.id===manual.data.id);
 const service=new AutomationLearningService(db,{traceRoot:join(root,'runs')});await service.tick();
 assert.equal((await api('/automation/knowledge-candidates')).data.find((row:any)=>row.id===manual.data.id).content,original.content);
 await db.query('UPDATE automation_knowledge_candidates SET content=$1 WHERE id=$2',['x'.repeat(8*1024*1024),manual.data.id]);
 const saved2=(await api('/knowledge/documents','POST',{spaceId:space,title:'容量验证来源',content:'容量验证步骤'})).data;
 const source2=(await api('/knowledge/documents')).data.find((row:any)=>row.id===saved2.id);await work({doc:source2});await work({doc:source2});
 const next=new AutomationLearningService(db,{traceRoot:join(root,'runs')});await next.tick();
 assert.equal((await api('/automation/knowledge-candidates')).data.length,2,'automatic extraction must not grow beyond the 8 MiB quota');
 const report=await api('/knowledge/reuse?departmentId='+department);assert.equal(report.data.candidateCapacity.maxBytes,8*1024*1024);
 await db.query('UPDATE automation_knowledge_candidates SET content=$1 WHERE id=$2',[original.content,manual.data.id]);
 const restarted=new AutomationLearningService(db,{traceRoot:join(root,'runs')});await restarted.tick();
 const candidate=(await api('/automation/knowledge-candidates')).data.find((row:any)=>row.documentId===source2.id);assert.ok(candidate.reuseEvidence);
 const publication=await api('/automation/knowledge-candidates/'+candidate.id+'/publish','POST',{version:candidate.version,reviewed:true});assert.equal(publication.status,200,JSON.stringify(publication.data));
 const published=(await api('/knowledge/documents')).data.find((row:any)=>row.id===publication.data.id);assert.equal(published.source.skillName,undefined,'experience publication never silently grants Skill instructions');
});
test('single-employee shared-method use with an employee-private source never enters department knowledge',{skip:!isolated},async()=>{
 const privateSpace=(await api('/knowledge/spaces','POST',{name:'员工私有夹具',scope:'employee',departmentId:department,agentIds:['reader']})).data.id;
 const secretSaved=(await api('/knowledge/documents','POST',{spaceId:privateSpace,title:'私有资料',content:'PRIVATE_WORK_SECRET'})).data;
 const sharedSaved=(await api('/knowledge/documents','POST',{spaceId:space,title:'混合输入共享方法',content:'共享边界检查步骤',source:{skillName:'mixed-check'}})).data;
 const docs=(await api('/knowledge/documents')).data,secret=docs.find((row:any)=>row.id===secretSaved.id),shared=docs.find((row:any)=>row.id===sharedSaved.id);
 await db.query('UPDATE departments SET data=$1 WHERE id=$2',[{name:'私有边界夹具',agents:[{...agent,knowledgeSpaceIds:[space,privateSpace]}]},department]);
 const one=await work({doc:shared,secretDoc:secret,note:'PRIVATE_WORK_SECRET'});await work({doc:shared,secretDoc:secret,note:'PRIVATE_WORK_SECRET'});
 const record=await api('/knowledge/work-records/'+one.runId);assert.equal(record.status,200);assert.equal(record.data.shareable,false,'all participating employees having access does not make an employee-private space department-shared');
 assert.equal((await api('/knowledge/work-records/'+one.runId+'/publish','POST',{spaceId:space})).status,422);
 const report=await api('/knowledge/reuse?departmentId='+department);assert.ok(!JSON.stringify(report.data.groups).includes('PRIVATE_WORK_SECRET'));
 await new AutomationLearningService(db,{traceRoot:join(root,'runs')}).tick();assert.ok(!(await api('/automation/knowledge-candidates')).data.some((row:any)=>row.documentId===shared.id));
 await db.query('UPDATE departments SET data=$1 WHERE id=$2',[{name:'隔离统计验证',agents:[agent]},department]);
});
test('publication rehashes the source revision after candidate generation',{skip:!isolated},async()=>{
 const saved=(await api('/knowledge/documents','POST',{spaceId:space,title:'原文哈希验证',content:'原始验证步骤'})).data;const source=(await api('/knowledge/documents')).data.find((row:any)=>row.id===saved.id);await work({doc:source});await work({doc:source});await new AutomationLearningService(db,{traceRoot:join(root,'runs')}).tick();
 const candidate=(await api('/automation/knowledge-candidates')).data.find((row:any)=>row.documentId===source.id);assert.ok(candidate);
 await db.query('UPDATE knowledge_revisions SET content=$1 WHERE document_id=$2 AND version=1',['corrupted with the stored hash unchanged',source.id]);
 assert.equal((await api('/automation/knowledge-candidates/'+candidate.id+'/publish','POST',{version:candidate.version,reviewed:true})).status,409,'a matching SHA column alone is not intact source evidence');
 await db.query('UPDATE knowledge_revisions SET content=$1 WHERE document_id=$2 AND version=1',[source.content,source.id]);
});
test('reuse scans do not traverse unbounded earlier archives to calculate baselines',{skip:!isolated},async()=>{
 const {knowledgeReuse}=await import('../apps/api/src/knowledge-reuse.ts');const unbounded:string[]=[];
 const guarded={query:async(sql:string,args:any[])=>{if(sql.includes("SELECT id FROM project_runs WHERE status='completed'")&&sql.includes('requirement')&&!sql.includes('LIMIT'))unbounded.push(sql);return db.query(sql,args)}};
 const result=await knowledgeReuse(guarded as any,join(root,'runs'),department);assert.ok(result.groups.length>0);assert.equal(unbounded.length,0,'bounded adoption scanning must not recursively scan unlimited efficiency baselines');
});
test('a bounded history window still generates proved candidates and preserves older pending evidence',{skip:!isolated},async()=>{
 const saved=(await api('/knowledge/documents','POST',{spaceId:space,title:'旧待审来源',content:'旧来源步骤'})).data;const older=(await api('/knowledge/documents')).data.find((row:any)=>row.id===saved.id);await work({doc:older});await work({doc:older});await new AutomationLearningService(db,{traceRoot:join(root,'runs')}).tick();
 const pending=(await api('/automation/knowledge-candidates')).data.find((row:any)=>row.documentId===older.id);assert.ok(pending);
 const project=randomUUID();await db.query('INSERT INTO projects(id,department_id,department_version,department_name,requirement,policy,plan,source) VALUES($1,$2,1,$3,$4,$5,$6,$7)',[project,department,'窗口夹具','元数据夹具',{maxBudget:1},{agents:[],tasks:[]},'manual']);
 for(let i=0;i<101;i++)await db.query("INSERT INTO project_runs(id,project_id,project_version,attempt,status,snapshot) VALUES($1,$2,1,$3,'completed',$4)",[randomUUID(),project,i+1,{}]);
 const freshSaved=(await api('/knowledge/documents','POST',{spaceId:space,title:'新窗口来源',content:'新来源步骤'})).data;const fresh=(await api('/knowledge/documents')).data.find((row:any)=>row.id===freshSaved.id);for(let i=0;i<3;i++)await work({doc:fresh});
 const report=await api('/knowledge/reuse?departmentId='+department);assert.equal(report.data.truncated,true);
 await new AutomationLearningService(db,{traceRoot:join(root,'runs')}).tick();const created=(await api('/automation/knowledge-candidates')).data.find((row:any)=>row.documentId===fresh.id);assert.ok(created,'three sealed different works are sufficient even when older history is omitted');
 const published=await api('/automation/knowledge-candidates/'+pending.id+'/publish','POST',{version:pending.version,reviewed:true});assert.equal(published.status,200,JSON.stringify(published.data));
});
test('candidate publishing rechecks the actual accepted work and current grants',{skip:!isolated},async()=>{
 const candidate=(await api('/automation/knowledge-candidates')).data.find((row:any)=>row.reuseEvidence&&row.documentId===doc.id);
 assert.ok(candidate,'a real accepted-work candidate is required');
 for(const runId of candidate.reuseEvidence.works.map((w:any)=>w.runId))writeFileSync(join(root,'runs',runId,'artifacts','result.md'),'changed after candidate');
 assert.equal((await api('/automation/knowledge-candidates/'+candidate.id+'/publish','POST',{version:candidate.version,reviewed:true})).status,409);
 await db.query('UPDATE departments SET data=$1 WHERE id=$2',[{name:'已撤销权限',agents:[{...agent,knowledgeSpaceIds:[]}]},department]);
 const response=await api('/knowledge/reuse?departmentId='+department);assert.equal(response.status,200);assert.equal(response.data.groups.length,0);
});
test('bounded background batches eventually visit every department',{skip:!isolated},async()=>{
 for(let i=0;i<21;i++){const d=randomUUID(),p=randomUUID(),r=randomUUID();await db.query('INSERT INTO departments(id,data) VALUES($1,$2)',[d,{name:'轮转夹具',agents:[]}]);await db.query('INSERT INTO projects(id,department_id,department_version,department_name,requirement,policy,plan,source) VALUES($1,$2,1,$3,$4,$5,$6,$7)',[p,d,'轮转夹具','无模型元数据夹具',{maxBudget:1},{agents:[],tasks:[]},'manual']);await db.query("INSERT INTO project_runs(id,project_id,project_version,status,snapshot) VALUES($1,$2,1,'completed',$3)",[r,p,{}]);}
 const batches:string[][]=[];let now=new Date('2031-01-01T00:00:00Z');
 const wrapped={query:db.query.bind(db),connect:async()=>{const client=await db.connect();return{query:async(sql:string,args:any[])=>{const result=await client.query(sql,args);if(sql.startsWith('SELECT DISTINCT p.department_id'))batches.push(result.rows.map((r:any)=>r.department_id));return result},release:()=>client.release()}}};
 const service=new AutomationLearningService(wrapped as any,{traceRoot:join(root,'runs'),clock:()=>now});await service.tick();now=new Date(now.getTime()+60000);await service.tick();assert.equal(service.lastError,null);
 assert.equal(new Set(batches.flat()).size,22,'a permanent first-20 limit must not starve later departments');
});
test('accepted reuse flows through reviewed publication into an authorized lazy skill with a fixed recovery revision',{skip:!isolated},async()=>{
 // These isolated archive fixtures verify the interfaces, not real employee quality or adoption.
 await db.query('UPDATE departments SET data=$1 WHERE id=$2',[{name:'隔离统计验证',agents:[agent]},department]);
 await db.query("UPDATE product_settings SET data=data||'{\"reuseMinSuccessfulWorks\":3}'::jsonb WHERE id=1");
 const created=await api('/knowledge/documents','POST',{spaceId:space,title:'闭环协议夹具方法',content:'隔离协议夹具：先识别边界，再核对结果；不是员工交付。'});
 assert.equal(created.status,201,JSON.stringify(created.data));
 const source=(await api('/knowledge/documents')).data.find((row:any)=>row.id===created.data.id);
 for(let i=0;i<3;i++)await work({doc:source});
 const {syncReuseCandidates}=await import('../apps/api/src/knowledge-reuse.ts');
 await syncReuseCandidates(db,join(root,'runs'),department);
 const candidate=(await api('/automation/knowledge-candidates')).data.find((row:any)=>row.documentId===source.id);
 assert.ok(candidate,'three accepted fixture works create a reviewable candidate');
 assert.equal(candidate.reuseEvidence.successWorkCount,3);
 assert.equal(new Set(candidate.reuseEvidence.works.map((item:any)=>item.workKey)).size,3);
 const publication='/automation/knowledge-candidates/'+candidate.id+'/publish';
 assert.equal((await api(publication,'POST',{version:candidate.version,reviewed:false})).status,422);
 const published=await api(publication,'POST',{version:candidate.version,reviewed:true});
 assert.equal(published.status,200,JSON.stringify(published.data));
 assert.equal((await api(publication,'POST',{version:candidate.version,reviewed:true})).data.id,published.data.id);
 let rows=(await api('/knowledge/documents')).data;
 assert.equal(rows.filter((row:any)=>row.id===published.data.id).length,1,'lost responses cannot duplicate publication');
 const document=rows.find((row:any)=>row.id===published.data.id);
 const store=await import('../apps/api/src/knowledge-store.ts');
 const {companySkills}=await import('../services/agent-runtime/approved-skills.mjs');
 const outsider={...agent,id:'outsider',knowledgeSpaceIds:[]};
 const ordinary=await store.knowledgeSnapshot([agent,outsider],department);
 assert.ok(!companySkills(ordinary,agent).some((item:any)=>item.evidence.documentId===document.id),'reviewed experience does not automatically become a skill');
 const promoted=await api('/knowledge/documents/'+document.id,'PUT',{spaceId:space,title:document.title,content:document.content,version:document.version,source:{...document.source,skillName:'reviewed-boundary-check'}});
 assert.equal(promoted.status,200,JSON.stringify(promoted.data));
 const pinned=await store.knowledgeSnapshot([agent,outsider],department);
 const method=companySkills(pinned,agent).find((item:any)=>item.evidence.documentId===document.id);
 assert.ok(method);assert.equal(method.evidence.version,2);
 assert.deepEqual(companySkills(pinned,outsider),[]);
 assert.ok(!JSON.stringify(pinned).includes(document.content),'catalog contains references rather than the full method');
 const loaded=await store.queryKnowledge(pinned,agent.id,'skill',document.id);
 assert.equal(loaded.content,document.content);assert.equal(loaded.sha256,method.evidence.sha256);
 assert.equal(await store.queryKnowledge(pinned,outsider.id,'skill',document.id),undefined);
 const edited=await api('/knowledge/documents/'+document.id,'PUT',{spaceId:space,title:document.title,content:'新修订的隔离夹具方法，不能替换旧批准上下文。',version:2,source:{...document.source,skillName:'reviewed-boundary-check'}});
 assert.equal(edited.status,200,JSON.stringify(edited.data));
 assert.equal((await store.queryKnowledge(JSON.parse(JSON.stringify(pinned)),agent.id,'skill',document.id)).content,loaded.content);
 const fresh=await store.knowledgeSnapshot([agent],department);
 const freshMethod=companySkills(fresh,agent).find((item:any)=>item.evidence.documentId===document.id);
 assert.ok(freshMethod);assert.equal(freshMethod.evidence.version,3);
 await syncReuseCandidates(db,join(root,'runs'),department);
 const after=(await api('/automation/knowledge-candidates')).data.find((row:any)=>row.id===candidate.id);
 assert.equal(after.status,'published');assert.equal(after.content,candidate.content,'background reconciliation preserves the reviewed publication');
});

after(async()=>{if(!isolated)return;server.closeAllConnections();await new Promise<void>(r=>server.close(r));await db.end();assert.ok(root.startsWith(join(tmpdir(),'knowledge-reuse-')));rmSync(root,{recursive:true,force:true});});

