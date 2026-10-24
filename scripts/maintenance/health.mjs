import {retentionAdvice} from '../../services/agent-runtime/storage-retention.mjs';
import {MIN_STORAGE_FREE_BYTES} from '../../services/agent-runtime/storage-governance.mjs';

export const REPORT_FORMAT='weiwu-maintenance-health-v1';
export const MAX_INPUT_BYTES=1024*1024;
export const MAX_REPORT_BYTES=65536;
const number=value=>Number.isSafeInteger(value)&&value>=0;
const code=value=>typeof value==='string'&&/^[A-Z][A-Z0-9_]{0,63}$/.test(value)?value:'INSPECTION_FAILED';
const unknown=reason=>({status:'unknown',code:reason});
const failed=reason=>({status:'failed',code:reason});
const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)?value:undefined;

/** Pure, disclosure-limited projection; inputs are evidence, never authorization. */
export function buildHealthReport({storage,disk,retention,backup,now=Date.now()}={}){
 if(!Number.isFinite(now))throw Error('INVALID_CLOCK');
 let storageCheck=unknown('STORAGE_UNAVAILABLE');
 if(storage?.code)storageCheck=unknown(code(storage.code));
 else if(storage?.present===true&&['bytes','files','entries','links'].every(key=>number(storage[key]))){
  storageCheck={status:storage.complete===true&&storage.links===0?'passed':'unknown',code:storage.complete===true&&storage.links===0?'INVENTORY_COMPLETE':'INVENTORY_INCOMPLETE',bytes:storage.bytes,files:storage.files,entries:storage.entries,links:storage.links};
 }
 const diskCheck=number(disk?.freeBytes)?{status:disk.freeBytes>=MIN_STORAGE_FREE_BYTES?'passed':'failed',code:disk.freeBytes>=MIN_STORAGE_FREE_BYTES?'CAPACITY_AVAILABLE':'CAPACITY_LOW',freeBytes:disk.freeBytes,minFreeBytes:MIN_STORAGE_FREE_BYTES}:unknown('CAPACITY_UNAVAILABLE');
 let retentionCheck=unknown('RETENTION_SNAPSHOT_MISSING');
 if(retention?.code)retentionCheck=failed(code(retention.code));
 else if(retention?.data){
  const value=retention.data,rows=value.recommendations;
  if(value.mode!=='suggestion-only'||value.automaticDeletion!==false||!Array.isArray(rows)||rows.length>150||rows.some(row=>!row||!['journal','workspace','sandbox'].includes(row.kind)||!Number.isFinite(row.ageDays)||row.ageDays<0||typeof row.runId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(row.runId)))retentionCheck=failed('RETENTION_SNAPSHOT_INVALID');
  else retentionCheck={...unknown('RETENTION_SNAPSHOT_NOT_LIVE'),recommendations:rows.length,kinds:Object.fromEntries(['journal','workspace','sandbox'].map(kind=>[kind,rows.filter(row=>row.kind===kind).length])),sha256:digest(retention.sha256)};
 }
 let backupCheck=unknown('RESTORE_EVIDENCE_MISSING');
 if(backup?.code)backupCheck=failed(code(backup.code));
 else if(backup?.data){
  const value=backup.data,proof=value.copyProof,at=Date.parse(value.checkedAt),age=now-at;
  if(value.format!=='full-offline-isolated-restore-v1')backupCheck=failed('RESTORE_EVIDENCE_FORMAT');
  else if(value.fixture!==false)backupCheck=unknown('RESTORE_EVIDENCE_FIXTURE');
  else if(!Number.isFinite(at)||age<0)backupCheck=unknown('RESTORE_EVIDENCE_TIME_INVALID');
  else if(age>7*86400000)backupCheck=unknown('RESTORE_EVIDENCE_STALE');
  else{
   const flags=[value.restoreReadOnlyOpenedTwice,value.persistentBusinessFingerprintsEqual,proof?.sourceStableDuringCopy,proof?.sourceDatabaseNeverOpened,proof?.businessAndDatabaseFilesExactSha256];
   if(flags.some(flag=>flag===false)||value.employeeTest?.status==='failed')backupCheck=failed('RECORDED_RESTORE_FAILED');
   else if(flags.some(flag=>flag!==true)||!digest(proof?.contentManifestSha256)||value.employeeTest?.status!=='passed')backupCheck=unknown('RESTORE_EVIDENCE_INCOMPLETE');
   else backupCheck={...unknown('CURRENT_RESTORE_NOT_VERIFIED'),recordedStatus:'passed',checkedAt:new Date(at).toISOString(),ageHours:Math.floor(age/3600000),sha256:digest(backup.sha256),contentManifestSha256:proof.contentManifestSha256};
  }
 }
 const checks={storage:storageCheck,disk:diskCheck,retention:retentionCheck,backup:backupCheck};
 const status=Object.values(checks).some(check=>check.status==='failed')?'failed':Object.values(checks).some(check=>check.status==='unknown')?'unknown':'passed';
 return {format:REPORT_FORMAT,scope:'offline-read-only',checkedAt:new Date(now).toISOString(),status,automaticDeletion:false,modelRequests:0,checks,retentionPolicy:retentionAdvice([],now).policy};
}

export function encodeReport(report){const text=JSON.stringify(report,null,2)+'\n';if(Buffer.byteLength(text)>MAX_REPORT_BYTES)throw Error('REPORT_TOO_LARGE');return text;}
