import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {once} from 'node:events';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import type http from 'node:http';
import type pg from 'pg';

// Only the guarded isolated integration runner may provide this database.
if(process.env.SIMULATED_INTEGRATION!=='pglite')throw Error('Use scripts/test-integration.mjs for this fixture');
let pool:pg.Pool,server:http.Server,root:string,base:string,backup:any;
const password='isolated-restore-fixture',runId=randomUUID(),key=Buffer.alloc(32,7);
async function post(path:string,body:any){const response=await fetch(base+'/backup/'+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});return {status:response.status,data:await response.json()};}
before(async()=>{
 root=await mkdtemp(join(tmpdir(),'weiwu-restore-protection-'));process.env.DATA_DIR=root;process.env.OBSIDIAN_VAULT=join(root,'vault');process.env.TRACE_ROOT=join(root,'runs');
 await mkdir(join(root,'runs'),{recursive:true});await writeFile(join(root,'credential.key'),key);
 const db=await import('../apps/api/src/db.ts');pool=db.pool;await db.migrate();
 const agent={id:'backup-manager',name:'Fixture manager',role:'manager',modelId:'unused-model',instructions:'No model calls',tools:[]};
 const policy={maxBudget:1,maxAgents:1,maxConcurrentAgents:1,deadlineSeconds:300,allowedModelIds:['unused-model'],allowedTools:[],allowedKnowledgeSpaceIds:[],allowedDepartmentIds:['source-department']};
 const plan={agents:[agent],tasks:[]};
 await pool.query("INSERT INTO departments(id,data) VALUES('source-department',$1)",[{name:'Fixture source',agents:[agent]}]);
 await pool.query("INSERT INTO projects(id,department_id,department_version,department_name,requirement,policy,plan,status,source) VALUES('source-project','source-department',1,'Fixture source','Synthetic backup only',$1,$2,'COMPLETED','manual')",[policy,plan]);
 await pool.query("INSERT INTO project_runs(id,project_id,project_version,status,snapshot) VALUES($1,'source-project',1,'completed',$2)",[runId,{projectId:'source-project',projectVersion:1,departmentId:'source-department',agents:[agent],policy}]);
 await pool.query("INSERT INTO tool_approvals(id,run_id,agent_id,tool,arguments,status,decided_at) VALUES('legacy-approval',$1,'backup-manager','fixture-read','{}','approved',now())",[runId]);
 const {backupRouter}=await import('../apps/api/src/backup.ts');
 const {createArchiveWriterManager}=await import('../services/agent-runtime/archive-writer-scope.mjs');
 const {createBackupRestoreState,migrateBackupRestoreState}=await import('../apps/api/src/backup-restore-state.ts');await migrateBackupRestoreState(pool);
 const writers=createArchiveWriterManager({traceRoot:join(root,'runs')}),state=createBackupRestoreState({pool,writers,traceRoot:join(root,'runs'),dataRoot:root});await state.reconcilePending();
 const app=express();app.use(express.json({limit:'50mb'}));app.use((_req,res,next)=>{res.locals.principal={kind:'local-owner'};next();});app.use(backupRouter(join(root,'runs'),writers,state));
 app.use((error:any,_req:any,res:any,_next:any)=>res.status(error.status??500).json({code:error.code,message:error.message}));
 server=app.listen(0,'127.0.0.1');await once(server,'listening');base='http://127.0.0.1:'+(server.address() as any).port;
 const response=await post('export',{password});assert.equal(response.status,200,JSON.stringify(response.data));backup=response.data;
});
after(async()=>{if(server)await new Promise<void>(resolve=>server.close(()=>resolve()));await pool?.end();if(root)await rm(root,{recursive:true,force:true});});

test('legacy encrypted restore remains available for a destination without enterprise history',async()=>{
 const response=await post('restore',{password,backup,confirmation:'RESTORE'});
 assert.equal(response.status,200,JSON.stringify(response.data));assert.deepEqual(await readFile(join(root,'credential.key')),key);
 const old=(await pool.query("SELECT status,decision_actor_kind,decided_by_user_id,decided_epoch,decision_request_id,decision_reason,decision_audit_id FROM tool_approvals WHERE id='legacy-approval'")).rows[0];
 assert.deepEqual(old,{status:'approved',decision_actor_kind:null,decided_by_user_id:null,decided_epoch:null,decision_request_id:null,decision_reason:null,decision_audit_id:null});
});

