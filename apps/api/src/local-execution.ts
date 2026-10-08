import {Router} from 'express';
import {z} from 'zod';
import {randomUUID,createHash,timingSafeEqual} from 'node:crypto';
import {createRequire} from 'node:module';
import {join} from 'node:path';
import {mkdirSync} from 'node:fs';
import {isDeepStrictEqual} from 'node:util';
import type pg from 'pg';
import {pool} from './db.ts';
import {AppError} from './provider.ts';
import {shareCostMaintenance} from './cost-control.ts';
import {assertRunAuthorization} from './execution-policy.ts';
import {withFreshLocalAdmission} from './local-admission.ts';
import {openRunArchive} from '../../../services/agent-runtime/trace-store.mjs';
const {decodeFiles,exportFiles,mirrorFiles,revision}=createRequire(import.meta.url)('../../desktop/local-executor.cjs');
const digest=(value:string)=>createHash('sha256').update(value).digest();
function validateResult(row:any,result:any){
 const files=decodeFiles(result.files),name=row.payload.name,args=row.payload.arguments;
 if(typeof result.localWorkspace!=='string'||!result.localWorkspace||result.localWorkspace.length>4096)throw new AppError(422,'缺少本机工作区位置');
 if(name==='terminal'||name==='terminal_test'){
  if(!Number.isInteger(result.exitCode)||typeof result.output!=='string')throw new AppError(422,'缺少命令退出码或输出');
 }else if(name==='filesystem'||name==='artifact_write'){
  const file=files.find((item:any)=>item.path===args.path);
  if(result.path!==args.path||!file||result.sha256!==createHash('sha256').update(file.bytes).digest('hex'))throw new AppError(422,'文件回执与回传内容不符');
  if(name==='filesystem'&&(file.bytes.length>1024*1024||result.content!==file.bytes.toString('utf8')))throw new AppError(422,'读取回执不正确');
  if(name==='artifact_write'&&(!file.bytes.equals(Buffer.from(args.content))||result.bytes!==file.bytes.length))throw new AppError(422,'写入回执与批准内容不符');
 }
}
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
const publicDevice=(row:any)=>({id:row.id,name:row.name,platform:row.platform,grantId:row.grant_id,label:row.label,allowCommands:row.allow_commands,enabled:row.enabled,lastSeen:row.last_seen,online:row.online});
export async function localTarget(policy:any,agents:any[],db:Pick<pg.PoolClient,'query'>=pool,online=true){
 const target=policy.executionTarget;
 if(target?.kind!=='local')return {kind:'server',platform:'linux'};
 const row=(await db.query("SELECT *,last_seen>clock_timestamp()-interval '15 seconds' AS online FROM local_devices WHERE id=$1",[target.deviceId])).rows[0];
 if(!row?.enabled||row.grant_id!==target.grantId)throw new AppError(422,'本机设备或目录授权已变化，请重新选择设备并批准方案','LOCAL_GRANT_CHANGED');
 if(!row.allow_commands&&agents.some(agent=>agent.tools?.some((tool:string)=>tool==='terminal'||tool==='terminal_test')))throw new AppError(422,'此设备没有开放本机命令，请在桌面端授权或移除终端工具','LOCAL_COMMAND_DENIED');
 if(online&&!row.online)throw new AppError(422,'本机执行器状态未刷新，请确认本机服务仍在运行，然后检查恢复条件','LOCAL_DEVICE_OFFLINE');
 return {kind:'local',deviceId:row.id,grantId:row.grant_id,name:row.name,platform:row.platform,label:row.label,allowCommands:row.allow_commands};
}
async function proof(id:string,key:unknown,db:Pick<pg.PoolClient,'query'>=pool){
 if(typeof key!=='string'||!/^[a-f0-9]{64}$/.test(key))throw new AppError(403,'本机设备凭证无效','LOCAL_DEVICE_DENIED');
 const row=(await db.query('SELECT * FROM local_devices WHERE id=$1',[id])).rows[0];
 if(!row||!timingSafeEqual(Buffer.from(row.token_hash,'hex'),digest(key)))throw new AppError(403,'本机设备凭证无效','LOCAL_DEVICE_DENIED');
 return row;
}
async function operationTransaction<T>(id:string,fn:(db:pg.PoolClient,row:any,run:any,device:any)=>Promise<T>){
 const db=await pool.connect();
 try{
  await db.query('BEGIN');await shareCostMaintenance(db);
  const identity=(await db.query('SELECT o.run_id,r.project_id FROM local_operations o JOIN project_runs r ON r.id=o.run_id WHERE o.id=$1',[id])).rows[0];
  if(!identity)throw new AppError(404,'本机操作不存在');
  await db.query('SELECT id FROM projects WHERE id=$1 FOR UPDATE',[identity.project_id]);
  const run=(await db.query('SELECT * FROM project_runs WHERE id=$1 FOR UPDATE',[identity.run_id])).rows[0];
  const row=(await db.query('SELECT * FROM local_operations WHERE id=$1 FOR UPDATE',[id])).rows[0];
  const device=(await db.query('SELECT * FROM local_devices WHERE id=$1 FOR UPDATE',[row.device_id])).rows[0];
  const value=await fn(db,row,run,device);await db.query('COMMIT');return value;
 }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
}
async function executable(db:pg.PoolClient,row:any,run:any,device:any){
 if(!device?.enabled||row.grant_id!==device.grant_id||run.status!=='running'||run.cancel_requested||run.lease_owner!==row.lease_owner||!(await db.query('SELECT id FROM project_runs WHERE id=$1 AND lease_until>clock_timestamp()',[run.id])).rowCount||!(await db.query('SELECT id FROM local_operations WHERE id=$1 AND deadline>clock_timestamp()',[row.id])).rowCount)return false;
 // A started operation can return its authenticated receipt while polling is
 // delayed. Heartbeat freshness is admission evidence, not grant withdrawal;
 // the device, run, lease, deadline and full authorization checks still apply.
 await assertRunAuthorization(run,db,{requireLocalOnline:row.started!==true});return true;
}
export class LocalOperationService {
 constructor(public traceRoot:string,public owner:string){}
 async enqueue(runId:string,name:string,args:any,context:any,files?:any[],signal?:AbortSignal){
  try{return await withFreshLocalAdmission(()=>this.enqueueAttempt(runId,name,args,context,files,signal),signal);}
  catch(error){throw Object.assign(error as object,{notExecuted:(error as any).notExecuted??true});}
 }
 private async enqueueAttempt(runId:string,name:string,args:any,context:any,files?:any[],signal?:AbortSignal){
  const db=await pool.connect(),id=randomUUID();let committing=false;
  try{
   signal?.throwIfAborted();
   await db.query('BEGIN');await shareCostMaintenance(db);
   const identity=(await db.query('SELECT project_id FROM project_runs WHERE id=$1',[runId])).rows[0];if(!identity)throw Error('运行不存在');
   await db.query('SELECT id FROM projects WHERE id=$1 FOR UPDATE',[identity.project_id]);
   const run=(await db.query('SELECT * FROM project_runs WHERE id=$1 FOR UPDATE',[runId])).rows[0];
   if(run.status!=='running'||run.cancel_requested||run.lease_owner!==this.owner||!(await db.query('SELECT id FROM project_runs WHERE id=$1 AND lease_until>clock_timestamp()',[runId])).rowCount)throw new AppError(409,'本机操作的运行租约已失效','LOCAL_LEASE_DENIED');
   await assertRunAuthorization(run,db,{requireLocalOnline:false});const target=await localTarget(run.snapshot.policy,run.snapshot.agents,db,false);
   if(target.kind!=='local')throw new AppError(422,'此运行没有批准本机设备','LOCAL_TARGET_DENIED');
   const employee=run.snapshot.agents.find((agent:any)=>agent.id===context.agentId);
   if(name!=='prepare'&&(!employee?.tools.includes(name)||!context.callId||!context.sessionId))throw new AppError(422,'本机操作不属于获授权员工','LOCAL_EMPLOYEE_DENIED');
   if(name==='prepare')decodeFiles(files??[]);
   else if(!['artifact_write','filesystem','terminal','terminal_test'].includes(name))throw new AppError(422,'未开放此本机工具');
   let approvalId=null;
   if(name==='terminal'||name==='terminal_test'){
    approvalId=z.uuid().parse(context.approvalId);
    if(!(await db.query("SELECT id FROM tool_approvals WHERE id=$1 AND run_id=$2 AND agent_id=$3 AND tool=$4 AND arguments=$5::jsonb AND status='approved' FOR UPDATE",[approvalId,runId,employee.id,name,JSON.stringify(args)])).rowCount)throw new AppError(422,'本机命令缺少相符的逐次批准','LOCAL_APPROVAL_DENIED');
   }
   signal?.throwIfAborted();
   await localTarget(run.snapshot.policy,run.snapshot.agents,db);
   signal?.throwIfAborted();
   const payload={runId,grantId:target.grantId,name,arguments:args,context,approvalId,...(files?{files}:{}),deviceId:target.deviceId};
   await db.query('INSERT INTO local_operations(id,device_id,run_id,grant_id,lease_owner,payload,approval_id) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,target.deviceId,runId,target.grantId,this.owner,payload,approvalId]);
   signal?.throwIfAborted();
   openRunArchive(this.traceRoot,runId).append('local/operation-queued',{operationId:id,name,deviceId:target.deviceId,...context});committing=true;await db.query('COMMIT');return id;
  }catch(error){await db.query('ROLLBACK');throw Object.assign(error as object,{notExecuted:!committing});}finally{db.release();}
 }
 async wait(id:string,signal?:AbortSignal){
  try{
   while(true){
    signal?.throwIfAborted();
    const state=await operationTransaction(id,async(db,row,run,device)=>{
     if(row.status==='completed')return await executable(db,row,run,device)?row:{...row,status:'cancelled'};
     if(['failed','cancelled'].includes(row.status))return row;
     if(!await executable(db,row,run,device)){
      await db.query("UPDATE local_operations SET status='cancelled',finished_at=now() WHERE id=$1",[id]);return {...row,status:'cancelled'};
     }return row;
    });
    if(state.status==='completed')return state.result.result;
    if(state.status==='failed')throw Object.assign(Error(state.result.error.message),{code:state.result.error.code,notExecuted:state.result.error.notExecuted});
    if(state.status==='cancelled')throw Object.assign(Error('本机操作已停止；已开始的修改需要核对'),{code:'LOCAL_OPERATION_CANCELLED',notExecuted:!state.started});
    await sleep(100);
   }
  }catch(error){const cancelled=await pool.query("UPDATE local_operations SET status='cancelled',finished_at=now() WHERE id=$1 AND status IN ('queued','claimed','started') RETURNING started",[id]);if(cancelled.rows[0]?.started===false)Object.assign(error as object,{notExecuted:true});throw error;}
 }
}
export class LocalRunExecutor {
 root:string;preparing?:Promise<void>;
 constructor(public archive:any,public snapshot:any,public service:LocalOperationService){this.root=join(archive.dir,'artifacts');mkdirSync(this.root,{recursive:true,mode:0o700});}
 revision(){return revision(exportFiles(this.root));}
 async prepare(signal:AbortSignal){
  return this.preparing??=(async()=>{
   const callId='local-prepare-'+this.archive.id,ref={callId};
   this.archive.append('runtime/operation-start',{name:'local_workspace',arguments:{deviceId:this.snapshot.executionTarget.deviceId}},ref);
   try{const id=await this.service.enqueue(this.archive.id,'prepare',{}, {},exportFiles(this.root),signal);const result=await this.service.wait(id,signal);mirrorFiles(this.root,result.files);this.archive.append('runtime/operation-finished',{name:'local_workspace'},ref);this.archive.append('local/device-bound',{...this.snapshot.executionTarget,localWorkspace:result.localWorkspace});}
   catch(error){if((error as any).notExecuted)this.archive.append('runtime/operation-finished',{name:'local_workspace'},ref);else this.archive.append('runtime/outcome-unknown',{name:'local_workspace',callId,arguments:{deviceId:this.snapshot.executionTarget.deviceId},message:(error as Error).message},ref);throw error;}
  })();
 }
 async execute(name:string,args:any,signal:AbortSignal,context:any){
  await this.prepare(signal);const id=await this.service.enqueue(this.archive.id,name,args,context,undefined,signal);const result=await this.service.wait(id,signal);
  const metadata=mirrorFiles(this.root,result.files);const {files:_files,...visible}=result;
  this.archive.append('local/operation-finished',{operationId:id,name,...context,localWorkspace:result.localWorkspace});return {...visible,...metadata};
 }
 async close(){await pool.query("UPDATE local_operations SET status='cancelled',finished_at=now() WHERE run_id=$1 AND lease_owner=$2 AND status IN ('queued','claimed','started')",[this.archive.id,this.service.owner]);}
}
export function localDeviceRouter(traceRoot:string){
 const router=Router(),registration=z.object({id:z.uuid(),token:z.string().regex(/^[a-f0-9]{64}$/),name:z.string().trim().min(1).max(100),platform:z.enum(['win32','darwin','linux']),grant:z.object({id:z.uuid(),label:z.string().min(1).max(200),allowCommands:z.boolean()})});
 router.get('/local-devices',async(_req,res)=>res.json((await pool.query("SELECT *,last_seen>clock_timestamp()-interval '15 seconds' AS online FROM local_devices ORDER BY name")).rows.map(publicDevice)));
 router.post('/local-devices/register',async(req,res)=>{
  const input=registration.parse(req.body),db=await pool.connect();
  try{await db.query('BEGIN');await shareCostMaintenance(db);const existing=(await db.query('SELECT * FROM local_devices WHERE id=$1 FOR UPDATE',[input.id])).rows[0];
   if(existing){await proof(input.id,req.get('X-Local-Device-Key'),db);if(!existing.enabled||existing.grant_id!==input.grant.id||existing.label!==input.grant.label||existing.allow_commands!==input.grant.allowCommands||existing.platform!==input.platform)throw new AppError(403,'设备授权已撤回或改变，请在桌面端重新启用','LOCAL_GRANT_CHANGED');await db.query('UPDATE local_devices SET last_seen=clock_timestamp() WHERE id=$1',[input.id]);}
   else await db.query('INSERT INTO local_devices(id,token_hash,name,platform,grant_id,label,allow_commands) VALUES($1,$2,$3,$4,$5,$6,$7)',[input.id,digest(input.token).toString('hex'),input.name,input.platform,input.grant.id,input.grant.label,input.grant.allowCommands]);
   await db.query('COMMIT');res.json({ok:true,id:input.id});
  }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
 });
 router.post('/local-devices/:id/poll',async(req,res)=>{
  const id=z.uuid().parse(req.params.id),device=await proof(id,req.get('X-Local-Device-Key'));
  if(!device.enabled)throw new AppError(403,'本机设备已被停用','LOCAL_DEVICE_DENIED');
  const input=z.object({active:z.object({id:z.uuid(),claimToken:z.uuid()}).nullable().default(null)}).parse(req.body);
  await pool.query('UPDATE local_devices SET last_seen=clock_timestamp() WHERE id=$1',[id]);
  if(input.active){const cancel=await operationTransaction(input.active.id,async(db,row,run,current)=>{if(row.device_id!==id||row.claim_token!==input.active!.claimToken)throw new AppError(403,'操作领取凭证不正确');const valid=['claimed','started'].includes(row.status)&&await executable(db,row,run,current);if(!valid&&['claimed','started'].includes(row.status))await db.query("UPDATE local_operations SET status='cancelled',finished_at=now() WHERE id=$1",[row.id]);return !valid;});return res.json({cancel});}
  const orphan=(await pool.query("SELECT id,claim_token,started FROM local_operations WHERE device_id=$1 AND status IN ('claimed','started') ORDER BY created_at LIMIT 1",[id])).rows[0];
  if(orphan){
   // A poll reply may be lost after claiming but before the device receives it.
   // Re-offer only an unstarted claim. /start still transitions atomically once;
   // a started operation must keep its unknown-outcome reconciliation path.
   const recovered=await operationTransaction(orphan.id,async(db,row,run,current)=>{
    if(row.status==='claimed'&&!row.started&&await executable(db,row,run,current))return {job:{id:row.id,...row.payload,claimToken:row.claim_token}};
    if(['claimed','started'].includes(row.status))return {orphan:{id:row.id,claimToken:row.claim_token,started:row.started}};
    return {job:null};
   });
   return res.json(recovered);
  }
  const pending=(await pool.query("SELECT id FROM local_operations WHERE device_id=$1 AND status='queued' ORDER BY created_at LIMIT 1",[id])).rows[0];if(!pending)return res.json({job:null});
  const job=await operationTransaction(pending.id,async(db,row,run,current)=>{
   if(row.status!=='queued')return null;
   if(!await executable(db,row,run,current)){await db.query("UPDATE local_operations SET status='cancelled',finished_at=now() WHERE id=$1",[row.id]);return null;}
   if((await db.query("SELECT id FROM local_operations WHERE device_id=$1 AND status IN ('claimed','started') AND id<>$2",[id,row.id])).rowCount)return null;
   const claimToken=randomUUID();await db.query("UPDATE local_operations SET status='claimed',claim_token=$1 WHERE id=$2",[claimToken,row.id]);return {id:row.id,...row.payload,claimToken};
  });res.json({job});
 });
 router.post('/local-devices/:id/operations/:operation/start',async(req,res)=>{
  const id=z.uuid().parse(req.params.id);await proof(id,req.get('X-Local-Device-Key'));const token=z.uuid().parse(req.body.claimToken);
  await operationTransaction(z.uuid().parse(req.params.operation),async(db,row,run,device)=>{
   if(row.device_id!==id||row.claim_token!==token||row.status!=='claimed'||!await executable(db,row,run,device))throw new AppError(409,'操作已启动、停止或授权失效','LOCAL_START_DENIED');
   await db.query("UPDATE local_operations SET status='started',started=true WHERE id=$1",[row.id]);
  });res.json({ok:true});
 });
 router.post('/local-devices/:id/operations/:operation/result',async(req,res)=>{
  const id=z.uuid().parse(req.params.id);await proof(id,req.get('X-Local-Device-Key'));
  const input=z.object({claimToken:z.uuid(),ok:z.boolean(),result:z.any().optional(),error:z.object({code:z.union([z.string().max(100),z.number()]),message:z.string().max(1000),notExecuted:z.boolean().default(false)}).optional()}).parse(req.body);
  if(input.ok){if(!input.result||typeof input.result!=='object')throw new AppError(422,'操作结果不正确');decodeFiles(input.result.files);if(input.result.output!==undefined&&(typeof input.result.output!=='string'||Buffer.byteLength(input.result.output)>1024*1024))throw new AppError(422,'操作输出超过限制');}
  else if(!input.error)throw new AppError(422,'缺少操作错误详情');
  await operationTransaction(z.uuid().parse(req.params.operation),async(db,row,run,device)=>{
   if(row.device_id!==id||row.claim_token!==input.claimToken)throw new AppError(403,'操作领取凭证不正确');
   if(input.ok)validateResult(row,input.result);
   if(row.result){if(!isDeepStrictEqual(row.result,input))throw new AppError(409,'已有不同操作回执');return;}
   if(input.ok&&!row.started)throw new AppError(409,'操作尚未确认开始');
   if(!['claimed','started'].includes(row.status)||!await executable(db,row,run,device)){
    if(row.late_result&&!isDeepStrictEqual(row.late_result,input))throw new AppError(409,'已有不同迟到回执');
    await db.query("UPDATE local_operations SET status='cancelled',late_result=$1,finished_at=now() WHERE id=$2",[input,row.id]);return;
   }
   await db.query('UPDATE local_operations SET status=$1,result=$2,finished_at=now() WHERE id=$3',[input.ok?'completed':'failed',input,row.id]);
   // Only a valid started claim reaching the durable-result branch proves this
   // device is currently reachable. Cancelled/expired late receipts stay above.
   if(row.started)await db.query('UPDATE local_devices SET last_seen=clock_timestamp() WHERE id=$1',[id]);
  });res.json({ok:true});
 });
 router.delete('/local-devices/:id',async(req,res)=>{await pool.query('UPDATE local_devices SET enabled=false WHERE id=$1',[z.uuid().parse(req.params.id)]);res.json({ok:true});});
 router.post('/local-devices/:id/disable',async(req,res)=>{const id=z.uuid().parse(req.params.id);await proof(id,req.get('X-Local-Device-Key'));await pool.query('UPDATE local_devices SET enabled=false WHERE id=$1',[id]);res.json({ok:true});});
 router.get('/runs/:id/local-operations',async(req,res)=>res.json((await pool.query('SELECT id,status,started,payload,result,late_result AS "lateResult",created_at AS "createdAt" FROM local_operations WHERE run_id=$1 ORDER BY created_at',[z.uuid().parse(req.params.id)])).rows.map(row=>({...row,payload:{name:row.payload.name,context:row.payload.context,arguments:row.payload.arguments},result:row.result?{ok:row.result.ok,error:row.result.error,localWorkspace:row.result.result?.localWorkspace,exitCode:row.result.result?.exitCode,output:row.result.result?.output}:null,lateResult:row.lateResult?{ok:row.lateResult.ok,error:row.lateResult.error,localWorkspace:row.lateResult.result?.localWorkspace,exitCode:row.lateResult.result?.exitCode,output:row.lateResult.result?.output}:null}))));
 return router;
}
