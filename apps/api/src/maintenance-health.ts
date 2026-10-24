import {lstatSync} from 'node:fs';
import {isAbsolute,join} from 'node:path';
import {z} from 'zod';
import {plainPath,readEvidence} from '../../../scripts/maintenance/files.mjs';
import {MAX_REPORT_BYTES,REPORT_FORMAT} from '../../../scripts/maintenance/health.mjs';
import {MIN_STORAGE_FREE_BYTES} from '../../../services/agent-runtime/storage-governance.mjs';

const count=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const timestamp=z.string().max(32).refine(value=>Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value);
const state=z.enum(['passed','unknown','failed']);
// Object schemas strip every non-public property, including producer codes and source hashes.
const reportSchema=z.object({format:z.literal(REPORT_FORMAT),scope:z.literal('offline-read-only'),checkedAt:timestamp,status:state,
 automaticDeletion:z.literal(false),modelRequests:z.literal(0),checks:z.object({
  storage:z.object({status:z.enum(['passed','unknown']),bytes:count.optional(),files:count.optional(),entries:count.optional(),links:count.optional()}),
  disk:z.object({status:state,freeBytes:count.optional(),minFreeBytes:z.literal(MIN_STORAGE_FREE_BYTES).optional()}),
  retention:z.object({status:z.enum(['unknown','failed']),recommendations:count.max(150).optional(),kinds:z.object({journal:count.max(150),workspace:count.max(150),sandbox:count.max(150)}).optional()}),
  backup:z.object({status:z.enum(['unknown','failed']),recordedStatus:z.literal('passed').optional(),checkedAt:timestamp.optional(),ageHours:count.optional()}),
 })}).refine(value=>{
 const {storage,disk,retention,backup}=value.checks;
 if(storage.status==='passed'&&(storage.bytes===undefined||storage.files===undefined||storage.entries===undefined||storage.links!==0))return false;
 if(disk.status!=='unknown'&&(disk.freeBytes===undefined||disk.minFreeBytes!==MIN_STORAGE_FREE_BYTES||(disk.status==='passed')!==(disk.freeBytes>=MIN_STORAGE_FREE_BYTES)))return false;
 if(retention.kinds&&retention.recommendations!==Object.values(retention.kinds).reduce((a,b)=>a+b,0))return false;
 if(backup.recordedStatus&&(backup.status!=='unknown'||!backup.checkedAt||backup.ageHours===undefined||Date.parse(backup.checkedAt)>Date.parse(value.checkedAt)))return false;
 return value.status===(Object.values(value.checks).some(check=>check.status==='failed')?'failed':'unknown');
});
type Report=Pick<z.infer<typeof reportSchema>,'checkedAt'|'status'|'checks'>;
type Slot={slot:0|1;state:'missing'|'invalid'|'stale'|'future'|'available'};
export type MaintenanceHealth={version:1;currentStatus:'unknown';availability:'unavailable'|'available'|'degraded';
 code:'NOT_CONFIGURED'|'REPORT_DIRECTORY_UNAVAILABLE'|'REPORTS_MISSING'|'REPORT_UNAVAILABLE'|'REPORT_AVAILABLE'|'REPORT_DEGRADED';maxAgeHours:48;slots:Slot[];report?:Report};
const unavailable=(code:MaintenanceHealth['code'],slots:Slot[]=[]):MaintenanceHealth=>({version:1,currentStatus:'unknown',availability:'unavailable',code,maxAgeHours:48,slots});

/** Read two bounded local snapshots. No scanning, writes, DB calls or current-health certification. */
export function readMaintenanceHealth(directory?:string,now=Date.now()):MaintenanceHealth{
 if(!directory)return unavailable('NOT_CONFIGURED');
 if(!Number.isFinite(now)||!isAbsolute(directory)||/^[/\\]{2}/.test(directory))return unavailable('REPORT_DIRECTORY_UNAVAILABLE');
 try{plainPath(directory);if(!lstatSync(directory).isDirectory())return unavailable('REPORT_DIRECTORY_UNAVAILABLE');}
 catch(error){return unavailable((error as NodeJS.ErrnoException).code==='ENOENT'?'REPORTS_MISSING':'REPORT_DIRECTORY_UNAVAILABLE');}
 const reports:Report[]=[],slots:Slot[]=[];
 for(const slot of [0,1] as const){
  try{
   const parsed=reportSchema.safeParse(readEvidence(join(directory,`report-${slot}.json`),MAX_REPORT_BYTES).data);
   if(!parsed.success){slots.push({slot,state:'invalid'});continue;}
   const {checkedAt,status,checks}=parsed.data,age=now-Date.parse(checkedAt);
   if(age<0){slots.push({slot,state:'future'});continue;}
   if(age>48*3600000){slots.push({slot,state:'stale'});continue;}
   slots.push({slot,state:'available'});reports.push({checkedAt,status,checks});
  }catch(error){slots.push({slot,state:(error as NodeJS.ErrnoException).code==='ENOENT'?'missing':'invalid'});}
 }
 if(!reports.length)return unavailable(slots.every(slot=>slot.state==='missing')?'REPORTS_MISSING':'REPORT_UNAVAILABLE',slots);
 reports.sort((a,b)=>Date.parse(b.checkedAt)-Date.parse(a.checkedAt));
 const degraded=slots.some(slot=>slot.state!=='available'&&slot.state!=='missing');
 return {version:1,currentStatus:'unknown',availability:degraded?'degraded':'available',code:degraded?'REPORT_DEGRADED':'REPORT_AVAILABLE',maxAgeHours:48,slots,report:reports[0]};
}