test('business-only imports reject human authority before staging or SQL replacement',async()=>{
 const {decryptBackup,encryptBackup}=await import('../apps/api/src/backup.ts');
 const paths=(await readdir(root)).sort();
 for(const authority of [{requested_by_user_id:'absent-human'},{authorized_by_user_id:'absent-human'},{authority_kind:'human',authorized_epoch:1},{authority_kind:'automatic-policy'}]){
  const value=await decryptBackup(backup,password);
  Object.assign(value.tables.project_runs[0],authority);
  const response=await post('restore',{password,backup:await encryptBackup(value,password),confirmation:'RESTORE'});
  assert.equal(response.status,422,JSON.stringify(response.data));
  assert.equal(response.data.code,'BACKUP_IDENTITY_DEPENDENCIES_UNSUPPORTED');
  assert.deepEqual((await readdir(root)).sort(),paths,'unsupported source was rejected before staging');
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM project_runs')).rows[0].count,1);
  assert.deepEqual(await readFile(join(root,'credential.key')),key);
 }
 for(const [table,row] of [['manager_messages',{authorized_by_user_id:'absent-human',authority_kind:'human'}],['human_users',{id:'ignored-human'}]] as const){
  const value=await decryptBackup(backup,password);value.tables[table]??=[];value.tables[table].push(row);
  const response=await post('restore',{password,backup:await encryptBackup(value,password),confirmation:'RESTORE'});
  assert.equal(response.status,422,JSON.stringify(response.data));assert.equal(response.data.code,'BACKUP_IDENTITY_DEPENDENCIES_UNSUPPORTED');
  assert.deepEqual((await readdir(root)).sort(),paths);
 }
 // Even incomplete imported decision metadata depends on identity/audit history.
 // Reject it before staging, rather than stripping it or failing on an FK later.
 const decisionFields={decided_by_user_id:'absent-human',decided_epoch:1,decision_actor_kind:'local-owner',decision_request_id:'fixture-request',decision_reason:'fixture reason',decision_audit_id:'absent-audit'};
 for(const [field,value] of Object.entries(decisionFields)){
  const payload=await decryptBackup(backup,password);
  payload.tables.tool_approvals=[{id:'untrusted-decision',run_id:runId,status:'approved',[field]:value}];
  const response=await post('restore',{password,backup:await encryptBackup(payload,password),confirmation:'RESTORE'});
  assert.equal(response.status,422,`${field}: ${JSON.stringify(response.data)}`);
  assert.equal(response.data.code,'BACKUP_IDENTITY_DEPENDENCIES_UNSUPPORTED',field);
  assert.deepEqual((await readdir(root)).sort(),paths,'decision metadata must be rejected before staging');
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM project_runs')).rows[0].count,1);
  assert.deepEqual(await readFile(join(root,'credential.key')),key);
 }
});

test('authority-only source cannot create an archive that its importer would reject',async()=>{
 await pool.query("INSERT INTO knowledge_spaces(id,name,scope,vault_folder) VALUES('authority-note-space','Authority pending note','company','authority-source')");
 const folder=join(root,'vault','authority-source'),note=join(folder,'note.md'),content='# Authority source\n\nNot indexed by a rejected export.\n';
 await mkdir(folder,{recursive:true});await writeFile(note,content);
 const before=(await pool.query('SELECT * FROM knowledge_documents')).rows;
 await pool.query("UPDATE project_runs SET authority_kind='automatic-policy' WHERE id=$1",[runId]);
 try{const response=await post('export',{password});assert.equal(response.status,422,response.data.message);assert.equal(response.data.code,'BACKUP_IDENTITY_DEPENDENCIES_UNSUPPORTED');
  assert.deepEqual((await pool.query('SELECT * FROM knowledge_documents')).rows,before);assert.equal(await readFile(note,'utf8'),content);}
 finally{await pool.query('UPDATE project_runs SET authority_kind=NULL WHERE id=$1',[runId]);}
});

test('activated bootstrap alone protects an otherwise empty target before SQL clear and file swap',async()=>{
 await pool.query("UPDATE identity_bootstrap SET expected_fingerprint='fixture-fingerprint',activated_at=now(),version=version+1 WHERE id=1");
 const before=(await pool.query('SELECT * FROM identity_bootstrap')).rows;
 const response=await post('restore',{password,backup,confirmation:'RESTORE'});
 assert.equal(response.status,409,JSON.stringify(response.data));assert.equal(response.data.code,'BACKUP_DESTINATION_PROTECTED');
 assert.deepEqual((await pool.query('SELECT * FROM identity_bootstrap')).rows,before);
 const exported=await post('export',{password});assert.equal(exported.status,409,exported.data.message);assert.equal(exported.data.code,'BACKUP_SOURCE_IDENTITY_UNSUPPORTED');
 // Remove only this isolated fixture's bootstrap to exercise independent audit/user protection next.
 await pool.query('UPDATE identity_bootstrap SET expected_fingerprint=NULL,activated_at=NULL,version=1 WHERE id=1');
});

