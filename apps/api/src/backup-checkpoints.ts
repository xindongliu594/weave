import {existsSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {readRun} from '../../../services/agent-runtime/trace-store.mjs';
import {readStepCheckpoints,validateCheckpointReceipts,checkpointDigest} from '../../../services/agent-runtime/step-checkpoints.mjs';
import {isDeepStrictEqual} from 'node:util';
import {createHash} from 'node:crypto';
import type {EnterpriseBackupV2} from './enterprise-backup-schema.ts';
import {readCommittedCanonical} from './task-canonical.ts';
import {validateArchivedTaskCommit} from './task-original-commit.ts';
import {executionBackend} from './execution-backend.ts';
import {validateWorkFilePath} from './work-files.ts';

const references=(snapshot:any)=>Object.values(snapshot?.recovery?.nodes??{}).map((node:any)=>node.stepCheckpoint).filter(Boolean);
// Staging is private and immutable while this runs; no current database/files are changed.
export function validateBackupCheckpoints(root:string,paths:string[],databaseRuns:any[]=[]) {
 const runs=new Map<string,any>(),checkpoints=new Map<string,Map<string,any>>();
 for(const id of new Set(paths.map(path=>path.split('/')[0]))) {
  let run:any;
  try{run=readRun(root,id);}catch{
   // Old unrelated forensic records may be damaged; preserve them, but never
   // let this fallback certify a checkpoint or a referenced ancestor.
   let snapshot;try{snapshot=JSON.parse(readFileSync(join(root,id,'snapshot.json'),'utf8'));}catch{}
   run=snapshot?{id,snapshot,events:[],integrity:'incomplete'}:null;
  }
  if(!run){if(existsSync(join(root,id,'checkpoint-objects')))throw Error('CHECKPOINT_ARCHIVE_INVALID');continue;}
  if(existsSync(join(root,id,'checkpoint-objects'))&&(run.integrity!=='ok'||run.id!==id))throw Error('CHECKPOINT_ARCHIVE_INVALID');
  runs.set(id,run);
  if(run.events.some((event:any)=>event.type==='step/checkpoint'))checkpoints.set(id,readStepCheckpoints({root,runId:id}));
 }
 // A missing whole child archive cannot hide its durable database references.
 for(const row of databaseRuns){
  if(!references(row.snapshot).length)continue;
  const run=runs.get(row.id);
  if(!run||run.integrity!=='ok'||run.id!==row.id||checkpointDigest(run.snapshot.recovery)!==checkpointDigest(row.snapshot.recovery))throw Error('CHECKPOINT_DATABASE_REFERENCE_INVALID');
 }
 for(const run of runs.values()) {
  const refs=references(run.snapshot),savedPoints=checkpoints.get(run.id);
  if(!refs.length&&!savedPoints?.size)continue;
  // Structural validation is separate from execution admission. Unknown operations/fees stay archived.
  const ancestors=new Map<string,any>();let cursor=run;
  while(cursor){
   if(ancestors.has(cursor.id)||ancestors.size>=16||cursor.integrity!=='ok'||cursor.snapshot.projectId!==run.snapshot.projectId||cursor.snapshot.planVersion!==run.snapshot.planVersion||!cursor.events.some((event:any)=>event.type==='run/created'&&/^[a-f0-9]{64}$/.test(event.data?.snapshotSha256??'')))throw Error('CHECKPOINT_LINEAGE_INVALID');
   ancestors.set(cursor.id,cursor);
   const parent=cursor.snapshot.recovery?.sourceRunId;
   if(!parent)break;
   cursor=runs.get(parent);if(!cursor)throw Error('CHECKPOINT_LINEAGE_INVALID');
  }
  for(const reference of refs){
   const saved=checkpoints.get(reference.runId)?.get(reference.id);
   if(!ancestors.has(reference.runId)||!saved||saved.sha256!==reference.sha256)throw Error('CHECKPOINT_REFERENCE_INVALID');
  }
  for(const checkpoint of savedPoints?.values()??[])validateCheckpointReceipts(ancestors,checkpoint);
 }
}

/** Physical closure only, never execution admission. Old forensic records may
 * remain damaged, but every positive checkpoint/canonical/commit claim must
 * resolve to exact archive bytes and its original SQL task/operation identity. */
export function validateEnterpriseBackupReferences(payload:EnterpriseBackupV2,root:string):void{
 try{
  const decode=(row:any,columns:string[])=>({...row,...Object.fromEntries(columns.map(key=>[key,row[key]===null?null:JSON.parse(row[key])]))});
  const runs=payload.tables.project_runs.map(row=>decode(row,['snapshot','canonical_workspace']));
  const attempts=payload.tables.task_attempt_workspaces.map(row=>decode(row,['input_origins','committed_outputs','scope','sandbox_identity','contract','accepted_stop']));
  const operations=payload.tables.local_operations.map(row=>decode(row,['payload','result','merge_record']));
  const operationMap=new Map(operations.map(row=>[row.id,row]));
  const devices=new Map(payload.tables.local_devices.map(row=>[row.id,decode(row,['backend'])]));
  const imports=new Map(payload.tables.work_file_snapshots.map(row=>[row.id,JSON.parse(row.files as string)]));
  const key=(row:any)=>JSON.stringify([row.run_id,row.task_id,row.attempt_id,row.generation]);
  const tasks=new Map(attempts.map(row=>[key(row),row]));
  validateBackupCheckpoints(root,Object.keys(payload.files),runs);
  for(const row of payload.tables.work_file_snapshots){
   const files=JSON.parse(row.files as string);let total=0;const paths=new Set();
   if(!Array.isArray(files)||files.length>100)throw Error();
   for(const file of files){validateWorkFilePath(file.path);const path=file.path.toLowerCase();if(paths.has(path)||[...paths].some((other:any)=>other.startsWith(path+'/')||path.startsWith(other+'/')))throw Error();paths.add(path);
    if(typeof file.base64!=='string')throw Error();const bytes=Buffer.from(file.base64,'base64');
    if(bytes.toString('base64')!==file.base64||bytes.length!==file.bytes||bytes.length>2*1024*1024||createHash('sha256').update(bytes).digest('hex')!==file.sha256)throw Error();total+=bytes.length;
   }if(total!==row.bytes||total>8*1024*1024)throw Error();
  }
  for(const run of runs){
   if(run.canonical_workspace){const head=readCommittedCanonical(root,run);if(head.ref.mergeId){const operation=operationMap.get(head.ref.mergeId);if(!operation||operation.run_id!==run.id||!isDeepStrictEqual(run.canonical_workspace,{version:1,...operation.merge_record?.after,receipt:operation.merge_record?.receipt}))throw Error('CANONICAL_OPERATION_MISSING');}}
   if(!existsSync(join(root,run.id)))continue;
   let archived;try{archived=readRun(root,run.id);}catch{if(attempts.some(task=>task.run_id===run.id)||run.canonical_workspace)throw Error('TASK_ARCHIVE_INVALID');continue;}
   if(!archived?.events.some((event:any)=>event.type==='step/checkpoint'))continue;
   const points=readStepCheckpoints({root,runId:run.id});
   for(const point of points.values()){
    if(point.version!==2)continue;
    const task=tasks.get(JSON.stringify([run.id,point.key.taskId,point.key.attemptId,point.key.generation]));
    if(!task||task.capability_hash!==point.capabilityHash||task.scope?.workspace?.scopeHash!==point.scopeHash||!isDeepStrictEqual(task.input_origins,point.inputOrigins))throw Error('CHECKPOINT_TASK_SQL_MISSING');
    if(point.lastMerge){const op=operationMap.get(point.lastMerge.operationId);if(!op||op.run_id!==run.id||!isDeepStrictEqual(op.merge_record?.receipt,point.lastMerge))throw Error('CHECKPOINT_ORIGINAL_OPERATION_MISSING');}
   }
  }
  function inputSources(task:any,origins:any[]){
   for(const origin of origins){const source=origin.source;
    if(source?.kind==='import'){
     const file=imports.get(source.snapshotId)?.find((file:any)=>file.path===origin.path&&file.sha256===origin.sha256);
     if(!file||!source.agentIds.includes(task.principal))throw Error('TASK_IMPORT_SOURCE_MISSING');
    }else if(source?.kind==='accepted'){
     const operation=operations.find(row=>row.run_id===source.runId&&row.payload?.taskScope?.key?.taskId===source.taskId&&row.payload.taskScope.key.attemptId===source.attemptId&&row.merge_state==='committed'&&row.merge_record?.after?.revision===source.revision);
     if(!operation?.merge_record?.after?.manifest?.some((file:any)=>file.path===origin.path&&file.sha256===origin.sha256))throw Error('TASK_ACCEPTED_SOURCE_MISSING');
    }else throw Error('TASK_INPUT_SOURCE_INVALID');
   }
  }
  const checked=new Set<string>();
  for(const task of attempts){inputSources(task,task.input_origins);for(const commit of task.committed_outputs??[]){
   const operation=operationMap.get(commit.receipt?.operationId),run=runs.find(row=>row.id===task.run_id);
   if(!operation||!run)throw Error('TASK_ORIGINAL_COMMIT_MISSING');
   validateArchivedTaskCommit(root,run,task,operation,executionBackend(devices.get(operation.device_id)?.backend));
   inputSources(task,commit.scope.inputOrigins);checked.add(operation.id);
  }}
  for(const operation of operations){
   if(operation.merge_state==='committed'&&operation.payload?.taskScope?.profile==='task-attempt-openshell-v1'&&!checked.has(operation.id))throw Error('TASK_COMMIT_SQL_MISSING');
  }
 }catch{throw Object.assign(Error('备份的检查点、任务提交、文件或原操作关联证据不完整。'),{status:422,code:'BACKUP_REFERENCE_INVALID'});}
}
