import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {PGlite} from '@electric-sql/pglite';
import {bindTrustedAttempt,resolveTaskScope} from '../apps/api/src/task-execution.ts';
import {checkpointContract} from '../services/agent-runtime/step-checkpoints.mjs';
import {migrateProduct} from '../apps/api/src/product-schema.ts';
import {migrate,pool} from '../apps/api/src/db.ts';
import {decodeTaskAcceptedStop} from '../apps/api/src/task-accepted-stop-state.ts';

const {revision}=createRequire(import.meta.url)('../apps/desktop/local-executor.cjs');
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
const ordered=(value:any):any=>Array.isArray(value)?value.map(ordered):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,ordered(value[key])])):value;
const digest=(value:any)=>sha(JSON.stringify(ordered(value)));
const file=(path:string,text:string)=>({path,content:Buffer.from(text).toString('base64')});
const at='2026-10-20T10:00:00.000Z',dispatch='2026-10-20T10:00:01.000Z',confirmed='2026-10-20T10:00:02.000Z';

// These are synthetic SQL fences, not a claim that an employee was accepted or
// a physical sandbox stopped. No provider/model/operation success is fabricated.
function marker(key:any,state='prepared'):any{
 const proof={accepted:{seq:4,digest:sha('accepted')},checkpoint:{id:randomUUID(),sha256:sha('checkpoint'),seq:5},originalOperationId:randomUUID(),originalMergeDigest:sha('merge'),runtimeTaskId:'native-'+key.taskId,principal:'employee',sessionId:'session',contractHash:sha('contract'),permissionHash:sha('permission'),capabilityHash:sha('capability'),deviceId:randomUUID(),grantId:randomUUID(),fingerprint:sha('backend')};
 const identity={version:1,stopId:randomUUID(),key,sandboxId:randomUUID(),workspaceRevision:sha('partial work'),proofDigest:digest({kind:'task-accepted-stop-proof',version:1,proof})};
 const record:any={version:1,identity,proof,state,preparedAt:at,digest:digest({kind:'task-accepted-stop',version:1,identity,proof})};
 if(state!=='prepared')record.dispatchedAt=dispatch;
 if(state==='unknown')record.lastError={code:'LOCAL_OUTCOME_UNKNOWN',message:'stop result unknown'};
 if(state==='stopped'){record.confirmedAt=confirmed;record.result={...identity,phase:'stopped',replayed:false};}
 return record;
}

async function fixture(){
 const sql=new PGlite(),runId=randomUUID();
 await sql.exec(`CREATE TABLE project_runs(id text PRIMARY KEY,status text,lease_owner text,lease_until timestamptz,cancel_requested boolean);
 CREATE TABLE task_attempt_workspaces(run_id text,task_id text,attempt_id text,generation int,principal text,session_id text,runtime_task_id text,contract_hash text,permission_hash text,capability_hash text,contract jsonb,input_origins jsonb DEFAULT '[]',committed_outputs jsonb DEFAULT '[]',scope jsonb,work_revision text,phase text DEFAULT 'active',accepted_stop jsonb,PRIMARY KEY(run_id,task_id,attempt_id,generation));
 CREATE TABLE local_operations(id text,run_id text,status text,merge_state text,payload jsonb,result jsonb,late_result jsonb,started boolean);`);
 await sql.query("INSERT INTO project_runs VALUES($1,'running','owner',now()+interval '1 hour',false)",[runId]);
 const db={query:async(s:string,p?:any[])=>{const result=await sql.query(s,p);return {...result,rowCount:result.rows.length||result.affectedRows};}} as any;
 const tasks=['a','b','c'].map(id=>({id,assignee:'employee',inputs:[{path:'in.txt'}],outputs:[{path:id+'.txt'}],inScope:[id+'.txt'],outOfScope:[],dependencies:[]}));
 const snapshot:any={projectId:'project',planVersion:1,executionProfile:'task-attempt-openshell-v1',agents:[{id:'employee',employeeId:'original',tools:['filesystem','artifact_write']}],tasks,policy:{allowedTools:['filesystem','artifact_write']},executionTarget:{kind:'local',backend:{kind:'openshell',version:'0.1.2',image:'node@sha256:'+sha('image'),policySha256:sha('policy')}},importedFiles:[{path:'in.txt',content:'input',sha256:sha('input'),snapshotId:'snapshot',agentIds:['original']}]};
 const run:any={id:runId,project_id:'project',project_version:1,lease_owner:'owner',status:'running',cancel_requested:false,snapshot,events:[{type:'team/checkpoint',data:{members:[{id:'session',name:'employee'}],tasks:tasks.map(task=>({id:'native-'+task.id,assignee:'employee',attemptId:'attempt-'+task.id,status:'in_progress'}))}},{type:'run/task-mapping',data:{tasks:tasks.map(task=>({task_id:'native-'+task.id,seed_id:task.id}))}}]};
 const candidate=(taskId:string):any=>({runId,taskId,attemptId:'attempt-'+taskId,agentId:'employee',sessionId:'session',runtimeTaskId:'native-'+taskId,contractHash:checkpointContract(snapshot,tasks.find(task=>task.id===taskId))});
 const canonical={files:[file('in.txt','input'),file('private.txt','private')],revision:revision([file('in.txt','input'),file('private.txt','private')])};
 const put=async(record:any,key=record.identity.key)=>db.query('UPDATE task_attempt_workspaces SET accepted_stop=$1 WHERE run_id=$2 AND task_id=$3 AND attempt_id=$4 AND generation=$5',[record,key.runId,key.taskId,key.attemptId,key.generation]);
 return {sql,db,run,candidate,canonical,put,key:(assignment:any)=>({runId,taskId:assignment.taskId,attemptId:assignment.attemptId,generation:assignment.generation})};
}

