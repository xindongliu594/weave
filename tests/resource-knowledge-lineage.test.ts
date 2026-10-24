import {after,before,beforeEach,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve,join,sep} from 'node:path';
import {once} from 'node:events';
import type pg from 'pg';
import type {Principal} from '../apps/api/src/identity-types.ts';
import {toolEvidence} from './model-fixture.ts';
import {chunkDocument} from '../services/agent-runtime/knowledge.mjs';
import {createRunArchive} from '../services/agent-runtime/trace-store.mjs';
import {inspectArtifact} from '../services/agent-runtime/handoff.mjs';

assert.equal(process.env.SIMULATED_INTEGRATION,'pglite');
assert.ok(['127.0.0.1','localhost','[::1]'].includes(new URL(process.env.DATABASE_URL!).hostname));
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222';
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
const bounds=(departments:string[],refs:unknown[]=[])=>({requiredDepartmentIds:departments,adminOnly:false,private:false,refs});
const principal=(user='operator'):Principal=>({kind:'human',userId:user,sessionId:user+'-session',issuer:'https://fixture.example',subject:user,orgRole:user==='admin'?'admin':'member',sessionEpoch:0,authenticatedAt:new Date().toISOString()});
const employee=(departmentId=A)=>({id:'manager',name:'Manager',role:'manager',title:'负责人',instructions:'核对资料',modelId:'model',tools:['knowledge_search','knowledge_read','filesystem','artifact_write'],knowledgeSpaceIds:[departmentId]});
let db:pg.Pool,app:any,server:any,url:string,temporary:string,traceRoot:string;
async function call(path:string,actor='operator',method='GET',body?:unknown,key?:string){const response=await fetch(url+path,{method,headers:{'content-type':'application/json','x-fixture-actor':actor,...(key?{'idempotency-key':key}:{})},body:body===undefined?undefined:JSON.stringify(body)});const text=await response.text();let data:any;try{data=JSON.parse(text);}catch{data=text;}return {status:response.status,data};}
async function grant(user:string,department:string,role='operator'){await db.query('INSERT INTO department_memberships(user_id,department_id,role,can_approve) VALUES($1,$2,$3,$4) ON CONFLICT(user_id,department_id) DO UPDATE SET role=$3,can_approve=$4',[user,department,role,role!=='viewer']);}
async function document(space:string,content:string,sourceBounds:unknown=bounds([space]),skillName?:string){
 const id=randomUUID(),source=skillName?{skillName}:{};await db.query('INSERT INTO knowledge_documents(id,space_id,title) VALUES($1,$2,$3)',[id,space,content]);
 await db.query('INSERT INTO knowledge_revisions(document_id,version,content,sha256,source,source_bounds) VALUES($1,1,$2,$3,$4,$5)',[id,content,hash(content),source,sourceBounds]);
 for(const c of chunkDocument(id,1,content))await db.query('INSERT INTO knowledge_chunks(id,document_id,version,line_start,line_end,content,tokens) VALUES($1,$2,1,$3,$4,$5,$6)',[c.id,id,c.lineStart,c.lineEnd,c.content,JSON.stringify(c.tokens)]);
 return {id,documentId:id,spaceId:space,title:content,content,version:1,sha256:hash(content),source,sourceBounds,chunkCount:chunkDocument(id,1,content).length};
}
async function project(departments=[A]){
 const id=randomUUID(),agents=departments.map((departmentId,index)=>({...employee(departmentId),id:index?'collaborator':'manager',role:index?'member':'manager',sourceDepartmentId:departmentId,sourceAgentId:'manager'}));
 const plan={agents,rationale:'Synthetic knowledge',tasks:[{id:'task',subject:'核对资料并交付',objective:'完成来源核验',assigneeId:'manager',dependencies:[],acceptanceCriteria:['交付固定来源核对结果'],estimatedInputTokens:100,estimatedOutputTokens:100}]};
 const {bindPolicy}=await import('../apps/api/src/execution-policy.ts'),policy=bindPolicy({maxBudget:1,maxAgents:2,maxConcurrentAgents:2,deadlineSeconds:300,allowedDepartmentIds:departments},agents as any,departments[0]);
 await db.query("INSERT INTO projects(id,department_id,department_version,department_name,requirement,policy,plan,source) VALUES($1,$2,1,'Synthetic','Synthetic knowledge goal',$3,$4,'manual')",[id,departments[0],policy,plan]);await db.query('INSERT INTO plan_versions(project_id,version,plan,policy) VALUES($1,1,$2,$3)',[id,plan,policy]);return {id,plan};
}
async function work(departments=[A],doc?:Awaited<ReturnType<typeof document>>){
 const p=await project(departments),id=randomUUID();const sourceBounds=bounds(departments,doc?[{kind:'knowledge-revision',id:doc.id,version:1,sha256:doc.sha256}]:[]);
 const snapshot={mode:'product',projectId:p.id,planVersion:1,departmentId:A,title:'Synthetic work',requirement:'Synthetic knowledge goal',approval:{fixture:true},agents:p.plan.agents,
  knowledge:{format:'document-versions-v2',documents:doc?[doc]:[],agentDocuments:Object.fromEntries(p.plan.agents.map(a=>[a.id,doc?[doc.id]:[]])),sourceTarget:{departmentIds:departments,adminOnly:false}},
  tasks:[{id:'task',kind:'work',assigneeId:'manager',subject:'Synthetic',dependencies:[],outputs:[{path:'result.txt'}]}]};
 await db.query("INSERT INTO project_runs(id,project_id,project_version,status,snapshot,department_ids,authority_kind,source_bounds) VALUES($1,$2,1,'completed',$3,$4,'human',$5)",[id,p.id,snapshot,departments,sourceBounds]);
 const archive=createRunArchive(traceRoot,snapshot,{id}),files=join(traceRoot,id,'artifacts');mkdirSync(files,{recursive:true});writeFileSync(join(files,'result.txt'),'Synthetic result');
 if(doc){archive.append('capability/adopted',{agentId:'manager',taskId:'task',attemptId:'accepted',kind:'skill',id:'method',source:{documentId:doc.id,version:1,sha256:doc.sha256},note:'SYNTHETIC_ADOPTION',validation:'pending'});archive.append('knowledge/citation',{agentId:'manager',operation:'read',sources:[{documentId:doc.id,version:1,sha256:doc.sha256,chunkId:chunkDocument(doc.id,1,doc.content)[0].id}]});}
 archive.append('run/task-mapping',{tasks:[{task_id:'t1',seed_id:'task'}]});archive.append('handoff/accepted',{runId:id,taskId:'task',attemptId:'accepted',inputs:[],outputs:[inspectArtifact(files,{path:'result.txt'})],commands:[]});archive.append('team/checkpoint',{tasks:[{id:'t1',status:'completed',attemptId:'accepted'}]});archive.append('run/finished',{status:'completed'});return {id,p,snapshot};
}
before(async()=>{temporary=await mkdtemp(resolve('.superpowers/sdd/2026-10-23-enterprise-plugin-completion/knowledge-fixture-'));traceRoot=join(temporary,'runs');process.env.DATA_DIR=temporary;process.env.TRACE_ROOT=traceRoot;process.env.OBSIDIAN_VAULT=join(temporary,'vault');process.env.WEIWU_AUTH_MODE='legacy-local';const database=await import('../apps/api/src/db.ts');db=database.pool;await database.migrate();
 const {createApp}=await import('../apps/api/src/app.ts'),{apiAccess}=await import('../apps/api/src/api-access.ts'),{idempotency}=await import('../apps/api/src/idempotency.ts');app=createApp({assertExecutorReady:async()=>{}});await app.locals.shutdownBackground();await app.locals.ready;const index=app.router.stack.findIndex((layer:any)=>layer.handle===idempotency);assert.ok(index>0);app.router.stack[index-1].handle=apiAccess({authenticate:async(req:any)=>principal(req.get('x-fixture-actor')??'operator'),csrf:(_req:any,_res:any,next:any)=>next()} as any,{mode:'legacy-local'});server=app.listen(0,'127.0.0.1');await once(server,'listening');url=`http://127.0.0.1:${server.address().port}/api`;});
