import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,mkdirSync,rmSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {once} from 'node:events';

const implementation:any=await import('../apps/api/src/enterprise-restore-admission.ts');

test('restored environment quarantine blocks common execution paths without changing history',async t=>{
 assert.equal(typeof implementation.assertRestoreExecutionAdmitted,'function','restore execution admission must exist');
 assert.equal(process.env.SIMULATED_INTEGRATION,'pglite');
 const root=mkdtempSync(join(tmpdir(),'restore-admission-'));process.env.DATA_DIR=root;process.env.TRACE_ROOT=join(root,'runs');process.env.OBSIDIAN_VAULT=join(root,'vault');mkdirSync(join(root,'runs'));
 const {pool,migrate}=await import('../apps/api/src/db.ts');t.after(async()=>{await pool.end();rmSync(root,{recursive:true,force:true});});await migrate();
 await t.test('normal instance remains admitted',async()=>{await implementation.assertRestoreExecutionAdmitted(pool);});
 const operationId=randomUUID(),inputDigest='a'.repeat(64);
 await pool.query("INSERT INTO enterprise_restore_admission(operation_id,input_digest,status,source_issuer) VALUES($1,$2,'quarantined','https://fixture.invalid')",[operationId,inputDigest]);
 await pool.query('UPDATE backup_restore_anchor SET enterprise_restore_operation_id=$1',[operationId]);
 const blocked=(error:any)=>error.status===409&&error.code==='BACKUP_RESTORED_ENVIRONMENT_QUARANTINED';
 await t.test('environment admission denies quarantine',async()=>{await assert.rejects(implementation.assertRestoreExecutionAdmitted(pool),blocked);});
 await pool.query("INSERT INTO models(id,data,status) VALUES('fixture-model','{}','available')");
 await pool.query("INSERT INTO model_reservations(id,model_id,purpose,amount,input_rate,output_rate,status,expires_at) VALUES('expired-pending','fixture-model','fixture',0.01,1,2,'pending',now()-interval '1 hour'),('unknown-fee','fixture-model','fixture',0.02,1,2,'uncertain',now()-interval '1 hour')");
 const before=(await pool.query('SELECT id,status,amount::text,history::text,context::text FROM model_reservations ORDER BY id')).rows;
 await t.test('all planning/manager/model callers share the guarded reservation entry',async()=>{
  const {reserveCall}=await import('../apps/api/src/cost-control.ts');
  await assert.rejects(reserveCall({model:{id:'fixture-model',inputRate:1,outputRate:2},amount:0.001,purpose:'fixture'}),blocked);
  assert.deepEqual((await pool.query('SELECT id,status,amount::text,history::text,context::text FROM model_reservations ORDER BY id')).rows,before);
 });
 await t.test('cost reads do not expire or rewrite imported reservations',async()=>{
  const {expireReservations}=await import('../apps/api/src/cost-control.ts');await expireReservations();
  assert.deepEqual((await pool.query('SELECT id,status,amount::text,history::text,context::text FROM model_reservations ORDER BY id')).rows,before);
 });
 await t.test('run admission cannot escape through the legacy local-owner branch',async()=>{
  const {assertCurrentRunAuthority}=await import('../apps/api/src/run-current-authority.ts');
  await assert.rejects(assertCurrentRunAuthority(pool,'no-existing-run','tool'),blocked);
  const {assertRunAuthorization}=await import('../apps/api/src/execution-policy.ts');
  await assert.rejects(assertRunAuthorization({id:'no-existing-run',snapshot:{executionProfile:'task-attempt-openshell-v1'}},pool),blocked);
 });
 await t.test('old v1 export and restore both protect the target marker',async()=>{
  const {assertBackupSourcePortable,assertBackupDestinationClear}=await import('../apps/api/src/backup-destination.ts');
  const client=await pool.connect();try{await client.query('BEGIN');await assert.rejects(assertBackupSourcePortable(client),(error:any)=>error.code==='BACKUP_SOURCE_IDENTITY_UNSUPPORTED');await client.query('ROLLBACK');
   await client.query('BEGIN');await assert.rejects(assertBackupDestinationClear(client),(error:any)=>error.code==='BACKUP_DESTINATION_PROTECTED');await client.query('ROLLBACK');
  }finally{client.release();}
  assert.equal((await pool.query('SELECT status FROM enterprise_restore_admission')).rows[0].status,'quarantined');
 });
 await pool.query("INSERT INTO departments(id,data) VALUES('department',$1)",[{name:'Fixture',agents:[]}]);
 await pool.query("INSERT INTO projects(id,department_id,department_version,department_name,requirement,policy,plan,source) VALUES('project','department',1,'Fixture','Synthetic requirement','{}','{}','manual')");
 await t.test('manager background maintenance preserves imported messages',async()=>{
  await pool.query("INSERT INTO manager_messages(id,project_id,project_version,content,max_cost,model_id,status,started_at) VALUES('old-reply','project',1,'fixture',0.01,'fixture-model','replying',now()-interval '1 hour')");
  const {ManagerChatService}=await import('../apps/api/src/manager-chat.ts'),service=new ManagerChatService(pool);
  try{await service.tick();assert.equal((await pool.query("SELECT status FROM manager_messages WHERE id='old-reply'")).rows[0].status,'replying');}finally{await service.close();}
 });
 await t.test('automation cannot create drafts or rewrite schedules before activation',async()=>{
  const source=(await pool.query("SELECT * FROM projects WHERE id='project'")).rows[0];
  await pool.query("INSERT INTO automation_schedules(id,name,source_project_id,snapshot,kind,next_due) VALUES('schedule','fixture','project',$1,'once',now()-interval '1 hour')",[source]);
  const {AutomationLearningService}=await import('../apps/api/src/automation-learning.ts'),service=new AutomationLearningService(pool,{traceRoot:join(root,'runs')});
  try{await service.tick();assert.equal(service.lastError,null);assert.equal((await pool.query('SELECT * FROM automation_occurrences')).rowCount,0);assert.equal((await pool.query("SELECT status FROM automation_schedules WHERE id='schedule'")).rows[0].status,'active');}finally{await service.close();}
 });
 await t.test('coordinator does not inspect or start executors while quarantined',async()=>{
  const {createArchiveWriterManager}=await import('../services/agent-runtime/archive-writer-scope.mjs');
  const {RunCoordinator}=await import('../apps/api/src/run-coordinator.ts'),traceRoot=join(root,'runs'),service=new RunCoordinator(traceRoot,createArchiveWriterManager({traceRoot}),undefined,{startPaused:true});
  let inspections=0;service.runtime.inspect=async()=>{inspections++;return {ready:false} as any;};
  try{await service.tick();assert.equal(inspections,0);}finally{await service.close();}
 });
 await t.test('automatic billing reconciliation retains unknown query evidence',async()=>{
  await pool.query("UPDATE model_reservations SET context=$1 WHERE id='unknown-fee'",[{providerReconciliation:{status:'querying',checkedAt:'2000-01-01T00:00:00.000Z'}}]);
  const original=(await pool.query("SELECT context::text,history::text,amount::text FROM model_reservations WHERE id='unknown-fee'")).rows;
  const {ProviderReconciliationService,expireProviderQueries}=await import('../apps/api/src/provider-reconciliation.ts'),service=new ProviderReconciliationService();
  try{await expireProviderQueries();(service as any).tick();await (service as any).work;assert.deepEqual((await pool.query("SELECT context::text,history::text,amount::text FROM model_reservations WHERE id='unknown-fee'")).rows,original);}finally{await service.close();}
 });
 await t.test('vault and embedding background paths cannot alter restored references',async()=>{
  const {syncObsidian}=await import('../apps/api/src/obsidian.ts');
  await assert.rejects(syncObsidian(),blocked);assert.equal(existsSync(join(root,'vault')),false);
  const {indexChunks,startKnowledgeIndex,vectorCandidates}=await import('../apps/api/src/knowledge-vector.ts');
  await assert.rejects(indexChunks([{id:'not-a-chunk',title:'Fixture',content:'Do not download or embed'}]),blocked);
  assert.deepEqual(await vectorCandidates([],[],'fixture',5),[]);await startKnowledgeIndex();
  assert.equal((await pool.query('SELECT * FROM knowledge_embeddings')).rowCount,0);
 });
 await t.test('activation requires a fresh live target session of the current source-issuer admin',async t=>{
  assert.equal(typeof implementation.activateRestoredEnvironmentIn,'function');
  const {loadHumanPrincipal}=await import('../apps/api/src/identity-store.ts');
  await pool.query("INSERT INTO human_users(id,issuer,subject,status,org_role) VALUES('administrator','https://fixture.invalid','admin','active','admin')");
  await pool.query("UPDATE enterprise_restore_admission SET restored_at=clock_timestamp()-interval '2 seconds'");
  const time=new Date().toISOString(),reference={userId:'administrator',sessionId:'fresh-target-session',sessionEpoch:0,authenticatedAt:time,createdAt:time,lastSeenAt:time};
  await pool.query("INSERT INTO human_sessions(sid,sess,expire) VALUES($1,$2,now()+interval '1 hour')",[reference.sessionId,{human:reference}]);
  await pool.query("INSERT INTO human_session_lifecycles(sid,family_sid,valid_until,retain_until) VALUES($1,$1,now()+interval '1 hour',now()+interval '1 hour')",[reference.sessionId]);
  const principal=(await loadHumanPrincipal(pool,reference))!;
  async function activate(actor:any=principal,input={operationId,inputDigest}){const client=await pool.connect();try{await client.query('BEGIN');await implementation.activateRestoredEnvironmentIn(client,actor,input);await client.query('COMMIT');}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}}
  const denied=(error:any)=>error.status===403&&error.code==='BACKUP_ACTIVATION_REAUTHENTICATION_REQUIRED';
  await t.test('a marker without its committed receipt cannot activate',async()=>{await assert.rejects(activate(),(error:any)=>error.code==='BACKUP_RESTORE_RECONCILIATION_REQUIRED');});
  await pool.query('INSERT INTO backup_restore_receipts(operation_id,database_id,previous_generation,next_generation,manifest_sha256) SELECT $1,database_id,0,1,$2 FROM backup_restore_anchor WHERE singleton=1',[operationId,'b'.repeat(64)]);
  await pool.query('UPDATE backup_restore_anchor SET generation=1 WHERE singleton=1');
  await t.test('local-owner, device and system cannot activate',async()=>{for(const actor of [{kind:'local-owner'},{kind:'device',deviceId:'old-device'},{kind:'system',service:'fixture'}])await assert.rejects(activate(actor),denied);});
  await t.test('a different package digest is rejected',async()=>{await assert.rejects(activate(principal,{operationId,inputDigest:'c'.repeat(64)}),(error:any)=>error.code==='BACKUP_ACTIVATION_INPUT_CHANGED');});
  await t.test('missing session, changed issuer and disabled or revoked administrator are rejected',async()=>{
   await assert.rejects(activate({...principal,sessionId:'copied-source-session'}),denied);
   await assert.rejects(activate({...principal,issuer:'https://another.invalid'}),denied);
   await pool.query("UPDATE human_users SET status='disabled' WHERE id='administrator'");await assert.rejects(activate(),denied);
   await pool.query("UPDATE human_users SET status='active',session_epoch=1 WHERE id='administrator'");await assert.rejects(activate(),denied);
   await pool.query("UPDATE human_users SET session_epoch=0 WHERE id='administrator'");
  });
  await t.test('old login and revoked session family cannot activate',async()=>{
   const old={...reference,authenticatedAt:new Date(Date.now()-60_000).toISOString()};
   await pool.query('UPDATE human_sessions SET sess=$1 WHERE sid=$2',[{human:old},reference.sessionId]);await assert.rejects(activate({...principal,authenticatedAt:old.authenticatedAt}),denied);
   await pool.query('UPDATE human_sessions SET sess=$1 WHERE sid=$2',[{human:reference},reference.sessionId]);
   await pool.query('UPDATE human_session_lifecycles SET family_revoked_at=now() WHERE sid=$1',[reference.sessionId]);await assert.rejects(activate(),denied);
   await pool.query('UPDATE human_session_lifecycles SET family_revoked_at=NULL WHERE sid=$1',[reference.sessionId]);
  });
  const history=(await pool.query('SELECT id,issuer,subject,status,org_role,session_epoch::text FROM human_users ORDER BY id')).rows;
  await t.test('fresh activation adds one new audit and does not rewrite identity history',async()=>{
   await activate();assert.equal((await implementation.readRestoreAdmission(pool)).verified,true);await implementation.assertRestoreExecutionAdmitted(pool);
   assert.deepEqual((await pool.query('SELECT id,issuer,subject,status,org_role,session_epoch::text FROM human_users ORDER BY id')).rows,history);
   await activate();assert.equal((await pool.query("SELECT * FROM human_audit_events WHERE action='backup.restore'")).rowCount,1);
  });
  await t.test('an active label cannot bypass missing audit or mismatched generation',async()=>{
   await pool.query('UPDATE backup_restore_anchor SET generation=2 WHERE singleton=1');await assert.rejects(implementation.assertRestoreExecutionAdmitted(pool),(error:any)=>error.code==='BACKUP_RESTORE_RECONCILIATION_REQUIRED');
   await pool.query('UPDATE backup_restore_anchor SET generation=1 WHERE singleton=1');
   await pool.query("UPDATE enterprise_restore_admission SET activated_by='no-matching-activation-audit'");await assert.rejects(implementation.assertRestoreExecutionAdmitted(pool),(error:any)=>error.code==='BACKUP_RESTORE_RECONCILIATION_REQUIRED');
   await pool.query("UPDATE enterprise_restore_admission SET activated_by='administrator'");
  });
  await t.test('losing the admission marker must not make a restored instance look like a normal instance',async()=>{
   const client=await pool.connect();try{await client.query('BEGIN');await client.query('DELETE FROM enterprise_restore_admission');
    await assert.rejects(implementation.assertRestoreExecutionAdmitted(client),(error:any)=>error.code==='BACKUP_RESTORE_RECONCILIATION_REQUIRED');
   }finally{await client.query('ROLLBACK');client.release();}
  });
  await t.test('global activation never grants copied resources or a different native version',async()=>{
   assert.equal(typeof implementation.assertRestoredResourceAdmitted,'function');
   const pending={native:['d'.repeat(64),'e'.repeat(64)],mcp:[JSON.stringify(['connection',1])],device:['old-device'],schedule:[JSON.stringify(['schedule',1])],contract:['f'.repeat(64)]};
   await pool.query('UPDATE enterprise_restore_admission SET pending_resources=$1',[pending]);
   for(const [kind,ids]of Object.entries(pending))for(const id of ids)await assert.rejects(implementation.assertRestoredResourceAdmitted(pool,kind,id),(error:any)=>error.code==='BACKUP_RESOURCE_REAUTHORIZATION_REQUIRED');
   await implementation.assertRestoredResourceAdmitted(pool,'mcp',JSON.stringify(['connection',2]));
   await implementation.acknowledgeRestoredResourceIn(pool,'native','d'.repeat(64));
   await implementation.assertRestoredResourceAdmitted(pool,'native','d'.repeat(64));
   await assert.rejects(implementation.assertRestoredResourceAdmitted(pool,'native','e'.repeat(64)),(error:any)=>error.code==='BACKUP_RESOURCE_REAUTHORIZATION_REQUIRED');
   const {AutomationLearningService}=await import('../apps/api/src/automation-learning.ts'),service=new AutomationLearningService(pool,{traceRoot:join(root,'runs')});
   try{await service.tick();assert.equal((await pool.query('SELECT * FROM automation_occurrences')).rowCount,0,'copied active schedule remains effectively paused');}finally{await service.close();}
   assert.equal((await pool.query("SELECT status FROM automation_schedules WHERE id='schedule'")).rows[0].status,'active','historical portable state is unchanged');
  });
  await t.test('pending restored schedules cannot starve a newly authorized schedule',async()=>{
   const source=(await pool.query("SELECT * FROM projects WHERE id='project'")).rows[0],ids=[];
   for(let i=0;i<21;i++){const id='pending-'+i;ids.push(JSON.stringify([id,1]));await pool.query("INSERT INTO automation_schedules(id,name,source_project_id,snapshot,kind,next_due) VALUES($1,'fixture','project',$2,'once',now()-interval '2 hours')",[id,source]);}
   await pool.query("UPDATE enterprise_restore_admission SET pending_resources=jsonb_set(pending_resources,'{schedule}',(pending_resources->'schedule')||$1::jsonb)",[JSON.stringify(ids)]);
   await pool.query("INSERT INTO automation_schedules(id,name,source_project_id,snapshot,kind,next_due) VALUES('new-schedule','new','project',$1,'once',now()-interval '1 minute')",[source]);
   const {AutomationLearningService}=await import('../apps/api/src/automation-learning.ts'),service=new AutomationLearningService(pool,{traceRoot:join(root,'runs')});
   try{await service.tick();assert.equal((await pool.query("SELECT * FROM automation_occurrences WHERE schedule_id='new-schedule'")).rowCount,1);assert.equal((await pool.query("SELECT * FROM automation_occurrences WHERE schedule_id LIKE 'pending-%'")).rowCount,0);}finally{await service.close();}
  });
  await t.test('schedule API displays effective pause and explicit resume creates a new authorized version',async()=>{
   const express=(await import('express')).default,{automationLearningRouter,AutomationLearningService}=await import('../apps/api/src/automation-learning.ts');
   const app=express();app.use(express.json());app.use(automationLearningRouter({db:pool}));app.use((e:any,_req:any,res:any,_next:any)=>res.status(e.status??500).json({code:e.code,message:e.message}));
   const server=app.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${(server.address() as any).port}`,service=new AutomationLearningService(pool,{traceRoot:join(root,'runs')});
   try{const rows=await (await fetch(base+'/automation/schedules')).json(),old=rows.find((row:any)=>row.id==='schedule');assert.equal(old.status,'paused');assert.equal(old.historicalStatus,'active');assert.equal(old.restoreAuthorizationRequired,true);
    const resume=()=>fetch(base+'/automation/schedules/schedule/state',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'resume',version:old.version})});
    assert.equal((await resume()).status,200);assert.equal((await resume()).status,409);await service.tick();assert.equal((await pool.query("SELECT * FROM automation_occurrences WHERE schedule_id='schedule'")).rowCount,1);
   }finally{await service.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
  });
  await t.test('only a genuinely virgin source can activate through first target OIDC bootstrap',async()=>{
   const {readEnterpriseTables}=await import('../apps/api/src/enterprise-backup-export.ts'),tables=await readEnterpriseTables(pool);
   const client=await pool.connect();try{await client.query('BEGIN');
    await client.query('DELETE FROM enterprise_restore_admission');await client.query('UPDATE backup_restore_anchor SET enterprise_restore_operation_id=NULL');tables.human_users=[];
    await implementation.installRestoreAdmissionIn(client,{tables,nativePluginBundles:{}},operationId,inputDigest);
    assert.equal((await client.query('SELECT source_bootstrap_virgin FROM enterprise_restore_admission')).rows[0].source_bootstrap_virgin,true);
    await client.query("UPDATE enterprise_restore_admission SET restored_at=clock_timestamp()-interval '2 seconds'");
    await assert.rejects(implementation.activateRestoredEnvironmentIn(client,principal,{operationId,inputDigest}),denied);
    await client.query("UPDATE identity_bootstrap SET expected_fingerprint=$1,activated_at=clock_timestamp(),consumed_at=clock_timestamp(),consumed_by='administrator' WHERE id=1",['9'.repeat(64)]);
    await implementation.activateRestoredEnvironmentIn(client,principal,{operationId,inputDigest});assert.equal((await implementation.readRestoreAdmission(client)).verified,true);
    await client.query('DELETE FROM enterprise_restore_admission');await client.query('UPDATE backup_restore_anchor SET enterprise_restore_operation_id=NULL');tables.identity_bootstrap[0].activated_at=new Date().toISOString();
    await implementation.installRestoreAdmissionIn(client,{tables,nativePluginBundles:{}},operationId,inputDigest);
    assert.equal((await client.query('SELECT source_bootstrap_virgin FROM enterprise_restore_admission')).rows[0].source_bootstrap_virgin,false);
    await assert.rejects(implementation.activateRestoredEnvironmentIn(client,principal,{operationId,inputDigest}),denied);
   }finally{await client.query('ROLLBACK');client.release();}
  });
 });
});
