import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync,rmSync,linkSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {gzipSync} from 'node:zlib';
import {createArchiveWriterManager} from '../services/agent-runtime/archive-writer-scope.mjs';
import {createRunArchive} from '../services/agent-runtime/trace-store.mjs';
import {commitStepCheckpoint} from '../services/agent-runtime/step-checkpoints.mjs';
import {nativeManifestId} from '../services/agent-runtime/native-capabilities.mjs';
import {enterpriseTableSpecs,decryptEnterpriseBackup} from '../apps/api/src/enterprise-backup-schema.ts';
import type {HumanPrincipal} from '../apps/api/src/identity-types.ts';

const modulePath='../apps/api/src/enterprise-backup-export.ts';
const implementation:any=await import(modulePath).catch(error=>{if(error.code==='ERR_MODULE_NOT_FOUND')return {};throw error;});
const hash=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex');
const password='owned-enterprise-export-fixture';

test('enterprise export preserves source history, secrets boundary and referenced bytes',async t=>{
  assert.equal(typeof implementation.exportEnterpriseBackup,'function','complete enterprise exporter must exist');
  assert.equal(process.env.SIMULATED_INTEGRATION,'pglite');
  const root=mkdtempSync(join(tmpdir(),'enterprise-export-')),traceRoot=join(root,'runs');
  process.env.DATA_DIR=root;process.env.TRACE_ROOT=traceRoot;process.env.OBSIDIAN_VAULT=join(root,'vault');delete process.env.LOCAL_WORKSPACE_ROOT;
  writeFileSync(join(root,'credential.key'),Buffer.alloc(32,7));
  const {pool,migrate}=await import('../apps/api/src/db.ts');
  t.after(async()=>{await pool.end();rmSync(root,{recursive:true,force:true});});await migrate();
  const writers=createArchiveWriterManager({traceRoot});
  const {createBackupRestoreState}=await import('../apps/api/src/backup-restore-state.ts');
  const state=createBackupRestoreState({pool,writers,traceRoot,dataRoot:root});
  const actor:HumanPrincipal={kind:'human',userId:randomUUID(),sessionId:'historical-session-not-a-cookie',issuer:'https://fixture.invalid',subject:'admin',orgRole:'admin',sessionEpoch:0,authenticatedAt:new Date().toISOString()};
  await pool.query("INSERT INTO human_users(id,issuer,subject,status,org_role) VALUES($1,$2,$3,'active','admin')",[actor.userId,actor.issuer,actor.subject]);
  await pool.query("INSERT INTO human_users(id,issuer,subject,status,org_role) VALUES('member',$1,'member','active','member'),('revoked',$1,'revoked','disabled','admin')",[actor.issuer]);
  await pool.query("INSERT INTO departments(id,data) VALUES('department',$1)",[{name:'fixture',agents:[]}]);
  await pool.query("INSERT INTO department_memberships(department_id,user_id,role,can_approve,granted_by) VALUES('department','member','operator',false,$1)",[actor.userId]);
  await pool.query("INSERT INTO gateways(id,data,credential) VALUES('gateway','{}','sealed-fixture')");
  await pool.query("INSERT INTO models(id,data,status) VALUES('model','{}','available')");
  const agent={id:'employee',employeeId:'employee',name:'fixture',role:'manager',modelId:'model',tools:[]};
  const contract={schema:1,capabilityId:'team.status',namespace:'weiwu',toolName:'agent_teams_status',source:{kind:'builtin',reference:'fixture:release',version:'1',digest:'a'.repeat(64)},definitionSha256:'a'.repeat(64),effect:'workspace',isolationProfile:'runtime-v1',permissions:['team:status'],retry:'never',cost:{kind:'free'},reconciliation:{kind:'receipt'},compensation:{kind:'none',requiresApproval:true},evidenceRefs:['fixture:review']};
  const policy={maxBudget:1,maxAgents:1,maxConcurrentAgents:1,maxModelCalls:32,maxTaskModelCalls:16,deadlineSeconds:180};
  await pool.query("INSERT INTO projects(id,department_id,department_version,department_name,requirement,policy,plan,source) VALUES('project','department',1,'fixture','fixture',$1,$2,'manual')",[policy,{agents:[agent],tasks:[]}]);
  const snapshot={projectId:'project',planVersion:1,departmentId:'department',executionProfile:'legacy-run-v1',agents:[agent],tasks:[],policy,effectContractVersion:1,effectContracts:[contract]};
  const archive=createRunArchive(traceRoot,snapshot),workspace=join(archive.dir,'artifacts');mkdirSync(workspace);writeFileSync(join(workspace,'result.txt'),'checkpoint version\r\n');
  const checkpoint=commitStepCheckpoint({archive,workspace,boundary:{taskId:'employee',attemptId:'first',sessionId:'fixture',trigger:'tool-result',eventCursor:1,contractHash:'a'.repeat(64)},receipts:[]});
  writeFileSync(join(workspace,'result.txt'),'later version\r\n');
  await pool.query("INSERT INTO project_runs(id,project_id,project_version,status,snapshot,lease_owner,lease_until) VALUES($1,'project',1,'running',$2,'owner',now()+interval '1 hour')",[archive.id,snapshot]);
  const {ToolEffectContractService}=await import('../apps/api/src/tool-effect-contracts.ts');
  const {ToolOperationService}=await import('../apps/api/src/tool-operations.ts');
  const {effectDigest}=await import('../services/agent-runtime/tool-effects.mjs');
  const contracts=new ToolEffectContractService({db:pool,resolveBinding:async()=>contract as any});await contracts.review({namespace:contract.namespace,toolName:contract.toolName},effectDigest(contract),actor);
  const ops=new ToolOperationService({db:pool,writers,contracts}).forRun(archive.id,'owner');
  const prepare=()=>({contract:contract as any,agentId:'employee',sessionId:'fixture',callId:randomUUID(),argumentsSha256:effectDigest({})});
  const parent=await ops.prepare(prepare());await ops.dispatch({operationId:parent.operationId,expectedVersion:1,intentSha256:parent.intentSha256});
  const child=await ops.prepare({...prepare(),parentOperationId:parent.operationId});
  await ops.markUnknown({operationId:parent.operationId,intentSha256:parent.intentSha256,reasonCode:'FIXTURE_RESULT_UNKNOWN'});
  await pool.query("UPDATE project_runs SET status='cancelled' WHERE id=$1",[archive.id]);archive.append('run/finished',{status:'cancelled'});
  const {appendAudit,auditActor}=await import('../apps/api/src/audit-events.ts');
  const {lockDepartmentAuthority}=await import('../apps/api/src/project-route-access.ts');
  const auditClient=await pool.connect(),requestAuditId=randomUUID(),decisionAuditId=randomUUID(),decisionRequestId=randomUUID();
  try{
    await auditClient.query('BEGIN');const authority=await lockDepartmentAuthority(auditClient,actor,['department'],'operator');
    await appendAudit(auditClient,{eventId:requestAuditId,action:'project.approve',actor:auditActor(actor),authority,correlation:{correlationId:decisionRequestId,requestId:decisionRequestId},resource:{type:'project',id:'project',departmentIds:['department']},outcome:'success',changes:{version:'1'}});
    await appendAudit(auditClient,{eventId:decisionAuditId,action:'tool.approval',actor:auditActor(actor),authority,requestedByAuditId:requestAuditId,correlation:{correlationId:decisionRequestId,requestId:decisionRequestId,runId:archive.id},resource:{type:'tool_operation',id:'approval',departmentIds:['department']},outcome:'success',changes:{decision:'approved'}});
    await auditClient.query("INSERT INTO tool_approvals(id,run_id,agent_id,tool,arguments,status,decided_at,decided_by_user_id,decided_epoch,decision_actor_kind,decision_request_id,decision_reason,decision_audit_id) VALUES('approval',$1,'employee','filesystem','{}','approved',now(),$2,0,'human',$3,'approved-by-current-authority',$4)",[archive.id,actor.userId,decisionRequestId,decisionAuditId]);
    await auditClient.query('COMMIT');
  }catch(error){await auditClient.query('ROLLBACK');throw error;}finally{auditClient.release();}
  await pool.query("INSERT INTO local_devices(id,token_hash,name,platform,grant_id,label) VALUES('old-device','do-not-export-device-token','fixture','fixture','old-grant','fixture')");
  await pool.query("INSERT INTO model_reservations(id,model_id,project_id,run_id,purpose,amount,input_rate,output_rate,status) VALUES('unknown-fee','model','project',$1,'fixture',0.123456789012345678901,0.4,1.6,'uncertain')",[archive.id]);
  await pool.query("INSERT INTO usage(id,model_id,project_id,cost,input_tokens,output_tokens,purpose) VALUES('usage','model','project',0.0001234567890123456789,1,2,'fixture')");
  // JSON numbers must not pass through JS number during export.
  await pool.query(`UPDATE models SET data='{"precise":9007199254740993123456789}'::jsonb,capabilities='null'::jsonb WHERE id='model'`);
  await pool.query("INSERT INTO knowledge_spaces(id,name,scope) VALUES('space','fixture','company')");
  const {saveKnowledgeDocument}=await import('../apps/api/src/knowledge.ts');
  const doc=await saveKnowledgeDocument({spaceId:'space',title:'方法',content:'旧版本'},undefined,true,undefined,{principal:actor});
  await saveKnowledgeDocument({spaceId:'space',title:'方法',content:'新版本',version:1},doc.id,false,undefined,{principal:actor});
  const code=Buffer.from('export default {};'),compressed=gzipSync(code),metadata=Buffer.from('{"name":"fixture","version":"1.0.0"}');
  const manifest={format:'dsh-native-tools-v1',namespace:'fixture',package:'fixture',version:'1.0.0',dshVersion:'0.1.5-rc.1',lockSha256:'1'.repeat(64),source:{kind:'company',reference:'synthetic-only'},config:{},bundle:{bytes:compressed.length,sha256:hash(compressed),codeSha256:hash(code),metadataSha256:hash(metadata)},tools:[{name:'plugin__fixture__read',originalName:'read',description:'synthetic-only',parameters:{type:'object'},files:{read:[],write:[]}}]};
  const bundleId=nativeManifestId(manifest),bundleRoot=join(root,'native-plugins',bundleId);mkdirSync(bundleRoot,{recursive:true});
  writeFileSync(join(bundleRoot,'manifest.json'),JSON.stringify(manifest));writeFileSync(join(bundleRoot,'bundle.gz'),compressed);writeFileSync(join(bundleRoot,'package.json'),metadata);
  await pool.query("INSERT INTO native_capabilities(namespace,manifest_id,enabled) VALUES('fixture',$1,true)",[bundleId]);
  // Managed non-UUID paths must not be silently omitted like the legacy format.
  mkdirSync(join(traceRoot,'managed'));writeFileSync(join(traceRoot,'managed','evidence.txt'),'managed bytes');
  const take=()=>implementation.exportEnterpriseBackup({principal:actor,traceRoot,writers,state,password});
  const sourceDigest=async()=>{
    const rows=[];for(const table of Object.keys(enterpriseTableSpecs))rows.push([table,(await pool.query(`SELECT row_to_json(t)::text AS value FROM ${table} t ORDER BY row_to_json(t)::text`)).rows]);
    const bytes:Record<string,string>={};for(const base of [traceRoot,join(root,'vault'),join(root,'native-plugins')])for(const entry of readdirSync(base,{recursive:true,withFileTypes:true}))if(entry.isFile())bytes[join(entry.parentPath,entry.name)]=hash(readFileSync(join(entry.parentPath,entry.name)));
    return hash(JSON.stringify({rows,bytes,master:hash(readFileSync(join(root,'credential.key')))}));
  };
  await t.test('full encrypted snapshot has all fixed tables, immutable audit and exact textual codecs',async()=>{
    const before=await sourceDigest(),backup=await take(),value=await decryptEnterpriseBackup(backup,password);
    assert.equal(await sourceDigest(),before);assert.equal(value.source.databaseId,(await pool.query('SELECT database_id FROM backup_restore_anchor WHERE singleton=1')).rows[0].database_id);
    assert.equal(value.source.engine,'pglite');assert.deepEqual(Object.keys(value.tables).sort(),Object.keys(enterpriseTableSpecs).sort());
    for(const [table,rows] of Object.entries(value.tables))assert.equal(rows.length,(await pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n,table);
    assert.equal(value.tables.model_reservations[0].amount,'0.123456789012345678901');assert.equal(value.tables.usage[0].cost,'0.0001234567890123456789');
    assert.match(String(value.tables.models[0].data),/9007199254740993123456789/);assert.equal(value.tables.models[0].capabilities,'null');
    assert.ok(value.tables.human_audit_events.length>=3);assert.equal(value.tables.knowledge_revisions.length,2);
    assert.equal(value.tables.tool_approvals[0].decision_audit_id,decisionAuditId);assert.equal(value.tables.human_audit_events.find(row=>row.id===decisionAuditId)?.requested_by_audit_id,requestAuditId);
    assert.equal(value.tables.local_operations.find(row=>row.id===parent.operationId)?.effect_state,'unknown');assert.equal(value.tables.local_operations.find(row=>row.id===child.operationId)?.parent_operation_id,parent.operationId);
    assert.equal('token_hash' in value.tables.local_devices[0],false);assert.equal('claim_token' in value.tables.local_operations[0],false);
    assert.equal(value.files['managed/evidence.txt'],Buffer.from('managed bytes').toString('base64'));assert.equal(value.files[archive.id+'/artifacts/result.txt'],Buffer.from('later version\r\n').toString('base64'));
    assert.ok(Object.keys(value.files).some(path=>path.startsWith(archive.id+'/checkpoint-objects/')));assert.ok(value.nativePluginBundles[bundleId]);assert.equal(Object.keys(value.vaultFiles).length,1);
    assert.ok(!JSON.stringify(backup).includes('do-not-export-device-token'));assert.ok(checkpoint.id);
  });
  await t.test('active execution and model calls block export, with known failures leaving source usable',async()=>{
    for(const [table,id,column,blocked,original] of [['project_runs',archive.id,'status','running','cancelled'],['model_reservations','unknown-fee','status','pending','uncertain']] as const){
      await pool.query(`UPDATE ${table} SET ${column}=$1 WHERE id=$2`,[blocked,id]);const before=await sourceDigest();
      try{await assert.rejects(take(),(error:any)=>error.status===409&&error.code==='BACKUP_SOURCE_BUSY');assert.equal(await sourceDigest(),before);}finally{await pool.query(`UPDATE ${table} SET ${column}=$1 WHERE id=$2`,[original,id]);}
    }await take();
  });
  await t.test('revoked principals cannot export',async()=>{
    await pool.query("UPDATE human_users SET status='disabled' WHERE id=$1",[actor.userId]);
    try{await assert.rejects(take(),(error:any)=>[403,404].includes(error.status));}finally{await pool.query("UPDATE human_users SET status='active' WHERE id=$1",[actor.userId]);}await take();
  });
  await t.test('active manager and capability probes block a consistent snapshot',async()=>{
    await pool.query("INSERT INTO manager_messages(id,project_id,project_version,content,status,max_cost,model_id) VALUES('busy-message','project',1,'fixture','replying',0.01,'model')");
    try{await assert.rejects(take(),(error:any)=>error.code==='BACKUP_SOURCE_BUSY');}finally{await pool.query("DELETE FROM manager_messages WHERE id='busy-message'");}
    await pool.query("INSERT INTO model_capability_tests(id,model_id,model_version,probe_version,status) VALUES('busy-probe','model',1,'fixture','running')");
    try{await assert.rejects(take(),(error:any)=>error.code==='BACKUP_SOURCE_BUSY');}finally{await pool.query("DELETE FROM model_capability_tests WHERE id='busy-probe'");}await take();
  });
  await t.test('missing checkpoint CAS and hardlinked files reject without latching source',async()=>{
    const objects=join(archive.dir,'checkpoint-objects'),path=join(objects,readdirSync(objects)[0]),bytes=readFileSync(path);unlinkSync(path);
    try{await assert.rejects(take(),(error:any)=>error.status===422&&error.code==='BACKUP_REFERENCE_INVALID');}finally{writeFileSync(path,bytes);}
    const alias=join(workspace,'hardlink.txt');linkSync(join(workspace,'result.txt'),alias);
    try{await assert.rejects(take(),(error:any)=>error.status===422&&error.code==='BACKUP_FILE_UNSAFE');}finally{unlinkSync(alias);}await take();
  });
  await t.test('changed vault bytes are not silently reindexed during export',async()=>{
    const row=(await pool.query('SELECT vault_path FROM knowledge_documents WHERE id=$1',[doc.id])).rows[0],path=join(root,'vault',row.vault_path),bytes=readFileSync(path);writeFileSync(path,'unsynced edit');
    const before=await sourceDigest();try{await assert.rejects(take(),(error:any)=>error.code==='BACKUP_VAULT_UNSYNCED');assert.equal(await sourceDigest(),before);}finally{writeFileSync(path,bytes);}await take();
  });
  await t.test('sealed credentials cannot be exported without their original master key',async()=>{
    const path=join(root,'credential.key'),bytes=readFileSync(path);unlinkSync(path);
    try{await assert.rejects(take(),(error:any)=>error.code==='BACKUP_CREDENTIAL_KEY_MISSING');}finally{writeFileSync(path,bytes);}await take();
  });
  await t.test('root writer fence blocks snapshot overlap and releases after writer completes',async()=>{
    let entered!:()=>void,release!:()=>void;const ready=new Promise<void>(r=>entered=r),hold=new Promise<void>(r=>release=r);
    const writing=writers.withWriter([archive.id],async()=>{entered();await hold;});await ready;
    try{await assert.rejects(take(),(error:any)=>error.code==='BACKUP_SOURCE_BUSY');}finally{release();await writing;}await take();
  });
});