after(async()=>{await app?.locals.shutdown();server?.closeAllConnections();if(server)await new Promise<void>(r=>server.close(()=>r()));await db?.end();if(temporary){assert.ok(temporary.startsWith(resolve('.superpowers/sdd/2026-10-23-enterprise-plugin-completion')+sep+'knowledge-fixture-'));await rm(temporary,{recursive:true,force:true});}});
beforeEach(async()=>{await db.query('TRUNCATE departments,human_users,models,gateways,knowledge_spaces,work_file_snapshots,request_keys CASCADE');await db.query("INSERT INTO gateways(id,data) VALUES('gateway',$1)",[{name:'No network',baseUrl:'http://127.0.0.1:1/v1'}]);await db.query("INSERT INTO models(id,data,status,capabilities) VALUES('model',$1,'available',$2)",[{name:'Fixture',gatewayId:'gateway',model:'fixture',inputRate:1,outputRate:1},toolEvidence]);for(const id of [A,B]){await db.query('INSERT INTO departments(id,data) VALUES($1,$2)',[id,{name:id,description:'Synthetic',dailyBudget:5,agents:[employee(id)]}]);await db.query("INSERT INTO knowledge_spaces(id,name,scope,department_id) VALUES($1,$1,'department',$1)",[id]);}await db.query("INSERT INTO knowledge_spaces(id,name,scope,department_id,agent_ids) VALUES('company','Company','company',NULL,'[]'),('private','Private','employee',$1,'[\"manager\"]')",[A]);for(const user of ['operator','viewer','admin'])await db.query("INSERT INTO human_users(id,issuer,subject,status,org_role) VALUES($1,'https://fixture.example',$1,'active',$2)",[user,user==='admin'?'admin':'member']);await grant('operator',A);await grant('viewer',A,'viewer');});

