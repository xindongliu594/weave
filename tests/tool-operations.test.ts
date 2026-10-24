import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {pool,migrate} from '../apps/api/src/db.ts';
import {createArchiveWriterManager} from '../services/agent-runtime/archive-writer-scope.mjs';
import {ToolEffectContractService,migrateToolEffectContracts} from '../apps/api/src/tool-effect-contracts.ts';
import {effectDigest} from '../services/agent-runtime/tool-effects.mjs';
import type {EffectContract} from '../packages/contracts/tool-effects.ts';
import {identityPostgresUrl} from './fixtures/identity/postgres.ts';
import {migrateIdentity} from '../apps/api/src/identity-schema.ts';

const path='../apps/api/src/tool-operations.ts';
const implementation=await import(path).catch(error=>{if(error.code==='ERR_MODULE_NOT_FOUND')return {};throw error;});
const sha='a'.repeat(64);
const nativeUrl=process.env.TOOL_OPERATIONS_POSTGRES_URL;
if(nativeUrl){identityPostgresUrl(nativeUrl);assert.equal(process.env.DATABASE_URL,nativeUrl);}
async function nativeFixture(){
 // The cached PostgreSQL has no pgvector. Reuse the exact original SQL for the
 // tables this service exercises; this is a narrow lock test, not full migrate.
 const dbSource=readFileSync(new URL('../apps/api/src/db.ts',import.meta.url),'utf8');
 const base=dbSource.match(/await pool\.query\(`([\s\S]*?)`\);/);assert.ok(base);await pool.query(base[1]);await migrateIdentity(pool);
 const product=readFileSync(new URL('../apps/api/src/product-schema.ts',import.meta.url),'utf8');
 for(const table of ['tool_approvals','local_devices','local_operations']){
  const ddl=product.match(new RegExp('CREATE TABLE IF NOT EXISTS '+table+' \\([\\s\\S]*?\\);'));assert.ok(ddl);await pool.query(ddl[0]);
 }
 const alterations=product.match(/ALTER TABLE (?:project_runs|local_operations) ADD COLUMN IF NOT EXISTS (?:lease_owner|lease_until|cancel_requested|merge_state|merge_record|merge_rejection)[^;]*;/g);assert.equal(alterations?.length,6);for(const ddl of alterations!)await pool.query(ddl);
}
const contract:EffectContract={schema:1,capabilityId:'team.status',namespace:'weiwu',toolName:'agent_teams_status',source:{kind:'builtin',reference:'fixture:release',version:'1',digest:sha},definitionSha256:sha,effect:'workspace',isolationProfile:'runtime-v1',permissions:['team:status'],retry:'never',cost:{kind:'free'},reconciliation:{kind:'receipt'},compensation:{kind:'none',requiresApproval:true},evidenceRefs:['fixture:review']};

