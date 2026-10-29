import type pg from 'pg';
import {AppError} from './provider.ts';
import {assertEnterpriseCatalog} from './enterprise-backup-catalog.ts';
import {enterpriseTableSpecs,parseEnterpriseBackup,type EnterpriseBackupV2} from './enterprise-backup-schema.ts';
import {createEnterpriseBackup,type EnterpriseTableName} from './enterprise-backup-schema.ts';
import {createHash,randomBytes} from 'node:crypto';
import {mkdirSync,writeFileSync,lstatSync,readdirSync,readFileSync,existsSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {pool} from './db.ts';
import {underBackupRoot} from './backup-root-scope.ts';
import type {Principal} from './identity-types.ts';
import {administrative,currentRoutePrincipal} from './project-route-access.ts';
import type {ArchiveWriterManager} from '../../../services/agent-runtime/archive-writer-scope.mjs';
import {assertArchivePlain} from '../../../services/agent-runtime/archive-objects.mjs';
import type {BackupRestoreState,BackupRestoreOperation} from './backup-restore-state.ts';
import {readEnterpriseTables} from './enterprise-backup-export.ts';
import {validateEnterpriseBackupReferences} from './backup-checkpoints.ts';
import {nativeCapabilityRoot,restoreNativeBundles} from './native-capabilities.ts';
import {obsidianRoot,restoreVaultFiles,INITIAL_VAULT_FILES} from './obsidian.ts';
import {installRestoreAdmissionIn} from './enterprise-restore-admission.ts';

const quote=(name:string)=>'"'+name.replaceAll('"','""')+'"';
const transient=['human_sessions','human_session_lifecycles','oidc_login_transactions','request_keys','backup_restore_receipts'];
const defaults={autoBudgetLimit:0.25,dailyBudgetLimit:20,maxActiveRuns:2,retentionDays:0};
function notFresh():never{throw new AppError(409,'目标已有数据、身份、历史或自定义设置；请使用全新隔离实例恢复，原数据未替换。','BACKUP_DESTINATION_NOT_FRESH');}

/** Read-only. The restore caller repeats this under all destination locks before
 * staging/installing anything. Defaults are exact formal migration values,
 * never inferred from the incoming source or accepted by version alone. */
export async function preflightEnterpriseRestore(db:Pick<pg.PoolClient,'query'>,payload:EnterpriseBackupV2):Promise<void>{
  parseEnterpriseBackup(payload);await assertEnterpriseCatalog(db);
  if(payload.tables.identity_bootstrap.length!==1||payload.tables.identity_bootstrap[0].id!==1||payload.tables.product_settings.length!==1||payload.tables.product_settings[0].id!==1)throw new AppError(422,'来源缺少正式身份或产品配置记录。','BACKUP_FORMAT_INVALID');
  if(payload.tables.project_runs.some(row=>['queued','running'].includes(String(row.status)))||payload.tables.model_reservations.some(row=>row.status==='pending')||payload.tables.manager_messages.some(row=>['waiting','replying'].includes(String(row.status)))||payload.tables.model_capability_tests.some(row=>row.status==='running'))throw new AppError(422,'来源包含排队或进行中的执行、模型调用或经理消息；请在来源结束或取消等待后重新备份。','BACKUP_SOURCE_BUSY');
  const empty=[...Object.keys(enterpriseTableSpecs).filter(name=>!['identity_bootstrap','product_settings'].includes(name)),...transient];
  const occupied=await db.query('SELECT '+empty.map(name=>'EXISTS(SELECT 1 FROM '+quote(name)+')').join(' OR ')+' AS occupied');
  if(occupied.rows[0]?.occupied!==false)notFresh();
  const settings=await db.query('SELECT count(*)::int AS count FROM product_settings WHERE id=1 AND version=1 AND data=$1::jsonb',[JSON.stringify(defaults)]);
  const settingCount=await db.query('SELECT count(*)::int AS count FROM product_settings');
  if(settings.rows[0]?.count!==1||settingCount.rows[0]?.count!==1)notFresh();
  const bootstrap=await db.query('SELECT count(*)::int AS count FROM identity_bootstrap WHERE id=1 AND version=1 AND '+Object.keys(enterpriseTableSpecs.identity_bootstrap.columns).filter(name=>!['id','version'].includes(name)).map(name=>quote(name)+' IS NULL').join(' AND '));
  const bootstrapCount=await db.query('SELECT count(*)::int AS count FROM identity_bootstrap');
  if(bootstrap.rows[0]?.count!==1||bootstrapCount.rows[0]?.count!==1)notFresh();
  const anchor=await db.query('SELECT singleton,generation::text,enterprise_restore_operation_id FROM backup_restore_anchor');
  if(anchor.rows.length!==1||anchor.rows[0].singleton!==1||anchor.rows[0].generation!=='0'||anchor.rows[0].enterprise_restore_operation_id!==null)notFresh();
  const admission=await db.query("SELECT to_regclass(format('%I.enterprise_restore_admission',current_schema())) AS relation");
  if(admission.rows[0]?.relation&&(await db.query('SELECT 1 FROM enterprise_restore_admission LIMIT 1')).rowCount)notFresh();
}

function emptyDirectory(path:string){
 let present;try{present=lstatSync(path);}catch(error:any){if(error.code==='ENOENT')return;throw error;}
 if(!present.isDirectory()||present.isSymbolicLink())notFresh();assertArchivePlain(path,'directory');if(readdirSync(path).length)notFresh();
}
function freshNativeDirectory(path:string){
 if(!existsSync(path))return;assertArchivePlain(path,'directory');
 const entries=readdirSync(path);if(entries.length===0)return;
 if(entries.length!==1||entries[0]!=='install-jobs')notFresh();emptyDirectory(join(path,'install-jobs'));
}
function freshFiles(traceRoot:string,dataRoot:string){
 // Never overwrite an old key, including a dangling symlink. These are only
 // target checks, not deletion/cleanup rules for a running source instance.
 try{lstatSync(join(dataRoot,'credential.key'));notFresh();}catch(error:any){if(error.code!=='ENOENT')throw error;}
 for(const path of [traceRoot,join(dataRoot,'.backup-restore-state')])emptyDirectory(path);freshNativeDirectory(nativeCapabilityRoot());
 const vault=obsidianRoot();let exists;try{exists=lstatSync(vault);}catch(error:any){if(error.code==='ENOENT')return;throw error;}
 if(!exists.isDirectory()||exists.isSymbolicLink())notFresh();assertArchivePlain(vault,'directory');
 for(const name of readdirSync(vault)){const path=join(vault,name);if(name==='.obsidian'){emptyDirectory(path);continue;}
  const expected=Object.hasOwn(INITIAL_VAULT_FILES,name)?INITIAL_VAULT_FILES[name]:undefined;if(expected===undefined)notFresh();
  const stat=assertArchivePlain(path,'file');if(stat.size!==Buffer.byteLength(expected)||!readFileSync(path).equals(Buffer.from(expected)))notFresh();
 }
}
function orderedTables():EnterpriseTableName[]{
 const pending=new Set(Object.keys(enterpriseTableSpecs) as EnterpriseTableName[]),result:EnterpriseTableName[]=['department_versions'];pending.delete('department_versions');
 while(pending.size){const ready=[...pending].filter(name=>enterpriseTableSpecs[name].foreignKeys.every(fk=>fk.target===name||!pending.has(fk.target as EnterpriseTableName)));if(!ready.length)throw Error('Fixed backup table contract contains a cycle');for(const name of ready){result.push(name);pending.delete(name);}}
 return result;
}
function orderedRows(name:EnterpriseTableName,rows:Record<string,unknown>[]){
 const fks=enterpriseTableSpecs[name].foreignKeys.filter(fk=>fk.target===name);if(!fks.length)return rows;
 const pending=new Int32Array(rows.length),children=rows.map(()=>[] as number[]);
 for(const fk of fks){const keys=new Map(rows.map((row,index)=>[JSON.stringify(fk.targetColumns.map(col=>row[col])),index]));
  rows.forEach((row,index)=>{const values=fk.columns.map(col=>row[col]);if(values.some(v=>v===null))return;const parent=keys.get(JSON.stringify(values));if(parent===undefined)throw new AppError(422,'备份自引用来源缺失。','BACKUP_REFERENCE_INVALID');pending[index]++;children[parent].push(index);});
 }
 const queue=rows.flatMap((_row,index)=>pending[index]===0?[index]:[]),ordered:Record<string,unknown>[]=[];
 for(let at=0;at<queue.length;at++){const index=queue[at];ordered.push(rows[index]);for(const child of children[index])if(--pending[child]===0)queue.push(child);}
 if(ordered.length!==rows.length)throw new AppError(422,'备份自引用成环。','BACKUP_REFERENCE_INVALID');return ordered;
}
async function insertTables(db:pg.PoolClient,payload:EnterpriseBackupV2){
 // Only these pristine migration-created rows may be removed. Existing
 // enterprise/history data was rejected under locks before staging.
 await db.query('DELETE FROM identity_bootstrap WHERE id=1');await db.query('DELETE FROM product_settings WHERE id=1');
 for(const name of orderedTables()){
  const entries=Object.entries(enterpriseTableSpecs[name].columns),rows=orderedRows(name,payload.tables[name]);
  const extra=name==='local_devices'?['token_hash']:[],columns=[...entries.map(([col])=>col),...extra],batch=Math.max(1,Math.floor(1000/columns.length));
  for(let offset=0;offset<rows.length;offset+=batch){const values:unknown[]=[],groups=[];
   for(const row of rows.slice(offset,offset+batch)){const params=[];
    for(const [col,[type]]of entries){values.push(row[col]);params.push('$'+values.length+'::'+(type==='vector(384)'?'public.vector(384)':type));}
    if(extra.length){values.push(randomBytes(32).toString('hex'));params.push('$'+values.length+'::text');}
    groups.push('('+params.join(',')+')');
   }await db.query('INSERT INTO '+quote(name)+'('+columns.map(quote).join(',')+') VALUES '+groups.join(','),values);
  }
 }
 const {manifest:_,...base}=payload,actual=createEnterpriseBackup({...base,tables:await readEnterpriseTables(db)});
 if(!isDeepStrictEqual(actual.manifest.tables,payload.manifest.tables))throw new AppError(422,'恢复后的表摘要与来源不同，已阻止提交。','BACKUP_ROWS_MISMATCH');
}

/** Import into a fresh target; execution remains quarantined until re-admission. */
export async function restoreEnterpriseBackup(input:{principal:Principal;payload:EnterpriseBackupV2;traceRoot:string;writers:ArchiveWriterManager;state:BackupRestoreState}):Promise<{operationId:string;status:'quarantined';inputDigest:string}>{
 const payload=parseEnterpriseBackup(input.payload),dataRoot=resolve(process.env.DATA_DIR??'.data');
 const inputDigest=createHash('sha256').update(JSON.stringify(payload)).digest('hex');
 if(input.writers.traceRoot!==resolve(input.traceRoot))throw new AppError(422,'恢复目录与已配置的写入器不符。','BACKUP_FILE_UNSAFE');
 return underBackupRoot(input.writers,input.state,async safety=>{
  let client:pg.PoolClient|undefined,stage:ReturnType<BackupRestoreState['createStage']>|undefined,operation:BackupRestoreOperation|undefined,transaction=false,committing=false,committed=false,discard=false,first:unknown;
  try{
   client=await pool.connect();transaction=true;await client.query('BEGIN');
   for(const lock of [918274,918275])if((await client.query(`SELECT pg_try_advisory_xact_lock(${lock}) AS locked`)).rows[0]?.locked!==true)throw new AppError(409,'恢复维护锁正忙，请稍后重试。','BACKUP_DESTINATION_BUSY');
   const names=[...Object.keys(enterpriseTableSpecs),...transient,'backup_restore_anchor','enterprise_restore_admission'];
   await client.query('LOCK TABLE '+names.map(quote).join(',')+' IN EXCLUSIVE MODE NOWAIT');
   await currentRoutePrincipal(client,input.principal,true);if(!administrative(input.principal))throw new AppError(403,'恢复需要当前管理员权限。','BACKUP_ADMIN_REQUIRED');
   await preflightEnterpriseRestore(client,payload);freshFiles(input.traceRoot,dataRoot);
   stage=input.state.createStage();
   for(const [name,base64]of Object.entries(payload.files)){const path=join(stage.path,name);mkdirSync(dirname(path),{recursive:true,mode:0o700});writeFileSync(path,Buffer.from(base64,'base64'),{mode:0o600,flag:'wx'});}
   validateEnterpriseBackupReferences(payload,stage.path);
   safety.unknown=true;
   operation=await input.state.prepareRestore(client,{stage,master:payload.master??undefined,vaultFiles:payload.vaultFiles,previousPaths:[],nativePluginBundles:payload.nativePluginBundles,inputDigest});
   // Recheck the physical before-image against fresh defaults. This also
   // rejects an outside writer that raced the earlier filesystem preflight.
   if(operation.manifest.beforeKey!==null||operation.manifest.beforeTrace?.length||operation.manifest.bundles.some(bundle=>bundle.existed)||Object.entries(operation.manifest.beforeVault).some(([path,file])=>file!==null&&(!Object.hasOwn(INITIAL_VAULT_FILES,path)||file.data!==Buffer.from(INITIAL_VAULT_FILES[path]).toString('base64'))))notFresh();
   await insertTables(client,payload);await installRestoreAdmissionIn(client,payload,operation.id,inputDigest);
   restoreNativeBundles(payload.nativePluginBundles);restoreVaultFiles(payload.vaultFiles,[]);input.state.installArchive(operation);await input.state.recordCommitReceipt(client,operation);
   committing=true;await client.query('COMMIT');committing=false;transaction=false;committed=true;input.state.confirmCommitted(operation);safety.unknown=false;
  }catch(error:any){
   first=error?.code==='55P03'?new AppError(409,'目标正在写入，未替换数据。','BACKUP_DESTINATION_BUSY'):error;discard=committing;let rolledBack=!client;
   if(client&&transaction&&!committing&&!committed)try{await client.query('ROLLBACK');rolledBack=true;}catch{discard=true;}
   if(!committing&&!committed&&rolledBack&&operation)try{input.state.rollbackAfterSql(operation);safety.unknown=false;}catch{safety.unknown=true;}
   safety.unknown||=discard||committed;
  }
  if(client)try{client.release(discard);}catch(error){safety.unknown=true;first??=error;}
  if(stage&&!operation&&!safety.unknown)try{input.state.removeUnpublishedStage(stage);}catch(error){safety.unknown=true;first??=error;}
  if(first)throw first;return {operationId:operation!.id,status:'quarantined' as const,inputDigest};
 });
}
