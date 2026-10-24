import {after,before,beforeEach,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {join,resolve,sep} from 'node:path';
import {once} from 'node:events';
import type pg from 'pg';
import type {Principal} from '../apps/api/src/identity-types.ts';
import express from 'express';
import {toolEvidence} from './model-fixture.ts';
import {createRunArchive} from '../services/agent-runtime/trace-store.mjs';
import {inspectArtifact} from '../services/agent-runtime/handoff.mjs';

assert.equal(process.env.SIMULATED_INTEGRATION,'pglite');
assert.ok(['127.0.0.1','localhost','[::1]'].includes(new URL(process.env.DATABASE_URL!).hostname));
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222';
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
const policy={maxBudget:1,maxAgents:2,maxConcurrentAgents:2,deadlineSeconds:300};
const employee=(id='manager')=>({id,name:id,role:'manager',title:'负责人',instructions:'核验并交付文件',modelId:'model',tools:['filesystem','artifact_write','knowledge_search'],knowledgeSpaceIds:[]});
const principal=(userId:string):Principal=>({kind:'human',userId,sessionId:userId+'-session',issuer:'https://fixture.example',subject:userId,orgRole:userId==='admin'?'admin':'member',sessionEpoch:0,authenticatedAt:new Date().toISOString()});
let db:pg.Pool,app:any,server:any,url:string,temporary:string,traceRoot:string;
async function call(path:string,actor='operator',method='GET',body?:unknown,key?:string){
 const response=await fetch(url+path,{method,headers:{'content-type':'application/json','x-fixture-actor':actor,...(key?{'idempotency-key':key}:{})},body:body===undefined?undefined:JSON.stringify(body)});
 const text=await response.text();let data:any;try{data=JSON.parse(text);}catch{data=text;}return {status:response.status,data};
}
async function grant(user:string,departmentId:string,role='operator',approve=true){await db.query('INSERT INTO department_memberships(user_id,department_id,role,can_approve) VALUES($1,$2,$3,$4) ON CONFLICT(user_id,department_id) DO UPDATE SET role=$3,can_approve=$4',[user,departmentId,role,approve]);}
async function project(departments=[A]){
 const id=randomUUID(),agents=departments.map((departmentId,index)=>({...employee(index?'collaborator':'manager'),role:index?'member':'manager',sourceDepartmentId:departmentId,sourceAgentId:'manager'}));
 const plan={agents,rationale:'合成文件接线',tasks:[{id:'deliver',subject:'核对文件并交付',objective:'完成文件核对',assigneeId:'manager',dependencies:[],acceptanceCriteria:['核对文件内容与来源'],estimatedInputTokens:100,estimatedOutputTokens:100}]};
 const {bindPolicy}=await import('../apps/api/src/execution-policy.ts'),bound=bindPolicy({...policy,allowedDepartmentIds:departments},agents as any,departments[0]);
 await db.query("INSERT INTO projects(id,department_id,department_version,department_name,requirement,policy,plan,source) VALUES($1,$2,1,'Fixture','核对已授权资料并形成合成结果',$3,$4,'manual')",[id,departments[0],bound,plan]);
 await db.query('INSERT INTO plan_versions(project_id,version,plan,policy) VALUES($1,1,$2,$3)',[id,plan,bound]);return {id,plan};
}
async function sealed(departments=[A],existing?:{id:string;snapshot:any},content='SOURCE_FILE_CONTENT'){
 const target=existing?null:await project(departments),id=existing?.id??randomUUID();
 const snapshot=existing?.snapshot??{mode:'product',projectId:target!.id,planVersion:1,title:'Synthetic file fixture',agents:[],tasks:[{id:'deliver',kind:'implementation',dependencies:[],inputs:[],outputs:[{path:'report.txt'}],inScope:['report.txt'],verify:['node --check report.txt']}]};
 if(!existing)await db.query("INSERT INTO project_runs(id,project_id,project_version,status,snapshot,department_ids,authority_kind,source_bounds) VALUES($1,$2,1,'completed',$3,$4,'human',$5)",[id,target!.id,snapshot,departments,{requiredDepartmentIds:departments,adminOnly:false,private:false,refs:[]}]);
 else await db.query("UPDATE project_runs SET status='completed' WHERE id=$1",[id]);
 const archive=createRunArchive(traceRoot,snapshot,{id}),directory=join(traceRoot,id,'artifacts');mkdirSync(directory,{recursive:true});writeFileSync(join(directory,'report.txt'),content);
 const outputs=(snapshot.tasks[0].outputs??[]).length?snapshot.tasks[0].outputs.map((file:any)=>inspectArtifact(directory,file)):[];
 archive.append('run/task-mapping',{tasks:[{task_id:'t1',seed_id:'deliver'}]});archive.append('handoff/accepted',{runId:id,taskId:'deliver',attemptId:'a',inputs:[],outputs,commands:[]});archive.append('team/checkpoint',{tasks:[{id:'t1',status:'completed',attemptId:'a'}]});archive.append('run/finished',{status:'completed'});
 return {id,snapshot,directory};
}
async function sourceFile(departments=[B]){const run=await sealed(departments);const result=await call('/work-files/from-run','admin','POST',{runId:run.id,paths:['report.txt']});assert.equal(result.status,201,JSON.stringify(result.data));return {...run,fileId:result.data.id};}
before(async()=>{
 temporary=await mkdtemp(resolve('.superpowers/sdd/2026-10-23-enterprise-plugin-completion/file-fixture-'));traceRoot=join(temporary,'runs');process.env.DATA_DIR=temporary;process.env.TRACE_ROOT=traceRoot;process.env.OBSIDIAN_VAULT=join(temporary,'vault');process.env.WEIWU_AUTH_MODE='legacy-local';
 const database=await import('../apps/api/src/db.ts');db=database.pool;await database.migrate();
 const {createApp}=await import('../apps/api/src/app.ts'),{apiAccess}=await import('../apps/api/src/api-access.ts'),{idempotency}=await import('../apps/api/src/idempotency.ts');
 app=createApp({assertExecutorReady:async()=>{}});await app.locals.shutdownBackground();await app.locals.ready;
 const index=app.router.stack.findIndex((layer:any)=>layer.handle===idempotency);assert.ok(index>0);app.router.stack[index-1].handle=apiAccess({authenticate:async(req:any)=>principal(req.get('x-fixture-actor')??'operator'),csrf:(_req:any,_res:any,next:any)=>next()} as any,{mode:'legacy-local'});
 server=app.listen(0,'127.0.0.1');await once(server,'listening');url=`http://127.0.0.1:${server.address().port}/api`;
});
after(async()=>{await app?.locals.shutdown();server?.closeAllConnections();if(server)await new Promise<void>(r=>server.close(()=>r()));await db?.end();if(temporary){assert.ok(temporary.startsWith(resolve('.superpowers/sdd/2026-10-23-enterprise-plugin-completion')+sep+'file-fixture-'));await rm(temporary,{recursive:true,force:true});}});
beforeEach(async()=>{
 await db.query('TRUNCATE departments,human_users,models,gateways,request_keys,knowledge_spaces,work_file_snapshots CASCADE');
 await db.query("INSERT INTO gateways(id,data) VALUES('gateway',$1)",[{name:'No-network fixture',baseUrl:'http://127.0.0.1:1/v1'}]);await db.query("INSERT INTO models(id,data,status,capabilities) VALUES('model',$1,'available',$2)",[{name:'Fixture',gatewayId:'gateway',model:'fixture',inputRate:1,outputRate:1},toolEvidence]);
 for(const id of [A,B])await db.query('INSERT INTO departments(id,data) VALUES($1,$2)',[id,{name:id,description:'Synthetic',dailyBudget:5,agents:[employee()]}]);
 for(const user of ['operator','viewer','admin'])await db.query("INSERT INTO human_users(id,issuer,subject,status,org_role) VALUES($1,'https://fixture.example',$1,'active',$2)",[user,user==='admin'?'admin':'member']);
 await grant('operator',A);await grant('viewer',A,'viewer',false);
});

test('member file list filters before pagination and current scope guards detail/download and cached from-run',async()=>{
 const own=await sourceFile([A]),foreign=await sourceFile([A,B]);
 const list=await call('/work-files?limit=1','viewer');assert.equal(list.status,200,JSON.stringify(list.data));assert.deepEqual(list.data.map((row:any)=>row.id),[own.fileId]);
 assert.equal((await call(`/work-files/${own.fileId}`,'viewer')).status,200);assert.equal((await call(`/work-files/${own.fileId}/files/0/download`,'viewer')).data,'SOURCE_FILE_CONTENT');
 for(const path of [`/work-files/${foreign.fileId}`,`/work-files/${foreign.fileId}/files/0/download`])assert.equal((await call(path,'viewer')).status,404);
 await grant('operator',B);const body={runId:foreign.id,paths:['report.txt']};assert.equal((await call('/work-files/from-run','operator','POST',body,'reuse-key')).status,200);
 await db.query('DELETE FROM department_memberships WHERE user_id=$1 AND department_id=$2',['operator',B]);assert.equal((await call('/work-files/from-run','operator','POST',body,'reuse-key')).status,404);
 assert.equal((await call('/work-files','operator','POST',{name:'unbound',files:[]})).status,403);assert.equal((await call('/work-files/generate','operator','POST',{format:'csv',name:'unbound'})).status,403);
});

test('B to A selection fails before loading or verifying file bodies even for an administrator copy',async()=>{
 const source=await sourceFile([B]);await grant('operator',B,'viewer',false);
 const {selectedWorkFileInputs,selectedWorkFileCopies}=await import('../apps/api/src/work-files.ts');let bodyReads=0;
 const guard={query:async(sql:string,args?:any[])=>{if(sql.startsWith('SELECT id,name,files,')){bodyReads++;throw Error('FILE_BODY_READ_BEFORE_AUTHORIZATION');}return db.query(sql,args);}};
 const selections=[{snapshotId:source.fileId,paths:['report.txt'],agentIds:['manager'],mode:'workspace' as const}];
 for(const actor of ['operator','admin'])for(const select of [selectedWorkFileInputs,selectedWorkFileCopies])await assert.rejects((select as any)(selections,guard,{principal:principal(actor),targetDepartmentIds:[A],targetAdminOnly:actor==='admin'}),(error:any)=>error.status===422&&error.code==='SOURCE_BOUNDS_INVALID');
 assert.equal(bodyReads,0);
 const target=await project();assert.equal((await call(`/projects/${target.id}/plan`,'operator','PUT',{version:1,plan:{...target.plan,workFileSelections:selections}})).status,422);
 assert.equal((await db.query('SELECT version FROM projects WHERE id=$1',[target.id])).rows[0].version,1);
});

test('authorized AB file reuse survives approval input chunks workspace copy and a second sealed derivation',async()=>{
 const source=await sourceFile([B]);await grant('operator',B);const target=await project([A,B]);
 const plan={...target.plan,workFileSelections:[{snapshotId:source.fileId,paths:['report.txt'],agentIds:['manager','collaborator'],mode:'workspace'}],tasks:target.plan.tasks.map(task=>({...task,outputs:[{path:'report.txt'}]}))};
 const saved=await call(`/projects/${target.id}/plan`,'operator','PUT',{version:1,plan});assert.equal(saved.status,200,JSON.stringify(saved.data));
 const approved=await call(`/projects/${target.id}/approve`,'operator','POST',{version:2});assert.equal(approved.status,202,JSON.stringify(approved.data));
 const row=(await db.query('SELECT * FROM project_runs WHERE id=$1',[approved.data.id])).rows[0];assert.deepEqual(row.source_bounds.requiredDepartmentIds,[A,B]);
 assert.ok(row.snapshot.knowledge.runInputs[0].sourceBounds.requiredDepartmentIds.includes(B));assert.equal(row.snapshot.knowledge.runInputs[0].sourceFile.snapshotId,source.fileId);
 assert.ok(row.snapshot.importedFiles[0].sourceBounds.requiredDepartmentIds.includes(B));assert.equal(row.snapshot.importedFiles[0].sha256,sha('SOURCE_FILE_CONTENT'));
 const {prepareImportedWorkspace}=await import('../apps/api/src/work-files.ts');prepareImportedWorkspace(traceRoot,row.id,row.snapshot.importedFiles);assert.equal(readFileSync(join(traceRoot,row.id,'artifacts','report.txt'),'utf8'),'SOURCE_FILE_CONTENT');
 const derived=await sealed([A,B],{id:row.id,snapshot:row.snapshot});const copied=await call('/work-files/from-run','operator','POST',{runId:derived.id,paths:['report.txt']});assert.equal(copied.status,201,JSON.stringify(copied.data));
 const {readFileBounds}=await import('../apps/api/src/source-bounds.ts'),bounds=await readFileBounds(db,copied.data.id);assert.deepEqual(bounds.requiredDepartmentIds,[A,B]);assert.ok(bounds.refs.some(ref=>ref.kind==='file'&&ref.id===source.fileId));
 assert.equal((await call(`/work-files/${copied.data.id}/files/0/download`,'viewer')).status,404);assert.equal((await call(`/work-files/${copied.data.id}/files/0/download`)).status,200);
 await db.query("UPDATE work_file_snapshots SET source_bounds=jsonb_set(source_bounds,'{private}','true') WHERE id=$1",[source.fileId]);
 assert.equal((await call(`/work-files/${copied.data.id}/files/0/download`)).status,404,'a restriction on an ancestor survives two derivations');
});

test('unknown private admin-only and broken file refs remain concealed without opening knowledge sources',async()=>{
 const source=await sourceFile([A]);const original=(await db.query('SELECT source_bounds FROM work_file_snapshots WHERE id=$1',[source.fileId])).rows[0].source_bounds;
 for(const bounds of [null,{...original,private:true},{...original,adminOnly:true},{...original,unexpected:'not in source schema'},{...original,refs:original.refs.map((ref:any)=>({...ref,version:99}))},{...original,refs:original.refs.map((ref:any)=>({...ref,sha256:'0'.repeat(64)}))},{...original,refs:[...original.refs,{kind:'knowledge-revision',id:'unknown',version:1,sha256:'0'.repeat(64)}]}]){
  await db.query('UPDATE work_file_snapshots SET source_bounds=$1 WHERE id=$2',[bounds,source.fileId]);assert.equal((await call(`/work-files/${source.fileId}`)).status,404);assert.deepEqual((await call('/work-files')).data,[]);assert.equal((await call(`/work-files/${source.fileId}`,'admin')).status,200);
 }
 await db.query('UPDATE work_file_snapshots SET source_bounds=$1,source_run_id=NULL WHERE id=$2',[original,source.fileId]);assert.equal((await call(`/work-files/${source.fileId}`)).status,404);
});

async function ancestorGraph(edges:number[][]){
 const root=await sourceFile([A]),runs=[root,await sealed([A]),await sealed([A]),await sealed([A])];
 const refs=await Promise.all(runs.map(async run=>({kind:'run',id:run.id,version:1,sha256:(await db.query("SELECT encode(sha256(convert_to(snapshot::text,'UTF8')),'hex') AS hash FROM project_runs WHERE id=$1",[run.id])).rows[0].hash})));
 const bounds=(indices:number[])=>({requiredDepartmentIds:[A],adminOnly:false,private:false,refs:indices.map(index=>refs[index])});
 for(let index=0;index<runs.length;index++)await db.query('UPDATE project_runs SET source_bounds=$1 WHERE id=$2',[bounds(edges[index]),runs[index].id]);
 await db.query('UPDATE work_file_snapshots SET source_bounds=$1 WHERE id=$2',[bounds([0,1,2,3]),root.fileId]);
 return {root,runs};
}

test('a complete root manifest cannot conceal a cyclic pair inside its fixed source ancestors',async()=>{
 const {root}=await ancestorGraph([[1,2,3],[2],[1],[]]);
 const {readFileBounds}=await import('../apps/api/src/source-bounds.ts');assert.equal((await readFileBounds(db,root.fileId)).private,true);
 assert.equal((await call(`/work-files/${root.fileId}/files/0/download`,'viewer')).status,404);
 assert.deepEqual((await call('/work-files?limit=1','viewer')).data,[]);
});

test('each ancestor must carry its own complete fixed source closure even when the root lists every node',async()=>{
 // A -> B -> leaf, but A omits leaf from its persisted transitive closure.
 const {root}=await ancestorGraph([[1,2,3],[2],[3],[]]);
 assert.equal((await call(`/work-files/${root.fileId}/files/0/download`,'viewer')).status,404);
 assert.deepEqual((await call('/work-files?limit=1','viewer')).data,[]);
});

test('a valid diamond source closure permits member download and a missing fixed ancestor conceals it',async()=>{
 const {root,runs}=await ancestorGraph([[1,2,3],[3],[3],[]]);
 const {readFileBounds}=await import('../apps/api/src/source-bounds.ts');assert.equal((await readFileBounds(db,root.fileId)).private,false);
 assert.equal((await call(`/work-files/${root.fileId}/files/0/download`,'viewer')).data,'SOURCE_FILE_CONTENT');
 assert.deepEqual((await call('/work-files?limit=1','viewer')).data.map((file:any)=>file.id),[root.fileId]);
 await db.query('DELETE FROM project_runs WHERE id=$1',[runs[3].id]);
 assert.equal((await call(`/work-files/${root.fileId}/files/0/download`,'viewer')).status,404);
 assert.deepEqual((await call('/work-files?limit=1','viewer')).data,[]);
});

test('from-run creation records the real actor and rolls the snapshot back when its audit write fails',async()=>{
 const source=await sealed([A]),body={runId:source.id,paths:['report.txt']},connect=db.connect;
 (db as any).connect=function(callback?:unknown){if(callback)return (connect as any).call(db,callback);return (async()=>{const client=await (connect as ()=>Promise<pg.PoolClient>).call(db),query=client.query,release=client.release;
  client.query=function(...args:any[]){if(/INSERT INTO human_audit_events/.test(String(args[0])))return Promise.reject(Error('injected file audit failure'));return (query as any).apply(client,args);} as any;
  client.release=function(...args:any[]){client.query=query;client.release=release;return (release as any).apply(client,args);};return client;})();};
 try{assert.equal((await call('/work-files/from-run','operator','POST',body)).status,500);}finally{db.connect=connect;}
 assert.equal((await db.query('SELECT count(*)::int AS count FROM work_file_snapshots')).rows[0].count,0);
 const created=await call('/work-files/from-run','operator','POST',body);assert.equal(created.status,201,JSON.stringify(created.data));
 const event=(await db.query("SELECT actor_user_id,action,changes,resource_id FROM human_audit_events WHERE action='file.create'")).rows[0];assert.equal(event.actor_user_id,'operator');assert.equal(event.resource_id,created.data.id);assert.equal(event.changes.sourceRunId,source.id);assert.equal(event.changes.snapshotId,created.data.id);
});

// Inject transport faults around real SQL so COMMIT still commits both records.
// A dedicated test host exposes the original error object without changing app errors.
async function transactionFault(mode:'commit-reply'|'rollback-reply',path:string,body:unknown){
 const {workFilesRouter}=await import('../apps/api/src/work-files.ts');
 const first=Error('first transaction failure'),second=Error('rollback reply lost');let received:unknown,discarded:unknown;
 const adapter={query:db.query.bind(db),connect:async()=>{
  const client=await db.connect(),query=client.query.bind(client);
  return new Proxy(client,{get(target,key){
   if(key==='query')return async(sql:string,args?:unknown[])=>{
    if(mode==='rollback-reply'&&sql.includes('INSERT INTO human_audit_events'))throw first;
    const result=await query(sql,args);
    if(mode==='commit-reply'&&sql==='COMMIT')throw first;
    if(mode==='rollback-reply'&&sql==='ROLLBACK')throw second;
    return result;
   };
   if(key==='release')return (destroy?:boolean|Error)=>{discarded=destroy;client.release(destroy);};
   return Reflect.get(target,key);
  }});
 }};
 const host=express();host.use(express.json());host.use((_req,res,next)=>{res.locals.principal=principal('admin');next();});host.use('/api',workFilesRouter(adapter,traceRoot));
 host.use((error:unknown,_req:express.Request,res:express.Response,_next:express.NextFunction)=>{received=error;res.status(503).json({failed:true});});
 const listener=host.listen(0,'127.0.0.1');await once(listener,'listening');
 try{const response=await fetch(`http://127.0.0.1:${(listener.address() as import('node:net').AddressInfo).port}/api${path}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});assert.equal(response.status,503);await response.json();}
 finally{listener.closeAllConnections();await new Promise<void>(done=>listener.close(()=>done()));}
 return {first,received,discarded};
}

test('file transaction commit reply loss discards its connection and keeps snapshot and audit committed together',async()=>{
 for(const fromRun of [false,true]){
  const source=fromRun?await sealed([A]):undefined;
  const before=(await db.query('SELECT count(*)::int AS count FROM work_file_snapshots')).rows[0].count;
  const fault=await transactionFault('commit-reply',fromRun?'/work-files/from-run':'/work-files',fromRun?{runId:source!.id,paths:['report.txt']}:{name:'Synthetic upload',files:[{path:'report.txt',base64:Buffer.from('UPLOAD').toString('base64')}]});
  assert.equal(fault.received,fault.first);assert.equal(fault.discarded,true);
  assert.equal((await db.query('SELECT count(*)::int AS count FROM work_file_snapshots')).rows[0].count,before+1);
  assert.equal((await db.query("SELECT count(*)::int AS count FROM work_file_snapshots file JOIN human_audit_events audit ON audit.resource_id=file.id AND audit.action='file.create'")).rows[0].count,before+1);
 }
});

test('file transaction rollback reply failure preserves the first error and discards its connection without partial records',async()=>{
 for(const fromRun of [false,true]){
  const source=fromRun?await sealed([A]):undefined;
  const fault=await transactionFault('rollback-reply',fromRun?'/work-files/from-run':'/work-files',fromRun?{runId:source!.id,paths:['report.txt']}:{name:'Synthetic upload',files:[{path:'report.txt',base64:Buffer.from('UPLOAD').toString('base64')}]});
  assert.equal(fault.received,fault.first);assert.equal(fault.discarded,true);
  assert.equal((await db.query('SELECT count(*)::int AS count FROM work_file_snapshots')).rows[0].count,0);
  assert.equal((await db.query("SELECT count(*)::int AS count FROM human_audit_events WHERE action='file.create'")).rows[0].count,0);
 }
});

test('artifact export and lineage deny foreign and trace-only runs before reading archives, with legal member downloads',async()=>{
 const own=await sealed([A]),foreign=await sealed([A,B]);
 for(const suffix of ['artifacts','artifact?path=report.txt','export','lineage-evidence']){const result=await call(`/runs/${own.id}/${suffix}`,'viewer');assert.equal(result.status,200,JSON.stringify({suffix,result}));}
 const snapshotFile=join(traceRoot,foreign.id,'snapshot.json'),original=readFileSync(snapshotFile);writeFileSync(snapshotFile,'INVALID_JSON_MUST_NOT_BE_READ');
 try{for(const suffix of ['artifacts','artifact?path=report.txt','export','lineage-evidence'])assert.equal((await call(`/runs/${foreign.id}/${suffix}`,'viewer')).status,404);}finally{writeFileSync(snapshotFile,original);}
 await grant('viewer',B,'viewer',false);assert.equal((await call(`/runs/${foreign.id}/artifact?path=report.txt`,'viewer')).data,'SOURCE_FILE_CONTENT');
 await db.query('DELETE FROM project_runs WHERE id=$1',[foreign.id]);assert.equal((await call(`/runs/${foreign.id}/export`,'viewer')).status,404);
});
