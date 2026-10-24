import {Router} from 'express';
import {z} from 'zod';
import {randomUUID,createHash} from 'node:crypto';
import {join,resolve,isAbsolute} from 'node:path';
import {lstatSync} from 'node:fs';
import {isDeepStrictEqual} from 'node:util';
import type pg from 'pg';
import type {ArchiveWriterManager} from '../../../services/agent-runtime/archive-writer-scope.mjs';
import {pool} from './db.ts';
import {AppError} from './provider.ts';
import {scanStorage,workspaceRunIds,workspaceCopyCandidates,validateWorkspaceCopies,removeWorkspaceCopies,reconcileWorkspaceCopies,assertStorageHeadroom,MIN_STORAGE_FREE_BYTES,type StorageOptions} from '../../../services/agent-runtime/storage-governance.mjs';
import {ARCHIVE_ROOT_LIMIT_BYTES,RUN_ARCHIVE_LIMIT_BYTES} from '../../../services/agent-runtime/archive-storage.mjs';
import {retentionAdvice} from '../../../services/agent-runtime/storage-retention.mjs';
import {readRun} from '../../../services/agent-runtime/trace-store.mjs';
import {unresolvedOperations} from '../../../services/agent-runtime/recovery.mjs';
import {type SandboxMaintenance,maintenanceCandidate,validateMaintenance,applyMaintenance,reconcileMaintenance,maintenanceError,maintenanceConfirmation,boundSandbox,assertMaintenanceScope} from './storage-lifecycle.ts';
import {readTaskStopMaintenance} from './task-stop-maintenance.ts';
import {withTaskStopMaintenance} from './task-stop-storage.ts';
import {readMaintenanceHealth} from './maintenance-health.ts';
import {unresolvedOperationSql} from './tool-operations.ts';
import {administrative,currentRoutePrincipal,httpPrincipal} from './project-route-access.ts';
import type {Principal} from './identity-types.ts';
export const storageTables=['storage_cleanups'];
export async function migrateStorage(db:Pick<pg.Pool,'query'>){await db.query(`CREATE TABLE IF NOT EXISTS storage_cleanups(id text PRIMARY KEY,status text NOT NULL DEFAULT 'preview',preview jsonb NOT NULL,result jsonb,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());`);}
type Paths={dataRoot?:string;workspaceRoot?:string;nativeDeviceId?:string;deploymentBase?:string;maintenanceReportDir?:string;sandbox?:()=>SandboxMaintenance|undefined};
const idSchema=z.uuid();
const scope=(traceRoot:string,paths:Paths)=>createHash('sha256').update(JSON.stringify([resolve(traceRoot),paths.workspaceRoot&&resolve(paths.workspaceRoot),paths.nativeDeviceId])).digest('hex');
const publicRow=(row:any)=>({id:row.id,status:row.status,preview:row.preview,result:row.result,createdAt:row.created_at,updatedAt:row.updated_at});
async function fileOptions(traceRoot:string,paths:Paths,db:Pick<pg.PoolClient,'query'>,runIds?:string[]):Promise<StorageOptions>{
 let ids=runIds;try{ids??=workspaceRunIds(paths.workspaceRoot);}catch{ids=[];}
 ids=[...new Set(ids)];if(ids.length>4096)throw new AppError(409,'清理范围超过安全上限','STORAGE_PREVIEW_LIMIT');
 const rows=(await db.query(`SELECT r.id,r.status,r.snapshot->'executionTarget'->>'kind' AS kind,r.snapshot->'executionTarget'->>'deviceId' AS device_id,EXISTS(SELECT 1 FROM local_operations o WHERE o.run_id=r.id AND ${unresolvedOperationSql('o')}) AS blocked FROM project_runs r WHERE r.id=ANY($1::text[])`,[ids])).rows;
 return {traceRoot,workspaceRoot:paths.workspaceRoot,runs:rows.map(row=>({id:row.id,status:row.status,blocked:row.blocked,native:!!paths.nativeDeviceId&&row.kind==='local'&&row.device_id===paths.nativeDeviceId}))};
}
async function idle(db:Pick<pg.PoolClient,'query'>){
 if((await db.query("SELECT id FROM project_runs WHERE status IN ('queued','running') LIMIT 1")).rowCount)throw new AppError(409,'请先停止队列和执行任务，再清理工作区副本。','STORAGE_ACTIVE_RUN');
 if((await db.query(`SELECT id FROM local_operations WHERE ${unresolvedOperationSql()} LIMIT 1`)).rowCount)throw new AppError(409,'仍有待执行或结果未知的工具操作，请先核对执行记录。','STORAGE_UNKNOWN_OPERATION');
}
function maintenanceRuns(preview:any):string[]{
 if(!Array.isArray(preview?.candidates)||preview.candidates.length>4096)throw new AppError(409,'维护清单已变化','STORAGE_PREVIEW_STALE');
 const ids=[...new Set<string>(preview.candidates.map((item:any)=>idSchema.parse(item.runId)))].sort();
 if(ids.length>128)throw new AppError(409,'单次维护最多覆盖 128 个运行，请重新生成较小的预览。','STORAGE_PREVIEW_LIMIT');return ids;
}
type MaintenanceTransaction={client:pg.PoolClient;begin:()=>Promise<void>;commit:()=>Promise<void>;physical:<T>(work:()=>T)=>T;partial:(id:string,result:()=>any)=>void};
/** One original native owner spans every SQL transaction, physical promise and receipt. */
async function maintain<T>(traceRoot:string,runIds:string[],writers:ArchiveWriterManager|undefined,db:pg.Pool,work:(tx:MaintenanceTransaction)=>Promise<T>):Promise<T>{
 if(!writers||writers.traceRoot!==resolve(traceRoot))throw new AppError(503,'维护写入边界尚未连接','STORAGE_WRITER_UNAVAILABLE');
 const execute=async()=>{
  assertMaintenanceScope(traceRoot,runIds,writers);let client:pg.PoolClient|undefined,active=false,committing=false,physical=false,discard=false,unsafe=false,rejected=false,first:unknown,value:T|undefined,partial:{id:string;result:()=>any}|undefined;
  const begin=async()=>{active=true;await client!.query('BEGIN');await client!.query('SELECT pg_advisory_xact_lock(918274)');await client!.query('SELECT pg_advisory_xact_lock(918275)');await client!.query('SELECT pg_advisory_xact_lock(918276)');await client!.query('LOCK TABLE project_runs,local_operations,local_devices,model_reservations IN SHARE MODE');};
  const commit=async()=>{committing=true;await client!.query('COMMIT');committing=false;active=false;};
  const rollback=async()=>{if(!active&&!committing)return true;try{await client!.query('ROLLBACK');active=false;return true;}catch{discard=true;return false;}};
  try{client=await db.connect();value=await work({client,begin,commit,physical:fn=>{physical=true;return fn();},partial:(id,result)=>{partial={id,result};}});}
  catch(error){
   rejected=true;first=error;const rolledBack=client?await rollback():true;unsafe=physical||committing||!rolledBack;discard||=committing;
   // A receipt is best effort only after a proven transaction outcome. Never
   // overwrite completed state after an unknown COMMIT or reuse a bad client.
   if(partial&&client&&!discard&&rolledBack){
    try{await begin();await client.query("UPDATE storage_cleanups SET status='partial',result=$2,updated_at=now() WHERE id=$1 AND status='started'",[partial.id,{...partial.result(),errorCode:(error as any)?.code??'CLEANUP_FAILED',message:'清理中止，请查看记录并核对；原交付保留。'}]);await commit();}
    catch{const receiptRolledBack=await rollback();discard||=committing;unsafe||=committing||!receiptRolledBack;}
   }
  }
  try{client?.release(discard);}catch(error){if(!rejected){rejected=true;first=error;}unsafe=true;}
  if(rejected){if(unsafe)throw first;return {ok:false as const,error:first};}return {ok:true as const,value:value!};
 };
 try{
  // An empty workspace preview has no file producer and no run lock to acquire.
  const outcome=runIds.length?await writers.withMaintenance(runIds,execute,{timeoutMs:2000}):await execute();
  if(!outcome.ok)throw outcome.error;return outcome.value;
 }catch(error){throw maintenanceError(error);}
}
async function currentAdministrator(db:pg.PoolClient,principal:Principal){await currentRoutePrincipal(db,principal,true);if(!administrative(principal))throw new AppError(403,'维护需要当前管理员权限','STORAGE_ADMIN_REQUIRED');}
function samePreview(row:any,discovered:any){if(!row||!isDeepStrictEqual(row.preview,discovered.preview)||!isDeepStrictEqual(maintenanceRuns(row.preview),maintenanceRuns(discovered.preview)))throw new AppError(409,'维护预览在等待期间已变化，请重新核对。','STORAGE_PREVIEW_STALE');}
export function storageRouter(traceRoot:string,paths:Paths={},db:pg.Pool=pool,writers?:ArchiveWriterManager){
 const router=Router(),scopeHash=scope(traceRoot,paths);
 router.get('/storage/maintenance',(req,res)=>{
  if(Object.keys(req.query).length)throw new AppError(422,'维护记录不接受额外查询参数','MAINTENANCE_QUERY_UNSUPPORTED');
  res.set('Cache-Control','no-store').json(readMaintenanceHealth(paths.maintenanceReportDir));
 });
 router.get('/storage/retention',async(_req,res)=>{
  const adapter=paths.sandbox?.(),scopes=adapter?.executor.storageScopes()??[];
  const rows=(await db.query(`SELECT r.id,r.status,r.finished_at,r.snapshot->'executionTarget' AS target,EXISTS(SELECT 1 FROM local_operations o WHERE o.run_id=r.id AND ${unresolvedOperationSql('o')}) OR EXISTS(SELECT 1 FROM model_reservations c WHERE c.run_id=r.id AND c.status IN ('pending','uncertain')) AS blocked FROM project_runs r ORDER BY created_at DESC LIMIT 50`)).rows;
  const ordinary=(path:string,directory=false)=>{try{const s=lstatSync(path);return !s.isSymbolicLink()&&(directory?s.isDirectory():s.isFile()&&s.nlink===1);}catch{return false;}};
  // Suggestions only; the original preview still checks archive integrity, grants and exact file versions.
  const archiveBlocked=(row:any)=>{if(!idSchema.safeParse(row.id).success||row.status!=='completed'||row.blocked)return true;try{const record=readRun(traceRoot,row.id);return !record||record.integrity!=='ok'||record.status!=='completed'||unresolvedOperations(record.events).length>0;}catch{return true;}};
  res.json(retentionAdvice(rows.filter(row=>idSchema.safeParse(row.id).success).map(row=>({id:row.id,status:row.status,finishedAt:row.finished_at instanceof Date?row.finished_at.toISOString():row.finished_at,blocked:archiveBlocked(row),
   journal:ordinary(join(traceRoot,row.id,'events.jsonl')),
   workspace:!!paths.workspaceRoot&&!!paths.nativeDeviceId&&row.target?.kind==='local'&&row.target.deviceId===paths.nativeDeviceId&&ordinary(join(paths.workspaceRoot,row.id),true),
   sandbox:!!adapter&&row.target?.deviceId===adapter.deviceId&&row.target?.grantId===adapter.grantId&&row.target?.backend?.fingerprint===adapter.fingerprint&&scopes.some(s=>s.runId===row.id&&['ready','stopped'].includes(s.phase)&&!!s.storage)
  }))));
 });
 router.get('/storage/sandboxes',async(_req,res)=>{const adapter=paths.sandbox?.(),scopes=await withTaskStopMaintenance(adapter?.executor.storageScopes()??[],runId=>readTaskStopMaintenance({db,traceRoot,runId}));res.json({available:!!adapter,scopes,hardQuota:false});});
 router.post('/storage/sandboxes/:id/inspect',async(req,res)=>{
  const runId=idSchema.parse(req.params.id),principal=httpPrincipal(res);z.object({}).strict().parse(req.body);
  const result=await maintain(traceRoot,[runId],writers,db,async tx=>{await tx.begin();await currentAdministrator(tx.client,principal);await idle(tx.client);const adapter=await boundSandbox(traceRoot,runId,paths.sandbox,tx.client);const result=await tx.physical(()=>adapter.executor.inspectStorage(runId));await tx.commit();return result;});res.json(result);
 });
 router.get('/storage',async(_req,res)=>{
  const archive=scanStorage(traceRoot),groups:any[]=[{id:'runs',name:'运行档案（交付、恢复、费用证据）',...archive,protection:'长期保护'}];
  if(paths.dataRoot)for(const [id,name] of [['database','业务数据库'],['credentials','加密凭证'],['workspaces','本机工作区副本'],['journal','本机操作收据'],['openshell','OpenShell 配置与操作映射'],['obsidian-vault','知识库原文'],['openrig','部门队列元数据']])groups.push({id,name,...scanStorage(join(paths.dataRoot,id)),protection:id==='workspaces'?'仅核验一致的完成副本可清理':'保护'});
  const deploymentGroups=paths.deploymentBase&&isAbsolute(paths.deploymentBase)?['releases','cache','backups','logs','runtime','metadata','data','probes'].map(id=>({id,name:id,...scanStorage(join(paths.deploymentBase!,id)),protection:'只读盘点；未自动删除'})):[];
  const runRows=(await db.query('SELECT id,project_id,status FROM project_runs ORDER BY created_at DESC LIMIT 50')).rows;
  const runs=runRows.map(run=>{const dir=join(traceRoot,run.id),count=scanStorage(dir),parts=['events.jsonl','events.jsonl.gz','journal-archive.json','sessions','artifacts','checkpoint-objects','workspace'].map(id=>({id,...scanStorage(join(dir,id))}));return {...run,...count,parts,overLimit:count.bytes>=RUN_ARCHIVE_LIMIT_BYTES};});
  let disk:any;try{disk={...assertStorageHeadroom(traceRoot,0),minFreeBytes:MIN_STORAGE_FREE_BYTES};disk.blocked=disk.freeBytes<MIN_STORAGE_FREE_BYTES;}catch{disk={unavailable:true};}
  res.json({...archive,maxBytes:ARCHIVE_ROOT_LIMIT_BYTES,runMaxBytes:RUN_ARCHIVE_LIMIT_BYTES,mode:'admission-only',retention:'preserve',groups,deploymentGroups,runs,disk,archiveBlocked:!archive.complete||archive.links>0||archive.bytes>=ARCHIVE_ROOT_LIMIT_BYTES,cleanupMode:'confirmed-completed-native-copies'});
 });
 router.get('/storage/cleanups',async(_req,res)=>res.json((await db.query('SELECT * FROM storage_cleanups ORDER BY created_at DESC LIMIT 50')).rows.map(publicRow)));
 router.post('/storage/preview',async(req,res)=>{
  const input=z.union([z.object({kind:z.literal('workspace').optional()}).strict(),z.object({kind:z.enum(['sandbox','journal']),runId:idSchema}).strict()]).parse(req.body),kind=input.kind??'workspace';const client=await db.connect();
  try{await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(918276)');
   const copies:any=kind==='workspace'?workspaceCopyCandidates(await fileOptions(traceRoot,paths,client)):{candidates:[await maintenanceCandidate(traceRoot,kind,(input as {runId:string}).runId,paths.sandbox,client)],protectedRuns:[]};
   maintenanceRuns(copies);
   const preview={...copies,kind,bytes:copies.candidates.reduce((sum:number,item:any)=>sum+item.bytes,0),scopeHash,expiresAt:new Date(Date.now()+30*60000).toISOString(),policy:'completed-native-identical-copies-v1',metadataReservationBytes:0},id=randomUUID();
   // Reserve room for both deletion receipts and a later interruption reconciliation.
   preview.metadataReservationBytes=4*Buffer.byteLength(JSON.stringify(preview))+4096;
   const existing=(await client.query("SELECT * FROM storage_cleanups WHERE status='preview' AND created_at>now()-interval '30 minutes' AND preview->>'scopeHash'=$1 AND preview->'candidates'=$2::jsonb AND COALESCE(preview->>'kind','workspace')=$3 ORDER BY created_at DESC LIMIT 1",[scopeHash,JSON.stringify(copies.candidates),kind])).rows[0];
   if(existing){await client.query('COMMIT');return res.status(201).json(publicRow(existing));}
   const capacity=(await client.query("SELECT count(*)::int AS records,COALESCE(sum(GREATEST(octet_length(preview::text)+octet_length(COALESCE(result::text,'')),COALESCE((preview->>'metadataReservationBytes')::bigint,0))),0)::bigint AS bytes FROM storage_cleanups")).rows[0];
   if(capacity.records>=1000||Number(capacity.bytes)+preview.metadataReservationBytes>16*1024*1024||copies.candidates.length>4096)throw new AppError(409,'清理元数据已达安全上限（1000 条 / 16 MiB，含结果预留），请先备份并整理记录；已有记录保留。','STORAGE_PREVIEW_LIMIT');
   const row=(await client.query('INSERT INTO storage_cleanups(id,preview) VALUES($1,$2) RETURNING *',[id,preview])).rows[0];await client.query('COMMIT');res.status(201).json(publicRow(row));
  }catch(error){await client.query('ROLLBACK');throw maintenanceError(error);}finally{client.release();}
 });
 router.post('/storage/cleanups/:id/confirm',async(req,res)=>{
  const id=idSchema.parse(req.params.id),input=z.object({confirmation:z.enum(['CLEAN_WORKSPACE_COPIES','RETIRE_SANDBOX','ARCHIVE_JOURNAL'])}).strict().parse(req.body),principal=httpPrincipal(res);
  const discovered=(await db.query('SELECT * FROM storage_cleanups WHERE id=$1',[id])).rows[0];if(!discovered)throw new AppError(404,'清理预览不存在');const runIds=maintenanceRuns(discovered.preview);
  const saved=await maintain(traceRoot,runIds,writers,db,async tx=>{
   const client=tx.client;let cleanupResult:any={deleted:[],bytes:0};await tx.begin();
   let row=(await client.query('SELECT * FROM storage_cleanups WHERE id=$1 FOR UPDATE',[id])).rows[0];samePreview(row,discovered);await currentAdministrator(client,principal);
   const kind=row.preview.kind??'workspace';if(input.confirmation!==maintenanceConfirmation[kind])throw new AppError(422,'确认内容与当前维护类型不相符。','STORAGE_CONFIRMATION_MISMATCH');
   if(['completed','partial','interrupted'].includes(row.status)){await tx.commit();return publicRow(row);}
   if(row.status!=='preview')throw new AppError(409,'上次清理结果尚未核对，请先核对记录；不会自动续删。','STORAGE_RECONCILIATION_REQUIRED');
   if(row.preview.scopeHash!==scopeHash||Date.now()-new Date(row.created_at).getTime()>30*60000||Date.now()>Date.parse(row.preview.expiresAt))throw new AppError(409,'清理预览已过期或工作区已改变，请重新预览。','STORAGE_PREVIEW_STALE');
   await idle(client);
   if(kind==='workspace')validateWorkspaceCopies(await fileOptions(traceRoot,paths,client,row.preview.candidates.map((c:any)=>c.runId)),row.preview.candidates);else await validateMaintenance(traceRoot,row.preview,paths.sandbox,client);
   await client.query("UPDATE storage_cleanups SET status='started',updated_at=now() WHERE id=$1",[id]);await tx.commit();tx.partial(id,()=>cleanupResult);
   // The durable started state survives a crash. Reacquire locks and recheck before any unlink.
   await tx.begin();
   row=(await client.query('SELECT * FROM storage_cleanups WHERE id=$1 FOR UPDATE',[id])).rows[0];
   samePreview(row,discovered);await currentAdministrator(client,principal);
   if(row.status!=='started')throw new AppError(409,'清理状态已被核对，请重新查看记录。','STORAGE_PREVIEW_STALE');
   await idle(client);
   try{if(kind==='workspace'){const options=await fileOptions(traceRoot,paths,client,runIds);validateWorkspaceCopies(options,row.preview.candidates);cleanupResult=row.preview.candidates.length?tx.physical(()=>removeWorkspaceCopies(options,row.preview.candidates)):{deleted:[],bytes:0};}else cleanupResult=await applyMaintenance(traceRoot,row.preview,paths.sandbox,client,writers!,tx.physical);}catch(error:any){cleanupResult=error?.cleanupResult??cleanupResult;throw error;}
   await client.query("UPDATE storage_cleanups SET status='completed',result=$2,updated_at=now() WHERE id=$1",[id,cleanupResult]);
   row=(await client.query('SELECT * FROM storage_cleanups WHERE id=$1',[id])).rows[0];await tx.commit();return publicRow(row);
  });res.json(saved);
 });
 router.post('/storage/cleanups/:id/reconcile',async(req,res)=>{
  const id=idSchema.parse(req.params.id),principal=httpPrincipal(res);z.object({}).strict().parse(req.body);
  const discovered=(await db.query('SELECT * FROM storage_cleanups WHERE id=$1',[id])).rows[0];if(!discovered)throw new AppError(404,'清理记录不存在');const runIds=maintenanceRuns(discovered.preview);
  const result=await maintain(traceRoot,runIds,writers,db,async tx=>{const client=tx.client;await tx.begin();
   const row=(await client.query('SELECT * FROM storage_cleanups WHERE id=$1 FOR UPDATE',[id])).rows[0];if(!row)throw new AppError(404,'清理记录不存在');
   samePreview(row,discovered);await currentAdministrator(client,principal);
   if(!['started','partial'].includes(row.status)&&!(row.status==='interrupted'&&['present','unverified'].includes(row.result?.state))){await tx.commit();return publicRow(row);}
   if(row.preview.scopeHash!==scopeHash)throw new AppError(409,'工作区范围已变化，不能核对原清理记录。','STORAGE_PREVIEW_STALE');await idle(client);
   const result=(row.preview.kind??'workspace')==='workspace'?{...row.result,observed:reconcileWorkspaceCopies(await fileOptions(traceRoot,paths,client,runIds),row.preview.candidates),replayed:false}:{...row.result,...await reconcileMaintenance(traceRoot,row.preview,paths.sandbox,client,writers!,tx.physical)};
   const status=['present','unverified'].includes(result.state)?'partial':'interrupted';
   await client.query('UPDATE storage_cleanups SET status=$3,result=$2,updated_at=now() WHERE id=$1',[id,result,status]);const saved=(await client.query('SELECT * FROM storage_cleanups WHERE id=$1',[id])).rows[0];await tx.commit();return publicRow(saved);
  });res.json(result);
 });
 return router;
}
