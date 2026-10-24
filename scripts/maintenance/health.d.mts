export const REPORT_FORMAT:'weiwu-maintenance-health-v1';
export const MAX_INPUT_BYTES:1048576;
export const MAX_REPORT_BYTES:65536;
export type HealthStatus='passed'|'unknown'|'failed';
type Check={status:HealthStatus;code:string};
export type MaintenanceReport={format:typeof REPORT_FORMAT;scope:'offline-read-only';checkedAt:string;status:HealthStatus;automaticDeletion:false;modelRequests:0;
 checks:{
  storage:Check&{bytes?:number;files?:number;entries?:number;links?:number};
  disk:Check&{freeBytes?:number;minFreeBytes?:number};
  retention:Check&{recommendations?:number;kinds?:{journal:number;workspace:number;sandbox:number};sha256?:string};
  backup:Check&{recordedStatus?:'passed';checkedAt?:string;ageHours?:number;sha256?:string;contentManifestSha256?:string};
 };
 retentionPolicy:{hotJournalHours:number;completedCopiesDays:number;releaseKeepLatest:number;backupDays:number;backupKeepLatest:number};
};
export function buildHealthReport(input?:{storage?:unknown;disk?:unknown;retention?:unknown;backup?:unknown;now?:number}):MaintenanceReport;
export function encodeReport(report:unknown):string;
