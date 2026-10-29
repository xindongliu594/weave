import type pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import type {ArchiveWriterManager} from '../../../services/agent-runtime/archive-writer-scope.mjs';
import {syncArchiveDirectory} from '../../../services/agent-runtime/archive-objects.mjs';
import {AppError} from './provider.ts';
import {obsidianRoot,withVaultLock} from './obsidian.ts';
import {nativeCapabilityRoot,readNativeBundle} from './native-capabilities.ts';
import {resetVaultCache} from './vault.ts';
import {readRestoreAdmission} from './enterprise-restore-admission.ts';

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const HASH=/^[a-f0-9]{64}$/;
const MANIFEST_LIMIT=128*1024*1024,VAULT_LIMIT=40*1024*1024,TREE_LIMIT=512*1024*1024,ENTRY_LIMIT=100000;
const sha=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const unresolved=()=>new AppError(409,'恢复结果尚未核对，已保留恢复前后资料。请完成本机恢复核对后继续。','BACKUP_RESTORE_RECONCILIATION_REQUIRED');
const invalid=()=>new AppError(422,'恢复控制目录、文件或记录不满足本机安全约束。','BACKUP_RESTORE_STATE_INVALID');
const limit=()=>new AppError(422,'当前资料超过在线恢复记录限制，请使用已验证的离线备份流程。','BACKUP_RESTORE_STATE_LIMIT');
type SavedFile={data:string;sha256:string}|null;
type Tree=Array<{path:string;kind:'directory'}|{path:string;kind:'file';bytes:number;sha256:string}>|null;
type Manifest={format:1;operationId:string;databaseId:string;generation:string;inputDigest:string;traceRoot:string;dataRoot:string;vaultRoot:string;bundleRoot:string;beforeTrace:Tree;afterTrace:Tree;beforeKey:SavedFile;afterKey:SavedFile;beforeVault:Record<string,SavedFile>;afterVault:Record<string,SavedFile>;bundles:Array<{id:string;existed:boolean}>};
export type BackupRestoreOperation={readonly id:string;readonly stage:string;readonly beforeTrace:string;readonly retainedAfter:string;readonly manifestSha256:string;readonly manifest:Manifest};
type Stage={id:string;path:string};
type Database=Pick<pg.PoolClient,'query'>;
function stat(name:string){try{return fs.lstatSync(name);}catch(error){if((error as any).code==='ENOENT')return null;throw error;}}
function plain(name:string,kind:'file'|'directory'){
 const info=stat(name);if(!info||info.isSymbolicLink()||!(kind==='file'?info.isFile()&&info.nlink===1:info.isDirectory())||fs.realpathSync.native(name)!==name)throw invalid();return info;
}
function parents(name:string){const names=[];for(let current=path.dirname(name);;current=path.dirname(current)){names.push(current);if(path.dirname(current)===current)break;}for(const current of names.reverse()){const info=stat(current);if(info)plain(current,'directory');}}
function overlaps(a:string,b:string){const normalize=(v:string)=>process.platform==='win32'?v.toLowerCase():v;const relative=path.relative(normalize(a),normalize(b));return !relative||(!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative));}
function child(root:string,name:string){if(typeof name!=='string'||!name||name.includes('\\')||name.includes('\0')||name.includes(':')||name.split('/').some(part=>!part||part==='.'||part==='..'))throw invalid();const target=path.join(root,...name.split('/'));if(!overlaps(root,target)||target===root)throw invalid();parents(target);return target;}
function saved(name:string,max=VAULT_LIMIT):SavedFile{parents(name);const info=stat(name);if(!info)return null;plain(name,'file');if(info.size>max)throw limit();const bytes=fs.readFileSync(name);return {data:bytes.toString('base64'),sha256:sha(bytes)};}
function fromBase64(value:string|undefined,max:number):SavedFile{if(value===undefined)return null;if(typeof value!=='string'||value.length>Math.ceil(max/3)*4)throw invalid();const bytes=Buffer.from(value,'base64');if(bytes.length>max||bytes.toString('base64')!==value)throw invalid();return {data:value,sha256:sha(bytes)};}
function tree(root:string):Tree{
 parents(root);if(!stat(root))return null;plain(root,'directory');const result:NonNullable<Tree>=[];let size=0;
 function walk(dir:string,prefix=''){for(const name of fs.readdirSync(dir).sort()){const relative=prefix+name,target=child(root,relative),info=stat(target)!;if(result.length>=ENTRY_LIMIT)throw limit();if(info.isDirectory()){plain(target,'directory');result.push({path:relative,kind:'directory'});walk(target,relative+'/');}else{plain(target,'file');size+=info.size;if(size>TREE_LIMIT)throw limit();result.push({path:relative,kind:'file',bytes:info.size,sha256:sha(fs.readFileSync(target))});}}}
 walk(root);return result;
}
function flushTree(root:string,entries:Tree){if(entries===null)return;for(const entry of entries)if(entry.kind==='file'){const name=child(root,entry.path);plain(name,'file');const fd=fs.openSync(name,process.platform==='win32'?'r+':'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}for(const entry of [...entries].reverse())if(entry.kind==='directory')syncArchiveDirectory(child(root,entry.path));syncArchiveDirectory(root);if(!isDeepStrictEqual(tree(root),entries))throw unresolved();}
function writeFileDurable(name:string,bytes:Buffer|string){parents(name);const fd=fs.openSync(name,'wx',0o600);try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}syncArchiveDirectory(path.dirname(name));}
function atomicJson(name:string,value:unknown){const text=JSON.stringify(value);if(Buffer.byteLength(text)>MANIFEST_LIMIT)throw limit();const temporary=name+'.'+randomUUID()+'.tmp';writeFileDurable(temporary,text);fs.renameSync(temporary,name);syncArchiveDirectory(path.dirname(name));}
function replaceSaved(name:string,value:SavedFile){parents(name);if(stat(name))plain(name,'file');if(value===null){if(stat(name)){fs.unlinkSync(name);syncArchiveDirectory(path.dirname(name));}return;}fs.mkdirSync(path.dirname(name),{recursive:true,mode:0o700});parents(name);const temporary=name+'.'+randomUUID()+'.restore-tmp';writeFileDurable(temporary,Buffer.from(value.data,'base64'));fs.renameSync(temporary,name);syncArchiveDirectory(path.dirname(name));}
function readJson(name:string,max=MANIFEST_LIMIT){if(plain(name,'file').size>max)throw invalid();return JSON.parse(fs.readFileSync(name,'utf8'));}
function controlPath(dataRoot:string){return path.join(path.resolve(dataRoot),'.backup-restore-state');}
function unfinished(control:string){const names=fs.readdirSync(control);if(names.length>1002)throw invalid();for(const name of names){if(!UUID.test(name))continue;const directory=path.join(control,name);plain(directory,'directory');const completion=path.join(directory,'completion.json');if(!stat(completion))return true;const value=readJson(completion,2048);if(value.operationId!==name||!HASH.test(value.manifestSha256)||!['committed','rolled-back'].includes(value.status))throw invalid();}return false;}

/** Read-only startup hint. A damaged control path is pending, never a clean start. */
export function inspectBackupRestoreStartup(options:{traceRoot:string;dataRoot:string}):{pending:boolean}{
 const root=controlPath(options.dataRoot);try{if(!stat(root))return {pending:false};plain(root,'directory');return {pending:stat(path.join(root,'active.json'))!==null||unfinished(root)};}catch{return {pending:true};}
}
/** Local control tables are deliberately absent from the portable payload and TRUNCATE set. */
export async function migrateBackupRestoreState(db:Database){
 await db.query(`CREATE TABLE IF NOT EXISTS backup_restore_anchor(singleton integer PRIMARY KEY CHECK(singleton=1),database_id uuid NOT NULL UNIQUE,generation bigint NOT NULL DEFAULT 0 CHECK(generation>=0));
 CREATE TABLE IF NOT EXISTS backup_restore_receipts(operation_id uuid PRIMARY KEY,database_id uuid NOT NULL,previous_generation bigint NOT NULL CHECK(previous_generation>=0),next_generation bigint NOT NULL CHECK(next_generation=previous_generation+1),manifest_sha256 text NOT NULL CHECK(manifest_sha256 ~ '^[a-f0-9]{64}$'),UNIQUE(database_id,next_generation));`);
 await db.query('ALTER TABLE backup_restore_anchor ADD COLUMN IF NOT EXISTS enterprise_restore_operation_id uuid');
 await db.query('INSERT INTO backup_restore_anchor(singleton,database_id) VALUES(1,$1) ON CONFLICT(singleton) DO NOTHING',[randomUUID()]);
}
export function createBackupRestoreState(options:{pool:Pick<pg.Pool,'connect'>;writers:ArchiveWriterManager;traceRoot:string;dataRoot:string}){
 const {pool,writers}=options,traceRoot=path.resolve(options.traceRoot),dataRoot=path.resolve(options.dataRoot),control=controlPath(dataRoot),active=path.join(control,'active.json'),vaultRoot=obsidianRoot(),bundleRoot=nativeCapabilityRoot(),keyPath=path.join(dataRoot,'credential.key');
 if(writers.traceRoot!==traceRoot||[traceRoot,writers.lockRoot,vaultRoot,bundleRoot].some(root=>overlaps(root,control)||overlaps(control,root))||overlaps(traceRoot,vaultRoot)||overlaps(vaultRoot,traceRoot)||overlaps(traceRoot,bundleRoot)||overlaps(bundleRoot,traceRoot))throw invalid();
 const owned=new WeakSet<object>();
 function assertRoot(){writers.assertRootExclusive();parents(control);if(stat(control))plain(control,'directory');}
 function paths(id:string){if(!UUID.test(id))throw invalid();return {id,stage:path.join(path.dirname(traceRoot),'restore-'+id),beforeTrace:path.join(path.dirname(traceRoot),'before-restore-'+id),retainedAfter:path.join(path.dirname(traceRoot),'after-restore-'+id),directory:path.join(control,id)};}
 function materialize(manifest:Manifest,digest:string):BackupRestoreOperation{const p=paths(manifest.operationId),operation={id:p.id,stage:p.stage,beforeTrace:p.beforeTrace,retainedAfter:p.retainedAfter,manifestSha256:digest,manifest};owned.add(operation);return operation;}
 function assertOwned(operation:BackupRestoreOperation){assertRoot();if(!owned.has(operation))throw invalid();}
 function readOperation(pointer:{operationId:string;manifestSha256:string}):BackupRestoreOperation{
  assertRoot();try{if(!UUID.test(pointer.operationId)||!HASH.test(pointer.manifestSha256))throw invalid();const p=paths(pointer.operationId);plain(p.directory,'directory');const manifestPath=path.join(p.directory,'manifest.json');if(plain(manifestPath,'file').size>MANIFEST_LIMIT)throw invalid();const bytes=fs.readFileSync(manifestPath);if(sha(bytes)!==pointer.manifestSha256)throw invalid();const m=JSON.parse(bytes.toString()) as Manifest;
   if(m.format!==1||m.operationId!==pointer.operationId||!UUID.test(m.databaseId)||!/^\d+$/.test(m.generation)||!HASH.test(m.inputDigest)||m.traceRoot!==traceRoot||m.dataRoot!==dataRoot||m.vaultRoot!==vaultRoot||m.bundleRoot!==bundleRoot||!Array.isArray(m.bundles)||m.bundles.length>100)throw invalid();
   for(const item of m.bundles)if(!HASH.test(item.id)||typeof item.existed!=='boolean')throw invalid();
   for(const value of [m.beforeKey,m.afterKey,...Object.values(m.beforeVault),...Object.values(m.afterVault)])if(value!==null&&(!value||!HASH.test(value.sha256)||!isDeepStrictEqual(fromBase64(value.data,VAULT_LIMIT),value)))throw invalid();
   if(!isDeepStrictEqual(Object.keys(m.beforeVault).sort(),Object.keys(m.afterVault).sort())||Object.keys(m.beforeVault).length>ENTRY_LIMIT)throw invalid();for(const name of Object.keys(m.beforeVault))child(vaultRoot,name);
   return materialize(m,pointer.manifestSha256);
  }catch{throw unresolved();}
 }
 function load():BackupRestoreOperation|null{
  assertRoot();if(!stat(control))return null;plain(control,'directory');if(!stat(active)){try{if(unfinished(control))throw unresolved();}catch{throw unresolved();}return null;}
  try{return readOperation(readJson(active,2048));}catch{throw unresolved();}
 }
 function requireClear(){if(load())throw unresolved();}
 function createStage():Stage{assertRoot();requireClear();const p=paths(randomUUID());for(const name of [p.stage,p.beforeTrace,p.retainedAfter]){parents(name);if(stat(name))throw invalid();}fs.mkdirSync(p.stage,{mode:0o700});syncArchiveDirectory(path.dirname(p.stage));return {id:p.id,path:p.stage};}
 function removeUnpublishedStage(stage:Stage){assertRoot();if(stage.path!==paths(stage.id).stage||load())throw unresolved();if(stat(stage.path)){tree(stage.path);fs.rmSync(stage.path,{recursive:true});syncArchiveDirectory(path.dirname(stage.path));}}
 async function prepareRestore(db:Database,input:{stage:Stage;master?:string;vaultFiles:Record<string,string>;previousPaths:string[];nativePluginBundles:Record<string,unknown>;inputDigest:string}){
  assertRoot();requireClear();if(input.stage.path!==paths(input.stage.id).stage||!HASH.test(input.inputDigest))throw invalid();
  const anchor=(await db.query('SELECT database_id,generation::text FROM backup_restore_anchor WHERE singleton=1 FOR UPDATE')).rows[0];if(!anchor||!UUID.test(anchor.database_id))throw unresolved();
  const beforeVault:Record<string,SavedFile>=Object.create(null),afterVault:Record<string,SavedFile>=Object.create(null);let bytes=0;const names=[...new Set([...input.previousPaths,...Object.keys(input.vaultFiles)])].sort();if(names.length>ENTRY_LIMIT)throw limit();
  for(const name of names){beforeVault[name]=saved(child(vaultRoot,name));afterVault[name]=fromBase64(input.vaultFiles[name],VAULT_LIMIT);bytes+=(beforeVault[name]?.data.length??0)+(afterVault[name]?.data.length??0);if(bytes>VAULT_LIMIT*8/3)throw limit();}
  const afterKey=fromBase64(input.master,32);if(afterKey&&Buffer.from(afterKey.data,'base64').length!==32)throw invalid();
  const bundles=Object.keys(input.nativePluginBundles).sort().map(id=>{if(!HASH.test(id))throw invalid();const existed=stat(path.join(bundleRoot,id))!==null;if(existed)readNativeBundle(id,bundleRoot);return {id,existed};});if(bundles.length>100)throw limit();
  const manifest:Manifest={format:1,operationId:input.stage.id,databaseId:anchor.database_id,generation:anchor.generation,inputDigest:input.inputDigest,traceRoot,dataRoot,vaultRoot,bundleRoot,beforeTrace:tree(traceRoot),afterTrace:tree(input.stage.path),beforeKey:saved(keyPath,32),afterKey,beforeVault,afterVault,bundles};
  if(manifest.afterTrace===null)throw invalid();flushTree(traceRoot,manifest.beforeTrace);flushTree(input.stage.path,manifest.afterTrace);const text=JSON.stringify(manifest);if(Buffer.byteLength(text)>MANIFEST_LIMIT)throw limit();const p=paths(input.stage.id);
  fs.mkdirSync(control,{recursive:true,mode:0o700});plain(control,'directory');fs.mkdirSync(p.directory,{mode:0o700});syncArchiveDirectory(control);writeFileDurable(path.join(p.directory,'manifest.json'),text);const digest=sha(text);atomicJson(active,{operationId:input.stage.id,manifestSha256:digest});return materialize(manifest,digest);
 }
 function verifyBundles(operation:BackupRestoreOperation,committed:boolean){for(const bundle of operation.manifest.bundles){if(committed||bundle.existed||stat(path.join(bundleRoot,bundle.id)))readNativeBundle(bundle.id,bundleRoot);}}
 function verifyFiles(operation:BackupRestoreOperation,side:'before'|'after'){
  const m=operation.manifest;if(!isDeepStrictEqual(tree(traceRoot),side==='before'?m.beforeTrace:m.afterTrace)||!isDeepStrictEqual(saved(keyPath,32),side==='before'?m.beforeKey:m.afterKey))throw unresolved();const expected=side==='before'?m.beforeVault:m.afterVault;for(const [name,value] of Object.entries(expected))if(!isDeepStrictEqual(saved(child(vaultRoot,name)),value))throw unresolved();verifyBundles(operation,side==='after');
 }
 function installArchive(operation:BackupRestoreOperation){assertOwned(operation);const m=operation.manifest;if(!isDeepStrictEqual(tree(traceRoot),m.beforeTrace)||!isDeepStrictEqual(tree(operation.stage),m.afterTrace)||!isDeepStrictEqual(saved(keyPath,32),m.beforeKey)||stat(operation.beforeTrace))throw unresolved();if(m.beforeTrace!==null)fs.renameSync(traceRoot,operation.beforeTrace);syncArchiveDirectory(path.dirname(traceRoot));fs.renameSync(operation.stage,traceRoot);syncArchiveDirectory(path.dirname(traceRoot));replaceSaved(keyPath,m.afterKey);}
 async function recordCommitReceipt(db:Database,operation:BackupRestoreOperation){
  assertOwned(operation);verifyFiles(operation,'after');const m=operation.manifest;const changed=await db.query('UPDATE backup_restore_anchor SET generation=generation+1 WHERE singleton=1 AND database_id=$1 AND generation=$2 RETURNING generation::text',[m.databaseId,m.generation]);if(changed.rowCount!==1)throw unresolved();await db.query('INSERT INTO backup_restore_receipts(operation_id,database_id,previous_generation,next_generation,manifest_sha256) VALUES($1,$2,$3,$4,$5)',[operation.id,m.databaseId,m.generation,changed.rows[0].generation,operation.manifestSha256]);
 }
 function finish(operation:BackupRestoreOperation,status:'committed'|'rolled-back'){
  assertOwned(operation);const pending=load();if(!pending||pending.id!==operation.id||pending.manifestSha256!==operation.manifestSha256)throw unresolved();verifyFiles(operation,status==='committed'?'after':'before');atomicJson(path.join(paths(operation.id).directory,'completion.json'),{operationId:operation.id,manifestSha256:operation.manifestSha256,status});fs.unlinkSync(active);syncArchiveDirectory(control);resetVaultCache();
 }
 function rollbackPhysical(operation:BackupRestoreOperation){
  assertOwned(operation);const m=operation.manifest,current=tree(traceRoot),old=tree(operation.beforeTrace),stage=tree(operation.stage),retained=tree(operation.retainedAfter);
  if(!isDeepStrictEqual(current,m.beforeTrace)&&!isDeepStrictEqual(current,m.afterTrace)&&current!==null)throw unresolved();if(!isDeepStrictEqual(current,m.beforeTrace)&&!isDeepStrictEqual(old,m.beforeTrace))throw unresolved();if(stage!==null&&!isDeepStrictEqual(stage,m.afterTrace)||retained!==null&&!isDeepStrictEqual(retained,m.afterTrace))throw unresolved();
  const targets:Array<[string,SavedFile,SavedFile]>=[[keyPath,m.beforeKey,m.afterKey],...Object.keys(m.beforeVault).map(name=>[child(vaultRoot,name),m.beforeVault[name],m.afterVault[name]] as [string,SavedFile,SavedFile])];
  for(const [name,before,after] of targets){const value=saved(name);if(!isDeepStrictEqual(value,before)&&!isDeepStrictEqual(value,after))throw unresolved();}verifyBundles(operation,false);
  if(!isDeepStrictEqual(current,m.beforeTrace)){if(current!==null){if(retained!==null)throw unresolved();fs.renameSync(traceRoot,operation.retainedAfter);syncArchiveDirectory(path.dirname(traceRoot));}if(m.beforeTrace!==null){fs.renameSync(operation.beforeTrace,traceRoot);syncArchiveDirectory(path.dirname(traceRoot));}}
  for(const [name,before] of targets)if(!isDeepStrictEqual(saved(name),before))replaceSaved(name,before);
  verifyFiles(operation,'before');
 }
 function rollbackAfterSql(operation:BackupRestoreOperation){assertOwned(operation);rollbackPhysical(operation);finish(operation,'rolled-back');}
 function confirmCommitted(operation:BackupRestoreOperation){finish(operation,'committed');}
 async function verifyCommittedRestoreIn(db:Database,input:{operationId:string;inputDigest:string}){
  assertRoot();requireClear();const admission=await readRestoreAdmission(db);
  if(!admission||!('operation_id' in admission)||!admission.receiptVerified||admission.operation_id!==input.operationId||admission.input_digest!==input.inputDigest)throw unresolved();
  const operation=readOperation({operationId:input.operationId,manifestSha256:admission.manifest_sha256}),completion=readJson(path.join(paths(input.operationId).directory,'completion.json'),2048);
  if(completion.operationId!==operation.id||completion.manifestSha256!==operation.manifestSha256||completion.status!=='committed'||operation.manifest.inputDigest!==input.inputDigest)throw unresolved();
  verifyFiles(operation,'after');
 }
 async function reconcilePending(){
  return writers.withRootExclusive(()=>withVaultLock(async()=>{
   const operation=load();if(!operation)return {status:'clear' as const};let client:pg.PoolClient|undefined,committing=false,discard=false;
   try{client=await pool.connect();await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(918274)');await client.query('SELECT pg_advisory_xact_lock(918275)');const anchor=(await client.query('SELECT database_id,generation::text,enterprise_restore_operation_id FROM backup_restore_anchor WHERE singleton=1 FOR UPDATE')).rows[0],receipt=(await client.query('SELECT database_id,previous_generation::text,next_generation::text,manifest_sha256 FROM backup_restore_receipts WHERE operation_id=$1',[operation.id])).rows[0],m=operation.manifest;
    if(!anchor||anchor.database_id!==m.databaseId)throw unresolved();let status:'committed'|'rolled-back';
    if(receipt){
     if(receipt.database_id!==m.databaseId||receipt.previous_generation!==m.generation||receipt.next_generation!==(BigInt(m.generation)+1n).toString()||anchor.generation!==receipt.next_generation||receipt.manifest_sha256!==operation.manifestSha256)throw unresolved();
     if(anchor.enterprise_restore_operation_id!==null){
      const admission=await readRestoreAdmission(client);
      if(!admission||!('operation_id' in admission)||admission.operation_id!==operation.id||admission.input_digest!==m.inputDigest||!admission.receiptVerified||(admission.status!=='quarantined'&&!admission.verified))throw unresolved();
     }
     verifyFiles(operation,'after');status='committed';
    }
    else{if(anchor.generation!==m.generation)throw unresolved();rollbackPhysical(operation);status='rolled-back';}
    committing=true;await client.query('COMMIT');committing=false;finish(operation,status);return {status};
   }catch(error){discard=committing;try{if(client&&!committing)await client.query('ROLLBACK');}catch{discard=true;}throw error instanceof AppError?error:unresolved();}
   finally{client?.release(discard);}
  }),{timeoutMs:2000});
 }
 return Object.freeze({reconcilePending,requireClear,createStage,removeUnpublishedStage,prepareRestore,installArchive,recordCommitReceipt,confirmCommitted,rollbackAfterSql,verifyCommittedRestoreIn});
}
export type BackupRestoreState=ReturnType<typeof createBackupRestoreState>;
