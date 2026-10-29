import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtempSync,rmSync,mkdirSync,writeFileSync,readFileSync,readdirSync,renameSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createEnterpriseBackup,ENTERPRISE_BACKUP_SCHEMA_ID,decryptEnterpriseBackup} from '../apps/api/src/enterprise-backup-schema.ts';
import {readEnterpriseTables,exportEnterpriseBackup} from '../apps/api/src/enterprise-backup-export.ts';
import {acceptedStopApiFixture} from './helpers/task-accepted-stop-api-fixture.ts';
import {createArchiveWriterManager} from '../services/agent-runtime/archive-writer-scope.mjs';
import {createBackupRestoreState} from '../apps/api/src/backup-restore-state.ts';
import {gzipSync} from 'node:zlib';
import {nativeManifestId} from '../services/agent-runtime/native-capabilities.mjs';
import {execFileSync} from 'node:child_process';

const path='../apps/api/src/enterprise-backup-restore.ts';
const implementation:any=await import(path).catch(error=>{if(error.code==='ERR_MODULE_NOT_FOUND')return {};throw error;});

test('enterprise restore preflight admits only untouched fresh database defaults',async t=>{
 assert.equal(typeof implementation.preflightEnterpriseRestore,'function','fresh preserving restore preflight must exist');
 assert.equal(process.env.SIMULATED_INTEGRATION,'pglite');
 const root=mkdtempSync(join(tmpdir(),'enterprise-restore-'));process.env.DATA_DIR=root;process.env.TRACE_ROOT=join(root,'runs');process.env.OBSIDIAN_VAULT=join(root,'vault');
 const {pool,migrate}=await import('../apps/api/src/db.ts');t.after(async()=>{await pool.end();rmSync(root,{recursive:true,force:true});});await migrate();
 const payload=createEnterpriseBackup({version:2,schemaId:ENTERPRISE_BACKUP_SCHEMA_ID,createdAt:new Date().toISOString(),source:{applicationVersion:'0.2.0',databaseId:randomUUID(),engine:'pglite'},tables:await readEnterpriseTables(pool),files:{},master:null,vaultFiles:{},nativePluginBundles:{}});
 const digest=async(db:any)=>createHash('sha256').update(JSON.stringify(await readEnterpriseTables(db))).digest('hex');
 await t.test('fresh defaults survive preflight without a write',async()=>{const before=await digest(pool);await implementation.preflightEnterpriseRestore(pool,payload);assert.equal(await digest(pool),before);});
 const cases=[
  ['business history',"INSERT INTO activity(id,kind,title) VALUES('existing','fixture','preserve')"],
  ['department and its trigger history',"INSERT INTO departments(id,data) VALUES('existing','{}')"],
  ['existing user',"INSERT INTO human_users(id,issuer,subject) VALUES('existing','https://fixture.invalid','existing')"],
  ['changed defaults without version bump',`UPDATE product_settings SET data='{"autoBudgetLimit":0.5,"dailyBudgetLimit":20,"maxActiveRuns":2,"retentionDays":0}'`],
  ['activated identity',"UPDATE identity_bootstrap SET expected_fingerprint='existing',activated_at=now(),version=2"],
  ['old idempotency cache',"INSERT INTO request_keys(key,fingerprint,principal_key) VALUES('existing','existing','legacy-local')"],
  ['previous restore generation',"UPDATE backup_restore_anchor SET generation=1 WHERE singleton=1"],
  ['enterprise restore anchor without marker',"UPDATE backup_restore_anchor SET enterprise_restore_operation_id='00000000-0000-4000-8000-000000000001' WHERE singleton=1"],
  ['previous admission marker',"INSERT INTO enterprise_restore_admission(operation_id,input_digest,status) VALUES('00000000-0000-4000-8000-000000000001','existing','quarantined')"],
 ] as const;
 for(const [name,sql]of cases)await t.test('rejects '+name+' before changing it',async()=>{
  const client=await pool.connect();try{await client.query('BEGIN');await client.query(sql);const before=await digest(client);
   await assert.rejects(implementation.preflightEnterpriseRestore(client,payload),(error:any)=>error.status===409&&error.code==='BACKUP_DESTINATION_NOT_FRESH');assert.equal(await digest(client),before);
  }finally{await client.query('ROLLBACK');client.release();}await implementation.preflightEnterpriseRestore(pool,payload);
 });
 await t.test('extra target files or device actor fail before stage creation without erasing files',async()=>{
  const traceRoot=join(root,'runs'),writers=createArchiveWriterManager({traceRoot}),state=createBackupRestoreState({pool,writers,traceRoot,dataRoot:root});
  const cases=[join(traceRoot,'existing.txt'),join(root,'credential.key'),join(root,'vault','existing.md'),join(root,'vault','知识库说明.md'),join(root,'native-plugins','existing.txt'),join(root,'native-plugins','install-jobs','existing.json')];
  for(const path of cases){mkdirSync(join(path,'..'),{recursive:true});writeFileSync(path,'original bytes');const names=readdirSync(root).sort(),before=await digest(pool);
   try{await assert.rejects(implementation.restoreEnterpriseBackup({principal:{kind:'local-owner'},payload,traceRoot,writers,state}),(error:any)=>error.code==='BACKUP_DESTINATION_NOT_FRESH');assert.equal(await digest(pool),before);assert.equal(readFileSync(path,'utf8'),'original bytes');assert.deepEqual(readdirSync(root).sort(),names);}finally{rmSync(path);}
  }
  await assert.rejects(implementation.restoreEnterpriseBackup({principal:{kind:'device',deviceId:'untrusted'},payload,traceRoot,writers,state}),(error:any)=>[403,404].includes(error.status));
 });
 await t.test('fresh isolated preserving import keeps source, historical task bytes and target identity',async()=>{
  assert.equal(typeof implementation.restoreEnterpriseBackup,'function','preserving importer must exist');
  const traceRoot=join(root,'runs'),f=await acceptedStopApiFixture(traceRoot),schema='enterprise_target_'+randomUUID().replaceAll('-','');
  try{
   await f.acceptA();await pool.query("UPDATE project_runs SET status='cancelled' WHERE id=$1",[f.runId]);f.archive.append('run/finished',{status:'cancelled'});
   await pool.query("INSERT INTO human_users(id,issuer,subject,status,org_role,session_epoch) VALUES('source-admin','https://fixture.invalid','admin','active','admin',1234567890123)");
   await pool.query("INSERT INTO human_users(id,issuer,subject,status,org_role) VALUES('source-member','https://fixture.invalid','member','active','member'),('source-disabled','https://fixture.invalid','disabled','disabled','admin')");
   await pool.query("INSERT INTO department_memberships(department_id,user_id,role,can_approve,granted_by) VALUES('department','source-member','operator',false,'source-admin')");
   const actor={kind:'human' as const,userId:'source-admin',sessionId:'source-historical-audit-session',issuer:'https://fixture.invalid',subject:'admin',orgRole:'admin' as const,sessionEpoch:1234567890123,authenticatedAt:new Date().toISOString()};
   const {appendAudit,auditActor}=await import('../apps/api/src/audit-events.ts'),{lockDepartmentAuthority}=await import('../apps/api/src/project-route-access.ts');
   const requestAuditId=randomUUID(),decisionAuditId=randomUUID(),requestId=randomUUID(),auditClient=await pool.connect();
   try{await auditClient.query('BEGIN');const authority=await lockDepartmentAuthority(auditClient,actor,['department'],'operator');
    const common={actor:auditActor(actor),authority,correlation:{correlationId:requestId,requestId,runId:f.runId},outcome:'success' as const};
    await appendAudit(auditClient,{...common,eventId:requestAuditId,action:'project.approve',resource:{type:'project',id:f.snapshot.projectId,departmentIds:['department']},changes:{version:'1'}});
    await appendAudit(auditClient,{...common,eventId:decisionAuditId,action:'tool.approval',requestedByAuditId:requestAuditId,resource:{type:'tool_operation',id:'source-approval',departmentIds:['department']},changes:{decision:'approved'}});
    await auditClient.query("INSERT INTO tool_approvals(id,run_id,agent_id,tool,arguments,status,decided_at,decided_by_user_id,decided_epoch,decision_actor_kind,decision_request_id,decision_reason,decision_audit_id) VALUES('source-approval',$1,'employee','filesystem','{}','approved',now(),'source-admin',1234567890123,'human',$2,'approved-by-current-authority',$3)",[f.runId,requestId,decisionAuditId]);await auditClient.query('COMMIT');
   }catch(error){await auditClient.query('ROLLBACK');throw error;}finally{auditClient.release();}
   const contract:any={schema:1,capabilityId:'team.status',namespace:'weiwu',toolName:'agent_teams_status',source:{kind:'builtin',reference:'fixture:release',version:'1',digest:'a'.repeat(64)},definitionSha256:'a'.repeat(64),effect:'workspace',isolationProfile:'runtime-v1',permissions:['team:status'],retry:'never',cost:{kind:'free'},reconciliation:{kind:'receipt'},compensation:{kind:'none',requiresApproval:true},evidenceRefs:['fixture:review']};
   const {ToolEffectContractService}=await import('../apps/api/src/tool-effect-contracts.ts'),{ToolOperationService}=await import('../apps/api/src/tool-operations.ts'),{effectDigest}=await import('../services/agent-runtime/tool-effects.mjs'),{createRunArchive}=await import('../services/agent-runtime/trace-store.mjs');
   const contracts=new ToolEffectContractService({db:pool,resolveBinding:async()=>contract});await contracts.review({namespace:contract.namespace,toolName:contract.toolName},effectDigest(contract),actor);
   const {executionTarget:_target,...runtimePolicy}=f.snapshot.policy,runtimeAgents=f.snapshot.agents.map((agent:any)=>({...agent,tools:[]}));
   const runtimeProject=randomUUID(),runtimeSnapshot={projectId:runtimeProject,planVersion:1,departmentId:'department',agents:runtimeAgents,tasks:[],policy:runtimePolicy,executionProfile:'legacy-run-v1',effectContractVersion:1,effectContracts:[contract]},runtime=createRunArchive(traceRoot,runtimeSnapshot);
   await pool.query("INSERT INTO projects(id,department_id,department_version,department_name,requirement,policy,plan,source) VALUES($1,'department',1,'fixture','fixture',$2,$3,'manual')",[runtimeProject,runtimePolicy,{agents:runtimeAgents,tasks:[]}]);
   await pool.query("INSERT INTO project_runs(id,project_id,project_version,status,snapshot,lease_owner,lease_until) VALUES($1,$2,1,'running',$3,$4,now()+interval '1 hour')",[runtime.id,runtimeProject,runtimeSnapshot,f.owner]);
   const ops=new ToolOperationService({db:pool,writers:f.service.writers!,contracts}).forRun(runtime.id,f.owner),prepare=()=>({contract,agentId:'employee',sessionId:'runtime-fixture',callId:randomUUID(),argumentsSha256:effectDigest({})});
   const parent=await ops.prepare(prepare());await ops.dispatch({operationId:parent.operationId,expectedVersion:1,intentSha256:parent.intentSha256});const child=await ops.prepare({...prepare(),parentOperationId:parent.operationId});await ops.markUnknown({operationId:parent.operationId,intentSha256:parent.intentSha256,reasonCode:'FIXTURE_RESULT_UNKNOWN'});
   await pool.query("UPDATE project_runs SET status='cancelled' WHERE id=$1",[runtime.id]);runtime.append('run/finished',{status:'cancelled'});
   await pool.query("INSERT INTO models(id,data,status) VALUES('unused','{}','available')");
   await pool.query("INSERT INTO model_reservations(id,model_id,purpose,amount,input_rate,output_rate,status) VALUES('unknown-fee','unused','fixture',0.1234567890123456789,0.4,1.6,'uncertain')");
   const bytes=Buffer.from('input'),file={path:'in.txt',bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),base64:bytes.toString('base64'),kind:'text',text:'input',warnings:[]};
   await pool.query("INSERT INTO work_file_snapshots(id,name,files,bytes) VALUES('snapshot','fixture',$1,$2)",[JSON.stringify([file]),bytes.length]);
   await pool.query("INSERT INTO knowledge_spaces(id,name,scope) VALUES('space','fixture','company')");
   const {saveKnowledgeDocument}=await import('../apps/api/src/knowledge.ts');
   const note=await saveKnowledgeDocument({spaceId:'space',title:'方法',content:'历史版本'},undefined,true,undefined,{principal:{kind:'local-owner'}});
   await saveKnowledgeDocument({spaceId:'space',title:'方法',content:'当前版本',version:1},note.id,false,undefined,{principal:{kind:'local-owner'}});
   const withdrawn=await saveKnowledgeDocument({spaceId:'space',title:'已删除资料',content:'保留历史正文'},undefined,true,undefined,{principal:{kind:'local-owner'}});
   await pool.query('UPDATE knowledge_documents SET deleted_at=now() WHERE id=$1',[withdrawn.id]);await (await import('../apps/api/src/obsidian.ts')).archiveVaultDocument(withdrawn.id);
   // Protocol edge carrier after the last normal write/sync. This is not a
   // production knowledge placement recommendation or employee evidence.
   const noteOriginal=(await pool.query('SELECT vault_path FROM knowledge_documents WHERE id=$1',[note.id])).rows[0].vault_path;
   renameSync(join(root,'vault',noteOriginal),join(root,'vault','__proto__'));await pool.query("UPDATE knowledge_documents SET vault_path='__proto__' WHERE id=$1",[note.id]);
   const hash=(v:Buffer)=>createHash('sha256').update(v).digest('hex'),code=Buffer.from('export default {};'),compressed=gzipSync(code),metadata=Buffer.from('{"name":"fixture","version":"1.0.0"}');
   const manifest={format:'dsh-native-tools-v1',namespace:'fixture',package:'fixture',version:'1.0.0',dshVersion:'0.1.5-rc.1',lockSha256:'1'.repeat(64),source:{kind:'company',reference:'synthetic-only'},config:{},bundle:{bytes:compressed.length,sha256:hash(compressed),codeSha256:hash(code),metadataSha256:hash(metadata)},tools:[{name:'plugin__fixture__read',originalName:'read',description:'synthetic-only',parameters:{type:'object'},files:{read:[],write:[]}}]};
   const bundleId=nativeManifestId(manifest),bundleRoot=join(root,'native-plugins',bundleId);mkdirSync(bundleRoot,{recursive:true});writeFileSync(join(bundleRoot,'manifest.json'),JSON.stringify(manifest));writeFileSync(join(bundleRoot,'bundle.gz'),compressed);writeFileSync(join(bundleRoot,'package.json'),metadata);
   await pool.query("INSERT INTO native_capabilities(namespace,manifest_id,enabled) VALUES('fixture',$1,true)",[bundleId]);
   writeFileSync(join(root,'credential.key'),Buffer.alloc(32,4));
   writeFileSync(join(traceRoot,'__proto__'),'literal managed archive file');
   // Each real instance loads its DATA_DIR before imports. Use fresh processes
   // for the actual vault module instead of changing its captured directory.
   const sealed=execFileSync(process.execPath,['--import','tsx','--input-type=module','-e',"import {seal} from './apps/api/src/vault.ts';process.stdout.write(seal('synthetic-backup-secret'));"],{env:{...process.env,DATA_DIR:root}}).toString();
   await pool.query("INSERT INTO gateways(id,data,credential) VALUES('sealed-gateway','{}',$1)",[sealed]);
   const treeDigest=(at:string)=>createHash('sha256').update(JSON.stringify(readdirSync(at,{recursive:true,withFileTypes:true}).filter(e=>e.isFile()).map(e=>[join(e.parentPath,e.name).slice(at.length),createHash('sha256').update(readFileSync(join(e.parentPath,e.name))).digest('hex')]).sort())).digest('hex');
   const originalRows=await readEnterpriseTables(pool),originalFiles=treeDigest(traceRoot),sourceKey=readFileSync(join(root,'credential.key'));
   const sourceState=createBackupRestoreState({pool,writers:f.service.writers!,traceRoot,dataRoot:root}),password='owned-roundtrip-password';
   const saved=await decryptEnterpriseBackup(await exportEnterpriseBackup({principal:{kind:'local-owner'},traceRoot,writers:f.service.writers!,state:sourceState,password}),password);
   assert.equal(saved.tables.knowledge_documents.find(row=>row.id===note.id)!.deleted_at,null,'active source note remains active');assert.equal(Object.hasOwn(saved.vaultFiles,'__proto__'),true,'active note bytes are part of source package');
   await pool.query('CREATE SCHEMA '+schema);await pool.query('SET search_path TO '+schema+',public');
   const destination=join(root,'destination'),dataRoot=join(destination,'credentials'),targetTrace=join(destination,'runs');mkdirSync(dataRoot,{recursive:true});
   process.env.DATA_DIR=dataRoot;process.env.TRACE_ROOT=targetTrace;process.env.OBSIDIAN_VAULT=join(destination,'vault');await migrate();
   const writers=createArchiveWriterManager({traceRoot:targetTrace}),state=createBackupRestoreState({pool,writers,traceRoot:targetTrace,dataRoot});
   const targetId=(await pool.query('SELECT database_id FROM backup_restore_anchor WHERE singleton=1')).rows[0].database_id;
   // The real server's vault timer creates this exact startup scaffold even
   // before a user creates a document. It is not existing business content.
   const {ensureVault}=await import('../apps/api/src/obsidian.ts');ensureVault();
   const broken=structuredClone(saved),missing=Object.keys(broken.files).find(path=>path.includes('/checkpoint-objects/'))!;delete broken.files[missing];const {manifest:_manifest,...brokenInput}=broken;
   const entries=readdirSync(destination).sort();await assert.rejects(implementation.restoreEnterpriseBackup({principal:{kind:'local-owner'},payload:createEnterpriseBackup(brokenInput),traceRoot:targetTrace,writers,state}),(error:any)=>error.code==='BACKUP_REFERENCE_INVALID');assert.deepEqual(readdirSync(destination).sort(),entries);await implementation.preflightEnterpriseRestore(pool,saved);
   const {manifest:_savedManifest,...savedInput}=saved;await assert.rejects(implementation.restoreEnterpriseBackup({principal:{kind:'local-owner'},payload:createEnterpriseBackup({...savedInput,vaultFiles:{}}),traceRoot:targetTrace,writers,state}),(error:any)=>error.code==='BACKUP_REFERENCE_INVALID');assert.deepEqual(readdirSync(destination).sort(),entries);
   const result=await implementation.restoreEnterpriseBackup({principal:{kind:'local-owner'},payload:saved,traceRoot:targetTrace,writers,state});
   assert.equal(result.status,'quarantined');assert.match(result.operationId,/^[a-f0-9-]{36}$/);assert.equal((await pool.query('SELECT database_id FROM backup_restore_anchor WHERE singleton=1')).rows[0].database_id,targetId);assert.notEqual(targetId,saved.source.databaseId);
   assert.deepEqual(await readEnterpriseTables(pool),originalRows);assert.equal(treeDigest(targetTrace),originalFiles);assert.deepEqual(readFileSync(join(dataRoot,'credential.key')),sourceKey);
   assert.equal((await pool.query('SELECT requested_by_audit_id FROM human_audit_events WHERE id=$1',[decisionAuditId])).rows[0].requested_by_audit_id,requestAuditId);assert.equal((await pool.query('SELECT parent_operation_id FROM local_operations WHERE id=$1',[child.operationId])).rows[0].parent_operation_id,parent.operationId);assert.equal((await pool.query('SELECT effect_state FROM local_operations WHERE id=$1',[parent.operationId])).rows[0].effect_state,'unknown');
   const notePath=saved.tables.knowledge_documents.find(row=>row.id===note.id)!.vault_path as string;assert.deepEqual(readFileSync(join(destination,'vault',notePath)),readFileSync(join(root,'vault',notePath)));assert.deepEqual(readFileSync(join(dataRoot,'native-plugins',bundleId,'bundle.gz')),compressed);
   const receiptManifest=JSON.parse(readFileSync(join(dataRoot,'.backup-restore-state',result.operationId,'manifest.json'),'utf8'));assert.equal(Object.hasOwn(receiptManifest.beforeVault,'__proto__'),true);assert.equal(Object.hasOwn(receiptManifest.afterVault,'__proto__'),true);
   assert.equal(execFileSync(process.execPath,['--import','tsx','--input-type=module','-e',"import {unseal} from './apps/api/src/vault.ts';if(unseal(process.env.SYNTHETIC_CIPHER)!=='synthetic-backup-secret')throw Error('credential mismatch');process.stdout.write('verified');"],{env:{...process.env,DATA_DIR:dataRoot,SYNTHETIC_CIPHER:sealed}}).toString(),'verified');
   assert.equal((await pool.query('SELECT count(*)::int n FROM backup_restore_receipts')).rows[0].n,1);
   assert.equal((await pool.query('SELECT status FROM enterprise_restore_admission')).rows[0].status,'quarantined');
   assert.equal((await pool.query('SELECT count(*)::int n FROM local_operations WHERE claim_token IS NOT NULL')).rows[0].n,0);
   t.diagnostic('Target SQL/files/key/receipt/quarantine matched; checking re-export without live claim authority.');
   const again=await decryptEnterpriseBackup(await exportEnterpriseBackup({principal:{kind:'local-owner'},traceRoot:targetTrace,writers,state,password}),password);assert.deepEqual(again.tables,saved.tables,'restored history can be backed up again without restoring live claim authority');
   await assert.rejects(implementation.restoreEnterpriseBackup({principal:{kind:'local-owner'},payload:saved,traceRoot:targetTrace,writers,state}),(error:any)=>error.code==='BACKUP_DESTINATION_NOT_FRESH');
   await pool.query('SET search_path TO public');assert.deepEqual(await readEnterpriseTables(pool),originalRows);assert.equal(treeDigest(traceRoot),originalFiles);assert.deepEqual(readFileSync(join(root,'credential.key')),sourceKey);
  }finally{await pool.query('SET search_path TO public');await pool.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await f.close();process.env.DATA_DIR=root;process.env.TRACE_ROOT=traceRoot;process.env.OBSIDIAN_VAULT=join(root,'vault');}
 });
});