for(const state of ['prepared','dispatching','unknown'])test(state+' accepted-stop fences same-binding reuse, a first-generation B and scope mutation',async()=>{
 const f=await fixture();try{
  const a=await bindTrustedAttempt(f.db,f.run,f.candidate('a'));
  const initial=await resolveTaskScope(f.db,f.run,a,f.canonical,null);
  await f.put(marker(f.key(a),state));
  await assert.rejects(()=>bindTrustedAttempt(f.db,f.run,a),{code:'TASK_ACCEPTED_STOP_UNRESOLVED'});
  await assert.rejects(()=>bindTrustedAttempt(f.db,f.run,f.candidate('b')),{code:'TASK_ACCEPTED_STOP_UNRESOLVED'});
  await assert.rejects(()=>resolveTaskScope(f.db,f.run,a,f.canonical,initial),{code:'TASK_ACCEPTED_STOP_UNRESOLVED'});
  assert.equal((await f.db.query("SELECT count(*)::int n FROM task_attempt_workspaces WHERE task_id='b'")).rows[0].n,0);
  assert.deepEqual((await f.db.query("SELECT scope FROM task_attempt_workspaces WHERE task_id='a'")).rows[0].scope,initial);
 }finally{await f.sql.close();}
});

test('confirmed stopped A stays sealed while a distinct authorized B binds and resolves normally',async()=>{
 const f=await fixture();try{
  const a=await bindTrustedAttempt(f.db,f.run,f.candidate('a'));
  await f.put(marker(f.key(a),'stopped'));
  await assert.rejects(()=>bindTrustedAttempt(f.db,f.run,a),{code:'TASK_ACCEPTED_STOP_SEALED'});
  await assert.rejects(()=>bindTrustedAttempt(f.db,f.run,f.candidate('a')),{code:'TASK_ACCEPTED_STOP_SEALED'});
  await assert.rejects(()=>resolveTaskScope(f.db,f.run,a,f.canonical,null),{code:'TASK_ACCEPTED_STOP_SEALED'});
  const b=await bindTrustedAttempt(f.db,f.run,f.candidate('b'));
  assert.equal(b.generation,1);
  assert.equal((await resolveTaskScope(f.db,f.run,b,f.canonical,null)).key.taskId,'b');
  const nextCandidate={...f.candidate('a'),attemptId:'new-attempt-a'};
  f.run.events[0].data.tasks[0].attemptId=nextCandidate.attemptId;
  const next=await bindTrustedAttempt(f.db,f.run,nextCandidate);
  assert.equal(next.generation,2);
  assert.equal((await resolveTaskScope(f.db,f.run,next,f.canonical,null)).key.attemptId,nextCandidate.attemptId);
 }finally{await f.sql.close();}
});

