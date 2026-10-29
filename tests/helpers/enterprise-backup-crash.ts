import assert from 'node:assert/strict';
import type {TestContext} from 'node:test';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync,realpathSync} from 'node:fs';
import {join,relative} from 'node:path';
import {tmpdir} from 'node:os';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {gzipSync} from 'node:zlib';

const hash=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');
const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
export const enterpriseCrashPhases=['prepared','old-moved','installed','committed'] as const;

/** Each case owns two complete schemas and directories. Only the child dies;
 * the source is never the restore target, even in the negative cases. */
export async function enterpriseCrashCase(phase:typeof enterpriseCrashPhases[number],native:boolean,t:TestContext,fault?:'marker'|'generation'|'file'){
 assert.ok(native||process.env.SIMULATED_INTEGRATION==='pglite');
 const root=mkdtempSync(join(realpathSync(tmpdir()),'weiwu-backup-state-')),sourceRoot=join(root,'source'),sourceSchema='enterprise_crash_source_'+randomUUID().replaceAll('-',''),targetSchema='enterprise_crash_target_'+randomUUID().replaceAll('-','');
 const owner={root,pid:process.pid,kind:'enterprise-v2',schema:targetSchema};writeFileSync(join(root,'.owned-backup-test.json'),JSON.stringify(owner));
 mkdirSync(sourceRoot);Object.assign(process.env,{DATA_DIR:sourceRoot,TRACE_ROOT:join(sourceRoot,'runs'),OBSIDIAN_VAULT:join(sourceRoot,'vault'),LOCAL_WORKSPACE_ROOT:sourceRoot});
 const {pool,migrate}=await import('../../apps/api/src/db.ts');const children:Array<{child:ReturnType<typeof fork>;exited:Promise<any>}> = [];
 async function spawn(action:string){
  const child=fork(fileURLToPath(new URL('../fixtures/backup-restore-crash.mjs',import.meta.url)),[],{execArgv:['--import','tsx'],stdio:['ignore','inherit','inherit','ipc'],env:{...process.env,OWNED_BACKUP_NATIVE_TEST:String(native),OWNED_BACKUP_RESTART_TEST:JSON.stringify({root,kind:'enterprise-v2',runId:'history',action,phase})}}),exited=once(child,'exit');children.push({child,exited});return {child,exited};
 }
 try{
  await pool.query('CREATE SCHEMA '+sourceSchema);await pool.query('SET search_path TO '+sourceSchema+',public');await migrate();
  await pool.query("INSERT INTO human_users(id,issuer,subject,status,org_role) VALUES('source-admin','https://fixture.invalid','admin','active','admin')");
  await pool.query("INSERT INTO activity(id,kind,title) VALUES('source-history','fixture','Preserve original history')");
  await pool.query("INSERT INTO models(id,data,status) VALUES('source-model','{}','available')");
  await pool.query("INSERT INTO model_reservations(id,model_id,purpose,amount,input_rate,output_rate,status,expires_at) VALUES('source-unknown','source-model','fixture',0.02,1,2,'uncertain',now()-interval '1 hour')");
  const deviceId=randomUUID();await pool.query("INSERT INTO local_devices(id,token_hash,name,platform,grant_id,label,allow_commands) VALUES($1,$2,'Fixture','linux',$3,'fixture',false)",[deviceId,'a'.repeat(64),randomUUID()]);
  const {appendAudit}=await import('../../apps/api/src/audit-events.ts'),eventId=randomUUID();
  await appendAudit(pool,{eventId,action:'capability.configure',actor:{kind:'human',userId:'source-admin',orgRole:'admin'},correlation:{correlationId:eventId},resource:{type:'capability',id:'fixture',departmentIds:[]},outcome:'success',changes:{enabled:false,version:'1'},authority:{decisionId:eventId,checkedAt:new Date().toISOString(),policyVersion:'fixture',principalKey:'human:source-admin',departmentIds:[],membershipVersions:[],grantVersions:[],permissionSha256:'b'.repeat(64)}});
  const {createArchiveWriterManager}=await import('../../services/agent-runtime/archive-writer-scope.mjs'),{createBackupRestoreState}=await import('../../apps/api/src/backup-restore-state.ts');
  const sourceTrace=join(sourceRoot,'runs'),writers=createArchiveWriterManager({traceRoot:sourceTrace});mkdirSync(join(sourceTrace,'history'));writeFileSync(join(sourceTrace,'history','proof.txt'),'source delivery');writeFileSync(join(sourceRoot,'credential.key'),Buffer.alloc(32,9));
  await pool.query("INSERT INTO knowledge_spaces(id,name,scope) VALUES('source-space','Fixture','company')");
  const {saveKnowledgeDocument}=await import('../../apps/api/src/knowledge.ts');const note=await saveKnowledgeDocument({spaceId:'source-space',title:'Fixture note',content:'Preserve this exact note and immutable revision.'});
  const vaultPath=(await pool.query('SELECT vault_path FROM knowledge_documents WHERE id=$1',[note.id])).rows[0].vault_path,noteBytes=readFileSync(join(sourceRoot,'vault',vaultPath));
  const code=Buffer.from('Fixture plugin bytes; never executed'),compressed=gzipSync(code),metadata=Buffer.from('{}'),manifest={format:'dsh-native-tools-v1',namespace:'fixture',package:'@company/fixture',version:'1.0.0',source:{kind:'company',reference:'private'},dshVersion:'0.1.5-rc.1',config:{},lockSha256:hash('lock'),bundle:{sha256:hash(compressed),codeSha256:hash(code),metadataSha256:hash(metadata),bytes:compressed.length},tools:[{name:'plugin__fixture__read',originalName:'read',description:'Read',parameters:{type:'object'},files:{read:['file'],write:[]}}]};
  const {nativeManifestId}=await import('../../services/agent-runtime/native-capabilities.mjs'),bundleId=nativeManifestId(manifest),bundleRoot=join(sourceRoot,'native-plugins',bundleId);mkdirSync(bundleRoot,{recursive:true});writeFileSync(join(bundleRoot,'manifest.json'),JSON.stringify(manifest));writeFileSync(join(bundleRoot,'bundle.gz'),compressed);writeFileSync(join(bundleRoot,'package.json'),metadata);
  await pool.query('INSERT INTO native_capabilities(namespace,manifest_id,enabled) VALUES(\'fixture\',$1,true)',[bundleId]);
  const {readEnterpriseTables,exportEnterpriseBackup}=await import('../../apps/api/src/enterprise-backup-export.ts'),{decryptEnterpriseBackup}=await import('../../apps/api/src/enterprise-backup-schema.ts');
  const sourceRows=JSON.stringify(await readEnterpriseTables(pool)),sourceAnchor=(await pool.query('SELECT database_id FROM backup_restore_anchor')).rows[0].database_id;
  const envelope=await exportEnterpriseBackup({principal:{kind:'local-owner'},traceRoot:sourceTrace,writers,state:createBackupRestoreState({pool,writers,traceRoot:sourceTrace,dataRoot:sourceRoot}),password:'synthetic-crash-fixture-password'}),payload=await decryptEnterpriseBackup(envelope,'synthetic-crash-fixture-password');
  const inputDigest=hash(JSON.stringify(payload));writeFileSync(join(root,'payload.json'),JSON.stringify(payload),{mode:0o600});
  await pool.query('CREATE SCHEMA '+targetSchema);await pool.query('SET search_path TO '+targetSchema+',public');await migrate();const before=JSON.stringify(await readEnterpriseTables(pool)),targetAnchor=(await pool.query('SELECT database_id FROM backup_restore_anchor')).rows[0].database_id;assert.notEqual(targetAnchor,sourceAnchor);
  Object.assign(process.env,{DATA_DIR:root,TRACE_ROOT:join(root,'runs'),OBSIDIAN_VAULT:join(root,'vault'),LOCAL_WORKSPACE_ROOT:root});
  const original=await spawn('crash');let observed:any,ended=false;original.child.on('message',message=>{if(message&&typeof message==='object'&&'phase' in message)observed=message;});void original.exited.then(()=>{ended=true;});
  const deadline=Date.now()+15000;while(!existsSync(join(root,'phase.json'))&&!observed&&!ended&&Date.now()<deadline)await delay(20);
  const stopped=existsSync(join(root,'phase.json'))?JSON.parse(readFileSync(join(root,'phase.json'),'utf8')):observed;
  assert.equal(stopped?.phase,phase,JSON.stringify({expected:phase,ended,exitCode:original.child.exitCode,signalCode:original.child.signalCode,observedKeys:Object.keys(stopped??{})}));assert.equal(stopped.inputDigest,inputDigest,'phase must belong to the real v2 import');
  original.child.kill('SIGKILL');await original.exited;
  await pool.query('SET search_path TO '+targetSchema+',public');
  if(fault==='marker')await pool.query('DELETE FROM enterprise_restore_admission');
  if(fault==='generation')await pool.query('UPDATE backup_restore_anchor SET generation=generation+1');
  if(fault==='file')writeFileSync(join(root,'runs','history','proof.txt'),'external change');
  const restarted=await spawn('reconcile');let timer:ReturnType<typeof setTimeout>|undefined;
  const result:any=await Promise.race([once(restarted.child,'message').then(([message])=>({message})),restarted.exited.then(([code])=>({code})),new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(Error('Reconciler deadline')),15000);})]).finally(()=>clearTimeout(timer));
  if(fault){assert.deepEqual(result.message,{status:'blocked',code:'BACKUP_RESTORE_RECONCILIATION_REQUIRED'},'a connection error is not proof of the recovery barrier');assert.equal((await restarted.exited)[0],1);assert.equal(existsSync(join(root,'.backup-restore-state','active.json')),true);}
  else{assert.deepEqual(result.message,{status:phase==='committed'?'committed':'rolled-back'});assert.equal((await restarted.exited)[0],0);}
  await pool.query('SET search_path TO '+targetSchema+',public');const after=await readEnterpriseTables(pool);
  if(phase==='committed'){
   assert.deepEqual(after,payload.tables);assert.equal((await pool.query('SELECT database_id FROM backup_restore_anchor')).rows[0].database_id,targetAnchor);
   if(fault!=='marker')assert.equal((await pool.query('SELECT status FROM enterprise_restore_admission')).rows[0].status,'quarantined');assert.equal((await pool.query('SELECT operation_id::text FROM backup_restore_receipts')).rows[0].operation_id,stopped.operationId);
   const {assertRestoreExecutionAdmitted}=await import('../../apps/api/src/enterprise-restore-admission.ts');await assert.rejects(assertRestoreExecutionAdmitted(pool),(error:any)=>error.status===409);
   assert.notEqual((await pool.query('SELECT token_hash FROM local_devices WHERE id=$1',[deviceId])).rows[0].token_hash,'a'.repeat(64));
   assert.equal(readFileSync(join(root,'runs','history','proof.txt'),'utf8'),fault==='file'?'external change':'source delivery');assert.deepEqual(readFileSync(join(root,'credential.key')),Buffer.alloc(32,9));assert.deepEqual(readFileSync(join(root,'vault',vaultPath)),noteBytes);assert.deepEqual(readFileSync(join(root,'native-plugins',bundleId,'bundle.gz')),compressed);
  }else{assert.equal(JSON.stringify(after),before);assert.equal((await pool.query('SELECT * FROM enterprise_restore_admission')).rowCount,0);assert.equal((await pool.query('SELECT * FROM backup_restore_receipts')).rowCount,0);assert.equal(existsSync(join(root,'credential.key')),false);assert.equal(existsSync(join(root,'vault',vaultPath)),false);}
  await pool.query('SET search_path TO '+sourceSchema+',public');assert.equal(JSON.stringify(await readEnterpriseTables(pool)),sourceRows);assert.equal(readFileSync(join(sourceTrace,'history','proof.txt'),'utf8'),'source delivery');assert.deepEqual(readFileSync(join(sourceRoot,'credential.key')),Buffer.alloc(32,9));assert.deepEqual(readFileSync(join(sourceRoot,'vault',vaultPath)),noteBytes);assert.deepEqual(readFileSync(join(bundleRoot,'bundle.gz')),compressed);
  t.diagnostic(JSON.stringify({engine:native?'postgresql':'pglite',phase,fault:fault??null,operationId:stopped.operationId,inputDigest,sourceUnchanged:true,targetExecutionBlocked:phase==='committed'}));
 }finally{
  for(const {child,exited}of children)if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await exited;}
  await pool.query('SET search_path TO public');for(const schema of [targetSchema,sourceSchema]){assert.match(schema,/^enterprise_crash_(?:target|source)_[a-f0-9]{32}$/);await pool.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');}
  assert.equal(realpathSync(root),root);assert.match(relative(realpathSync(tmpdir()),root),/^weiwu-backup-state-[A-Za-z0-9]+$/);assert.deepEqual(JSON.parse(readFileSync(join(root,'.owned-backup-test.json'),'utf8')),owner);rmSync(root,{recursive:true});
 }
}
