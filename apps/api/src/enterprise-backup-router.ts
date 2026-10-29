import {Router,type Request,type Response} from 'express';
import {z} from 'zod';
import type pg from 'pg';
import {pool} from './db.ts';
import {AppError} from './provider.ts';
import {administrative,currentRoutePrincipal,httpPrincipal} from './project-route-access.ts';
import type {Principal} from './identity-types.ts';
import {shareCostMaintenance} from './cost-control.ts';
import type {ArchiveWriterManager} from '../../../services/agent-runtime/archive-writer-scope.mjs';
import type {BackupRestoreState} from './backup-restore-state.ts';
import {underBackupRoot} from './backup-root-scope.ts';
import {decryptEnterpriseBackup,type EnterpriseBackupV2,ENTERPRISE_BACKUP_FORMAT} from './enterprise-backup-schema.ts';
import {exportEnterpriseBackup} from './enterprise-backup-export.ts';
import {restoreEnterpriseBackup} from './enterprise-backup-restore.ts';
import {activateRestoredEnvironmentIn,readRestoreAdmission} from './enterprise-restore-admission.ts';

const password=z.string().min(12).max(200),archive=z.strictObject({password,backup:z.record(z.string(),z.unknown())});
const activation=z.strictObject({operationId:z.uuid(),inputDigest:z.string().regex(/^[a-f0-9]{64}$/)});
async function administrator(db:pg.PoolClient,principal:Principal){await currentRoutePrincipal(db,principal,true);if(!administrative(principal))throw new AppError(403,'备份需要当前管理员权限','BACKUP_ADMIN_REQUIRED');}
function publicErrors(work:(req:Request,res:Response)=>Promise<unknown>){return async(req:Request,res:Response)=>{try{await work(req,res);}catch(error:any){if(!(error instanceof AppError)&&[409,422].includes(error?.status)&&/^BACKUP_/.test(error?.code??''))throw new AppError(error.status,error.message,error.code);throw error;}};}
async function adminRead<T>(principal:Principal,work:(db:pg.PoolClient)=>Promise<T>){const client=await pool.connect();let discard=false;try{await client.query('BEGIN');await shareCostMaintenance(client);await administrator(client,principal);const value=await work(client);try{await client.query('COMMIT');}catch(error){discard=true;throw error;}return value;}catch(error){try{await client.query('ROLLBACK');}catch{discard=true;}throw error;}finally{client.release(discard);}}
export function enterpriseBackupSummary(payload:EnterpriseBackupV2){return {format:ENTERPRISE_BACKUP_FORMAT,schemaId:payload.schemaId,createdAt:payload.createdAt,tableCounts:Object.fromEntries(Object.entries(payload.manifest.tables).map(([name,value])=>[name,value.rows])),fileCount:payload.manifest.files.length,totalBytes:payload.manifest.files.reduce((sum,file)=>sum+file.bytes,0),
 unresolvedCosts:payload.tables.model_reservations.filter(row=>row.status==='uncertain').length,
 unresolvedOperations:payload.tables.local_operations.filter(row=>row.executor_kind==='runtime'?!['confirmed','failed-known'].includes(String(row.effect_state)):['queued','claimed','started','unknown'].includes(String(row.status))||row.merge_state==='unknown').length,requiresFreshDestination:true};}

export function enterpriseBackupRouter(traceRoot:string,writers:ArchiveWriterManager,state:BackupRestoreState){
 const router=Router();
 router.post('/backup/enterprise/export',publicErrors(async(req,res)=>{const input=z.strictObject({password}).parse(req.body),backup=await exportEnterpriseBackup({principal:httpPrincipal(res),traceRoot,writers,state,password:input.password});res.attachment('weave-enterprise-backup-'+new Date().toISOString().slice(0,10)+'.json').json(backup);}));
 router.post('/backup/enterprise/inspect',publicErrors(async(req,res)=>{const input=archive.parse(req.body),summary=await adminRead(httpPrincipal(res),async()=>enterpriseBackupSummary(await decryptEnterpriseBackup(input.backup,input.password)));res.json(summary);}));
 router.post('/backup/enterprise/restore',publicErrors(async(req,res)=>{const input=archive.extend({confirmation:z.literal('RESTORE ENTERPRISE')}).parse(req.body),payload=await decryptEnterpriseBackup(input.backup,input.password);res.status(201).json(await restoreEnterpriseBackup({principal:httpPrincipal(res),payload,traceRoot,writers,state}));}));
 router.get('/backup/enterprise/status',publicErrors(async(_req,res)=>{
  const principal=httpPrincipal(res);await adminRead(principal,async()=>{});
  try{const status=await underBackupRoot(writers,state,()=>adminRead(principal,async db=>{
   const admission=await readRestoreAdmission(db);if(!admission)return {state:'normal',executionBlocked:false,physicalVerified:null};
   if(!('operation_id' in admission)||!admission.receiptVerified)return {state:'reconciliation-required',executionBlocked:true,physicalVerified:false,reasonCode:'BACKUP_RESTORE_RECONCILIATION_REQUIRED'};
   const common={operationId:admission.operation_id,inputDigest:admission.input_digest,sourceIssuer:admission.source_issuer,resourcesRequireReauthorization:true};
   if(admission.verified)return {...common,state:'active',executionBlocked:false,physicalVerified:null,verification:'checked-at-activation'};
   try{await state.verifyCommittedRestoreIn(db,{operationId:admission.operation_id,inputDigest:admission.input_digest});return {...common,state:'quarantined',executionBlocked:true,physicalVerified:true};}
   catch(error:any){return {...common,state:'reconciliation-required',executionBlocked:true,physicalVerified:false,reasonCode:error?.code==='BACKUP_RESTORE_RECONCILIATION_REQUIRED'?error.code:'BACKUP_RESTORE_VERIFICATION_FAILED'};}
  }));res.json(status);}catch{res.json({state:'reconciliation-required',executionBlocked:true,physicalVerified:false,reasonCode:'BACKUP_RESTORE_RECONCILIATION_REQUIRED'});}
 }));
 router.post('/backup/enterprise/activate',publicErrors(async(req,res)=>{
  const input=activation.parse(req.body),principal=httpPrincipal(res);if(principal.kind!=='human')throw new AppError(403,'请使用当前管理员账户重新登录目标环境。','BACKUP_ACTIVATION_REAUTHENTICATION_REQUIRED');
  await underBackupRoot(writers,state,async safety=>{const client=await pool.connect();let committing=false,discard=false;
   try{await client.query('BEGIN');for(const lock of [918274,918275])await client.query(`SELECT pg_advisory_xact_lock(${lock})`);await administrator(client,principal);
    const admission=await readRestoreAdmission(client);if(!admission?.verified)await state.verifyCommittedRestoreIn(client,input);
    await activateRestoredEnvironmentIn(client,principal,input);committing=true;safety.unknown=true;await client.query('COMMIT');committing=false;safety.unknown=false;
   }catch(error){discard=committing;try{if(!committing)await client.query('ROLLBACK');}catch{discard=true;safety.unknown=true;}throw error;}finally{try{client.release(discard);}catch(error){safety.unknown=true;throw error;}}
  });res.json({status:'active'});
 }));
 return router;
}