test('malformed or row-key-swapped SQL stop marker fails closed before B can bind',async()=>{
 const f=await fixture();try{
  const a=await bindTrustedAttempt(f.db,f.run,f.candidate('a'));
  for(const record of [{version:9},marker({...f.key(a),generation:2},'stopped'),{...marker(f.key(a),'stopped'),state:'future'}]){
   await f.put(record,f.key(a));
   await assert.rejects(()=>bindTrustedAttempt(f.db,f.run,f.candidate('b')),{code:'TASK_ACCEPTED_STOP_INVALID'});
  }
  assert.equal((await f.db.query('SELECT count(*)::int n FROM task_attempt_workspaces')).rows[0].n,1);
 }finally{await f.sql.close();}
});

test('codec authenticates every immutable field with independent proof and record domains',async()=>{
 const decode=decodeTaskAcceptedStop,key={runId:randomUUID(),taskId:'a',attemptId:'attempt-a',generation:1},record=marker(key);
 assert.deepEqual(decode(record),record);
 // Object insertion order is immaterial; nested fields must remain present.
 const reorder=(value:any):any=>Array.isArray(value)?value.map(reorder):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).reverse().map(key=>[key,reorder(value[key])])):value;
 assert.deepEqual(decode(reorder(record)),record);
 for(const change of [(r:any)=>r.proof.accepted.seq++, (r:any)=>r.identity.key.generation++, (r:any)=>r.identity.proofDigest=sha(JSON.stringify(r.proof)),(r:any)=>r.digest=digest({kind:'other',version:1,identity:r.identity,proof:r.proof})]){
  const bad=structuredClone(record);change(bad);assert.throws(()=>decode(bad),{code:'TASK_ACCEPTED_STOP_INVALID'});
 }
});

test('codec enforces exact nested keys, byte bound, UUID SHA positive sequence and safe generation',async()=>{
 const decode=decodeTaskAcceptedStop,record=marker({runId:randomUUID(),taskId:'a',attemptId:'attempt-a',generation:1});
 const cases=[(r:any)=>r.extra=true,(r:any)=>r.identity.extra=true,(r:any)=>r.identity.key.extra=true,(r:any)=>r.proof.extra=true,(r:any)=>r.proof.accepted.extra=true,(r:any)=>r.proof.checkpoint.extra=true,
  (r:any)=>r.proof.checkpoint.id='not-a-uuid',(r:any)=>r.proof.originalOperationId='not-a-uuid',(r:any)=>r.identity.sandboxId='not-a-uuid',(r:any)=>r.identity.stopId='not-a-uuid',(r:any)=>r.proof.deviceId='not-a-uuid',(r:any)=>r.proof.grantId='not-a-uuid',
  (r:any)=>r.identity.key.runId='not-a-uuid',(r:any)=>r.identity.key.taskId='a\n',(r:any)=>r.identity.key.attemptId=' ',(r:any)=>r.proof.sessionId='x'.repeat(241),(r:any)=>r.proof.fingerprint='A'.repeat(64),
  (r:any)=>r.proof.accepted.seq=0,(r:any)=>r.proof.checkpoint.seq=1.5,(r:any)=>r.identity.key.generation=Number.MAX_SAFE_INTEGER+1,(r:any)=>r.version=2,(r:any)=>r.payload='x'.repeat(32769)];
 for(const change of cases){const bad=structuredClone(record);change(bad);assert.throws(()=>decode(bad),{code:'TASK_ACCEPTED_STOP_INVALID'});}
});

