import {after,before,beforeEach,test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {resolve,join,sep} from 'node:path';
import {once} from 'node:events';
import express from 'express';
import type pg from 'pg';

assert.equal(process.env.SIMULATED_INTEGRATION,'pglite','Use the isolated integration runner');
assert.ok(['127.0.0.1','localhost','[::1]'].includes(new URL(process.env.DATABASE_URL!).hostname));
let db:pg.Pool;
let temporary:string;
let fixtureSequence=0;
const path='../apps/api/src/source-bounds.ts';
const source:any=await import(path).catch(error=>{if(error.code!=='ERR_MODULE_NOT_FOUND')throw error;return {
  combineSourceBounds:()=>({requiredDepartmentIds:[],adminOnly:false,private:false,refs:[]}),assertTargetContainsSources:()=>{},
  parseSourceBounds:(value:unknown)=>value,
};});
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
const bounds=(departments:string[]=[],extra:Record<string,unknown>={})=>({requiredDepartmentIds:departments,adminOnly:false,private:false,refs:[],...extra});
before(async()=>{temporary=await mkdtemp(resolve('.superpowers/sdd/2026-10-23-enterprise-plugin-completion/source-fixture-'));process.env.DATA_DIR=temporary;process.env.OBSIDIAN_VAULT=join(temporary,'vault');const database=await import('../apps/api/src/db.ts');db=database.pool;await database.migrate();});
after(async()=>{await db?.end();if(temporary){assert.ok(temporary.startsWith(resolve('.superpowers/sdd/2026-10-23-enterprise-plugin-completion')+sep+'source-fixture-'));await rm(temporary,{recursive:true,force:true});}});
beforeEach(async()=>{process.env.OBSIDIAN_VAULT=join(temporary,'vault-'+(++fixtureSequence));await db.query('TRUNCATE departments,human_users,knowledge_spaces,work_file_snapshots CASCADE');await db.query("INSERT INTO departments(id,data) VALUES('A','{}'),('B','{}')");});

test('source unions preserve every department restriction and fixed reference across two derivations',()=>{
  const first=source.combineSourceBounds([bounds(['B'],{refs:[{kind:'knowledge-revision',id:'doc',version:1,sha256:sha('v1')}]}),bounds(['A'])]);
  assert.deepEqual(first.requiredDepartmentIds,['A','B']);
  const second=source.combineSourceBounds([first,bounds(['A'],{adminOnly:true}),first]);
  assert.deepEqual(second.requiredDepartmentIds,['A','B']); assert.equal(second.adminOnly,true); assert.equal(second.refs.length,1);
  assert.deepEqual(first,bounds(['A','B'],{refs:[{kind:'knowledge-revision',id:'doc',version:1,sha256:sha('v1')}]}));
});
test('shared targets cannot drop a source department private flag or administrator-only restriction',()=>{
  assert.throws(()=>source.assertTargetContainsSources(['A'],bounds(['B'])));
  source.assertTargetContainsSources(['B','A'],bounds(['B']));
  for(const target of [['A'],['A','B']])assert.throws(()=>source.assertTargetContainsSources(target,bounds(['A'],{private:true}),{targetAdminOnly:true}));
  assert.throws(()=>source.assertTargetContainsSources(['A'],bounds(['A'],{adminOnly:true})));
  source.assertTargetContainsSources(['A'],bounds(['A'],{adminOnly:true}),{targetAdminOnly:true});
  assert.equal(source.combineSourceBounds([bounds(['A'],{private:true}),bounds(['A'])]).private,true);
});
test('malformed and conflicting immutable source references cannot become valid bounds',()=>{
  for(const ref of [{kind:'unknown',id:'x'},{kind:'run',id:'x'},{kind:'file',id:'x',sha256:'bad'},
    {kind:'knowledge-revision',id:'doc',version:0,sha256:sha('x')},{kind:'knowledge-revision',id:'doc',version:1.5,sha256:sha('x')},
    {kind:'file',id:' x',sha256:sha('x')},{kind:'file',id:'x',sha256:sha('x'),owner:'admin'}])assert.throws(()=>source.parseSourceBounds(bounds(['A'],{refs:[ref]})));
  assert.throws(()=>source.parseSourceBounds({...bounds(['A']),owner:'admin'}));
  assert.throws(()=>source.combineSourceBounds([bounds(['A'],{refs:[{kind:'file',id:'f',sha256:sha('one')}]}),bounds(['B'],{refs:[{kind:'file',id:'f',sha256:sha('two')}]})]));
});
test('complete migration is repeatable and adds nullable authority/source fields with real identity foreign keys',async()=>{
  await db.query("INSERT INTO projects(id,department_id,department_version,department_name,requirement,policy,plan,source) VALUES('legacy','A',1,'A','test',$1,$2,'test')",[{allowedDepartmentIds:['A']},{agents:[{id:'agent'}]}]);
  await db.query("INSERT INTO project_runs(id,project_id,project_version,status,snapshot,department_ids) VALUES('legacy-run','legacy',1,'completed','{}',ARRAY['A'])");
  const columns=(await db.query("SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='project_runs'")).rows.map(row=>row.column_name);
  for(const name of ['requested_by_user_id','authorized_by_user_id','authorized_epoch','authority_kind','authority_department_ids','source_bounds'])assert.ok(columns.includes(name),name);
  const {migrate}=await import('../apps/api/src/db.ts');await migrate();
  const old=(await db.query("SELECT requested_by_user_id,authorized_by_user_id,authorized_epoch,authority_kind,authority_department_ids,source_bounds FROM project_runs WHERE id='legacy-run'")).rows[0];
  assert.ok(Object.values(old).every(value=>value===null));
  await assert.rejects(db.query("UPDATE project_runs SET requested_by_user_id='missing' WHERE id='legacy-run'"),(error:any)=>error.code==='23503');
  await assert.rejects(db.query("UPDATE project_runs SET authorized_by_user_id='missing' WHERE id='legacy-run'"),(error:any)=>error.code==='23503');
  await assert.rejects(db.query("UPDATE project_runs SET authorized_epoch=-1 WHERE id='legacy-run'"),(error:any)=>error.code==='23514');
  await assert.rejects(db.query("UPDATE project_runs SET authority_kind='system' WHERE id='legacy-run'"),(error:any)=>error.code==='23514');
});

async function runFixture(id:string,departments:string[],sourceBounds:unknown=null,snapshot:unknown={}) {
  await db.query("INSERT INTO projects(id,department_id,department_version,department_name,requirement,policy,plan,source) VALUES($1,$2,1,'Fixture','source test',$3,$4,'test')",[id,departments[0],{allowedDepartmentIds:departments},{agents:departments.map(d=>({id:d,sourceDepartmentId:d,sourceAgentId:d}))}]);
  await db.query("INSERT INTO project_runs(id,project_id,project_version,status,snapshot,department_ids,source_bounds) VALUES($1,$1,1,'completed',$2,$3,$4)",[id,snapshot,departments,sourceBounds]);
}
async function documentFixture(id:string,department:string|null,sourceBounds:unknown=null,scope=department?'department':'company') {
  await db.query('INSERT INTO knowledge_spaces(id,name,scope,department_id) VALUES($1,$1,$2,$3)',[id,scope,department]);
  await db.query('INSERT INTO knowledge_documents(id,space_id,title) VALUES($1,$1,$1)',[id]);
  await db.query("INSERT INTO knowledge_revisions(document_id,version,content,sha256,source_bounds) VALUES($1,1,$1,$2,$3)",[id,sha(id),sourceBounds]);
}
const readRun=(id:string)=>source.readRunBounds?source.readRunBounds(db,id):Promise.resolve(bounds());
const readRevision=(id:string)=>source.readKnowledgeRevisionBounds?source.readKnowledgeRevisionBounds(db,id,1):Promise.resolve(bounds());
const validate=(value:unknown)=>source.validateSourceBounds?source.validateSourceBounds(db,value):Promise.resolve(value);
test('durable run and revision readers retain legacy admin-only bounds and immutable references without backfill',async()=>{
  await runFixture('read-run',['A','B']); await documentFixture('read-doc','B'); await documentFixture('private-doc','A',null,'employee');
  const run=await readRun('read-run');assert.deepEqual(run.requiredDepartmentIds,['A','B']);assert.equal(run.adminOnly,true);
  assert.equal(run.refs.find((r:any)=>r.kind==='run').version,1);
  const revision=await readRevision('read-doc');assert.equal(revision.adminOnly,true);assert.deepEqual(revision.requiredDepartmentIds,['B']);
  assert.equal((await readRevision('private-doc')).private,true);
  assert.equal((await db.query("SELECT source_bounds FROM project_runs WHERE id='read-run'")).rows[0].source_bounds,null);
});
test('reference validation binds existing fixed versions and hashes and restores omitted inherited restrictions',async()=>{
  await runFixture('valid-run',['B'],bounds(['B'],{private:true}));
  const run=await readRun('valid-run'),ref=run.refs.find((r:any)=>r.kind==='run');
  const checked=await validate(bounds(['A'],{refs:ref?[ref]:[]}));assert.deepEqual(checked.requiredDepartmentIds,['A','B']);assert.equal(checked.private,true);
  for(const bad of [{...ref,id:'missing'},{...ref,version:2},{...ref,sha256:sha('wrong')}])await assert.rejects(validate(bounds([],{refs:[bad]})));
});
test('linked file provenance cannot discard the source run or disguise legacy uploads',async()=>{
  await runFixture('read-run',['A','B']);
  for(const table of ['work_file_snapshots','automation_knowledge_candidates'])assert.equal((await db.query("SELECT count(*)::int AS count FROM information_schema.columns WHERE table_name=$1 AND column_name='source_bounds'",[table])).rows[0].count,1);
  await db.query("INSERT INTO work_file_snapshots(id,name,files,bytes,source_run_id,source_bounds) VALUES('linked','linked','[]',0,'read-run',$1),('upload','upload','[]',0,NULL,$2)",[bounds(['A']),bounds()]);
  const readFile=(id:string)=>source.readFileBounds?source.readFileBounds(db,id):Promise.resolve(bounds());
  const linked=await readFile('linked');assert.deepEqual(linked.requiredDepartmentIds,['A','B']);assert.equal(linked.adminOnly,true);
  assert.equal((await readFile('upload')).adminOnly,true);
});
test('corrupt provenance and cycles fail closed while unavailable database errors propagate',async()=>{
  await runFixture('corrupt',['A'],{requiredDepartmentIds:['A'],adminOnly:false,private:'bad',refs:[]});
  assert.equal((await readRun('corrupt')).adminOnly,true);assert.equal((await readRun('corrupt')).private,true);
  await runFixture('cycle',['A'],bounds(['A']));const ref=(await readRun('cycle')).refs.find((r:any)=>r.kind==='run');
  await db.query("UPDATE project_runs SET source_bounds=$1 WHERE id='cycle'",[bounds(['A'],{refs:ref?[ref]:[]})]);
  assert.equal((await readRun('cycle')).private,true);
  if(source.readRunBounds)await assert.rejects(source.readRunBounds({query:async()=>{throw Error('database unavailable');}},'x'),/database unavailable/);
});

async function httpFixture(router:express.Router,work:(request:(path:string,body:unknown,method?:string)=>Promise<{status:number;body:any}>)=>Promise<void>) {
  const app=express();app.use(express.json());app.use((_req,res,next)=>{res.locals.principal={kind:'local-owner'};next();});app.use(router);app.use((error:any,_req:any,res:any,_next:any)=>res.status(error.status??422).json({message:error.message}));
  const server=app.listen(0,'127.0.0.1');await once(server,'listening');
  try{await work(async(path,body,method='POST')=>{const response=await fetch(`http://127.0.0.1:${(server.address() as any).port}${path}`,{method,headers:{'content-type':'application/json'},body:JSON.stringify(body)});return {status:response.status,body:await response.json()};});}
  finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
}
test('upload and generation persist server bounds and selected files carry their immutable provenance',async()=>{
  const files=await import('../apps/api/src/work-files.ts');
  await httpFixture(files.workFilesRouter(db),async request=>{
    const input={name:'source fixture',files:[{path:'note.txt',base64:Buffer.from('source data').toString('base64')}]};
    assert.equal((await request('/work-files',{...input,sourceBounds:bounds()})).status,422);
    const upload=await request('/work-files',input);assert.equal(upload.status,201);
    const row=(await db.query('SELECT source_bounds FROM work_file_snapshots WHERE id=$1',[upload.body.id])).rows[0];assert.equal(row.source_bounds?.adminOnly,true);
    const selected=[{snapshotId:upload.body.id,paths:['note.txt'],agentIds:['agent'],mode:'workspace' as const}];
    const inputs:any[]=await files.selectedWorkFileInputs(selected,db),copies:any[]=await files.selectedWorkFileCopies(selected,db);
    assert.equal(inputs[0].sourceBounds?.adminOnly,true);assert.equal(copies[0].sourceBounds?.refs.find((ref:any)=>ref.kind==='file').id,upload.body.id);
    const generated=await request('/work-files/generate',{format:'csv',name:'source',rows:[['value']]});assert.equal(generated.status,201);
    assert.equal((await db.query('SELECT source_bounds FROM work_file_snapshots WHERE id=$1',[generated.body.id])).rows[0].source_bounds.adminOnly,true);
  });
});
test('knowledge writes reject B to A and private sharing and preserve prior revisions and admin-only flags',async()=>{
  const {saveKnowledgeDocument}=await import('../apps/api/src/knowledge.ts');const save=saveKnowledgeDocument as any;
  await documentFixture('private-doc','A',null,'employee');
  await documentFixture('write-source','B',bounds(['B']));await documentFixture('target-a','A',bounds(['A']));
  const fromB=await readRevision('write-source');
  await assert.rejects(save({spaceId:'target-a',title:'Denied',content:'B content'},'denied-b-a',true,fromB));
  assert.equal((await db.query("SELECT count(*)::int AS count FROM knowledge_documents WHERE id='denied-b-a'")).rows[0].count,0);
  await assert.rejects(save({spaceId:'write-source',title:'Private',content:'private'},'denied-private',true,await readRevision('private-doc')));
  await save({spaceId:'write-source',title:'Derived',content:'first'},'derived-one',true,fromB);
  const first=await readRevision('derived-one');assert.deepEqual(first.requiredDepartmentIds,['B']);assert.equal(first.adminOnly,false);
  await save({spaceId:'write-source',title:'Derived twice',content:'second'},'derived-two',true,first);
  await assert.rejects(async()=>save({spaceId:'write-source',title:'Edited',content:'manual edit',version:1,sourceBounds:bounds()},'derived-two',false));
  await save({spaceId:'write-source',title:'Edited',content:'manual edit',version:1},'derived-two',false);
  const second=await source.readKnowledgeRevisionBounds(db,'derived-two',2);assert.equal(second.adminOnly,true);assert.deepEqual(second.requiredDepartmentIds,['B']);
  assert.ok(second.refs.some((ref:any)=>ref.id==='write-source'));assert.ok(second.refs.some((ref:any)=>ref.id==='derived-two'&&ref.version===1));
  await assert.rejects(async()=>save({spaceId:'target-a',title:'Untrusted',content:'new content',sourceBounds:fromB},'body-source',true));
  await save({spaceId:'target-a',title:'Untrusted',content:'new content'},'body-source',true);
  assert.equal((await readRevision('body-source')).adminOnly,true);assert.deepEqual((await readRevision('body-source')).requiredDepartmentIds,['A']);
  await assert.rejects(save({spaceId:'write-source',title:'Wrong hash',content:'x'},'wrong-ref',true,bounds(['B'],{refs:[{kind:'knowledge-revision',id:'write-source',version:1,sha256:sha('wrong')}]})));
});
test('candidate creation persists pinned sources and publish forwards all work references without losing restrictions',async()=>{
  const {automationLearningRouter}=await import('../apps/api/src/automation-learning.ts');
  await documentFixture('candidate-doc','B',bounds(['B']));
  const snapshot={approval:{},departmentId:'B',agents:[{id:'agent',knowledgeSpaceIds:['candidate-doc']}],knowledge:{documents:[{documentId:'candidate-doc',version:1,sha256:sha('candidate-doc'),spaceId:'candidate-doc'}],agentDocuments:{agent:['candidate-doc']}}};
  await runFixture('candidate-run',['B'],bounds(['B']),snapshot);
  let published:any;
  await httpFixture(automationLearningRouter({db,publishKnowledge:async(_input,_id,trusted)=>{published=trusted;return {id:_id,version:1};}}),async request=>{
    assert.equal((await request('/automation/knowledge-candidates',{runId:'candidate-run',documentId:'candidate-doc',sourceBounds:bounds()})).status,422);
    const created=await request('/automation/knowledge-candidates',{runId:'candidate-run',documentId:'candidate-doc'});assert.equal(created.status,201);
    const row=(await db.query('SELECT source_bounds FROM automation_knowledge_candidates WHERE id=$1',[created.body.id])).rows[0];assert.deepEqual(row.source_bounds?.requiredDepartmentIds,['B']);
    const result=await request(`/automation/knowledge-candidates/${created.body.id}/publish`,{version:1,reviewed:true});assert.equal(result.status,200);assert.deepEqual(published?.requiredDepartmentIds,['B']);assert.ok(published.refs.some((ref:any)=>ref.kind==='run'&&ref.id==='candidate-run'));
  });
  // Reuse candidates also carry runs beyond the displayed works preview; the publisher must read all references.
  await runFixture('read-run',['A','B']);await runFixture('valid-run',['B'],bounds(['B'],{private:true}));await documentFixture('read-doc','B');
  await db.query("INSERT INTO automation_knowledge_candidates(id,run_id,document_id,source_version,source_hash,space_id,title,content,reuse_evidence) VALUES('legacy-candidate','read-run','read-doc',1,$1,'read-doc','Legacy','x',$2)",[sha('read-doc'),{workReferences:[{runId:'read-run'},{runId:'valid-run'}],works:[{runId:'read-run'}]}]);
  const candidate=source.readCandidateBounds?await source.readCandidateBounds(db,'legacy-candidate'):bounds();assert.equal(candidate.private,true);assert.deepEqual(candidate.requiredDepartmentIds,['A','B']);assert.equal(candidate.adminOnly,true);
  await db.query("UPDATE automation_knowledge_candidates SET source_hash=$1 WHERE id='legacy-candidate'",[sha('tampered')]);
  await assert.rejects(source.readCandidateBounds?source.readCandidateBounds(db,'legacy-candidate'):Promise.resolve());
});
test('manual candidate editing preserves inherited provenance and adds the unknown-content admin restriction',async()=>{
  const {automationLearningRouter}=await import('../apps/api/src/automation-learning.ts');
  await runFixture('candidate-run',['B'],bounds(['B']));await documentFixture('write-source','B',bounds(['B']));
  await db.query("INSERT INTO automation_knowledge_candidates(id,run_id,document_id,source_version,source_hash,space_id,title,content,source_bounds) VALUES('edit-candidate','candidate-run','write-source',1,$1,'write-source','Before','old',$2)",[sha('write-source'),await readRevision('write-source')]);
  await httpFixture(automationLearningRouter({db}),async request=>{
    assert.equal((await request('/automation/knowledge-candidates/edit-candidate',{version:1,title:'Edited',content:'external text',sourceBounds:bounds()},'PUT')).status,422);
    const result=await request('/automation/knowledge-candidates/edit-candidate',{version:1,title:'Edited',content:'external text'},'PUT');assert.equal(result.status,200);
    const row=(await db.query("SELECT source_bounds,version FROM automation_knowledge_candidates WHERE id='edit-candidate'")).rows[0];
    assert.equal(row.source_bounds.adminOnly,true);assert.deepEqual(row.source_bounds.requiredDepartmentIds,['B']);assert.ok(row.source_bounds.refs.some((ref:any)=>ref.id==='candidate-run'));
    assert.equal((await request('/automation/knowledge-candidates/edit-candidate',{version:1,title:'Stale',content:'stale'},'PUT')).status,409);
    assert.equal((await db.query("SELECT version FROM automation_knowledge_candidates WHERE id='edit-candidate'")).rows[0].version,2);
  });
});
test('fixed file and revision hashes, source links and ancestry stay bound across two database derivations',async()=>{
  await runFixture('read-run',['A','B']);await documentFixture('write-source','B',bounds(['B']));await db.query("INSERT INTO work_file_snapshots(id,name,files,bytes) VALUES('upload','upload','[]',0)");
  const fromAB=await readRun('read-run');
  await runFixture('derived-ab-one',['A','B'],await validate(fromAB));const first=await readRun('derived-ab-one');
  await runFixture('derived-ab-two',['A','B'],await validate(first));const second=await readRun('derived-ab-two');
  assert.deepEqual(second.requiredDepartmentIds,['A','B']);assert.equal(second.adminOnly,true);assert.ok(second.refs.some((ref:any)=>ref.id==='read-run'));
  assert.throws(()=>source.assertTargetContainsSources(['A'],second,{targetAdminOnly:true}));
  const fromFile=await source.readFileBounds(db,'upload');await validate(fromFile);
  await db.query("UPDATE work_file_snapshots SET files='[{\"changed\":true}]' WHERE id='upload'");await assert.rejects(validate(fromFile));
  const fromRevision=await readRevision('write-source');await db.query("UPDATE knowledge_revisions SET content='corrupted' WHERE document_id='write-source' AND version=1");await assert.rejects(validate(fromRevision));
  await db.query("UPDATE knowledge_revisions SET content=document_id WHERE document_id='write-source' AND version=1");
  await db.query("UPDATE knowledge_revisions SET source=$1 WHERE document_id='write-source' AND version=1",[{runId:'read-run'}]);
  const linked=await readRevision('write-source');assert.deepEqual(linked.requiredDepartmentIds,['A','B']);assert.equal(linked.private,true,'mismatched stored ref and source.runId cannot be redistributed');
});
test('HTTP candidate publication reaches the real knowledge writer and persists verified source bounds',async()=>{
  const {automationLearningRouter}=await import('../apps/api/src/automation-learning.ts'),{saveKnowledgeDocument}=await import('../apps/api/src/knowledge.ts');
  await documentFixture('publish-doc','B',bounds(['B'],{adminOnly:true}));
  await runFixture('publish-run',['B'],bounds(['B']),{approval:{},departmentId:'B',agents:[{id:'agent',knowledgeSpaceIds:['publish-doc']}],knowledge:{documents:[{documentId:'publish-doc',version:1,sha256:sha('publish-doc'),spaceId:'publish-doc'}],agentDocuments:{agent:['publish-doc']}}});
  await httpFixture(automationLearningRouter({db,publishKnowledge:(input,id,sourceBounds,context)=>saveKnowledgeDocument(input,id,true,sourceBounds,context)}),async request=>{
    const created=await request('/automation/knowledge-candidates',{runId:'publish-run',documentId:'publish-doc'});assert.equal(created.status,201);
    const published=await request(`/automation/knowledge-candidates/${created.body.id}/publish`,{version:1,reviewed:true});assert.equal(published.status,200,JSON.stringify(published.body));
    const revision=(await db.query('SELECT source,source_bounds FROM knowledge_revisions WHERE document_id=$1 AND version=1',[created.body.id])).rows[0];
    assert.equal(revision.source.runId,'publish-run');assert.equal(revision.source_bounds.adminOnly,true);assert.deepEqual(revision.source_bounds.requiredDepartmentIds,['B']);
    assert.ok(revision.source_bounds.refs.some((ref:any)=>ref.kind==='run'&&ref.id==='publish-run'));assert.ok(revision.source_bounds.refs.some((ref:any)=>ref.kind==='knowledge-revision'&&ref.id==='publish-doc'&&ref.version===1&&ref.sha256===sha('publish-doc')));
    assert.equal((await source.readKnowledgeRevisionBounds(db,created.body.id,1)).private,false);
    assert.equal((await db.query('SELECT status FROM automation_knowledge_candidates WHERE id=$1',[created.body.id])).rows[0].status,'published');
  });
});