test('restore preserves destination users, membership, audits, outbox, projection, files and key',async()=>{
 await pool.query("INSERT INTO departments(id,data) VALUES('target-department',$1)",[{name:'Destination only'}]);
 await pool.query("INSERT INTO human_users(id,issuer,subject,status,org_role) VALUES('target-user','https://fixture.invalid','fixture-subject','active','admin')");
 await pool.query("INSERT INTO department_memberships(department_id,user_id,role) VALUES('target-department','target-user','manager')");
 await pool.query("INSERT INTO human_audit_events(id,actor_kind,actor_user_id,actor_snapshot,action,resource_type,resource_id,department_id,outcome) VALUES('target-audit','human','target-user',$1,'fixture','department','target-department','target-department','success')",[{id:'target-user'}]);
 await pool.query("INSERT INTO audit_outbox(id,audit_event_id,event_type,payload) VALUES('target-outbox','target-audit','fixture',$1)",[{fixture:true}]);
 await pool.query("INSERT INTO audit_run_projection(audit_event_id,correlation_id,occurred_at,summary) SELECT id,'fixture-correlation',occurred_at,$1 FROM human_audit_events WHERE id='target-audit'",[{fixture:true}]);
 await mkdir(join(root,'runs',runId,'artifacts'),{recursive:true});await writeFile(join(root,'runs',runId,'artifacts','kept.txt'),'keep target evidence');
 const names=['departments','human_users','department_memberships','human_audit_events','audit_outbox','audit_run_projection','identity_bootstrap'];
 const before=await Promise.all(names.map(async name=>(await pool.query('SELECT * FROM '+name)).rows));
 const paths=(await readdir(root)).filter(name=>!name.startsWith('before-restore-')).sort();
 const response=await post('restore',{password,backup,confirmation:'RESTORE'});
 assert.equal(response.status,409,JSON.stringify(response.data));assert.equal(response.data.code,'BACKUP_DESTINATION_PROTECTED');
 assert.deepEqual(await Promise.all(names.map(async name=>(await pool.query('SELECT * FROM '+name)).rows)),before);
 assert.equal(await readFile(join(root,'runs',runId,'artifacts','kept.txt'),'utf8'),'keep target evidence');assert.deepEqual(await readFile(join(root,'credential.key')),key);
 assert.deepEqual((await readdir(root)).filter(name=>!name.startsWith('before-restore-')).sort(),paths,'rejected stage is removed; target was not swapped');
});

test('online business export refuses enterprise identity and audit omission without changing source',async()=>{
 const names=['human_users','department_memberships','human_audit_events','audit_outbox','audit_run_projection'];
 const before=await Promise.all(names.map(async name=>(await pool.query('SELECT * FROM '+name)).rows));
 const response=await post('export',{password});
 assert.equal(response.status,409,response.data.message);
 assert.equal(response.data.code,'BACKUP_SOURCE_IDENTITY_UNSUPPORTED');
 assert.equal(response.data.data,undefined,'no misleading encrypted business-only archive returned');
 assert.deepEqual(await Promise.all(names.map(async name=>(await pool.query('SELECT * FROM '+name)).rows)),before);
 assert.deepEqual(await readFile(join(root,'credential.key')),key);
});

test('a protected source is rejected before Obsidian indexing changes knowledge or note bytes',async()=>{
 await pool.query("INSERT INTO knowledge_spaces(id,name,scope,vault_folder) VALUES('pending-note-space','Pending note','company','source')");
 const folder=join(root,'vault','source'),note=join(folder,'note.md'),content='# Review note\n\nAn unchanged local note pending indexing.\n';
 await mkdir(folder,{recursive:true});await writeFile(note,content);
 const names=['knowledge_documents','knowledge_revisions','knowledge_chunks'];
 const before=await Promise.all(names.map(async name=>(await pool.query('SELECT * FROM '+name)).rows));
 const response=await post('export',{password});
 assert.equal(response.status,409,response.data.message);assert.equal(response.data.code,'BACKUP_SOURCE_IDENTITY_UNSUPPORTED');
 assert.deepEqual(await Promise.all(names.map(async name=>(await pool.query('SELECT * FROM '+name)).rows)),before);
 assert.equal(await readFile(note,'utf8'),content);
});
