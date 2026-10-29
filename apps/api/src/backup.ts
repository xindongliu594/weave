import {nativeCapabilityTables,exportNativeBundles,restoreNativeBundles} from './native-capabilities.ts';
import {bindPolicy} from './execution-policy.ts';
import { Router } from 'express';
import { z } from 'zod';
import { scrypt as scryptCallback, randomBytes, createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { gzipSync, gunzipSync } from 'node:zlib';
import { readFileSync, writeFileSync, readdirSync, lstatSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import { pool } from './db.ts';
import { AppError } from './provider.ts';
import { vaultFileSnapshot, restoreVaultFiles, syncObsidian } from './obsidian.ts';
import { managerChatTables } from './manager-chat.ts';
import { browserMcpTables } from './work-tools-browser.ts';
import { workFileTables } from './work-files.ts';
import { automationTables } from './automation-learning.ts';
import {storageTables} from './storage-governance.ts';
import {validateBackupCheckpoints} from './backup-checkpoints.ts';
import {assertBackupDestinationClear,assertBackupSourcePortable,assertBusinessBackupPortable} from './backup-destination.ts';
import type pg from 'pg';
import type {ArchiveWriterManager} from '../../../services/agent-runtime/archive-writer-scope.mjs';
import {createBackupRestoreState,type BackupRestoreState,type BackupRestoreOperation} from './backup-restore-state.ts';
import {administrative,currentRoutePrincipal,httpPrincipal} from './project-route-access.ts';
import type {Principal} from './identity-types.ts';
import {underBackupRoot,type BackupSafety} from './backup-root-scope.ts';
const scrypt=promisify(scryptCallback);
const tables=['gateways','departments','department_versions','models','projects','plan_versions','activity','usage','project_runs','templates','knowledge_spaces','knowledge_documents','knowledge_revisions','knowledge_chunks','product_settings','tool_approvals','organization_previews','organization_conversations','model_reservations','knowledge_embeddings','model_capability_tests',...managerChatTables,...browserMcpTables,...workFileTables,...automationTables,...storageTables,...nativeCapabilityTables];
const password=z.string().min(12).max(200);
// The complete decrypted JSON, including base64 files, is the authoritative limit.
// The file walk/staging checks use the same ceiling as an early bounded guard.
export const ONLINE_BACKUP_LIMIT_BYTES=50*1024*1024;
export async function encryptBackup(value:unknown,passphrase:string){const salt=randomBytes(16),iv=randomBytes(12),key=await scrypt(passphrase,salt,32) as Buffer;const cipher=createCipheriv('aes-256-gcm',key,iv);const data=Buffer.concat([cipher.update(gzipSync(JSON.stringify(value))),cipher.final()]);return {format:'agent-department-backup-v1',salt:salt.toString('base64'),iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),data:data.toString('base64')};}
export async function decryptBackup(value:any,passphrase:string){try{if(value.format!=='agent-department-backup-v1')throw Error();const key=await scrypt(passphrase,Buffer.from(value.salt,'base64'),32) as Buffer;const cipher=createDecipheriv('aes-256-gcm',key,Buffer.from(value.iv,'base64'));cipher.setAuthTag(Buffer.from(value.tag,'base64'));return JSON.parse(gunzipSync(Buffer.concat([cipher.update(Buffer.from(value.data,'base64')),cipher.final()]),{maxOutputLength:ONLINE_BACKUP_LIMIT_BYTES}).toString());}catch{throw new AppError(422,'备份密码不正确、文件损坏或格式不支持');}}
function validFile(path:string){return /^[a-f0-9-]{36}\/.+/.test(path)&&!path.includes('\\')&&!path.includes('\0')&&path.split('/').every(p=>p&&p!=='.'&&p!=='..');}
// Reject an already unsupported source before syncObsidian can index or write notes.
// Release this short transaction before sync (which borrows its own connection).
// The actual export repeats the protected-table check under its snapshot locks.
type Safety=BackupSafety;
async function currentAdministrator(client:pg.PoolClient,principal:Principal){await currentRoutePrincipal(client,principal,true);if(!administrative(principal))throw new AppError(403,'备份需要当前管理员权限','BACKUP_ADMIN_REQUIRED');}
async function preflightBackupSource(principal:Principal,safety:Safety){
 const client=await pool.connect();let committing=false,discard=false,first:unknown;
 try{await client.query('BEGIN');await assertBackupSourcePortable(client);await currentAdministrator(client,principal);committing=true;await client.query('COMMIT');committing=false;}
 catch(error){first=error;discard=committing;try{if(!committing)await client.query('ROLLBACK');}catch{discard=true;}safety.unknown||=discard;}
 try{client.release(discard);}catch(error){safety.unknown=true;first??=error;}if(first)throw first;
}
export function backupRouter(traceRoot:string,writers:ArchiveWriterManager,state:BackupRestoreState=createBackupRestoreState({pool,writers,traceRoot,dataRoot:resolve(process.env.DATA_DIR??'.data')})){
 const router=Router(),dataRoot=resolve(process.env.DATA_DIR??'.data');
 async function underRoot<T>(work:(safety:Safety)=>Promise<T>){
  return underBackupRoot(writers,state,work);
 }
 router.post('/backup/export',async(req,res)=>{
  const pass=password.parse(req.body.password),principal=httpPrincipal(res);
  const backup=await underRoot(async safety=>{
   await preflightBackupSource(principal,safety);safety.unknown=true;await syncObsidian();safety.unknown=false;
   const client=await pool.connect();let committing=false,discard=false,first:unknown,backup:unknown;const locks:number[]=[];
   try{
    for(const lock of [918274,918275]){safety.unknown=true;await client.query('SELECT pg_advisory_lock('+lock+')');locks.push(lock);safety.unknown=false;}
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');await assertBackupSourcePortable(client);await client.query('LOCK TABLE project_runs IN SHARE MODE');await currentAdministrator(client,principal);
    if((await client.query("SELECT id FROM manager_messages WHERE status='replying' LIMIT 1")).rowCount)throw new AppError(409,'请等待经理回复结束');
    if((await client.query("SELECT id FROM model_capability_tests WHERE status='running' LIMIT 1")).rowCount)throw new AppError(409,'请等待模型能力测试结束');
    if((await client.query("SELECT id FROM model_reservations WHERE status='pending' LIMIT 1")).rowCount)throw new AppError(409,'请等待正在进行的模型调用结束后再备份');
    if((await client.query("SELECT id FROM project_runs WHERE status IN ('queued','running')")).rowCount)throw new AppError(409,'请先停止运行任务，再创建一致的备份');
    const rows:Record<string,any>={};for(const table of tables)rows[table]=(await client.query('SELECT * FROM '+table)).rows;assertBusinessBackupPortable(rows);
    const files:Record<string,string>={};let total=0;function walk(dir:string){for(const name of readdirSync(dir)){const file=join(dir,name),stat=lstatSync(file);if(stat.isSymbolicLink()||stat.isFile()&&stat.nlink!==1)throw new AppError(422,'执行档案包含不支持的链接，未生成备份');if(stat.isDirectory())walk(file);else if(stat.isFile()){total+=stat.size;if(total>ONLINE_BACKUP_LIMIT_BYTES)throw new AppError(422,'执行档案超过在线备份上限，请使用本地备份脚本');const key=relative(traceRoot,file).replaceAll('\\','/');if(validFile(key))files[key]=readFileSync(file).toString('base64');}}}if(existsSync(traceRoot))walk(traceRoot);
    const master=existsSync(join(dataRoot,'credential.key'))?readFileSync(join(dataRoot,'credential.key')).toString('base64'):null;
    const payload={version:1,createdAt:new Date().toISOString(),tables:rows,files,master,nativePluginBundles:exportNativeBundles(rows),vaultFiles:vaultFileSnapshot(rows.knowledge_documents.filter((d:any)=>d.vault_path).map((d:any)=>d.vault_path))};
    if(Buffer.byteLength(JSON.stringify(payload))>ONLINE_BACKUP_LIMIT_BYTES)throw new AppError(422,'在线备份超过50MiB，请使用本机目录备份');backup=await encryptBackup(payload,pass);committing=true;await client.query('COMMIT');committing=false;
   }catch(error){first=error;discard=committing||safety.unknown;try{if(!committing)await client.query('ROLLBACK');}catch{discard=true;}}
   for(const lock of locks.reverse())try{const result=await client.query('SELECT pg_advisory_unlock('+lock+') AS unlocked');if(result.rows[0]?.unlocked!==true)throw Error('Backup SQL lock release unconfirmed');}catch(error){discard=true;first??=error;}
   safety.unknown||=discard;try{client.release(discard);}catch(error){safety.unknown=true;first??=error;}if(first)throw first;return backup;
  });res.attachment('agent-department-backup-'+new Date().toISOString().slice(0,10)+'.json').json(backup);
 });
 router.post('/backup/restore',async(req,res)=>{
  const principal=httpPrincipal(res);
  const input=z.object({password,backup:z.record(z.string(),z.unknown()),confirmation:z.literal('RESTORE')}).parse(req.body);const value=await decryptBackup(input.backup,input.password);
  if(value.tables)for(const table of [...managerChatTables,...browserMcpTables,...workFileTables,...automationTables,...storageTables,...nativeCapabilityTables])value.tables[table]??=[];
  if(value.tables&&!value.tables.organization_previews)value.tables.organization_previews=[];
  if(value.tables&&!value.tables.organization_conversations)value.tables.organization_conversations=[];
  if(value.tables&&!value.tables.model_capability_tests)value.tables.model_capability_tests=[];
  if(Array.isArray(value.tables?.models))for(const model of value.tables.models)if(model&&typeof model==='object')model.capabilities??={};
  if(value.tables&&!value.tables.knowledge_embeddings)value.tables.knowledge_embeddings=[];
  if(value.tables&&!value.tables.model_reservations)value.tables.model_reservations=[];
  if(Array.isArray(value.tables?.project_runs))for(const run of value.tables.project_runs)run.department_ids??=run.snapshot?.departmentIds??[run.snapshot?.departmentId].filter(Boolean);
  if(Array.isArray(value.tables?.usage)){const projects=new Map<string,any>((value.tables.projects??[]).map((project:any)=>[project.id,project]));for(const usage of value.tables.usage)usage.department_id??=projects.get(usage.project_id)?.department_id??null;}
  if(Array.isArray(value.tables?.model_reservations)&&value.tables.model_reservations.some((r:any)=>r.status==='pending'))throw new AppError(422,'不能恢复包含进行中模型调用的备份');
  if(value.version!==1||!value.tables||!value.files||tables.some(t=>!Array.isArray(value.tables[t]))||Object.keys(value.files).some(p=>!validFile(p)))throw new AppError(422,'备份结构不正确');
  assertBusinessBackupPortable(value.tables);
  for(const message of value.tables.manager_messages)if(['waiting','replying'].includes(message.status)){message.status='cancelled';message.error='备份恢复后请重新发送消息';}
  for(const schedule of value.tables.automation_schedules)if(schedule.status==='active')schedule.status='paused';
  for(const entry of value.tables.native_capabilities)entry.enabled=false;
  for(const project of value.tables.projects)project.policy=bindPolicy(project.policy,project.plan.agents,project.department_id);
  for(const version of value.tables.plan_versions)version.policy??=null;
  if(value.tables.model_capability_tests.some((r:any)=>r.status==='running'))throw new AppError(422,'不能恢复包含进行中能力测试的备份');
  if(value.tables.project_runs.some((r:any)=>['queued','running'].includes(r.status)))throw new AppError(422,'不允许恢复包含执行中任务的备份');
  await underRoot(async safety=>{
   const stage=state.createStage();let client:pg.PoolClient|undefined,operation:BackupRestoreOperation|undefined,committing=false,committed=false,discard=false,first:unknown;
   try{
    let total=0;for(const [file,data]of Object.entries(value.files)){if(typeof data!=='string')throw new AppError(422,'备份文件格式不正确');const bytes=Buffer.from(data,'base64');if((total+=bytes.length)>ONLINE_BACKUP_LIMIT_BYTES)throw new AppError(422,'备份超出限制');const target=join(stage.path,file);mkdirSync(dirname(target),{recursive:true,mode:0o700});writeFileSync(target,bytes,{mode:0o600});}
    if(value.master&&Buffer.from(value.master,'base64').length!==32)throw new AppError(422,'备份主密钥格式不正确');
    try{validateBackupCheckpoints(stage.path,Object.keys(value.files),value.tables.project_runs);}catch{throw new AppError(422,'备份的步骤检查点、文件内容或恢复来源不完整，未替换当前数据。');}
    client=await pool.connect();await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(918274)');await client.query('SELECT pg_advisory_xact_lock(918275)');await client.query('LOCK TABLE project_runs IN EXCLUSIVE MODE');
    if((await client.query("SELECT id FROM manager_messages WHERE status='replying' LIMIT 1")).rowCount)throw new AppError(409,'请等待经理回复结束');
    if((await client.query("SELECT id FROM model_capability_tests WHERE status='running' LIMIT 1")).rowCount)throw new AppError(409,'请等待模型能力测试结束');
    if((await client.query("SELECT id FROM model_reservations WHERE status='pending' LIMIT 1")).rowCount)throw new AppError(409,'请等待模型调用结束后再恢复');
    if((await client.query("SELECT id FROM project_runs WHERE status IN ('queued','running')")).rowCount)throw new AppError(409,'请先停止队列和运行任务');
    await assertBackupDestinationClear(client);await currentAdministrator(client,principal);
    const previousPaths=(await client.query('SELECT vault_path FROM knowledge_documents WHERE vault_path IS NOT NULL')).rows.map(r=>r.vault_path);
    operation=await state.prepareRestore(client,{stage,master:value.master??undefined,vaultFiles:value.vaultFiles??{},previousPaths,nativePluginBundles:value.nativePluginBundles??{},inputDigest:createHash('sha256').update(JSON.stringify(value)).digest('hex')});safety.unknown=true;
    await client.query('TRUNCATE '+tables.join(',')+' CASCADE');
    // Device credentials and host-directory permissions are not portable backup data.
    await client.query('DELETE FROM local_devices');await client.query('DELETE FROM request_keys');
    for(const table of tables)if(value.tables[table].length)await client.query(`INSERT INTO ${table} SELECT * FROM json_populate_recordset(NULL::${table},$1::json) ON CONFLICT DO NOTHING`,[JSON.stringify(value.tables[table])]);
    restoreNativeBundles(value.nativePluginBundles??{});restoreVaultFiles(value.vaultFiles??{},previousPaths);state.installArchive(operation);await state.recordCommitReceipt(client,operation);
    committing=true;await client.query('COMMIT');committing=false;committed=true;state.confirmCommitted(operation);safety.unknown=false;
   }catch(error){
    first=error;discard=committing;let rolledBack=!client;
    if(client&&!committing&&!committed)try{await client.query('ROLLBACK');rolledBack=true;}catch{discard=true;}
    if(!committing&&!committed&&rolledBack&&operation)try{state.rollbackAfterSql(operation);safety.unknown=false;}catch{safety.unknown=true;}
    safety.unknown||=discard||committed;
   }
   if(client)try{client.release(discard);}catch(error){safety.unknown=true;first??=error;}
   if(!operation&&!safety.unknown)try{state.removeUnpublishedStage(stage);}catch(error){safety.unknown=true;first??=error;}
   if(first)throw first;
  });res.json({ok:true,message:'业务数据和执行档案已恢复；恢复前的档案已在本机保留。'});
 });return router;
}
