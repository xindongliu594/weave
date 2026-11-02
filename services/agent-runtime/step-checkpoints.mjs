import { readdirSync, lstatSync, readFileSync, mkdirSync, existsSync, openSync, writeSync, fsyncSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import { randomUUID, createHash } from 'node:crypto';
import { readRun, redact } from './trace-store.mjs';
import { validArtifactPath } from './sandbox.mjs';
import { assertArchiveCapacity, archiveStorageUsage, RUN_ARCHIVE_LIMIT_BYTES } from './archive-storage.mjs';
import { unresolvedOperations } from './recovery.mjs';
import { canonicalManifest } from '../../apps/desktop/local-executor.cjs';
import {assertArchivePlain,storeArchiveObjects,readArchiveObject} from './archive-objects.mjs';

const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const sha=/^[a-f0-9]{64}$/;
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
function assertPlain(path,kind){
  try{return assertArchivePlain(path,kind);}
  catch(error){if(error.code==='ARCHIVE_PATH_UNSAFE')throw Error('CHECKPOINT_PATH_UNSAFE');throw error;}
}
export const checkpointDigest=value=>hash(JSON.stringify(value));

const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&isDeepStrictEqual(Object.keys(value).sort(),[...keys].sort());
const identity=value=>exact(value,['runId','taskId','attemptId','generation'])&&[value.runId,value.taskId,value.attemptId].every(v=>typeof v==='string'&&v.length>0&&v.length<=256)&&Number.isSafeInteger(value.generation)&&value.generation>0;
function validateManifest(files,origins=false){
  if(!Array.isArray(files)||files.length>128)throw Error('CHECKPOINT_MANIFEST_INVALID');
  const seen=new Set();let bytes=0;
  for(const file of files){
    if(!exact(file,origins?['path','size','sha256','origin']:['path','size','sha256'])||!sha.test(file.sha256??'')||!Number.isSafeInteger(file.size)||file.size<0||file.size>5*1024*1024||(bytes+=file.size)>20*1024*1024||seen.has(file.path))throw Error('CHECKPOINT_MANIFEST_INVALID');
    validArtifactPath(file.path);seen.add(file.path);
  }
  if(!isDeepStrictEqual(canonicalManifest(files),manifest(files)))throw Error('CHECKPOINT_MANIFEST_INVALID');
}
function seedOrigin(origin,path,seed){
 const pin=seed?.sourceCheckpoint,key=pin?.key;
 return !!key&&exact(origin,['path','runId','taskId','attemptId','acceptedRevision','checkpointId'])&&origin.path===path&&origin.runId===key.runId&&origin.taskId===key.taskId&&origin.attemptId===key.attemptId&&origin.acceptedRevision===seed.workRevision&&origin.checkpointId===pin.id;
}
function validateOrigin(origin,path,seed){
 if(seedOrigin(origin,path,seed))return;
 if(!exact(origin,['path','runId','taskId','attemptId','acceptedRevision'])||origin.path!==path||![origin.runId,origin.taskId,origin.attemptId].every(v=>typeof v==='string'&&v.length>0)||!sha.test(origin.acceptedRevision??''))throw Error('CHECKPOINT_ORIGIN_INVALID');
}
function validateRecoverySeed(seed,key){
 const pin=seed?.sourceCheckpoint;
 if(!exact(seed,['version','initializationDigest','sourceCheckpoint','workRevision'])||seed.version!==1||![seed.initializationDigest,seed.workRevision].every(v=>typeof v==='string'&&sha.test(v))||
  !exact(pin,['key','id','sha256','seq'])||!identity(pin.key)||!uuid.test(pin.key.runId)||pin.key.runId===key.runId||pin.key.taskId!==key.taskId||!uuid.test(pin.id??'')||!sha.test(pin.sha256??'')||!Number.isSafeInteger(pin.seq)||pin.seq<1)throw Error('CHECKPOINT_REFS_INVALID');
}
/** Verify metadata and immutable objects, not SQL recovery authority or the source chain. */
export function validateTaskCheckpointRefs(refs,{runId,taskId,attemptId,generation,archiveDir,checkedObjects=new Set()}={}){
 const invalid=()=>{throw Error('CHECKPOINT_REFS_INVALID');};
 if(!isDeepStrictEqual(refs,redact(refs)))throw Error('CHECKPOINT_METADATA_UNSAFE');
 const hasSeed=!!refs&&Object.hasOwn(refs,'recoverySeed');
 if(!exact(refs,['profile','key','inputManifest','inputOrigins','workManifest','canonical','lastMerge','scopeHash','capabilityHash',...(hasSeed?['recoverySeed']:[])])||refs.profile!=='task-attempt-openshell-v1'||!identity(refs.key)||!uuid.test(refs.key.runId)||runId&&refs.key.runId!==runId||taskId&&refs.key.taskId!==taskId||attemptId&&refs.key.attemptId!==attemptId||generation!==undefined&&refs.key.generation!==generation||!sha.test(refs.scopeHash??'')||!sha.test(refs.capabilityHash??''))invalid();
 if(hasSeed)validateRecoverySeed(refs.recoverySeed,refs.key);
 validateManifest(refs.workManifest);validateManifest(refs.inputManifest,true);
 for(const row of refs.inputManifest)validateOrigin(row.origin,row.path,refs.recoverySeed);
 if(!Array.isArray(refs.inputOrigins)||refs.inputOrigins.length>128)invalid();
 const seen=new Set(),producers=new Map();let initializationDigest=refs.recoverySeed?.initializationDigest;
 for(const row of refs.inputOrigins){
  if(!exact(row,['path','sha256','origin','source'])||seen.has(row.path)||!sha.test(row.sha256??''))invalid();seen.add(row.path);validArtifactPath(row.path);validateOrigin(row.origin,row.path);
  const source=row.source,input=refs.inputManifest.find(f=>f.path===row.path);
  if(!input||input.sha256!==row.sha256||!isDeepStrictEqual(input.origin,row.origin))invalid();
  if(source?.kind==='import'){
   if(row.origin.runId!==refs.key.runId||!exact(source,['kind','snapshotId','sha256','agentIds'])||typeof source.snapshotId!=='string'||!source.snapshotId||source.sha256!==row.sha256||!Array.isArray(source.agentIds)||!source.agentIds.length||source.agentIds.some(id=>typeof id!=='string'||!id)||new Set(source.agentIds).size!==source.agentIds.length)invalid();
  }else if(source?.kind==='accepted'){
   if(row.origin.runId!==refs.key.runId||!exact(source,['kind','runId','taskId','attemptId','revision'])||source.runId!==row.origin.runId||source.taskId!==row.origin.taskId||source.attemptId!==row.origin.attemptId||source.revision!==row.origin.acceptedRevision)invalid();
  }else if(source?.kind==='recovery-accepted'){
   if(!exact(source,['kind','initializationDigest','key','revision','acceptedDigest'])||!identity(source.key)||!uuid.test(source.key.runId)||source.key.runId===refs.key.runId||
    source.key.runId!==row.origin.runId||source.key.taskId!==row.origin.taskId||source.key.attemptId!==row.origin.attemptId||source.revision!==row.origin.acceptedRevision||
    ![source.initializationDigest,source.revision,source.acceptedDigest].every(v=>typeof v==='string'&&sha.test(v))||initializationDigest!==undefined&&source.initializationDigest!==initializationDigest)invalid();
   initializationDigest=source.initializationDigest;
   const producer=JSON.stringify([source.key.runId,source.key.taskId,source.key.attemptId]),previous=producers.get(producer);
   if(previous&&!isDeepStrictEqual(previous,source))invalid();producers.set(producer,source);
  }else invalid();
 }
 for(const row of refs.inputManifest)if(!seen.has(row.path)){
  if(seedOrigin(row.origin,row.path,refs.recoverySeed)){
   const work=refs.workManifest.find(file=>file.path===row.path);if(!work||work.sha256!==row.sha256||work.size!==row.size)invalid();
  }else if(row.origin.runId!==refs.key.runId||row.origin.taskId!==refs.key.taskId||row.origin.attemptId!==refs.key.attemptId||refs.lastMerge===null)invalid();
 }
 const c=refs.canonical;
 if(!exact(c,['revision','manifest','mergeId'])||!(c.mergeId===null||typeof c.mergeId==='string'&&c.mergeId.length>0))invalid();
 validateManifest(c.manifest);if(checkpointDigest(c.manifest)!==c.revision)invalid();
 const merge=refs.lastMerge;
 if(merge!==null&&(!exact(merge,['mergeId','operationId','key','scopeHash','beforeRevision','afterRevision','workRevision','status'])||merge.status!=='committed'||!merge.operationId||merge.mergeId!==merge.operationId||!identity(merge.key)||!isDeepStrictEqual(merge.key,refs.key)||![merge.scopeHash,merge.beforeRevision,merge.afterRevision,merge.workRevision].every(v=>sha.test(v??''))||merge.workRevision!==checkpointDigest(refs.workManifest)))invalid();
 for(const file of [...refs.inputManifest,...refs.workManifest]){const current=c.manifest.find(row=>row.path===file.path);if(!current||current.sha256!==file.sha256||current.size!==file.size)invalid();}
 if(archiveDir)for(const file of [...refs.inputManifest,...refs.workManifest,...c.manifest]){
  const key=file.sha256+':'+file.size;if(checkedObjects.has(key))continue;
  try{readArchiveObject(join(archiveDir,'checkpoint-objects'),file);}catch{throw Error('CHECKPOINT_CONTENT_INVALID');}checkedObjects.add(key);
 }
 return refs;
}
function validateV2Boundary(boundary){
 if(!boundary||![boundary.taskId,boundary.attemptId,boundary.sessionId,boundary.trigger].every(v=>typeof v==='string'&&v.length>0)||!sha.test(boundary.contractHash??'')||!Number.isSafeInteger(boundary.eventCursor)||boundary.eventCursor<1||boundary.environment!==undefined&&boundary.environment!==null&&!sha.test(boundary.environment)||boundary.sessionCursor!==undefined&&(!Number.isSafeInteger(boundary.sessionCursor)||boundary.sessionCursor<0))throw Error('CHECKPOINT_BOUNDARY_INVALID');
}
function validateV2Receipts(receipts,key){
 if(!Array.isArray(receipts)||receipts.length>1024||receipts.some(row=>!row||row.inheritedFrom||row.taskExecution&&(!isDeepStrictEqual(row.taskExecution.key,key)||row.taskExecution.profile!=='task-attempt-openshell-v1')))throw Error('CHECKPOINT_RECEIPTS_INVALID');
}
function commitTaskCheckpoint({archive,boundary,receipts,taskRefs}){
 validateV2Boundary(boundary);validateV2Receipts(receipts,taskRefs?.key);
 validateTaskCheckpointRefs(taskRefs,{runId:archive.id,taskId:boundary.taskId,attemptId:boundary.attemptId,archiveDir:archive.dir});
 const metadata={id:randomUUID(),version:2,runId:archive.id,boundary,receipts,files:taskRefs.workManifest,...taskRefs};
 if(!isDeepStrictEqual(metadata,redact(metadata)))throw Error('CHECKPOINT_METADATA_UNSAFE');
 const bytes=Buffer.byteLength(JSON.stringify(metadata));if(bytes>512*1024||archiveStorageUsage(archive.dir).bytes+bytes+1024>RUN_ARCHIVE_LIMIT_BYTES)throw Error('CHECKPOINT_STORAGE_LIMIT');
 const record={...metadata,sha256:checkpointDigest(metadata)},expected=structuredClone(record),event=archive.append('step/checkpoint',record,{taskId:boundary.taskId,attemptId:boundary.attemptId,sessionId:boundary.sessionId});
 if(!isDeepStrictEqual(event?.data,expected))throw Error('CHECKPOINT_METADATA_UNSAFE');
 return {...record,seq:event.seq,at:event.at};
}

function taskCheckpointBinding(legacy,taskRefs){
 const {profile,key,inputManifest,inputOrigins,scopeHash,capabilityHash}=taskRefs,binding={legacy,profile,key,inputManifest,inputOrigins,scopeHash,capabilityHash};
 if(Object.hasOwn(taskRefs,'recoverySeed')||inputOrigins?.some(row=>row.source?.kind==='recovery-accepted'))return {domain:'task-checkpoint-recovery-v1',...binding,...(Object.hasOwn(taskRefs,'recoverySeed')?{recoverySeed:taskRefs.recoverySeed}:{})};
 return binding;
}
export function checkpointContract(snapshot,task,taskRefs) {
  if(taskRefs)return checkpointDigest(taskCheckpointBinding(checkpointContract(snapshot,task),taskRefs));
  const {maxBudget,maxModelCalls,maxOutputTokens,estimatedInputTokens,estimatedOutputTokens,...contract}=task;
  const employee=snapshot.agents?.find(agent=>agent.id===task.assignee);
  return checkpointDigest({contract,principal:employee&&{id:employee.id,tools:[...employee.tools].sort()},knowledge:snapshot.knowledge??null,executionTarget:snapshot.executionTarget??null});
}
export function checkpointEnvironment(snapshot,proof,taskRefs) {
  if(taskRefs){const legacy=checkpointEnvironment(snapshot,proof);return legacy?checkpointDigest(taskCheckpointBinding(legacy,taskRefs)):null;}
  const expected=snapshot.executionTarget?.backend;
  if(expected?.kind!=='openshell'||!proof||Object.entries(expected).some(([key,value])=>proof[key]!==value)||
      !/@sha256:[a-f0-9]{64}$/.test(proof.image??'')||!proof.node||!proof.effectivePolicyHash||proof.uid!==1000||proof.gid!==1000)return null;
  return checkpointDigest({backend:expected,node:proof.node,policy:proof.effectivePolicyHash,uid:proof.uid,gid:proof.gid,cpu:proof.cpu,memory:proof.memory});
}
export function checkpointLineage(root,source) {
  const runs=new Map();let run=source;
  while(run){
    if(runs.has(run.id)||runs.size>=16||run.integrity!=='ok'||run.snapshot.projectId!==source.snapshot.projectId||run.snapshot.planVersion!==source.snapshot.planVersion)throw Error('CHECKPOINT_LINEAGE_INVALID');
    if(unresolvedOperations(run.events).length)throw Error('CHECKPOINT_OPERATION_UNKNOWN');
    runs.set(run.id,run);const id=run.snapshot.recovery?.sourceRunId;
    if(!id)break;if(!uuid.test(id))throw Error('CHECKPOINT_LINEAGE_INVALID');run=readRun(root,id);if(!run)throw Error('CHECKPOINT_LINEAGE_INVALID');
  }
  return runs;
}
function originalReceipt(runs,entry,taskId,attemptId) {
  const run=runs.get(entry.evidence?.runId);if(!run)return false;
  const observed=run.events.find(e=>e.seq===entry.observationSeq&&e.type==='handoff/command-observed');
  if(observed?.data.taskId!==taskId||observed.data.attemptId!==attemptId)return false;
  return ['command','exitCode','workspaceRevision','evidence','acceptanceChecks'].every(key=>checkpointDigest(observed.data[key]??null)===checkpointDigest(entry[key]??null));
}
/** Structural backup validation; unknown effects remain preserved for later reconciliation. */
export function validateCheckpointReceipts(runs,checkpoint) {
  if(!Array.isArray(checkpoint.receipts))throw Error('CHECKPOINT_RECEIPTS_INVALID');
  for(const entry of checkpoint.receipts)if(!originalReceipt(runs,entry,checkpoint.boundary.taskId,entry.inheritedFrom?.attemptId??checkpoint.boundary.attemptId))throw Error('CHECKPOINT_RECEIPT_INVALID');
}
/** Unlike the download listing, this scan must never silently omit files. */
export function checkpointFiles(workspace) {
  assertPlain(workspace,'directory');
  const files=[];let entries=0,bytes=0;
  const visit=(dir,prefix='')=>{
    for(const name of readdirSync(dir).sort()) {
      if(++entries>1024)throw Error('CHECKPOINT_FILE_LIMIT');
      const path=validArtifactPath(prefix+name),absolute=join(dir,name),stat=lstatSync(absolute);
      if(stat.isSymbolicLink()||(stat.isFile()&&stat.nlink>1))throw Error('CHECKPOINT_PATH_UNSAFE');
      if(stat.isDirectory()){visit(absolute,path+'/');continue;}
      if(!stat.isFile()||stat.size>5*1024*1024||files.length>=128||(bytes+=stat.size)>20*1024*1024)throw Error('CHECKPOINT_FILE_LIMIT');
      const content=readFileSync(absolute);
      if(content.length!==stat.size)throw Error('CHECKPOINT_WORKSPACE_CHANGED');
      files.push({path,size:content.length,sha256:hash(content),content});
    }
  };
  visit(workspace);return files.sort((a,b)=>a.path.localeCompare(b.path));
}
const manifest=files=>files.map(({path,size,sha256})=>({path,size,sha256}));
/** Caller holds the workspace write fence. The journal commit is published last. */
export function commitStepCheckpoint({archive,workspace,boundary,receipts=[],taskRefs}) {
  if(!uuid.test(archive?.id)||!boundary?.taskId||!boundary.attemptId||!boundary.sessionId||!sha.test(boundary.contractHash??'')||
    !Number.isSafeInteger(boundary.eventCursor)||boundary.eventCursor<1)throw Error('CHECKPOINT_BOUNDARY_INVALID');
  assertPlain(archive.dir,'directory');assertArchiveCapacity(archive.dir);
  if(taskRefs!==undefined)return commitTaskCheckpoint({archive,boundary,receipts,taskRefs});
  const files=checkpointFiles(workspace),objects=join(archive.dir,'checkpoint-objects');
  if(existsSync(objects))assertPlain(objects,'directory');
  const fresh=files.filter(file=>!existsSync(join(objects,file.sha256)));
  const metadata=redact({id:randomUUID(),version:1,runId:archive.id,boundary,files:manifest(files),receipts});
  const bytes=Buffer.byteLength(JSON.stringify(metadata));
  if(bytes>512*1024||archiveStorageUsage(archive.dir).bytes+fresh.reduce((sum,file)=>sum+file.size,0)+bytes+1024>RUN_ARCHIVE_LIMIT_BYTES)throw Error('CHECKPOINT_STORAGE_LIMIT');
  try{storeArchiveObjects(archive.dir,files);}
  catch(error){
    if(error.code==='ARCHIVE_PATH_UNSAFE')throw Error('CHECKPOINT_PATH_UNSAFE');
    if(error.code==='ARCHIVE_OBJECT_INVALID')throw Error('CHECKPOINT_CONTENT_CORRUPT');
    throw error;
  }
  if(checkpointDigest(manifest(checkpointFiles(workspace)))!==checkpointDigest(metadata.files))throw Error('CHECKPOINT_WORKSPACE_CHANGED');
  const record={...metadata,sha256:checkpointDigest(metadata)};
  const event=archive.append('step/checkpoint',record,{taskId:boundary.taskId,attemptId:boundary.attemptId,sessionId:boundary.sessionId});
  return {...record,seq:event.seq,at:event.at};
}
export function readStepCheckpoint({root,runId,checkpointId}) {
  if(!uuid.test(runId??'')||!uuid.test(checkpointId??''))throw Error('CHECKPOINT_ID_INVALID');
  const run=readRun(root,runId);if(!run||run.integrity!=='ok')throw Error('CHECKPOINT_ARCHIVE_INVALID');
  const events=run.events.filter(event=>event.type==='step/checkpoint'&&event.data?.id===checkpointId);
  if(events.length!==1)throw Error('CHECKPOINT_NOT_FOUND');
  return validateCheckpointEvent(root,runId,events[0]);
}
/** Validate an immutable backup staging archive once, including deduplicated content. */
export function readStepCheckpoints({root,runId}) {
  if(!uuid.test(runId??''))throw Error('CHECKPOINT_ID_INVALID');
  const run=readRun(root,runId);if(!run||run.integrity!=='ok')throw Error('CHECKPOINT_ARCHIVE_INVALID');
  const results=new Map(),objects=new Set();
  for(const event of run.events.filter(event=>event.type==='step/checkpoint')) {
    if(!uuid.test(event.data?.id??'')||results.has(event.data.id))throw Error('CHECKPOINT_MANIFEST_INVALID');
    results.set(event.data.id,validateCheckpointEvent(root,runId,event,objects));
  }
  return results;
}
function validateCheckpointEvent(root,runId,event,checkedObjects=new Set()) {
  const {sha256,...data}=event.data;
  if(![1,2].includes(data.version)||data.runId!==runId||checkpointDigest(data)!==sha256||!Array.isArray(data.files)||data.files.length>128)throw Error('CHECKPOINT_MANIFEST_INVALID');
  if(data.version===2){
    const {id,version,runId:owner,boundary,files,receipts,...refs}=data;
    if(!uuid.test(id??'')||!boundary||!isDeepStrictEqual(files,refs.workManifest))throw Error('CHECKPOINT_MANIFEST_INVALID');
    validateV2Boundary(boundary);validateV2Receipts(receipts,refs.key);
    validateTaskCheckpointRefs(refs,{runId,taskId:boundary.taskId,attemptId:boundary.attemptId,archiveDir:join(root,runId),checkedObjects});
  }
  const objects=join(root,runId,'checkpoint-objects');
  // The portable backup contains files, not empty directories.
  if(data.files.length||existsSync(objects))assertPlain(objects,'directory');
  const seen=new Set();let size=0;
  for(const file of data.files) {
    validArtifactPath(file.path);
    if(seen.has(file.path)||!sha.test(file.sha256)||!Number.isSafeInteger(file.size)||file.size<0||file.size>5*1024*1024||(size+=file.size)>20*1024*1024)throw Error('CHECKPOINT_MANIFEST_INVALID');
    seen.add(file.path);const path=join(objects,file.sha256),key=file.sha256+':'+file.size;
    if(checkedObjects.has(key))continue;
    try {readArchiveObject(objects,file);}
    catch {throw Error('CHECKPOINT_CONTENT_INVALID: '+file.path);}
    checkedObjects.add(key);
  }
  return {...data,sha256,seq:event.seq,at:event.at};
}

/** Only opt-in, authenticated, fixed-environment local verification is reusable. */
export function validateInheritedEvidence({root,reference,snapshot,task,workspace,environment}) {
  const refused=reason=>({reusable:false,reasons:[reason],evidenceRefs:[]});
  if(snapshot.executionProfile==='task-attempt-openshell-v1')return refused('TASK_REQUIRES_FRESH_VERIFICATION');
  if(task.verificationReuse!=='same-workspace')return refused('TASK_REQUIRES_FRESH_VERIFICATION');
  if(!environment)return refused('CURRENT_SANDBOX_NOT_ATTESTED');
  if(!reference)return refused('NO_STEP_CHECKPOINT');
  try {
    const immediate=readRun(root,snapshot.recovery?.sourceRunId??reference.runId);
    if(!immediate||immediate.integrity!=='ok'||immediate.snapshot.projectId!==snapshot.projectId||immediate.snapshot.planVersion!==snapshot.planVersion)return refused('SOURCE_RUN_MISMATCH');
    const runs=checkpointLineage(root,immediate),source=runs.get(reference.runId);
    if(!source)return refused('SOURCE_RUN_MISMATCH');
    // Inspect the latest journal, including effects after the selected point.
    if(unresolvedOperations(source.events).length)return refused('SOURCE_OPERATION_UNKNOWN');
    const checkpoint=readStepCheckpoint({root,runId:reference.runId,checkpointId:reference.id});
    if(checkpoint.sha256!==reference.sha256||checkpoint.boundary.taskId!==task.id||checkpoint.boundary.contractHash!==checkpointContract(snapshot,task))return refused('CONTRACT_OR_PERMISSION_CHANGED');
    if(checkpoint.boundary.environment!==environment)return refused('ENVIRONMENT_CHANGED');
    const current=manifest(checkpointFiles(workspace));
    if(checkpointDigest(current)!==checkpointDigest(checkpoint.files))return refused('FILES_CHANGED');
    // A later failure or incomplete result invalidates an earlier pass.
    const latest=[...new Map(checkpoint.receipts.map(entry=>[entry.command,entry])).values()];
    const declared=new Set([...(task.inputs??[]),...(task.outputs??[])].map(file=>file.path));
    const evidenceRefs=latest.filter(entry=>originalReceipt(runs,entry,task.id,entry.inheritedFrom?.attemptId??checkpoint.boundary.attemptId)&&entry.evidence?.tool==='terminal_test'&&task.verify?.includes(entry.command)&&
      entry.evidence.verificationProfile==='node-permission-workspace-v1'&&entry.command.slice('node --test '.length).split(' ').every(file=>declared.has(file)&&current.some(row=>row.path===file))&&
      entry.workspaceRevision===checkpointDigest(canonicalManifest(current))&&
      /^node(?:\.exe)? --test [a-zA-Z0-9_./ -]+$/.test(entry.command)&&entry.exitCode===0&&entry.evidence.output?.complete===true&&
      entry.evidence.approval?.status==='available'&&entry.evidence.operation?.status==='available'&&entry.evidence.nodeTests?.status==='available'&&
      entry.evidence.nodeTests.tests>0&&entry.evidence.nodeTests.pass===entry.evidence.nodeTests.tests&&
      !entry.evidence.nodeTests.fail&&!entry.evidence.nodeTests.cancelled&&!entry.evidence.nodeTests.skipped&&!entry.evidence.nodeTests.todo)
      .map(entry=>({...entry,inheritedFrom:{runId:entry.inheritedFrom?.runId??checkpoint.runId,attemptId:entry.inheritedFrom?.attemptId??checkpoint.boundary.attemptId,
        checkpointId:checkpoint.id,checkpointRunId:checkpoint.runId,observationSeq:entry.observationSeq}}));
    return {reusable:evidenceRefs.length>0,reasons:evidenceRefs.length?[]:['NO_REUSABLE_TEST_RECEIPT'],evidenceRefs};
  }catch(error){return refused(String(error.message??error));}
}
