import {existsSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {readRun} from '../../../services/agent-runtime/trace-store.mjs';
import {readStepCheckpoints,validateCheckpointReceipts,checkpointDigest} from '../../../services/agent-runtime/step-checkpoints.mjs';

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