test('knowledge HTTP lists search and versions filter before pagination and never inherit private AI grants',async()=>{
 const own=await document(A,'needle OWN'),foreign=await document(B,'needle FOREIGN'),legacy=await document(A,'needle LEGACY',null);await document('company','needle COMPANY',bounds([]));await document('private','needle PRIVATE',bounds([A]));
 const shared=await document(A,'needle AB',bounds([A,B],[{kind:'knowledge-revision',id:foreign.id,version:1,sha256:foreign.sha256}]));
 assert.equal((await call('/knowledge/documents?limit=1','viewer')).status,200);assert.deepEqual((await call('/knowledge/documents?limit=1','viewer')).data.map((d:any)=>d.id),[own.id]);
 assert.deepEqual((await call('/knowledge/spaces','viewer')).data.map((s:any)=>s.id),[A]);
 assert.equal((await call(`/knowledge/documents/${own.id}/versions`,'viewer')).status,200);for(const id of [foreign.id,shared.id,legacy.id])assert.equal((await call(`/knowledge/documents/${id}/versions`,'viewer')).status,404);
 const results=await call('/knowledge/search','viewer','POST',{departmentId:A,agentId:'manager',query:'needle'});assert.equal(results.status,200);assert.deepEqual(results.data.map((d:any)=>d.documentId),[own.id]);
 await grant('viewer',B,'viewer');assert.equal((await call(`/knowledge/documents/${shared.id}/versions`,'viewer')).status,200);
});

