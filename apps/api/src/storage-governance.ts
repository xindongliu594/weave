import {Router} from 'express';
import {z} from 'zod';
import {randomUUID,createHash} from 'node:crypto';
import {join,resolve,isAbsolute} from 'node:path';
import type pg from 'pg';
import {pool} from './db.ts';
import {AppError} from './provider.ts';
import {scanStorage,workspaceRunIds,workspaceCopyCandidates,validateWorkspaceCopies,removeWorkspaceCopies,reconcileWorkspaceCopies,assertStorageHeadroom,MIN_STORAGE_FREE_BYTES,type StorageOptions} from '../../../services/agent-runtime/storage-governance.mjs';
import {ARCHIVE_ROOT_LIMIT_BYTES,RUN_ARCHIVE_LIMIT_BYTES} from '../../../services/agent-runtime/archive-storage.mjs';
import {type SandboxMaintenance,maintenanceCandidate,validateMaintenance,applyMaintenance,reconcileMaintenance,maintenanceError,maintenanceConfirmation,boundSandbox} from './storage-lifecycle.ts';
export const storageTables=['storage_cleanups'];
export async function migrateStorage(db:Pick<pg.Pool,'query'>){await db.query(`CREATE TABLE IF NOT EXISTS storage_cleanups(id text PRIMARY KEY,status text NOT NULL DEFAULT 'preview',preview jsonb NOT NULL,result jsonb,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());`);}
type Paths={dataRoot?:string;workspaceRoot?:string;nativeDeviceId?:string;deploymentBase?:string;sandbox?:()=>SandboxMaintenance|undefined};
const idSchema=z.uuid();
const scope=(traceRoot:string,paths:Paths)=>createHash('sha256').update(JSON.stringify([resolve(traceRoot),paths.workspaceRoot&&resolve(paths.workspaceRoot),paths.nativeDeviceId])).digest('hex');
const publicRow=(row:any)=>({id:row.id,status:row.status,preview:row.preview,result:row.result,createdAt:row.created_at,updatedAt:row.updated_at});
async function fileOptions(traceRoot:string,paths:Paths,db:Pick<pg.PoolClient,'query'>,runIds?:string[]):Promise<StorageOptions>{
 let ids=runIds;try{ids??=workspaceRunIds(paths.workspaceRoot);}catch{ids=[];}
 ids=[...new Set(ids)];if(ids.length>4096)throw new AppError(409,'清理范围超过安全上限','STORAGE_PREVIEW_LIMIT');
 const rows=(await db.query(`SELECT r.id,r.status,r.snapshot->'executionTarget'->>'kind' AS kind,r.snapshot->'executionTarget'->>'deviceId' AS device_id,EXISTS(SELECT 1 FROM local_operations o WHERE o.run_id=r.id AND (o.status NOT IN ('completed','failed','cancelled') OR (o.started AND o.result IS NULL))) AS blocked FROM project_runs r WHERE r.id=ANY($1::text[])`,[ids])).rows;
 return {traceRoot,workspaceRoot:paths.workspaceRoot,runs:rows.map(row=>({id:row.id,status:row.status,blocked:row.blocked,native:!!paths.nativeDeviceId&&row.kind==='local'&&row.device_id===paths.nativeDeviceId}))};
}
async function idle(db:Pick<pg.PoolClient,'query'>){
 if((await db.query("SELECT id FROM project_runs WHERE status IN ('queued','running') LIMIT 1")).rowCount)throw new AppError(409,'请先停止队列和执行任务，再清理工作区副本。','STORAGE_ACTIVE_RUN');
 if((await db.query("SELECT id FROM local_operations WHERE status NOT IN ('completed','failed','cancelled') OR (started AND result IS NULL) LIMIT 1")).rowCount)throw new AppError(409,'仍有待执行或结果未知的本机操作，请先核对执行记录。','STORAGE_UNKNOWN_OPERATION');
}
export function storageRouter(traceRoot:string,paths:Paths={},db:pg.Pool=pool){
 const router=Router(),scopeHash=scope(traceRoot,paths);
 router.get('/storage/sandboxes',async(_req,res)=>{const adapter=paths.sandbox?.();res.json({available:!!adapter,scopes:adapter?.executor.storageScopes()??[],hardQuota:false});});
 router.post('/storage/sandboxes/:id/inspect',async(req,res)=>{
  const runId=idSchema.parse(req.params.id);z.object({}).strict().parse(req.body);const client=await db.connect();
  try{await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(918276)');await client.query('LOCK TABLE project_runs,local_operations,local_devices IN SHARE MODE');await idle(client);const adapter=await boundSandbox(traceRoot,runId,paths.sandbox,client);const result=await adapter.executor.inspectStorage(runId);await client.query('COMMIT');res.json(result);}
  catch(error){await client.query('ROLLBACK');throw maintenanceError(error);}finally{client.release();}
 });
 router.get('/storage',async(_req,res)=>{
  const archive=scanStorage(traceRoot),groups:any[]=[{id:'runs',name:'运行档案（交付、恢复、费用证据）',...archive,protection:'长期保护'}];
  if(paths.dataRoot)for(const [id,name] of [['database','业务数据库'],['credentials','加密凭证'],['workspaces','本机工作区副本'],['journal','本机操作收据'],['openshell','OpenShell 配置与操作映射'],['obsidian-vault','知识库原文'],['openrig','部门队列元数据']])groups.push({id,name,...scanStorage(join(paths.dataRoot,id)),protection:id==='workspaces'?'仅核验一致的完成副本可清理':'保护'});
  const deploymentGroups=paths.deploymentBase&&isAbsolute(paths.deploymentBase)?['releases','cache','backups','logs','runtime','metadata','data','probes'].map(id=>({id,name:id,...scanStorage(join(paths.deploymentBase!,id)),protection:'只读盘点；未自动删除'})):[];
  const runRows=(await db.query('SELECT id,project_id,status FROM project_runs ORDER BY created_at DESC LIMIT 50')).rows;
  const runs=runRows.map(run=>{const dir=join(traceRoot,run.id),count=scanStorage(dir),parts=['events.jsonl','events.jsonl.gz','journal-archive.json','sessions','artifacts','workspace'].map(id=>({id,...scanStorage(join(dir,id))}));return {...run,...count,parts,overLimit:count.bytes>=RUN_ARCHIVE_LIMIT_BYTES};});
  let disk:any;try{disk={...assertStorageHeadroom(traceRoot,0),minFreeBytes:MIN_STORAGE_FREE_BYTES};disk.blocked=disk.freeBytes<MIN_STORAGE_FREE_BYTES;}catch{disk={unavailable:true};}
  res.json({...archive,maxBytes:ARCHIVE_ROOT_LIMIT_BYTES,runMaxBytes:RUN_ARCHIVE_LIMIT_BYTES,mode:'admission-only',retention:'preserve',groups,deploymentGroups,runs,disk,archiveBlocked:!archive.complete||archive.links>0||archive.bytes>=ARCHIVE_ROOT_LIMIT_BYTES,cleanupMode:'confirmed-completed-native-copies'});
 });
 router.get('/storage/cleanups',async(_req,res)=>res.json((await db.query('SELECT * FROM storage_cleanups ORDER BY created_at DESC LIMIT 50')).rows.map(publicRow)));
 router.post('/storage/preview',async(req,res)=>{
  const input=z.union([z.object({kind:z.literal('workspace').optional()}).strict(),z.object({kind:z.enum(['sandbox','journal']),runId:idSchema}).strict()]).parse(req.body),kind=input.kind??'workspace';const client=await db.connect();
  try{await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(918276)');
   const copies:any=kind==='workspace'?workspaceCopyCandidates(await fileOptions(traceRoot,paths,client)):{candidates:[await maintenanceCandidate(traceRoot,kind,(input as {runId:string}).runId,paths.sandbox,client)],protectedRuns:[]};
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
  const id=idSchema.parse(req.params.id),input=z.object({confirmation:z.enum(['CLEAN_WORKSPACE_COPIES','RETIRE_SANDBOX','ARCHIVE_JOURNAL'])}).strict().parse(req.body);
  const client=await db.connect();let claimed=false,cleanupResult:any={deleted:[],bytes:0};
  try{
   await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(918276)');
   let row=(await client.query('SELECT * FROM storage_cleanups WHERE id=$1 FOR UPDATE',[id])).rows[0];if(!row)throw new AppError(404,'清理预览不存在');
   const kind=row.preview.kind??'workspace';if(input.confirmation!==maintenanceConfirmation[kind])throw new AppError(422,'确认内容与当前维护类型不相符。','STORAGE_CONFIRMATION_MISMATCH');
   if(['completed','partial','interrupted'].includes(row.status)){await client.query('COMMIT');return res.json(publicRow(row));}
   if(row.status!=='preview')throw new AppError(409,'上次清理结果尚未核对，请先核对记录；不会自动续删。','STORAGE_RECONCILIATION_REQUIRED');
   if(row.preview.scopeHash!==scopeHash||Date.now()-new Date(row.created_at).getTime()>30*60000||Date.now()>Date.parse(row.preview.expiresAt))throw new AppError(409,'清理预览已过期或工作区已改变，请重新预览。','STORAGE_PREVIEW_STALE');
   await client.query('LOCK TABLE project_runs,local_operations IN SHARE MODE');await idle(client);
   if(kind==='workspace')validateWorkspaceCopies(await fileOptions(traceRoot,paths,client,row.preview.candidates.map((c:any)=>c.runId)),row.preview.candidates);else await validateMaintenance(traceRoot,row.preview,paths.sandbox,client);
   await client.query("UPDATE storage_cleanups SET status='started',updated_at=now() WHERE id=$1",[id]);await client.query('COMMIT');claimed=true;
   // The durable started state survives a crash. Reacquire locks and recheck before any unlink.
   await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(918274)');await client.query('SELECT pg_advisory_xact_lock(918276)');await client.query('LOCK TABLE project_runs,local_operations,local_devices,model_reservations IN SHARE MODE');
   row=(await client.query('SELECT * FROM storage_cleanups WHERE id=$1 FOR UPDATE',[id])).rows[0];
   if(row.status!=='started')throw new AppError(409,'清理状态已被核对，请重新查看记录。','STORAGE_PREVIEW_STALE');
   await idle(client);cleanupResult=kind==='workspace'?removeWorkspaceCopies(await fileOptions(traceRoot,paths,client,row.preview.candidates.map((c:any)=>c.runId)),row.preview.candidates):await applyMaintenance(traceRoot,row.preview,paths.sandbox,client);
   await client.query("UPDATE storage_cleanups SET status='completed',result=$2,updated_at=now() WHERE id=$1",[id,cleanupResult]);
   row=(await client.query('SELECT * FROM storage_cleanups WHERE id=$1',[id])).rows[0];await client.query('COMMIT');res.json(publicRow(row));
  }catch(error:any){await client.query('ROLLBACK');if(claimed){cleanupResult=error.cleanupResult??cleanupResult;await client.query("UPDATE storage_cleanups SET status='partial',result=$2,updated_at=now() WHERE id=$1 AND status='started'",[id,{...cleanupResult,errorCode:error.code??'CLEANUP_FAILED',message:'清理中止，请查看记录并核对；原交付保留。'}]);}
   if(error.code==='STORAGE_CANDIDATE_CHANGED')throw new AppError(409,error.message,error.code);throw maintenanceError(error);
  }finally{client.release();}
 });
 router.post('/storage/cleanups/:id/reconcile',async(req,res)=>{
  const id=idSchema.parse(req.params.id);z.object({}).strict().parse(req.body);const client=await db.connect();
  try{await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(918276)');await client.query('LOCK TABLE project_runs,local_operations IN SHARE MODE');
   const row=(await client.query('SELECT * FROM storage_cleanups WHERE id=$1 FOR UPDATE',[id])).rows[0];if(!row)throw new AppError(404,'清理记录不存在');
   if(!['started','partial'].includes(row.status)&&!(row.status==='interrupted'&&['present','unverified'].includes(row.result?.state))){await client.query('COMMIT');return res.json(publicRow(row));}
   if(row.preview.scopeHash!==scopeHash)throw new AppError(409,'工作区范围已变化，不能核对原清理记录。','STORAGE_PREVIEW_STALE');await idle(client);
   const result=(row.preview.kind??'workspace')==='workspace'?{...row.result,observed:reconcileWorkspaceCopies(await fileOptions(traceRoot,paths,client,row.preview.candidates.map((c:any)=>c.runId)),row.preview.candidates),replayed:false}:{...row.result,...await reconcileMaintenance(traceRoot,row.preview,paths.sandbox,client)};
   const status=['present','unverified'].includes(result.state)?'partial':'interrupted';
   await client.query('UPDATE storage_cleanups SET status=$3,result=$2,updated_at=now() WHERE id=$1',[id,result,status]);const saved=(await client.query('SELECT * FROM storage_cleanups WHERE id=$1',[id])).rows[0];await client.query('COMMIT');res.json(publicRow(saved));
  }catch(error){await client.query('ROLLBACK');throw maintenanceError(error);}finally{client.release();}
 });
 return router;
}
