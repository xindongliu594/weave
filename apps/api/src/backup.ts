import { Router } from 'express';
import { z } from 'zod';
import { scrypt as scryptCallback, randomBytes, createCipheriv, createDecipheriv, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { gzipSync, gunzipSync } from 'node:zlib';
import { readFileSync, writeFileSync, readdirSync, lstatSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import { pool } from './db.ts';
import { AppError } from './provider.ts';
import { resetVaultCache } from './vault.ts';
import { vaultFileSnapshot, restoreVaultFiles, syncObsidian, withVaultLock } from './obsidian.ts';
const scrypt=promisify(scryptCallback);
const tables=['gateways','departments','department_versions','models','projects','plan_versions','activity','usage','project_runs','templates','knowledge_spaces','knowledge_documents','knowledge_revisions','knowledge_chunks','product_settings','tool_approvals','organization_previews','model_reservations','knowledge_embeddings','model_capability_tests'];
const password=z.string().min(12).max(200);
export async function encryptBackup(value:unknown,passphrase:string){const salt=randomBytes(16),iv=randomBytes(12),key=await scrypt(passphrase,salt,32) as Buffer;const cipher=createCipheriv('aes-256-gcm',key,iv);const data=Buffer.concat([cipher.update(gzipSync(JSON.stringify(value))),cipher.final()]);return {format:'agent-department-backup-v1',salt:salt.toString('base64'),iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),data:data.toString('base64')};}
export async function decryptBackup(value:any,passphrase:string){try{if(value.format!=='agent-department-backup-v1')throw Error();const key=await scrypt(passphrase,Buffer.from(value.salt,'base64'),32) as Buffer;const cipher=createDecipheriv('aes-256-gcm',key,Buffer.from(value.iv,'base64'));cipher.setAuthTag(Buffer.from(value.tag,'base64'));return JSON.parse(gunzipSync(Buffer.concat([cipher.update(Buffer.from(value.data,'base64')),cipher.final()]),{maxOutputLength:50*1024*1024}).toString());}catch{throw new AppError(422,'备份密码不正确、文件损坏或格式不支持');}}
function validFile(path:string){return /^[a-f0-9-]{36}\/.+/.test(path)&&!path.includes('\\')&&!path.includes('\0')&&path.split('/').every(p=>p&&p!=='.'&&p!=='..');}
export function backupRouter(traceRoot:string){const router=Router();const dataRoot=resolve(process.env.DATA_DIR??'.data');
 router.post('/backup/export',async(req,res)=>withVaultLock(async()=>{const pass=password.parse(req.body.password);await syncObsidian();const client=await pool.connect();try{await client.query('SELECT pg_advisory_lock(918274)');await client.query('SELECT pg_advisory_lock(918275)');await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');await client.query('LOCK TABLE project_runs IN SHARE MODE');if((await client.query("SELECT id FROM model_capability_tests WHERE status='running' LIMIT 1")).rowCount)throw new AppError(409,'请等待模型能力测试结束');if((await client.query("SELECT id FROM model_reservations WHERE status='pending' LIMIT 1")).rowCount)throw new AppError(409,'请等待正在进行的模型调用结束后再备份');if((await client.query("SELECT id FROM project_runs WHERE status IN ('queued','running')")).rowCount)throw new AppError(409,'请先停止运行任务，再创建一致的备份');const rows:Record<string,any>={};for(const table of tables)rows[table]=(await client.query('SELECT * FROM '+table)).rows;const files:Record<string,string>={};let total=0;function walk(dir:string){for(const name of readdirSync(dir)){const file=join(dir,name),stat=lstatSync(file);if(stat.isSymbolicLink())continue;if(stat.isDirectory())walk(file);else if(stat.isFile()){total+=stat.size;if(total>30*1024*1024)throw new AppError(422,'执行档案超过在线备份上限，请使用本地备份脚本');const key=relative(traceRoot,file);if(!validFile(key))continue;files[key]=readFileSync(file).toString('base64');}}}if(existsSync(traceRoot))walk(traceRoot);const master=existsSync(join(dataRoot,'credential.key'))?readFileSync(join(dataRoot,'credential.key')).toString('base64'):null;const backup=await encryptBackup({version:1,createdAt:new Date().toISOString(),tables:rows,files,master,vaultFiles:vaultFileSnapshot(rows.knowledge_documents.filter((d:any)=>d.vault_path).map((d:any)=>d.vault_path))},pass);await client.query('COMMIT');res.attachment('agent-department-backup-'+new Date().toISOString().slice(0,10)+'.json').json(backup);}catch(e){await client.query('ROLLBACK');throw e;}finally{try{await client.query('SELECT pg_advisory_unlock(918275),pg_advisory_unlock(918274)');}finally{client.release();}}}));
 router.post('/backup/restore',async(req,res)=>withVaultLock(async()=>{
  const input=z.object({password,backup:z.record(z.string(),z.unknown()),confirmation:z.literal('RESTORE')}).parse(req.body);const value=await decryptBackup(input.backup,input.password);
  if(value.tables&&!value.tables.organization_previews)value.tables.organization_previews=[];
  if(value.tables&&!value.tables.model_capability_tests)value.tables.model_capability_tests=[];
  if(Array.isArray(value.tables?.models))for(const model of value.tables.models)if(model&&typeof model==='object')model.capabilities??={};
  if(value.tables&&!value.tables.knowledge_embeddings)value.tables.knowledge_embeddings=[];
  if(value.tables&&!value.tables.model_reservations)value.tables.model_reservations=[];
  if(Array.isArray(value.tables?.model_reservations)&&value.tables.model_reservations.some((r:any)=>r.status==='pending'))throw new AppError(422,'不能恢复包含进行中模型调用的备份');
  if(value.version!==1||!value.tables||!value.files||tables.some(t=>!Array.isArray(value.tables[t]))||Object.keys(value.files).some(p=>!validFile(p)))throw new AppError(422,'备份结构不正确');
  if(value.tables.model_capability_tests.some((r:any)=>r.status==='running'))throw new AppError(422,'不能恢复包含进行中能力测试的备份');
  if(value.tables.project_runs.some((r:any)=>['queued','running'].includes(r.status)))throw new AppError(422,'不允许恢复包含执行中任务的备份');
  const stage=join(dataRoot,'restore-'+randomUUID()),rollback=join(dataRoot,'before-restore-'+randomUUID());mkdirSync(stage,{recursive:true,mode:0o700});
  let total=0;for(const [file,data]of Object.entries(value.files)){if(typeof data!=='string')throw new AppError(422,'备份文件格式不正确');const bytes=Buffer.from(data,'base64');if((total+=bytes.length)>30*1024*1024)throw new AppError(422,'备份超出限制');const target=join(stage,file);mkdirSync(dirname(target),{recursive:true,mode:0o700});writeFileSync(target,bytes,{mode:0o600});}
  if(value.master&&Buffer.from(value.master,'base64').length!==32)throw new AppError(422,'备份主密钥格式不正确');
  const keyPath=join(dataRoot,'credential.key'),oldKey=existsSync(keyPath)?readFileSync(keyPath):null;const client=await pool.connect();let swapped=false;let movedOld=false;let undoVault:(()=>void)|undefined;
  try{await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(918274)');await client.query('SELECT pg_advisory_xact_lock(918275)');await client.query('LOCK TABLE project_runs IN EXCLUSIVE MODE');if((await client.query("SELECT id FROM model_capability_tests WHERE status='running' LIMIT 1")).rowCount)throw new AppError(409,'请等待模型能力测试结束');if((await client.query("SELECT id FROM model_reservations WHERE status='pending' LIMIT 1")).rowCount)throw new AppError(409,'请等待模型调用结束后再恢复');if((await client.query("SELECT id FROM project_runs WHERE status IN ('queued','running')")).rowCount)throw new AppError(409,'请先停止队列和运行任务');
    const previousPaths=(await client.query('SELECT vault_path FROM knowledge_documents WHERE vault_path IS NOT NULL')).rows.map(r=>r.vault_path);
    await client.query('TRUNCATE '+tables.join(',')+' CASCADE');
    await client.query('DELETE FROM request_keys');
    for(const table of tables)if(value.tables[table].length)await client.query(`INSERT INTO ${table} SELECT * FROM json_populate_recordset(NULL::${table},$1::json) ON CONFLICT DO NOTHING`,[JSON.stringify(value.tables[table])]);
    undoVault=restoreVaultFiles(value.vaultFiles??{},previousPaths);
    if(existsSync(traceRoot)){renameSync(traceRoot,rollback);movedOld=true;}renameSync(stage,traceRoot);swapped=true;
    if(value.master)writeFileSync(keyPath,Buffer.from(value.master,'base64'),{mode:0o600});else if(existsSync(keyPath))rmSync(keyPath);
    await client.query('COMMIT');resetVaultCache();res.json({ok:true,message:'业务数据和执行档案已恢复；恢复前的档案已在 Mac 保留。'});
  }catch(e){await client.query('ROLLBACK');undoVault?.();if(swapped||movedOld){if(swapped)rmSync(traceRoot,{recursive:true,force:true});if(movedOld)renameSync(rollback,traceRoot);if(oldKey)writeFileSync(keyPath,oldKey,{mode:0o600});else if(existsSync(keyPath))rmSync(keyPath);}throw e;}finally{client.release();if(existsSync(stage))rmSync(stage,{recursive:true,force:true});}
 }));return router;}
