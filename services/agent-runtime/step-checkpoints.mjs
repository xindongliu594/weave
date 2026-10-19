import { readdirSync, lstatSync, readFileSync, mkdirSync, existsSync, openSync, writeSync, fsyncSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { readRun, redact } from './trace-store.mjs';
import { validArtifactPath } from './sandbox.mjs';
import { assertArchiveCapacity, archiveStorageUsage, RUN_ARCHIVE_LIMIT_BYTES } from './archive-storage.mjs';
import { unresolvedOperations } from './recovery.mjs';
import { canonicalManifest } from '../../apps/desktop/local-executor.cjs';

const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const sha=/^[a-f0-9]{64}$/;
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
export const checkpointDigest=value=>hash(JSON.stringify(value));
export function checkpointContract(snapshot,task) {
  const {maxBudget,maxModelCalls,maxOutputTokens,estimatedInputTokens,estimatedOutputTokens,...contract}=task;
  const employee=snapshot.agents?.find(agent=>agent.id===task.assignee);
  return checkpointDigest({contract,principal:employee&&{id:employee.id,tools:[...employee.tools].sort()},knowledge:snapshot.knowledge??null,executionTarget:snapshot.executionTarget??null});
}
export function checkpointEnvironment(snapshot,proof) {
  const expected=snapshot.executionTarget?.backend;
  if(expected?.kind!=='openshell'||!proof||Object.entries(expected).some(([key,value])=>proof[key]!==value)||
      !/@sha256:[a-f0-9]{64}$/.test(proof.image??'')||!proof.node||!proof.effectivePolicyHash||proof.uid!==1000||proof.gid!==1000)return null;
  return checkpointDigest({backend:expected,node:proof.node,policy:proof.effectivePolicyHash,uid:proof.uid,gid:proof.gid,cpu:proof.cpu,memory:proof.memory});
}
function assertPlain(path,kind) {
  const stat=lstatSync(path);
  if(stat.isSymbolicLink() || (kind==='directory'?!stat.isDirectory():!stat.isFile()))throw Error('CHECKPOINT_PATH_UNSAFE');
  return stat;
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
/** Unlike the download listing, this scan must never silently omit files. */
export function checkpointFiles(workspace) {
  assertPlain(workspace,'directory');
  const files=[];let entries=0,bytes=0;
  const visit=(dir,prefix='')=>{
    for(const name of readdirSync(dir).sort()) {
      if(++entries>1024)throw Error('CHECKPOINT_FILE_LIMIT');
      const path=validArtifactPath(prefix+name),absolute=join(dir,name),stat=lstatSync(absolute);
      if(stat.isSymbolicLink())throw Error('CHECKPOINT_PATH_UNSAFE');
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
function storeObject(dir,file) {
  const target=join(dir,file.sha256);
  if(existsSync(target)) {
    assertPlain(target,'file');
    if(hash(readFileSync(target))!==file.sha256)throw Error('CHECKPOINT_CONTENT_CORRUPT');
    return;
  }
  const fd=openSync(target,'wx',0o600);
  try {let offset=0;while(offset<file.content.length)offset+=writeSync(fd,file.content,offset,file.content.length-offset);fsyncSync(fd);}
  finally{closeSync(fd);}
}
/** Caller holds the workspace write fence. The journal commit is published last. */
export function commitStepCheckpoint({archive,workspace,boundary,receipts=[]}) {
  if(!uuid.test(archive?.id)||!boundary?.taskId||!boundary.attemptId||!boundary.sessionId||!sha.test(boundary.contractHash??'')||
    !Number.isSafeInteger(boundary.eventCursor)||boundary.eventCursor<1)throw Error('CHECKPOINT_BOUNDARY_INVALID');
  assertPlain(archive.dir,'directory');assertArchiveCapacity(archive.dir);
  const files=checkpointFiles(workspace),objects=join(archive.dir,'checkpoint-objects');
  if(!existsSync(objects))mkdirSync(objects,{mode:0o700});assertPlain(objects,'directory');
  const fresh=files.filter(file=>!existsSync(join(objects,file.sha256)));
  const metadata=redact({id:randomUUID(),version:1,runId:archive.id,boundary,files:manifest(files),receipts});
  const bytes=Buffer.byteLength(JSON.stringify(metadata));
  if(bytes>512*1024||archiveStorageUsage(archive.dir).bytes+fresh.reduce((sum,file)=>sum+file.size,0)+bytes+1024>RUN_ARCHIVE_LIMIT_BYTES)throw Error('CHECKPOINT_STORAGE_LIMIT');
  for(const file of files)storeObject(objects,file);
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
  const event=events[0],{sha256,...data}=event.data;
  if(data.version!==1||data.runId!==runId||checkpointDigest(data)!==sha256||!Array.isArray(data.files)||data.files.length>128)throw Error('CHECKPOINT_MANIFEST_INVALID');
  const objects=join(root,runId,'checkpoint-objects');assertPlain(objects,'directory');
  const seen=new Set();let size=0;
  for(const file of data.files) {
    validArtifactPath(file.path);
    if(seen.has(file.path)||!sha.test(file.sha256)||!Number.isSafeInteger(file.size)||file.size<0||file.size>5*1024*1024||(size+=file.size)>20*1024*1024)throw Error('CHECKPOINT_MANIFEST_INVALID');
    seen.add(file.path);const path=join(objects,file.sha256);
    try {if(assertPlain(path,'file').size!==file.size||hash(readFileSync(path))!==file.sha256)throw Error('mismatch');}
    catch {throw Error('CHECKPOINT_CONTENT_INVALID: '+file.path);}
  }
  return {...data,sha256,seq:event.seq,at:event.at};
}

/** Only opt-in, authenticated, fixed-environment local verification is reusable. */
export function validateInheritedEvidence({root,reference,snapshot,task,workspace,environment}) {
  const refused=reason=>({reusable:false,reasons:[reason],evidenceRefs:[]});
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