test('runtime operations use the original table with immutable intents, one dispatch and append-only evidence',async t=>{
 assert.equal(typeof implementation.ToolOperationService,'function','runtime operation service must exist');
 if(!nativeUrl)assert.equal(process.env.SIMULATED_INTEGRATION,'pglite');
 const root=mkdtempSync(join(tmpdir(),'tool-operations-'));process.env.DATA_DIR=root;process.env.TRACE_ROOT=root;process.env.OBSIDIAN_VAULT=join(root,'vault');
 t.after(async()=>{await pool.end();console.log('TOOL_OPERATIONS_OWNED_ROOT='+JSON.stringify({root,pid:process.pid}));});
 if(nativeUrl)await nativeFixture();else await migrate();await migrateToolEffectContracts(pool);await implementation.migrateToolOperations(pool);await implementation.migrateToolOperations(pool);
 const writers=createArchiveWriterManager({traceRoot:root}),owner=randomUUID(),department=randomUUID();
 const actor={kind:'human' as const,userId:randomUUID(),sessionId:'session',issuer:'https://fixture.invalid',subject:'admin',orgRole:'admin' as const,sessionEpoch:0,authenticatedAt:new Date().toISOString()};
 await pool.query("INSERT INTO human_users(id,issuer,subject,status,org_role) VALUES($1,$2,$3,'active','admin')",[actor.userId,actor.issuer,actor.subject]);
 await pool.query('INSERT INTO departments(id,data) VALUES($1,$2)',[department,{name:'fixture',agents:[]}]);
 const contracts=new ToolEffectContractService({db:pool,resolveBinding:async()=>contract});
 await contracts.review({namespace:contract.namespace,toolName:contract.toolName},effectDigest(contract),actor);
 const service=new implementation.ToolOperationService({db:pool,writers,contracts});
 const makeRun=async()=>{const project=randomUUID(),runId=randomUUID(),agent={id:'employee',employeeId:'employee',name:'fixture',role:'manager',modelId:'unused',tools:[]};const policy={maxBudget:1,maxAgents:1,maxConcurrentAgents:1,maxModelCalls:1,maxTaskModelCalls:1,deadlineSeconds:180};
  await pool.query("INSERT INTO projects(id,department_id,department_version,department_name,requirement,policy,plan,source) VALUES($1,$2,1,'fixture','fixture',$3,$4,'manual')",[project,department,policy,{agents:[agent],tasks:[]}]);
  const snapshot={projectId:project,planVersion:1,departmentId:department,executionProfile:'legacy-run-v1',agents:[agent],tasks:[],policy,effectContractVersion:1,effectContracts:[contract]};
  await pool.query("INSERT INTO project_runs(id,project_id,project_version,status,snapshot,lease_owner,lease_until) VALUES($1,$2,1,'running',$3,$4,now()+interval '1 hour')",[runId,project,snapshot,owner]);return {runId,ops:service.forRun(runId,owner)};};
 const prepareInput=()=>({contract,agentId:'employee',sessionId:'session',callId:randomUUID(),argumentsSha256:effectDigest({})});
 const evidence=(operation:any,outcome='confirmed')=>({evidenceId:randomUUID(),outcome,receiptSha256:effectDigest({result:'done'}),reasonCode:'RUNTIME_BODY_RETURNED'});
 await t.test('same call reuses its prepared identity and changed arguments cannot create a second operation',async()=>{
  const {runId,ops}=await makeRun(),input=prepareInput(),first=await ops.prepare(input);assert.deepEqual(await ops.prepare(input),first);
  await assert.rejects(ops.prepare({...input,argumentsSha256:effectDigest({changed:true})}),/TOOL_OPERATION_IDENTITY_CONFLICT/);
  assert.equal((await pool.query('SELECT count(*)::int n FROM local_operations WHERE run_id=$1',[runId])).rows[0].n,1);
  const row=(await pool.query('SELECT * FROM local_operations WHERE id=$1',[first.operationId])).rows[0];assert.equal(row.executor_kind,'runtime');assert.equal(row.device_id,null);assert.equal(row.status,'prepared');assert.equal(row.merge_state,null);
  await assert.rejects(pool.query("UPDATE local_operations SET effect_intent='{}' WHERE id=$1",[first.operationId]),/immutable/i);
 });
 await t.test('dispatch CAS is one-shot and only an original receipt resolves it',async()=>{
  const {runId,ops}=await makeRun(),prepared=await ops.prepare(prepareInput());
  const fence=await ops.dispatch({operationId:prepared.operationId,expectedVersion:prepared.version,intentSha256:prepared.intentSha256});assert.equal(fence.version,2);
  await assert.rejects(ops.abortPrepared({operationId:prepared.operationId,expectedVersion:prepared.version,intentSha256:prepared.intentSha256}),/TOOL_OPERATION_ABORT_CONFLICT/);
  await assert.rejects(ops.dispatch({operationId:prepared.operationId,expectedVersion:prepared.version,intentSha256:prepared.intentSha256}),/TOOL_OPERATION_DISPATCH_CONFLICT/);
  await assert.rejects(service.requireResolvedEffectsIn(pool,[runId]),{code:'TOOL_OPERATION_UNRESOLVED'});
  const item=evidence(prepared),receipt=await ops.recordEvidence({operationId:prepared.operationId,intentSha256:prepared.intentSha256,evidence:item});assert.equal(receipt.state,'confirmed');
  assert.deepEqual(await ops.recordEvidence({operationId:prepared.operationId,intentSha256:prepared.intentSha256,evidence:item}),receipt);
  await assert.rejects(ops.recordEvidence({operationId:prepared.operationId,intentSha256:prepared.intentSha256,evidence:{...item,receiptSha256:'b'.repeat(64)}}),/TOOL_OPERATION_EVIDENCE_CONFLICT/);
  await service.requireResolvedEffectsIn(pool,[runId]);
 });
 await t.test('unknown stays on the same row and accepts original late evidence after lease loss',async()=>{
  const {runId,ops}=await makeRun(),prepared=await ops.prepare(prepareInput());await ops.dispatch({operationId:prepared.operationId,expectedVersion:1,intentSha256:prepared.intentSha256});
  await ops.markUnknown({operationId:prepared.operationId,intentSha256:prepared.intentSha256,reasonCode:'RUNTIME_CANCELLED'});
  await pool.query("UPDATE project_runs SET lease_owner='other',cancel_requested=true WHERE id=$1",[runId]);
  const receipt=await ops.recordEvidence({operationId:prepared.operationId,intentSha256:prepared.intentSha256,evidence:evidence(prepared)});assert.equal(receipt.state,'confirmed');
  assert.equal((await pool.query('SELECT jsonb_array_length(evidence_records)::int n FROM local_operations WHERE id=$1',[prepared.operationId])).rows[0].n,2);
  await assert.rejects(ops.prepare(prepareInput()),/TOOL_OPERATION_RUN_DENIED/);
 });
 await t.test('SQL refuses null state',async()=>{
  const {ops}=await makeRun(),operation=await ops.prepare(prepareInput());
  await assert.rejects(pool.query('UPDATE local_operations SET effect_state=NULL,effect_version=effect_version+1 WHERE id=$1',[operation.operationId]));
 });
 await t.test('SQL refuses redispatch of an unknown operation',async()=>{
  const {ops}=await makeRun(),operation=await ops.prepare(prepareInput());
  await ops.dispatch({operationId:operation.operationId,expectedVersion:1,intentSha256:operation.intentSha256});
  await ops.markUnknown({operationId:operation.operationId,intentSha256:operation.intentSha256,reasonCode:'TOOL_RUNTIME_CANCELLED'});
  await assert.rejects(pool.query("UPDATE local_operations SET effect_state='dispatched',effect_version=effect_version+1,status='dispatched' WHERE id=$1",[operation.operationId]));
 });
 await t.test('unresolved child is not cleared by a confirmed parent',async()=>{
  const {runId,ops}=await makeRun(),input=prepareInput(),parent=await ops.prepare(input);
  await ops.dispatch({operationId:parent.operationId,expectedVersion:1,intentSha256:parent.intentSha256});
  const child=await ops.prepare({...prepareInput(),parentOperationId:parent.operationId});
  await ops.recordEvidence({operationId:parent.operationId,intentSha256:parent.intentSha256,evidence:evidence(parent)});
  await assert.rejects(service.requireResolvedEffectsIn(pool,[runId]),{code:'TOOL_OPERATION_UNRESOLVED'});
  await assert.rejects(ops.prepare({...prepareInput(),parentOperationId:parent.operationId}),/TOOL_OPERATION_PARENT_INVALID/);
  assert.equal((await pool.query('SELECT effect_intent FROM local_operations WHERE id=$1',[child.operationId])).rows[0].effect_intent.rootCallId,input.callId);
 });
 await t.test('transaction uncertainty preserves first failure, discards connection and retains committed intent',async t=>{
  for(const mode of ['begin','rollback','commit'] as const)await t.test(mode,async()=>{
   const {runId}=await makeRun(),original=Error(mode+' reply lost'),releases:boolean[]=[];let sourceError=false;
   const faultContracts=new ToolEffectContractService({db:pool,resolveBinding:async()=>{if(sourceError)throw original;return contract;}});
   const db={async connect(){const client=await pool.connect();return {async query(sql:string,values?:unknown[]){
    if(sql==='BEGIN'&&mode==='begin')throw original;
    if(sql==='ROLLBACK'&&mode==='rollback')throw Error('cleanup reply lost');
    const value=await client.query(sql,values);if(sql==='COMMIT'&&mode==='commit')throw original;return value;
   },release(discard:boolean){releases.push(discard);client.release(discard);}};}};
   sourceError=mode==='rollback';const faulty=new implementation.ToolOperationService({db,writers,contracts:faultContracts});
   await assert.rejects(faulty.forRun(runId,owner).prepare(prepareInput()),error=>error===original);assert.deepEqual(releases,[true]);
   assert.equal((await pool.query('SELECT count(*)::int n FROM local_operations WHERE run_id=$1',[runId])).rows[0].n,mode==='commit'?1:0);
  });
 });
 await t.test('independent PostgreSQL backends serialize two workers at the original run fence',{skip:!nativeUrl},async()=>{
  const {runId,ops}=await makeRun(),input=prepareInput(),pair=await Promise.all([ops.prepare(input),ops.prepare(input)]);assert.equal(pair[0].operationId,pair[1].operationId);
  const prepared=pair[0],ref={operationId:prepared.operationId,expectedVersion:1,intentSha256:prepared.intentSha256};
  let release!:()=>void,started!:()=>void;const hold=new Promise<void>(r=>release=r),entered=new Promise<void>(r=>started=r);const pids:number[]=[];
  const db={async connect(){const client=await pool.connect(),index=pids.length;pids.push((await client.query('SELECT pg_backend_pid() pid')).rows[0].pid);return {async query(sql:string,values?:unknown[]){
   if(index===0&&sql==='COMMIT'){started();await hold;}return client.query(sql,values);
  },release(discard:boolean){client.release(discard);}};}};
  const concurrent=new implementation.ToolOperationService({db,writers,contracts}).forRun(runId,owner);let bodies=0;
  const first=concurrent.dispatch(ref).then(()=>{bodies++;});await entered;const second=concurrent.dispatch(ref).then(()=>{bodies++;});second.catch(()=>{});
  try{
   const deadline=Date.now()+3000;let blockers:number[]=[];
   while(Date.now()<deadline){if(pids[1])blockers=(await pool.query('SELECT pg_blocking_pids($1) pids',[pids[1]])).rows[0].pids;if(blockers.includes(pids[0]))break;await new Promise(r=>setTimeout(r,10));}
   assert.notEqual(pids[0],pids[1]);assert.ok(blockers.includes(pids[0]));console.log('TOOL_OPERATION_NATIVE_LOCK='+JSON.stringify({pids,blockers}));
  }finally{release();}
  await first;await assert.rejects(second,/TOOL_OPERATION_DISPATCH_CONFLICT/);assert.equal(bodies,1);
  assert.equal((await pool.query('SELECT count(*)::int n FROM local_operations WHERE run_id=$1',[runId])).rows[0].n,1);
 });
 await t.test('independent PostgreSQL dispatch and known abort have exactly one winner',{skip:!nativeUrl},async()=>{
  for(const firstMethod of ['dispatch','abortPrepared'] as const){
   const {runId,ops}=await makeRun(),prepared=await ops.prepare(prepareInput()),ref={operationId:prepared.operationId,expectedVersion:1,intentSha256:prepared.intentSha256};
   let entered!:()=>void,release!:()=>void;const started=new Promise<void>(done=>entered=done),hold=new Promise<void>(done=>release=done),pids:number[]=[];
   const db={async connect(){const client=await pool.connect(),index=pids.length;pids.push((await client.query('SELECT pg_backend_pid() pid')).rows[0].pid);return {async query(sql:string,values?:unknown[]){if(index===0&&sql==='COMMIT'){entered();await hold;}return client.query(sql,values);},release(discard:boolean){client.release(discard);}};}};
   const concurrent=new implementation.ToolOperationService({db,writers,contracts}).forRun(runId,owner),secondMethod=firstMethod==='dispatch'?'abortPrepared':'dispatch';
   const first=concurrent[firstMethod](ref);await started;const second=concurrent[secondMethod](ref);second.catch(()=>{});
   try{const deadline=Date.now()+3000;let blockers:number[]=[];while(Date.now()<deadline){if(pids[1])blockers=(await pool.query('SELECT pg_blocking_pids($1) pids',[pids[1]])).rows[0].pids;if(blockers.includes(pids[0]))break;await new Promise(done=>setTimeout(done,10));}assert.notEqual(pids[0],pids[1]);assert.ok(blockers.includes(pids[0]));}
   finally{release();}
   assert.equal((await first).state,firstMethod==='dispatch'?'dispatched':'failed-known');
   await assert.rejects(second,{code:firstMethod==='dispatch'?'TOOL_OPERATION_ABORT_CONFLICT':'TOOL_OPERATION_DISPATCH_CONFLICT'});
  }
 });
 await t.test('retirement between prepare and dispatch prevents execution',async()=>{
  const {runId,ops}=await makeRun(),prepared=await ops.prepare(prepareInput());await contracts.retire(effectDigest(contract),1,actor);
  await assert.rejects(ops.dispatch({operationId:prepared.operationId,expectedVersion:1,intentSha256:prepared.intentSha256}),/TOOL_EFFECT_RETIRED/);
  assert.equal((await pool.query('SELECT effect_state FROM local_operations WHERE id=$1',[prepared.operationId])).rows[0].effect_state,'prepared');
  const ref={operationId:prepared.operationId,expectedVersion:1,intentSha256:prepared.intentSha256};
  assert.equal(typeof ops.abortPrepared,'function');
  await assert.rejects(ops.abortPrepared({...ref,expectedVersion:2}),/TOOL_OPERATION_ABORT_CONFLICT/);
  await assert.rejects(ops.abortPrepared({...ref,intentSha256:'0'.repeat(64)}),/TOOL_OPERATION_IDENTITY_CONFLICT/);
  const stopped=await ops.abortPrepared(ref);assert.equal(stopped.state,'failed-known');
  assert.deepEqual(await ops.abortPrepared(ref),stopped);
  await service.requireResolvedEffectsIn(pool,[runId]);
  const project=(await pool.query('SELECT project_id FROM project_runs WHERE id=$1',[runId])).rows[0].project_id;
  await pool.query('UPDATE projects SET version=version+1 WHERE id=$1',[project]);
  await implementation.requireResolvedProjectEffectsIn(pool,project);
  const row=(await pool.query('SELECT * FROM local_operations WHERE id=$1',[prepared.operationId])).rows[0];
  assert.equal(row.started,false);assert.equal(row.status,'failed');assert.equal(row.effect_version,2);assert.equal(row.evidence_records.length,1);
  await assert.rejects(pool.query("UPDATE local_operations SET effect_state='dispatched',status='dispatched',effect_version=effect_version+1,started=true WHERE id=$1",[prepared.operationId]),/immutable/);
 });
});