test('codec requires state-specific absence and monotonic canonical ISO dates without resigning transitions',async()=>{
 const decode=decodeTaskAcceptedStop,key={runId:randomUUID(),taskId:'a',attemptId:'attempt-a',generation:1};
 for(const state of ['prepared','dispatching','unknown','stopped'])assert.equal(decode(marker(key,state)).state,state);
 const base=marker(key),transition={...base,state:'dispatching',dispatchedAt:dispatch};
 assert.equal(decode(transition).digest,base.digest);
 assert.equal(decode({...base,state:'unknown',lastError:{code:'COMMIT_UNKNOWN',message:'verify original identity'}}).digest,base.digest);
 for(const [state,field,value] of [
  ['prepared','dispatchedAt',dispatch],['prepared','confirmedAt',confirmed],['prepared','result',{}],['prepared','lastError',{}],
  ['dispatching','confirmedAt',confirmed],['dispatching','result',{}],['dispatching','lastError',{}],['unknown','confirmedAt',confirmed],['unknown','result',{}],['stopped','lastError',{code:'X',message:'x'}],
 ] as const){const bad=marker(key,state);bad[field]=value;assert.throws(()=>decode(bad),{code:'TASK_ACCEPTED_STOP_INVALID'});}
 for(const change of [(r:any)=>delete r.dispatchedAt,(r:any)=>delete r.confirmedAt,(r:any)=>delete r.result,(r:any)=>r.preparedAt='2026-10-20T18:00:00+08:00',(r:any)=>r.preparedAt='2026-02-30T10:00:00.000Z',(r:any)=>r.dispatchedAt='2026-10-20T09:59:59.000Z',(r:any)=>r.confirmedAt=at,(r:any)=>r.result.replayed=true,(r:any)=>r.result.key.taskId='other',(r:any)=>r.result.extra=true]){
  const bad=marker(key,'stopped');change(bad);assert.throws(()=>decode(bad),{code:'TASK_ACCEPTED_STOP_INVALID'});
 }
 const unknown=marker(key,'unknown');unknown.lastError.extra='not allowed';assert.throws(()=>decode(unknown),{code:'TASK_ACCEPTED_STOP_INVALID'});
});

test('canonical ISO timestamps are ordered by time across expanded-year boundaries',()=>{
 const record=marker({runId:randomUUID(),taskId:'a',attemptId:'attempt-a',generation:1},'stopped');
 record.preparedAt='9999-12-31T23:59:59.000Z';record.dispatchedAt='+010000-01-01T00:00:00.000Z';record.confirmedAt='+010000-01-01T00:00:01.000Z';
 assert.doesNotThrow(()=>decodeTaskAcceptedStop(record));
 record.confirmedAt=record.preparedAt;assert.throws(()=>decodeTaskAcceptedStop(record),{code:'TASK_ACCEPTED_STOP_INVALID'});
});

test('existing-table product migration adds a nullable marker without changing prior task history',{skip:process.env.SIMULATED_INTEGRATION!=='pglite'},async()=>{
 try{
  await migrate();
  await pool.query("INSERT INTO departments(id,data) VALUES('stop-schema-dept','{}')");
  await pool.query("INSERT INTO projects(id,department_id,department_version,department_name,requirement,policy,plan,source) VALUES('stop-schema-project','stop-schema-dept',1,'fixture','fixture',$1,'{\"agents\":[]}','fixture')",[{allowedModelIds:[],allowedTools:[],allowedKnowledgeSpaceIds:[],allowedDepartmentIds:[]}]);
  await pool.query("INSERT INTO project_runs(id,project_id,project_version,status,snapshot) VALUES('stop-schema-run','stop-schema-project',1,'stopped','{}')");
  await pool.query("INSERT INTO task_attempt_workspaces(run_id,task_id,attempt_id,generation,principal,session_id,runtime_task_id,contract_hash,permission_hash,capability_hash,contract,committed_outputs) VALUES('stop-schema-run','a','attempt-a',1,'employee','session','native-a',$1,$1,$1,'{}','[{\"historical\":true}]')",[sha('history')]);
  await pool.query('ALTER TABLE task_attempt_workspaces DROP COLUMN IF EXISTS accepted_stop');
  const before=(await pool.query('SELECT * FROM task_attempt_workspaces')).rows[0];
  await migrateProduct(pool);
  const after=(await pool.query('SELECT * FROM task_attempt_workspaces')).rows[0];
  assert.equal(after.accepted_stop,null);delete after.accepted_stop;assert.deepEqual(after,before);
  const column=(await pool.query("SELECT is_nullable,data_type FROM information_schema.columns WHERE table_name='task_attempt_workspaces' AND column_name='accepted_stop'")).rows[0];
  assert.deepEqual(column,{is_nullable:'YES',data_type:'jsonb'});
 }finally{await pool.end();}
});