test('knowledge target bounds reject B to A before chunk or Skill body reads and permit fixed AB approval',async()=>{
 await grant('operator',B);const doc=await document(B,'BOUND_METHOD',bounds([B]),'bound-method');
 const store=await import('../apps/api/src/knowledge-store.ts');let bodyReads=0;const guarded={query:async(sql:string,args?:unknown[])=>{if(sql.includes('SELECT content FROM knowledge_revisions')||sql.includes('FROM authorized WHERE')){bodyReads++;throw Error('UNAUTHORIZED_KNOWLEDGE_BODY_READ');}return db.query(sql,args);}};
 await assert.rejects((store.knowledgeSnapshot as any)([{...employee(B),sourceDepartmentId:B,sourceAgentId:'manager'}],A,guarded,[doc.id],{principal:principal(),targetDepartmentIds:[A]}),(error:any)=>[404,422].includes(error.status));assert.equal(bodyReads,0);
 const p=await project([A,B]);const saved=await call(`/projects/${p.id}/plan`,'operator','PUT',{version:1,plan:{...p.plan,knowledgeDocumentIds:[doc.id]}});assert.equal(saved.status,200,JSON.stringify(saved.data));const approved=await call(`/projects/${p.id}/approve`,'operator','POST',{version:2});assert.equal(approved.status,202,JSON.stringify(approved.data));
 const row=(await db.query('SELECT snapshot,source_bounds FROM project_runs WHERE id=$1',[approved.data.id])).rows[0];assert.deepEqual(row.source_bounds.requiredDepartmentIds,[A,B]);assert.equal((await store.queryKnowledge(row.snapshot.knowledge,'employee-2','skill',doc.id)).content,'BOUND_METHOD');
 await assert.rejects(store.queryKnowledge({...row.snapshot.knowledge,sourceTarget:{departmentIds:[A],adminOnly:false}},'employee-2','skill',doc.id,6,guarded as any));assert.equal(bodyReads,0);
 process.env.WEIWU_AUTH_MODE='oidc';try{await assert.rejects(store.queryKnowledge({manager:[{id:'old',content:'legacy secret'}]},'manager','read','old',6,guarded as any),(error:any)=>error.status===403);}finally{process.env.WEIWU_AUTH_MODE='legacy-local';}assert.equal(bodyReads,0);
});

test('department authoring preserves audit and source restrictions and cannot replay a revoked cached write',async()=>{
 const created=await call('/knowledge/documents','operator','POST',{spaceId:A,title:'Own procedure',content:'member procedure'},'knowledge-create');assert.equal(created.status,201,JSON.stringify(created.data));
 const row=(await db.query('SELECT source_bounds FROM knowledge_revisions WHERE document_id=$1',[created.data.id])).rows[0];assert.deepEqual(row.source_bounds.requiredDepartmentIds,[A]);assert.equal(row.source_bounds.adminOnly,false);
 assert.equal((await db.query("SELECT count(*)::int AS count FROM human_audit_events WHERE action='knowledge.publish' AND actor_user_id='operator'")).rows[0].count,1);
 assert.equal((await call('/knowledge/documents','operator','POST',{spaceId:A,title:'Forged',content:'body',sourceBounds:bounds([])})).status,422);
 await db.query("DELETE FROM department_memberships WHERE user_id='operator' AND department_id=$1",[A]);assert.equal((await call('/knowledge/documents','operator','POST',{spaceId:A,title:'Own procedure',content:'member procedure'},'knowledge-create')).status,404);
});

test('work reuse and efficiency exclude inaccessible historical AB runs before archive cost reads and metadata counts',async()=>{
 const doc=await document(A,'METHOD A',bounds([A]),'method-a'),hidden=await work([A,B],doc),own=await work([A],doc);writeFileSync(join(traceRoot,hidden.id,'snapshot.json'),'UNAUTHORIZED_HISTORY_MUST_NOT_BE_READ');
 const report=await call(`/knowledge/reuse?departmentId=${A}`,'viewer');assert.equal(report.status,200,JSON.stringify(report.data));assert.equal(report.data.scannedRuns,1);assert.ok(!JSON.stringify(report.data).includes(hidden.id));assert.equal(report.data.candidateCapacity,undefined);
 assert.deepEqual((await call('/knowledge/work-records','viewer')).data.map((row:any)=>row.runId),[own.id]);
 const publication=await call(`/knowledge/work-records/${own.id}/publish`,'operator','POST',{spaceId:A});assert.equal(publication.status,201,JSON.stringify(publication.data));assert.ok((await db.query('SELECT source_bounds FROM knowledge_revisions WHERE document_id=$1',[publication.data.id])).rows[0].source_bounds.refs.some((ref:any)=>ref.id===own.id));
 assert.equal((await call(`/knowledge/work-records/${hidden.id}/publish`,'operator','POST',{spaceId:A})).status,404);
 const record=await call(`/knowledge/work-records/${own.id}`,'viewer');assert.equal(record.status,200,JSON.stringify(record.data));assert.equal(record.data.efficiency.baseline,null);assert.equal((await call(`/knowledge/work-records/${hidden.id}`,'viewer')).status,404);
 const {workEfficiency}=await import('../apps/api/src/work-efficiency.ts'),{readRun}=await import('../services/agent-runtime/trace-store.mjs');let hiddenCosts=0;
 const guard={query:async(sql:string,args?:unknown[])=>{if((sql.includes('FROM usage')||sql.includes('FROM model_reservations'))&&args?.includes(hidden.id)){hiddenCosts++;throw Error('HIDDEN_COST_READ');}return db.query(sql,args);}};
 await (workEfficiency as any)(guard,traceRoot,readRun(traceRoot,own.id),principal('viewer'));assert.equal(hiddenCosts,0);
});

