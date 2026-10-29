import {join,resolve,relative,isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
import type pg from 'pg';
import {pool} from './db.ts';
import {AppError} from './provider.ts';
import type {Principal} from './identity-types.ts';
import {administrative,currentRoutePrincipal} from './project-route-access.ts';
import type {ArchiveWriterManager} from '../../../services/agent-runtime/archive-writer-scope.mjs';
import type {BackupRestoreState} from './backup-restore-state.ts';
import {underBackupRoot,type BackupSafety} from './backup-root-scope.ts';
import {obsidianRoot} from './obsidian.ts';
import {nativeCapabilityRoot,exportNativeBundles} from './native-capabilities.ts';
import {assertEnterpriseCatalog} from './enterprise-backup-catalog.ts';
import {createBackupFileReader} from './enterprise-backup-files.ts';
import {validateEnterpriseBackupReferences} from './backup-checkpoints.ts';
import {enterpriseTableSpecs,createEnterpriseBackup,encryptEnterpriseBackup,ENTERPRISE_BACKUP_SCHEMA_ID,type EnterpriseTableName,type EnterpriseBackupV2} from './enterprise-backup-schema.ts';
import packageMetadata from '../../../package.json';

const tables=Object.keys(enterpriseTableSpecs) as EnterpriseTableName[];
const quote=(name:string)=>'"'+name.replaceAll('"','""')+'"';
const busy=()=>new AppError(409,'请等待执行、模型调用、经理回复或其他数据写入结束后再备份；尚未开始的经理消息可在对话页取消等待。','BACKUP_SOURCE_BUSY');
const invalid=(code:string)=>new AppError(422,'企业备份文件或关联证据不完整，请先核对来源。',code);
const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');

/** Fixed projection only. JSONB text preserves SQL NULL, JSON null and exact
 * numeric tokens; pg's usual JSON.parse date/number codecs never touch them. */
export async function readEnterpriseTables(db:Pick<pg.PoolClient,'query'>){
  const rows={} as EnterpriseBackupV2['tables'];let total=0,bytes=0;
  for(const name of tables){
    const columns=Object.entries(enterpriseTableSpecs[name].columns).map(([column,[type]])=>{
      const id=quote(column);
      const expression=['jsonb','numeric','bigint','vector(384)'].includes(type)?id+'::text':type==='timestamp with time zone'?`to_char(${id} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`:id;
      return expression+' AS '+id;
    });
    const result=await db.query(`SELECT ${columns.join(',')} FROM ${quote(name)} ORDER BY ${enterpriseTableSpecs[name].primaryKey.map(quote).join(',')} LIMIT 100001`);
    if(result.rows.length>100000||(total+=result.rows.length)>500000||(bytes+=Buffer.byteLength(JSON.stringify(result.rows)))>50*1024*1024)throw invalid('BACKUP_SIZE_LIMIT');
    rows[name]=result.rows;
  }return rows;
}
export function decodedEnterpriseTables(rows:EnterpriseBackupV2['tables']){
  return Object.fromEntries(tables.map(name=>[name,rows[name].map(row=>Object.fromEntries(Object.entries(row).map(([column,value])=>[column,(enterpriseTableSpecs[name].columns as Record<string,readonly [string,boolean]>)[column][0]==='jsonb'&&value!==null?JSON.parse(value as string):value])))]));
}
function child(root:string,path:string){
  const file=resolve(root,path),rel=relative(root,file);
  if(!path||path.includes('\\')||path.split('/').some(p=>!p||p==='.'||p==='..')||!rel||rel.startsWith('..')||isAbsolute(rel))throw invalid('BACKUP_FILE_UNSAFE');return file;
}
async function snapshot(input:{principal:Principal;traceRoot:string;password:string},safety:BackupSafety){
  const client=await pool.connect(),locks:number[]=[];let first:unknown,discard=false,committing=false,transaction=false,result;
  try{
    for(const lock of [918274,918275]){safety.unknown=true;const row=await client.query(`SELECT pg_try_advisory_lock(${lock}) AS locked`);safety.unknown=false;if(row.rows[0]?.locked!==true)throw busy();locks.push(lock);}
    transaction=true;await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    // LOCK is before the transaction's first data/catalog snapshot.
    await client.query('LOCK TABLE '+[...tables,'backup_restore_anchor'].map(quote).join(',')+' IN SHARE MODE NOWAIT');
    await currentRoutePrincipal(client,input.principal,true);if(!administrative(input.principal))throw new AppError(403,'备份需要当前管理员权限','BACKUP_ADMIN_REQUIRED');
    await assertEnterpriseCatalog(client);
    for(const sql of ["SELECT 1 FROM project_runs WHERE status IN ('queued','running') LIMIT 1","SELECT 1 FROM model_reservations WHERE status='pending' LIMIT 1","SELECT 1 FROM manager_messages WHERE status IN ('waiting','replying') LIMIT 1","SELECT 1 FROM model_capability_tests WHERE status='running' LIMIT 1"]){if((await client.query(sql)).rowCount)throw busy();}
    const rows=await readEnterpriseTables(client),decoded=decodedEnterpriseTables(rows),reader=createBackupFileReader();
    const files=reader.tree(input.traceRoot),masterPath=join(resolve(process.env.DATA_DIR??'.data'),'credential.key');
    const master=reader.optional(masterPath)?.toString('base64')??null;
    if(master===null&&[...rows.gateways,...rows.models,...rows.mcp_connections].some(row=>row.credential!==null))throw invalid('BACKUP_CREDENTIAL_KEY_MISSING');
    if(master&&Buffer.from(master,'base64').length!==32)throw invalid('BACKUP_FILE_UNSAFE');
    const vaultFiles:Record<string,string>=Object.create(null);
    for(const doc of decoded.knowledge_documents){if(doc.deleted_at!==null||!doc.vault_path)continue;const bytes=reader.read(child(obsidianRoot(),doc.vault_path));
      if(!doc.vault_hash||hash(bytes)!==doc.vault_hash)throw invalid('BACKUP_VAULT_UNSYNCED');vaultFiles[doc.vault_path]=bytes.toString('base64');}
    const nativePluginBundles=exportNativeBundles(decoded);
    for(const [id,bundle] of Object.entries(nativePluginBundles)){
      const root=join(nativeCapabilityRoot(),id);
      for(const [path,expected] of [['bundle.gz',bundle.compressed],['package.json',bundle.metadata]] as const)if(reader.read(join(root,path)).toString('base64')!==expected)throw invalid('BACKUP_SOURCE_CHANGED');
      if(JSON.stringify(JSON.parse(reader.read(join(root,'manifest.json')).toString('utf8')))!==JSON.stringify(bundle.manifest))throw invalid('BACKUP_SOURCE_CHANGED');
    }
    const anchor=(await client.query('SELECT database_id FROM backup_restore_anchor WHERE singleton=1')).rows[0],version=String((await client.query('SELECT version() AS value')).rows[0]?.value??'');
    const payload=createEnterpriseBackup({version:2,schemaId:ENTERPRISE_BACKUP_SCHEMA_ID,createdAt:new Date().toISOString(),source:{applicationVersion:packageMetadata.version,databaseId:anchor?.database_id,engine:/emcc|emscripten|wasm|pglite/i.test(version)?'pglite':'postgresql'},tables:rows,files,master,nativePluginBundles,vaultFiles});
    validateEnterpriseBackupReferences(payload,input.traceRoot);
    // Backing up restored history must not require reviving its discarded live
    // claim secret. Archive integrity is checked above; execution always uses
    // the separate original-claim and current-authority gates.
    reader.verify();
    result=await encryptEnterpriseBackup(payload,input.password);reader.verify();
    committing=true;await client.query('COMMIT');committing=false;transaction=false;
  }catch(error:any){first=error?.code==='55P03'?busy():error;discard=committing||safety.unknown;if(transaction&&!committing)try{await client.query('ROLLBACK');}catch{discard=true;}}
  for(const lock of locks.reverse())try{const row=await client.query(`SELECT pg_advisory_unlock(${lock}) AS unlocked`);if(row.rows[0]?.unlocked!==true)throw Error('Enterprise backup SQL unlock unconfirmed');}catch(error){discard=true;first??=error;}
  safety.unknown||=discard;try{client.release(discard);}catch(error){safety.unknown=true;first??=error;}if(first)throw first;return result!;
}
export async function exportEnterpriseBackup(input:{principal:Principal;traceRoot:string;writers:ArchiveWriterManager;state:BackupRestoreState;password:string}){
  if(input.writers.traceRoot!==resolve(input.traceRoot))throw invalid('BACKUP_FILE_UNSAFE');
  try{return await underBackupRoot(input.writers,input.state,safety=>snapshot(input,safety));}
  catch(error:any){if(/^E_ARCHIVE_(?:FENCE|WRITER)_(?:BUSY|TIMEOUT)$/.test(error?.code??''))throw busy();throw error;}
}
