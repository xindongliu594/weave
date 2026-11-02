import {resolve} from 'node:path';
import type pg from 'pg';
import {observeRunArchive,runArchiveObservationHealth} from '../../../services/agent-runtime/trace-store.mjs';
import {validateObservationSummary,observationNames,observationPhases} from '../../../services/agent-runtime/observation-summary.mjs';
import {observeAuditProjections,auditProjectionObservationHealth} from './audit-outbox.ts';
import {createObservationExporter} from './observation-exporter.ts';

const activeRoots=new Set<string>();
const plus=(left:number,right=1)=>Math.min(Number.MAX_SAFE_INTEGER,left+right);
export function createObservability({traceRoot,db,telemetryEnv}:{traceRoot:string;db?:pg.Pool;telemetryEnv?:Record<string,string|undefined>}){
  if(typeof traceRoot!=='string'||!traceRoot)throw Error('OBSERVATION_ROOT_INVALID');
  const root=resolve(traceRoot),key=process.platform==='win32'?root.toLowerCase():root;
  if(activeRoots.has(key))throw Error('OBSERVATION_ROOT_REGISTERED');if(activeRoots.size>=16)throw Error('OBSERVATION_ROOT_LIMIT');activeRoots.add(key);
  let closed=false,accepted=0,rejected=0,lastObservedAt:string|null=null,lastErrorCode:string|null=null,auditObservedAt:number|null=null;
  const exporter=createObservationExporter(telemetryEnv);
  const byName=Object.fromEntries(observationNames.map(name=>[name,0])),byPhase=Object.fromEntries(observationPhases.map(phase=>[phase,0]));
  let finalTrace={subscribers:0,emitted:0,dropped:0,failures:0},finalAudit={...finalTrace};
  const offer=(input:unknown):boolean=>{
    if(closed)return false;const summary=validateObservationSummary(input);if(!summary){rejected=plus(rejected);lastErrorCode='OBSERVATION_INVALID';return false;}
    accepted=plus(accepted);byName[summary.name]=plus(byName[summary.name]);if(summary.phase)byPhase[summary.phase]=plus(byPhase[summary.phase]);lastObservedAt=summary.at;exporter.offer(summary);return true;
  };
  let disposeTrace:()=>void=()=>{},disposeAudit:()=>void=()=>{};
  try{disposeTrace=observeRunArchive(root,offer);if(db)disposeAudit=observeAuditProjections(db,summary=>{auditObservedAt=Date.now();offer(summary);});}
  catch(error){disposeTrace();disposeAudit();activeRoots.delete(key);void exporter.close();throw error;}
  const snapshot=()=>{
    const trace=closed?finalTrace:runArchiveObservationHealth(root),audit=closed?finalAudit:db?auditProjectionObservationHealth(db):finalAudit,now=Date.now();
    const delivery=exporter.snapshot();return {...delivery,state:closed?'closed':delivery.state,accepted,dropped:plus(delivery.dropped,plus(rejected,plus(trace.dropped,audit.dropped))),lastErrorCode:delivery.lastErrorCode??lastErrorCode,
      sampledAt:new Date(now).toISOString(),stale:lastObservedAt===null||now-Date.parse(lastObservedAt)>60000,auditStorageAvailable:auditObservedAt!==null&&now-auditObservedAt<=60000?true:null,lastObservedAt,observerFailures:plus(trace.failures,audit.failures),byName:{...byName},byPhase:{...byPhase}};
  };
  return {offer,snapshot,async close(){if(!closed){finalTrace=runArchiveObservationHealth(root);if(db)finalAudit=auditProjectionObservationHealth(db);closed=true;disposeTrace();disposeAudit();activeRoots.delete(key);}await exporter.close();}};
}
export type ObservationHealth=ReturnType<ReturnType<typeof createObservability>['snapshot']>;