test('real work candidate edit and publication retain every source and refuse a narrower destination',async()=>{
 const doc=await document(A,'publish method',bounds([A]),'publish-method'),run=await work([A],doc);const candidate=await call('/automation/knowledge-candidates','operator','POST',{runId:run.id,documentId:doc.id});assert.equal(candidate.status,201,JSON.stringify(candidate.data));
 const edited=await call(`/automation/knowledge-candidates/${candidate.data.id}`,'operator','PUT',{version:1,title:'Reviewed method',content:'Reviewed method body'});assert.equal(edited.status,200,JSON.stringify(edited.data));
 const publication=await call(`/automation/knowledge-candidates/${candidate.data.id}/publish`,'operator','POST',{version:2,reviewed:true});assert.equal(publication.status,200,JSON.stringify(publication.data));
 const revision=(await db.query('SELECT source_bounds,content FROM knowledge_revisions WHERE document_id=$1',[publication.data.id])).rows[0];assert.equal(revision.content,'Reviewed method body');
 const {knowledgeSnapshot,queryKnowledge}=await import('../apps/api/src/knowledge-store.ts'),manifest=await knowledgeSnapshot([employee()],A,db,[publication.data.id],{principal:principal(),targetDepartmentIds:[A]});assert.equal((await queryKnowledge(manifest,'manager','skill',publication.data.id)).content,'Reviewed method body');assert.deepEqual(revision.source_bounds.requiredDepartmentIds,[A]);assert.ok(revision.source_bounds.refs.some((r:any)=>r.kind==='run'&&r.id===run.id));assert.equal((await call(`/knowledge/documents/${publication.data.id}/versions`,'viewer')).status,200);
 await grant('operator',B);const cross=await work([A,B],doc),crossCandidate=await call('/automation/knowledge-candidates','operator','POST',{runId:cross.id,documentId:doc.id});assert.ok([201,409].includes(crossCandidate.status));
 // A distinct fixed source avoids the existing document+hash deduplication key.
 const other=await document(A,'cross method',bounds([A])),cross2=await work([A,B],other),next=await call('/automation/knowledge-candidates','operator','POST',{runId:cross2.id,documentId:other.id});assert.equal(next.status,201,JSON.stringify(next.data));
 assert.equal((await call(`/automation/knowledge-candidates/${next.data.id}/publish`,'operator','POST',{version:1,reviewed:true})).status,422);assert.equal((await db.query('SELECT count(*)::int AS count FROM knowledge_documents WHERE id=$1',[next.data.id])).rows[0].count,0);
});


test('candidate publication audit failure rolls back the actual revision and candidate state',async()=>{
 const doc=await document(A,'atomic method'),run=await work([A],doc),candidate=await call('/automation/knowledge-candidates','operator','POST',{runId:run.id,documentId:doc.id});assert.equal(candidate.status,201);
 const {Client}=await import('pg'),original=Client.prototype.query;(Client.prototype as any).query=function(sql:any,...args:any[]){if(typeof sql==='string'&&sql.includes('INSERT INTO human_audit_events'))return Promise.reject(Error('SYNTHETIC_AUDIT_UNAVAILABLE'));return (original as any).call(this,sql,...args);};
 try{assert.equal((await call(`/automation/knowledge-candidates/${candidate.data.id}/publish`,'operator','POST',{version:1,reviewed:true})).status,500);}finally{Client.prototype.query=original;}

 assert.equal((await db.query('SELECT count(*)::int AS count FROM knowledge_documents WHERE id=$1',[candidate.data.id])).rows[0].count,0);assert.deepEqual((await db.query('SELECT status,version FROM automation_knowledge_candidates WHERE id=$1',[candidate.data.id])).rows[0],{status:'pending',version:1});
 assert.equal((await call(`/automation/knowledge-candidates/${candidate.data.id}/publish`,'operator','POST',{version:1,reviewed:true})).status,200);
});

