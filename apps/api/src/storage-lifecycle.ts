import type pg from 'pg';import {isDeepStrictEqual} from 'node:util';import {join} from 'node:path';import {existsSync} from 'node:fs';import {createHash} from 'node:crypto';import {createRequire} from 'node:module';
import {AppError} from './provider.ts';import {readRun} from '../../../services/agent-runtime/trace-store.mjs';import {unresolvedOperations} from '../../../services/agent-runtime/recovery.mjs';import {journalArchiveCandidate,archiveJournal,readJournal} from '../../../services/agent-runtime/journal-archive.mjs';
const {revision,exportFiles}=createRequire(import.meta.url)('../../desktop/local-executor.cjs');
export type SandboxMaintenance={deviceId:string;grantId:string;fingerprint:string;executor:{storageScopes:()=>any[];inspectStorage:(runId:string)=>Promise<any>;retireStorage:(runId:string,expected:any)=>Promise<any>;reconcileStorage:(runId:string)=>Promise<any>;acceptedStopCapabilities?:()=>{version:1;deadline:'shared-abort-v1'};stopAcceptedTask?:(key:any,expected:any,beforeDispatch:()=>Promise<void>,signal?:AbortSignal)=>Promise<any>;reconcileAcceptedTaskStop?:(key:any,identity:any,signal?:AbortSignal)=>Promise<any>}};
type Database=Pick<pg.PoolClient,'query'>;
export const maintenanceConfirmation:Record<string,string>={workspace:'CLEAN_WORKSPACE_COPIES',sandbox:'RETIRE_SANDBOX',journal:'ARCHIVE_JOURNAL'};
export function maintenanceError(error:any){if(error instanceof AppError)return error;if(typeof error.code==='string'&&/^(JOURNAL_|SANDBOX_|WORKSPACE_|OPENSHELL_|LOCAL_)/.test(error.code))return new AppError(409,String(error.message).slice(0,1000),error.code);return error;}
async function completed(root:string,runId:string,db:Database){
 const row=(await db.query(`SELECT r.status,r.snapshot,EXISTS(SELECT 1 FROM local_operations o WHERE o.run_id=r.id AND (o.status NOT IN ('completed','failed','cancelled') OR (o.started AND o.result IS NULL))) AS blocked,EXISTS(SELECT 1 FROM model_reservations c WHERE c.run_id=r.id AND c.status IN ('pending','uncertain')) AS costs_pending FROM project_runs r WHERE r.id=$1`,[runId])).rows[0];
 if(!row||row.status!=='completed'||row.blocked||row.costs_pending)throw new AppError(409,'只维护已完成且操作、费用均已核对的运行；原现场保留。','STORAGE_RUN_PROTECTED');
 const record=readRun(root,runId);if(!record||record.integrity!=='ok'||record.status!=='completed'||unresolvedOperations(record.events).length)throw new AppError(409,'原运行档案不完整或仍有未知操作，不能维护。','STORAGE_RUN_PROTECTED');return {row,record};
}
export async function boundSandbox(root:string,runId:string,provider:(()=>SandboxMaintenance|undefined)|undefined,db:Database){
 const adapter=provider?.();if(!adapter)throw new AppError(409,'OpenShell 本机维护尚未连接，请检查执行设备。','STORAGE_SANDBOX_UNAVAILABLE');
 const {row,record}=await completed(root,runId,db),target=row.snapshot.executionTarget;
 const device=(await db.query('SELECT enabled,grant_id,backend FROM local_devices WHERE id=$1',[adapter.deviceId])).rows[0];
 if(!device?.enabled||device.grant_id!==adapter.grantId||device.backend?.kind!=='openshell'||device.backend.fingerprint!==adapter.fingerprint||target?.deviceId!==adapter.deviceId||target.grantId!==adapter.grantId||target.backend?.fingerprint!==adapter.fingerprint||!isDeepStrictEqual(target,(record.snapshot as any).executionTarget))throw new AppError(409,'沙箱设备授权或原运行绑定已变化，不能维护。','STORAGE_SANDBOX_BINDING');
 return adapter;
}
export async function maintenanceCandidate(root:string,kind:string,runId:string,provider:(()=>SandboxMaintenance|undefined)|undefined,db:Database){
 if(kind==='journal'){await completed(root,runId,db);return {...journalArchiveCandidate(root,runId),path:'events.jsonl'};}
 if(kind!=='sandbox')throw new AppError(422,'维护类型不正确');const adapter=await boundSandbox(root,runId,provider,db),scope=adapter.executor.storageScopes().find(s=>s.runId===runId);
 const canonical=revision(exportFiles(join(root,runId,'artifacts')));
 if(!scope||!['ready','stopped'].includes(scope.phase)||!scope.storage||scope.workspaceRevision!==canonical)throw new AppError(409,'请先核对沙箱容量与正式交付版本；未知或不一致现场保留。','STORAGE_SANDBOX_UNVERIFIED');
 return {runId,path:'OpenShell 沙箱',bytes:Number(scope.storage.workspace?.bytes??0)+Number(scope.storage.temp?.bytes??0),sandboxId:scope.sandboxId,workspaceRevision:canonical,deviceId:adapter.deviceId,grantId:adapter.grantId,fingerprint:adapter.fingerprint};
}
export async function validateMaintenance(root:string,preview:any,provider:(()=>SandboxMaintenance|undefined)|undefined,db:Database){
 if(preview.candidates?.length!==1)throw new AppError(409,'维护清单已变化');const expected=preview.candidates[0],current=await maintenanceCandidate(root,preview.kind,expected.runId,provider,db);
 if(!isDeepStrictEqual(expected,current))throw new AppError(409,'维护预览的身份、文件或版本已变化，请重新核对。','STORAGE_PREVIEW_STALE');
}
export async function applyMaintenance(root:string,preview:any,provider:(()=>SandboxMaintenance|undefined)|undefined,db:Database){
 await validateMaintenance(root,preview,provider,db);const candidate=preview.candidates[0];
 if(preview.kind==='journal')return archiveJournal(root,candidate);
 const adapter=await boundSandbox(root,candidate.runId,provider,db),result=await adapter.executor.retireStorage(candidate.runId,candidate);
 if(result.state!=='retired'||result.sandboxId!==candidate.sandboxId||result.runId!==candidate.runId)throw new AppError(409,'沙箱回收尚未取得完整回执，请只核对原请求。','LOCAL_OUTCOME_UNKNOWN');return result;
}
export async function reconcileMaintenance(root:string,preview:any,provider:(()=>SandboxMaintenance|undefined)|undefined,db:Database){
 if(preview.candidates?.length!==1)throw new AppError(409,'维护清单已变化');const candidate=preview.candidates[0];
 if(preview.kind==='sandbox'){const adapter=await boundSandbox(root,candidate.runId,provider,db);const result=await adapter.executor.reconcileStorage(candidate.runId);if(result.sandboxId!==candidate.sandboxId||result.runId!==candidate.runId)throw new AppError(409,'原沙箱身份不匹配');return {...result,replayed:false};}
 if(preview.kind!=='journal')throw new AppError(422,'维护类型不正确');let state='unverified';
 if(existsSync(join(root,candidate.runId,'events.jsonl')))state='plain-retained';
 else try{if(createHash('sha256').update(readJournal(join(root,candidate.runId))).digest('hex')===candidate.sha256)state='archived';}catch{}
 return {runId:candidate.runId,state,replayed:false};
}
