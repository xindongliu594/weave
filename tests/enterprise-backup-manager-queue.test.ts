import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createArchiveWriterManager} from '../services/agent-runtime/archive-writer-scope.mjs';
import {createBackupRestoreState} from '../apps/api/src/backup-restore-state.ts';
import {createEnterpriseBackup,decryptEnterpriseBackup} from '../apps/api/src/enterprise-backup-schema.ts';

test('enterprise backup cannot carry a queued manager request into an activated target',async t=>{
 assert.equal(process.env.SIMULATED_INTEGRATION,'pglite');
 const root=mkdtempSync(join(tmpdir(),'enterprise-manager-')),schema='manager_target_'+randomUUID().replaceAll('-','');
 function environment(name:string){const folder=join(root,name);Object.assign(process.env,{DATA_DIR:folder,TRACE_ROOT:join(folder,'runs'),OBSIDIAN_VAULT:join(folder,'vault')});mkdirSync(join(folder,'runs'),{recursive:true});return folder;}
 const sourceRoot=environment('source');writeFileSync(join(sourceRoot,'runs','delivery.txt'),'preserved delivery');
 const {pool,migrate}=await import('../apps/api/src/db.ts');await migrate();
 t.after(async()=>{await pool.query('SET search_path TO public');await pool.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await pool.end();rmSync(root,{recursive:true,force:true});});
 const {exportEnterpriseBackup,readEnterpriseTables}=await import('../apps/api/src/enterprise-backup-export.ts'),{restoreEnterpriseBackup}=await import('../apps/api/src/enterprise-backup-restore.ts');
 await pool.query("INSERT INTO departments(id,data) VALUES('department','{}')");
 await pool.query("INSERT INTO models(id,data) VALUES('model','{}')");
 await pool.query("INSERT INTO projects(id,department_id,department_version,department_name,requirement,policy,plan,source) VALUES('project','department',1,'fixture','fixture','{}','{}','manual')");
 await pool.query("INSERT INTO manager_messages(id,project_id,project_version,content,status,max_cost,model_id) VALUES('queued','project',1,'preserve this request','waiting',0.02,'model')");
 const sourceWriters=createArchiveWriterManager({traceRoot:join(sourceRoot,'runs')}),sourceState=createBackupRestoreState({pool,writers:sourceWriters,traceRoot:join(sourceRoot,'runs'),dataRoot:sourceRoot});
 const password='synthetic-manager-backup',take=()=>exportEnterpriseBackup({principal:{kind:'local-owner'},traceRoot:join(sourceRoot,'runs'),writers:sourceWriters,state:sourceState,password});
 for(const status of ['waiting','replying'])await t.test('export rejects '+status+' without changing source or fees',async()=>{
  await pool.query('UPDATE manager_messages SET status=$1',[status]);const before=JSON.stringify(await readEnterpriseTables(pool));
  await assert.rejects(take(),(error:any)=>error.status===409&&error.code==='BACKUP_SOURCE_BUSY');
  assert.equal(JSON.stringify(await readEnterpriseTables(pool)),before);assert.equal(readFileSync(join(sourceRoot,'runs','delivery.txt'),'utf8'),'preserved delivery');
 });
 let payload:any;
 await t.test('completed and explicitly cancelled manager history remains exportable',async()=>{
  for(const status of ['replied','failed','cancelled']){
   await pool.query('UPDATE manager_messages SET status=$1',[status]);const before=JSON.stringify(await readEnterpriseTables(pool));payload=await decryptEnterpriseBackup(await take(),password);
   assert.equal(payload.tables.manager_messages[0].status,status);assert.equal(payload.tables.manager_messages[0].content,'preserve this request');assert.equal(JSON.stringify(await readEnterpriseTables(pool)),before);
  }
 });
 assert.ok(payload,'Need a valid terminal-history backup');const sourceBefore=JSON.stringify(await readEnterpriseTables(pool));
 await pool.query('CREATE SCHEMA '+schema);await pool.query('SET search_path TO '+schema+',public');await migrate();const targetRoot=environment('target'),traceRoot=join(targetRoot,'runs');
 const writers=createArchiveWriterManager({traceRoot}),state=createBackupRestoreState({pool,writers,traceRoot,dataRoot:targetRoot});
 // Create the ordinary lock inode before comparing business/staging files.
 // Acquiring this reusable gate is not publication of a restore operation.
 await writers.withRootExclusive(async()=>{});
 for(const status of ['waiting','replying'])await t.test('import rejects a valid '+status+' package before staging or publishing authority',async()=>{
  const {manifest:_manifest,...base}=payload,altered=createEnterpriseBackup({...base,tables:{...payload.tables,manager_messages:payload.tables.manager_messages.map((row:any)=>({...row,status}))}});
  const before=JSON.stringify(await readEnterpriseTables(pool)),files=readdirSync(targetRoot,{recursive:true}).sort();
  await assert.rejects(restoreEnterpriseBackup({principal:{kind:'local-owner'},payload:altered,traceRoot,writers,state}),(error:any)=>error.status===422&&error.code==='BACKUP_SOURCE_BUSY');
  assert.equal(JSON.stringify(await readEnterpriseTables(pool)),before);assert.deepEqual(readdirSync(targetRoot,{recursive:true}).sort(),files);
  for(const table of ['enterprise_restore_admission','backup_restore_receipts'])assert.equal((await pool.query('SELECT * FROM '+table)).rowCount,0);
  assert.equal((await pool.query('SELECT generation::text FROM backup_restore_anchor')).rows[0].generation,'0');
 });
 await t.test('valid cancelled history imports after rejected attempts without recreating a waiting request',async()=>{
  const restored=await restoreEnterpriseBackup({principal:{kind:'local-owner'},payload,traceRoot,writers,state});assert.equal(restored.status,'quarantined');
  assert.equal((await pool.query('SELECT status FROM manager_messages')).rows[0].status,'cancelled');assert.equal((await pool.query('SELECT * FROM model_reservations')).rowCount,0);
  assert.equal(readFileSync(join(traceRoot,'delivery.txt'),'utf8'),'preserved delivery');
 });
 await pool.query('SET search_path TO public');assert.equal(JSON.stringify(await readEnterpriseTables(pool)),sourceBefore);
 t.diagnostic(JSON.stringify({sourceUnchanged:true,modelCalls:0}));
});