test('all reuse work references restrict candidate list and edits even when the primary run is local',async()=>{
 const doc=await document(A,'all works'),own=await work([A],doc),other=await work([A,B],doc),{combineSourceBounds,readRunBounds,readKnowledgeRevisionBounds}=await import('../apps/api/src/source-bounds.ts');
 const sourceBounds=combineSourceBounds([await readRunBounds(db,own.id),await readRunBounds(db,other.id),await readKnowledgeRevisionBounds(db,doc.id,1)]),id=randomUUID();
 const evidence={source:{documentId:doc.id,version:1,sha256:doc.sha256},workReferences:[{runId:own.id},{runId:other.id}]};
 await db.query('INSERT INTO automation_knowledge_candidates(id,run_id,document_id,source_version,source_hash,space_id,title,content,reuse_evidence,source_bounds) VALUES($1,$2,$3,1,$4,$5,\'All works\',\'SECRET_AB_CANDIDATE\',$6,$7)',[id,own.id,doc.id,doc.sha256,A,evidence,sourceBounds]);
 const {visibleCandidateQuery}=await import('../apps/api/src/resource-authorization.ts'),visible=visibleCandidateQuery(principal('viewer'));assert.deepEqual((await db.query(visible.text,visible.values)).rows,[]);
 assert.deepEqual((await call('/automation/knowledge-candidates','viewer')).data,[]);assert.equal((await call(`/automation/knowledge-candidates/${id}`,'operator','PUT',{version:1,title:'Edit',content:'New body'})).status,404);
 await grant('operator',B);assert.equal((await call('/automation/knowledge-candidates','operator')).data[0].id,id);assert.equal((await call(`/automation/knowledge-candidates/${id}`,'operator','PUT',{version:1,title:'Edit',content:'New body'})).status,200);
 const retained=(await db.query('SELECT source_bounds FROM automation_knowledge_candidates WHERE id=$1',[id])).rows[0].source_bounds;assert.deepEqual(retained.requiredDepartmentIds,[A,B]);assert.ok(retained.refs.some((ref:any)=>ref.id===other.id));
 await db.query("UPDATE automation_knowledge_candidates SET source_bounds=jsonb_set(source_bounds,'{refs}',$2) WHERE id=$1",[id,JSON.stringify(retained.refs.filter((ref:any)=>ref.id!==other.id))]);assert.deepEqual((await call('/automation/knowledge-candidates','operator')).data,[]);
 const {syncReuseCandidates}=await import('../apps/api/src/knowledge-reuse.ts');process.env.WEIWU_AUTH_MODE='oidc';try{let reads=0;const skipped=await syncReuseCandidates({query:async()=>{reads++;throw Error('UNBOUND_BACKGROUND_READ');}} as any,traceRoot,A);assert.equal(reads,0);assert.equal(skipped.skipped,'UNBOUND_ENTERPRISE_AUTHORITY');}finally{process.env.WEIWU_AUTH_MODE='legacy-local';}
});

test('native metadata exposes only enabled fixed tools granted to visible department employees',async()=>{
 const {gzipSync}=await import('node:zlib'),{nativeManifestId}=await import('../services/agent-runtime/native-capabilities.mjs'),{nativeCapabilityRoot}=await import('../apps/api/src/native-capabilities.ts');
 const code=Buffer.from('export const synthetic=true'),compressed=gzipSync(code),metadata=Buffer.from('{"name":"synthetic-plugin"}');
 const manifest={format:'dsh-native-tools-v1',namespace:'synthetic',package:'synthetic-plugin',version:'1.0.0',dshVersion:'0.1.5-rc.1',lockSha256:'a'.repeat(64),source:{kind:'company',reference:'PRIVATE_PACKAGE_PATH'},config:{token:'DO_NOT_EXPOSE_SECRET'},bundle:{sha256:createHash('sha256').update(compressed).digest('hex'),codeSha256:createHash('sha256').update(code).digest('hex'),metadataSha256:createHash('sha256').update(metadata).digest('hex'),bytes:compressed.length},tools:['allowed','foreign'].map(name=>({name:'plugin__synthetic__'+name,originalName:name,description:name,parameters:{type:'object'},files:{read:[],write:[]}}))};
 const id=nativeManifestId(manifest),folder=join(nativeCapabilityRoot(),id);mkdirSync(folder,{recursive:true});writeFileSync(join(folder,'manifest.json'),JSON.stringify(manifest));writeFileSync(join(folder,'bundle.gz'),compressed);writeFileSync(join(folder,'package.json'),metadata);
 await db.query("INSERT INTO native_capabilities(namespace,manifest_id,enabled) VALUES('synthetic',$1,true)",[id]);await db.query("UPDATE departments SET data=jsonb_set(data,'{agents,0,tools}',$2) WHERE id=$1",[A,JSON.stringify(['plugin__synthetic__allowed'])]);
 const result=await call('/capabilities/plugins','viewer');assert.equal(result.status,200);assert.equal(result.data.length,1);assert.equal(result.data[0].id,id);assert.deepEqual(result.data[0].manifest.tools.map((t:any)=>t.name),['plugin__synthetic__allowed']);assert.ok(!JSON.stringify(result.data).includes('DO_NOT_EXPOSE_SECRET'));assert.ok(!JSON.stringify(result.data).includes('PRIVATE_PACKAGE_PATH'));
 await db.query("UPDATE native_capabilities SET enabled=false WHERE namespace='synthetic'");assert.deepEqual((await call('/capabilities/plugins','viewer')).data,[]);
});


test('fixed citations require every source department before archive and chunk reads',async()=>{
 const doc=await document(A,'citation method'),own=await work([A],doc),shared=await work([A,B],doc),chunk=chunkDocument(doc.id,1,doc.content)[0].id;
 const ownResponse=await call(`/runs/${own.id}/citations/${chunk}`,'viewer');assert.equal(ownResponse.status,200,JSON.stringify(ownResponse.data));assert.equal(ownResponse.data.content,chunkDocument(doc.id,1,doc.content)[0].content);
 assert.equal((await call(`/runs/${shared.id}/citations/${chunk}`,'viewer')).status,404);await grant('viewer',B,'viewer');assert.equal((await call(`/runs/${shared.id}/citations/${chunk}`,'viewer')).status,200);
 await db.query('UPDATE knowledge_documents SET deleted_at=now() WHERE id=$1',[doc.id]);assert.equal((await call(`/runs/${own.id}/citations/${chunk}`,'viewer')).status,404);
});


test('document edit and withdrawal keep version CAS role checks provenance and transactional audit',async()=>{
 const created=await call('/knowledge/documents','operator','POST',{spaceId:A,title:'Editable',content:'first body'});assert.equal(created.status,201);const id=created.data.id;
 assert.equal((await call(`/knowledge/documents/${id}`,'viewer','PUT',{spaceId:A,version:1,title:'Viewer',content:'forbidden'})).status,404);
 assert.equal((await call(`/knowledge/documents/${id}`,'operator','PUT',{spaceId:A,version:1,title:'Changed',content:'second body'})).status,200);
 const revisions=await call(`/knowledge/documents/${id}/versions`,'viewer');assert.equal(revisions.status,200);assert.deepEqual(revisions.data.map((r:any)=>r.version),[2,1]);
 assert.equal((await call(`/knowledge/documents/${id}`,'operator','PUT',{spaceId:A,version:1,title:'Stale',content:'must not write'})).status,409);
 assert.equal((await db.query("SELECT count(*)::int AS count FROM human_audit_events WHERE resource_id=$1 AND action='knowledge.publish'",[id])).rows[0].count,2);
 assert.equal((await call(`/knowledge/documents/${id}`,'viewer','DELETE',{version:2})).status,404);assert.equal((await call(`/knowledge/documents/${id}`,'operator','DELETE',{version:2})).status,200);
 assert.equal((await call(`/knowledge/documents/${id}/versions`,'viewer')).status,404);assert.equal((await db.query("SELECT count(*)::int AS count FROM human_audit_events WHERE resource_id=$1 AND action='knowledge.withdraw'",[id])).rows[0].count,1);
});
