import {restoreExecutionBlocked} from './enterprise-restore-admission.ts';
import {lockedRun,claimExpiredRun,deferUnstartedRun,finishRun,terminalStatus} from './run-state.ts';
import {assertRunAuthorization,assertExecutionProfile,executionMode} from './execution-policy.ts';
import {assertCurrentRunAuthority,recordRunAuthorityDenial,type RunEffect} from './run-current-authority.ts';
import { executeBrowserMcpTool } from './work-tools-browser.ts';
import { randomUUID } from 'node:crypto';
import {join} from 'node:path';
import { prepareImportedWorkspace } from './work-files.ts';
import {readLiveCanonical} from './live-canonical-reader.ts';
import {restoreStepWorkspace} from './step-checkpoint-recovery.ts';
import {initializeLiveTaskRecovery} from './task-recovery-initialization.ts';
import {assertTaskRecoveryRuntime} from './task-recovery-runtime.ts';
import {materializeCommittedCanonical} from './task-canonical.ts';
import {isDeepStrictEqual} from 'node:util';
import {requireResolvedProjectEffectsIn} from './tool-operations.ts';
import {createToolEffectComposition} from './tool-effect-composition.ts';
import { pool } from './db.ts';
import { unseal } from './vault.ts';
import { AppError } from './provider.ts';
import { ProductDshRuntime,type RuntimeCompletion } from '../../../services/agent-runtime/product-runtime.mjs';
import { readRun, createRunArchive, openRunArchive } from '../../../services/agent-runtime/trace-store.mjs';
import { queryKnowledge } from './knowledge-store.ts';
import { reserveCall,settleCall,markCallUncertain,expireReservations,recordProviderResponse,shareCostMaintenance } from './cost-control.ts';
import { settings } from './product.ts';
import { assertRunModels,routeFingerprint } from './model-capabilities.ts';
import type { RuntimeUsage } from '../../../services/agent-runtime/openai-compatible.mjs';
import {LocalOperationService,LocalRunExecutor} from './local-execution.ts';
import type {SandboxMaintenance} from './storage-lifecycle.ts';
import type {ArchiveWriterManager,ArchiveWriterOwner} from '../../../services/agent-runtime/archive-writer-scope.mjs';
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
const acceptedRecordingPending='业务已完成，终态记录或费用回填尚待核对；请保留原运行记录与未知费用。';
type ActiveRun={projectId:string;writer:ArchiveWriterOwner;phase?:'executing'|'draining'|'drain-failed';work?:Promise<void>;writerDrained?:Promise<void>;drainFailure?:Error};
type Heartbeat={ids:string[];held:string[]};
async function heartbeatForCaller(work:Promise<Heartbeat>,signal?:AbortSignal){
  signal?.throwIfAborted();if(!signal)return work;
  let abort:()=>void;const cancelled=new Promise<never>((_resolve,reject)=>{abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true});});
  try{return await Promise.race([work,cancelled]);}finally{signal.removeEventListener('abort',abort!);}
}
export class RunCoordinator {
  private preparedRecovery=new Map<string,{snapshot:any;head:any;evidence:any}>();
  owner=randomUUID(); runtime:ProductDshRuntime; active=new Map<string,ActiveRun>();closing?:Promise<void>; ticking=false; stopped=false; timer?:NodeJS.Timeout;heartbeatWork?:Promise<Heartbeat>;
  constructor(public traceRoot:string,public writers:ArchiveWriterManager,createExecutor?:ConstructorParameters<typeof ProductDshRuntime>[0]['createExecutor'],maintenance:{startPaused?:boolean;sandboxMaintenance?:()=>SandboxMaintenance|undefined;toolEffects?:ReturnType<typeof createToolEffectComposition>}={}){
    if(!writers||writers.traceRoot!==traceRoot)throw Error('ARCHIVE_WRITER_CONFIG_REQUIRED');
    executionMode();
    const local=new LocalOperationService(traceRoot,this.owner,this.writers);
    const toolEffects=maintenance.toolEffects??createToolEffectComposition(pool,writers);
    this.runtime=new ProductDshRuntime({traceRoot,queryKnowledge,beforeTool:(id,signal)=>this.authorizeEffect(id,'tool',signal),beforeKnowledge:(id,signal)=>this.authorizeEffect(id,'knowledge',signal),runtimeBindingsForRun:(id,snapshot)=>toolEffects.runtimeBindingsForRun(id,snapshot,this.owner),externalTool:executeBrowserMcpTool,createExecutor:(archive,snapshot)=>{assertExecutionProfile(snapshot);return createExecutor?.(archive,snapshot)??(snapshot.executionTarget?.kind==='local'?new LocalRunExecutor(archive,snapshot,local,maintenance):undefined);},onUsage:(id,u)=>this.recordUsage(id,u),requestApproval:(input,signal)=>this.approveTool(input,signal),beforeRequest:(id,data,signal)=>this.reserve(id,data,signal),onResponse:data=>recordProviderResponse(data.id,data),onCallError:async data=>{await recordProviderResponse(data.id,data);await markCallUncertain(data.id,data.code,data.dispatched);}});
    if(!maintenance.startPaused)this.start();
  }
  start(){
    if(this.timer||this.stopped||this.closing)return;
    this.timer=setInterval(()=>{void this.heartbeat().catch(e=>{if(!this.stopped)console.error('Run heartbeat:',e instanceof Error?e.name:'error');});void this.tick();},1000);this.timer.unref();void this.tick();
  }
  async heartbeat(){
    if(await restoreExecutionBlocked(pool))return {ids:[],held:[]};
    if(this.stopped)return {ids:[],held:[]};if(this.heartbeatWork)return this.heartbeatWork;
    const entries=[...this.active].filter(([,entry])=>!entry.drainFailure&&(!entry.phase||entry.phase==='executing'));
    const ids=entries.map(([id])=>id);if(!ids.length)return {ids,held:[]};
    // Retain before SQL. Per-run updates restore the exact original ALS owner;
    // cancellation stays detached from heartbeatWork to avoid admission cycles.
    const retained:Array<{id:string;entry:ActiveRun;producer:ReturnType<ArchiveWriterOwner['retain']>}>=[];
    try{for(const [id,entry] of entries)retained.push({id,entry,producer:entry.writer.retain('heartbeat/cancel')});}
    catch(error){for(const {producer} of retained)producer.finish();throw error;}
    const updates:Promise<string[]>[]=[];
    for(const {id,entry,producer} of retained){
      const sql=producer.run(async()=>(await pool.query("UPDATE project_runs SET lease_until=clock_timestamp()+interval '30 seconds' WHERE id=ANY($1::text[]) AND lease_owner=$2 AND status='running' RETURNING id",[[id],this.owner])).rows.map(r=>r.id));updates.push(sql);
      const tail=producer.run(async()=>{const held=await sql;if(!held.includes(id)&&this.active.get(id)===entry&&(!entry.phase||entry.phase==='executing'))await this.runtime.cancel(id);});
      tail.then(()=>producer.finish(),error=>{producer.finish(error);if(!this.stopped)console.error('Run lease cancellation:',error instanceof Error?error.name:'error');});
    }
    this.heartbeatWork=Promise.allSettled(updates).then(results=>{
      const rejected=results.find(result=>result.status==='rejected');if(rejected?.status==='rejected')throw rejected.reason;
      return {ids,held:results.flatMap(result=>result.status==='fulfilled'?result.value:[])};
    });
    try{return await this.heartbeatWork;}finally{this.heartbeatWork=undefined;}
  }
  async recordUsage(runId:string,u:RuntimeUsage){
    this.writers.assertWriter(runId);
    return this.writers.withWriter([runId],async()=>{
    if((await pool.query('SELECT id FROM model_reservations WHERE id=$1',[u.id])).rowCount){await settleCall(u.id,u.inputTokens,u.outputTokens,u);return;}
    await lockedRun(this.writers,runId,async(client,run)=>{
    const agent=run?.snapshot?.agents?.find((item:any)=>item.id===u.agentId||item.employeeId===u.employeeId);
    const departmentId=agent?.sourceDepartmentId??run?.snapshot?.departmentId??null;
    await client.query(`INSERT INTO usage(id,model_id,project_id,department_id,run_id,input_tokens,output_tokens,cost,purpose,agent_id,employee_id,session_id,task_id,attempt_id,request_id,duration_ms)
      SELECT $1,$2,project_id,$7,id,$3,$4,$5,$15,$8,$9,$10,$11,$12,$13,$14 FROM project_runs WHERE id=$6 ON CONFLICT(id) DO NOTHING`,[u.id,u.modelId,u.inputTokens,u.outputTokens,u.cost,runId,departmentId,u.agentId??null,u.employeeId??null,u.sessionId??null,u.taskId??null,u.attemptId??null,u.requestId??null,u.durationMs??null,u.requestPurpose==='compaction'?'上下文摘要':u.requestPurpose==='handoff'?'正式交接':'项目执行']);
    });
    });
  }
  async reserve(runId:string,data:any,signal?:AbortSignal){
    signal?.throwIfAborted();
    if(this.active.has(runId)){
      let heartbeat=await heartbeatForCaller(this.heartbeat(),signal);signal?.throwIfAborted();
      // A newly started job can join active while a heartbeat for earlier jobs
      // is queued. Renew once for this uncovered job; a covered lost owner fails.
      if(!heartbeat.ids.includes(runId)&&this.active.has(runId)){heartbeat=await heartbeatForCaller(this.heartbeat(),signal);signal?.throwIfAborted();}
      if(!heartbeat.held.includes(runId))throw new AppError(409,'工作进程已失去运行租约','LEASE_LOST');
    }
    const run=(await pool.query('SELECT project_id,snapshot FROM project_runs WHERE id=$1 AND lease_owner=$2',[runId,this.owner])).rows[0];
    if(!run)throw new AppError(409,'工作进程已失去运行租约');
    await assertRunModels(run.snapshot);
    const model=run.snapshot.modelRoutes.find((m:any)=>m.id===data.modelId);if(!model)throw new AppError(422,'模型不属于批准快照');
    const agent=run.snapshot.agents.find((item:any)=>item.id===data.agentId||item.employeeId===data.employeeId)??(!data.agentId&&!data.employeeId?run.snapshot.agents[0]:undefined);
    if(!agent)throw new AppError(422,'调用员工不在批准快照中');
    const billingDepartmentId=agent.sourceDepartmentId??run.snapshot.departmentId;
    try{await reserveCall({id:data.id,model,amount:data.reservation,purpose:data.requestPurpose==='compaction'?'上下文摘要':data.requestPurpose==='handoff'?'正式交接':'项目执行',projectId:run.project_id,runId,leaseOwner:this.owner,billingDepartmentId,signal,authorize:async(db,row)=>{await assertRunModels(row.snapshot,db);await assertRunAuthorization(row,db,{authorityLock:true,effect:'model'});},context:{agentId:data.agentId,employeeId:data.employeeId,sourceDepartmentId:billingDepartmentId,sourceAgentId:agent.sourceAgentId,sessionId:data.sessionId,taskId:data.taskId,runtimeTaskId:data.runtimeTaskId,reworkRound:data.reworkRound,attemptId:data.attemptId,requestId:data.requestId,requestPurpose:data.requestPurpose}});}catch(error){await recordRunAuthorityDenial(pool,error);throw error;}
  }
  /** Short effect admission; locks never span the tool body or provider call. */
  async authorizeEffect(runId:string,effect:RunEffect,signal?:AbortSignal):Promise<void>{
    const result=await this.writers.withWriter([runId],async()=>{
      const client=await pool.connect();let discard=false,committing=false,primary:unknown;
      try{
        signal?.throwIfAborted();try{await client.query('BEGIN');}catch(error){discard=true;throw error;}
        await shareCostMaintenance(client);
        const identity=(await client.query('SELECT project_id FROM project_runs WHERE id=$1',[runId])).rows[0];
        if(identity)await client.query('SELECT id FROM projects WHERE id=$1 FOR UPDATE',[identity.project_id]);
        const row=(await client.query('SELECT *,lease_until>clock_timestamp() AS lease_valid FROM project_runs WHERE id=$1 FOR UPDATE',[runId])).rows[0];
        if(!row||row.project_id!==identity?.project_id||row.status!=='running'||row.cancel_requested||row.lease_owner!==this.owner||!row.lease_valid)throw new AppError(409,'运行已停止或租约失效','LEASE_LOST');
        await assertRunAuthorization(row,client,{authorityLock:true,effect,requireLocalOnline:false});signal?.throwIfAborted();
        committing=true;await client.query('COMMIT');return {ok:true as const};
      }catch(error){primary=error;try{await client.query('ROLLBACK');}catch{discard=true;}
        if(discard||committing){discard=true;throw error;}return {ok:false as const,error};
      }finally{try{client.release(discard);}catch(error){if(primary===undefined)throw error;}}
    },{signal});
    if(!result.ok){await recordRunAuthorityDenial(pool,result.error);throw result.error;}
  }
  async approveTool(input:any,signal?:AbortSignal){
    signal?.throwIfAborted();const id=randomUUID();
    const request=await lockedRun(this.writers,input.runId,async(client,row)=>{
      try{await assertCurrentRunAuthority(client,row.id,'tool');}
      catch(error){if(error instanceof AppError&&error.code==='RUN_AUTHORITY_REVOKED')return {denied:error};throw error;}
      await client.query('INSERT INTO tool_approvals(id,run_id,agent_id,tool,arguments) VALUES($1,$2,$3,$4,$5)',[id,input.runId,input.agentId,input.tool,input.arguments]);
      openRunArchive(this.traceRoot,input.runId).append('approval/requested',{id,...input});
    });
    if(request?.denied){await recordRunAuthorityDenial(pool,request.denied);throw request.denied;}
    let persistenceFailed=false;
    try{while(true){signal?.throwIfAborted();
      this.writers.assertWriter(input.runId);
      const row=await this.writers.withWriter([input.runId],async()=>{try{return (await pool.query('SELECT status FROM tool_approvals WHERE id=$1',[id])).rows[0];}catch(error){persistenceFailed=true;throw error;}});
      if(row?.status==='approved'){await this.authorizeEffect(input.runId,'tool',signal);return id;}if(row?.status!=='pending')throw Error('工具操作未获批准');await sleep(500);
    }}finally{if(!persistenceFailed)await lockedRun(this.writers,input.runId,async(client)=>{await client.query("UPDATE tool_approvals SET status='cancelled',decided_at=now() WHERE id=$1 AND status='pending'",[id]);});}
  }

  async recover(){
    if(await restoreExecutionBlocked(pool))return;
    await expireReservations();
    const stale=(await pool.query("SELECT id FROM project_runs WHERE status='running' AND (lease_until IS NULL OR lease_until<clock_timestamp())")).rows;
    for(const candidate of stale){
      await this.writers.withWriter([candidate.id],async()=>{
      if(await restoreExecutionBlocked(pool))return;
      let legacy=false;
      const row=await claimExpiredRun(this.writers,candidate.id,current=>{
        legacy=current.snapshot.executionTarget?.kind!=='local';
        return legacy||(current.lease_owner===this.owner&&this.active.has(current.id));
      });
      if(!row){if(legacy)console.error('Run recovery: legacy cleanup deferred');return;}
      await lockedRun(this.writers,row.id,async(client)=>{await client.query("UPDATE local_operations SET status='cancelled',finished_at=now() WHERE run_id=$1 AND status IN ('queued','claimed','started')",[row.id]);});
      const archived=readRun(this.traceRoot,row.id);
      if(archived?.integrity==='ok'){
        for(const event of archived.events.filter(e=>e.type==='billing/usage'))await this.recordUsage(row.id,event.data);
        const finished=archived.events.findLast(e=>e.type==='run/finished');
        if(finished&&terminalStatus(finished.data.status)){await finishRun(this.writers,row.id,row.lease_owner,finished.data.status,finished.data.message??null);return;}
      }
      await finishRun(this.writers,row.id,row.lease_owner,'interrupted','运行进程中断，请检查记录后恢复',record=>this.traceFinished(record,'interrupted','服务租约过期，运行已停止；可从已记录的任务结果恢复。'));
      });
    }
  }
  traceFinished(row:any,status:string,message:string){
    const existing=readRun(this.traceRoot,row.id);const archive=existing?openRunArchive(this.traceRoot,row.id):createRunArchive(this.traceRoot,row.snapshot,{id:row.id});archive.append('run/finished',{status,message});
  }

  private async prepareRecovery(id:string){
    const row=(await pool.query('SELECT * FROM project_runs WHERE id=$1',[id])).rows[0];
    if(row?.snapshot.executionProfile!=='task-attempt-openshell-v1'||!row.snapshot.recovery)return;
    const reference=row.snapshot.recovery.workspaceCheckpoint;
    if(!reference||row.parent_run_id!==reference.runId)throw new AppError(409,'恢复运行缺少原检查点定位','TASK_RECOVERY_UNAVAILABLE');
    await initializeLiveTaskRecovery(this.writers,{sourceRunId:reference.runId,checkpointId:reference.id,childRunId:id},AbortSignal.timeout(120000));
    const current=(await pool.query('SELECT * FROM project_runs WHERE id=$1',[id])).rows[0];
    await assertTaskRecoveryRuntime(pool,this.traceRoot,current);
    this.preparedRecovery.set(id,{snapshot:structuredClone(current.snapshot),head:structuredClone(current.canonical_workspace),evidence:structuredClone(current.task_evidence)});
  }

  async tick(){
    if(this.ticking||this.stopped)return;this.ticking=true;
    try{
      if(await restoreExecutionBlocked(pool))return;
      // Heartbeats precede recovery. A dead worker eventually loses its lease.
      await this.heartbeat();
      const cancel=(await pool.query("SELECT id FROM project_runs WHERE lease_owner=$1 AND cancel_requested=true AND status='running'",[this.owner])).rows;
      for(const row of cancel){const entry=this.active.get(row.id);if(entry&&(!entry.phase||entry.phase==='executing'))await this.cancelOwned(row.id,entry);}
      await this.recover();
      if(this.stopped||!(await this.runtime.inspect()).ready)return;
      // Identity discovery holds no SQL lock. Never wait for native locks in a transaction.
      const candidate=(await pool.query(`SELECT r.id,r.project_id FROM project_runs r WHERE r.status='queued' AND NOT r.cancel_requested
        AND NOT EXISTS(SELECT 1 FROM project_runs a WHERE a.status='running' AND
          COALESCE(NULLIF(a.department_ids,'{}'),ARRAY[a.snapshot->>'departmentId']) && COALESCE(NULLIF(r.department_ids,'{}'),ARRAY[r.snapshot->>'departmentId']))
        ORDER BY r.created_at LIMIT 1`)).rows[0];
      if(!candidate)return;
      // Source certification must finish before the child owner exists. A
      // writer cannot upgrade its native fence to read a different source.
      try{await this.prepareRecovery(candidate.id);}catch(error){
        await this.writers.withWriter([candidate.id],()=>lockedRun(this.writers,candidate.id,async(client,row)=>{
          if(!row||row.status!=='queued')return;
          const message=error instanceof Error?error.message:'恢复初始化失败';
          await client.query("UPDATE project_runs SET status='interrupted',error=$2,finished_at=now(),lease_owner=NULL,lease_until=NULL WHERE id=$1",[row.id,message]);
          await client.query("UPDATE projects SET status='INTERRUPTED' WHERE id=$1 AND version=$2",[row.project_id,row.project_version]);
          this.traceFinished(row,'interrupted',message);
        }));return;
      }
      let writer:ArchiveWriterOwner|undefined=await this.writers.acquireOwner([candidate.id]);
      try{
      const job=await writer.run(async()=>{
      const client=await pool.connect();let job:any;
      try{
        await client.query('BEGIN');
        if(!(await client.query('SELECT pg_try_advisory_xact_lock(918274) AS locked')).rows[0].locked){await client.query('ROLLBACK');return;}
        const limit=(await settings(client)).data.maxActiveRuns;
        const count=Number((await client.query("SELECT count(*) FROM project_runs WHERE status='running'")).rows[0].count);
        if(count<limit&&!this.stopped){
          // All operations lock project before run; skip an in-flight edit instead of inverting that order.
          const project=(await client.query('SELECT id,version FROM projects WHERE id=$1 FOR UPDATE SKIP LOCKED',[candidate.project_id])).rows[0];
          if(project)job=(await client.query(`SELECT r.* FROM project_runs r WHERE r.id=$1 AND r.project_id=$2 AND r.project_version=$3 AND r.status='queued' AND NOT r.cancel_requested
            AND NOT EXISTS(SELECT 1 FROM project_runs a WHERE a.status='running' AND
              COALESCE(NULLIF(a.department_ids,'{}'),ARRAY[a.snapshot->>'departmentId']) && COALESCE(NULLIF(r.department_ids,'{}'),ARRAY[r.snapshot->>'departmentId']))
            FOR UPDATE OF r SKIP LOCKED`,[candidate.id,project.id,project.version])).rows[0];
          if(job&&!this.stopped){
            if(job.snapshot.executionProfile==='task-attempt-openshell-v1'&&job.snapshot.recovery){
              const pin=this.preparedRecovery.get(job.id);
              if(!pin||!isDeepStrictEqual(pin,{snapshot:job.snapshot,head:job.canonical_workspace,evidence:job.task_evidence}))throw new AppError(409,'恢复批准在领租约前发生变化','TASK_RECOVERY_RUNTIME_INVALID');
            }
            try{await assertCurrentRunAuthority(client,job.id,'resume');}
            catch(error){
              if(!(error instanceof AppError)||error.code!=='RUN_AUTHORITY_REVOKED')throw error;
              await client.query("UPDATE project_runs SET status='interrupted',error=$2,finished_at=now(),lease_owner=NULL,lease_until=NULL WHERE id=$1",[job.id,error.message]);
              await client.query("UPDATE projects SET status='INTERRUPTED' WHERE id=$1 AND version=$2",[job.project_id,job.project_version]);
              await client.query('COMMIT');return {authorityDenied:error};
            }
            await client.query("UPDATE project_runs SET status='running',lease_owner=$1,lease_until=clock_timestamp()+interval '30 seconds',started_at=now() WHERE id=$2",[this.owner,job.id]);await client.query("UPDATE projects SET status='RUNNING' WHERE id=$1 AND version=$2",[job.project_id,job.project_version]);
          }else job=undefined;
        }
        await client.query('COMMIT');
      }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
      return job;
      });
      if(job?.authorityDenied){await recordRunAuthorityDenial(pool,job.authorityDenied);return;}
      if(job&&this.stopped){await writer.run(()=>finishRun(this.writers,job.id,this.owner,'interrupted','工作进程关闭，任务尚未启动',row=>this.traceFinished(row,'interrupted','工作进程关闭，任务尚未启动')));return;}
      if(job){void this.launch(job,writer);writer=undefined;}
      }finally{if(writer){writer.finish();await writer.writerDrained;}}
    }catch(e){if(!this.stopped)console.error('Run worker:',e instanceof Error?e.name:'error');}finally{this.ticking=false;}
  }
  launch(row:any,writer?:ArchiveWriterOwner){
    const work=writer?this.launchWithOwner(row,writer):this.prepareRecovery(row.id).then(()=>this.writers.acquireOwner([row.id])).then(owner=>this.launchWithOwner(row,owner));
    work.catch(error=>{if(!this.stopped)console.error('Run completion:',error instanceof Error?error.name:'error');});
    return work;
  }
  private launchWithOwner(row:any,writer:ArchiveWriterOwner){
    this.writers.assertOwner(writer,row.id);
    const entry:ActiveRun=this.active.get(row.id)??{projectId:row.project_id,writer};
    if(entry.writer!==writer)throw Error('ARCHIVE_WRITER_OWNER_MISMATCH');
    this.active.set(row.id,entry);
    writer.writerDrained.catch(error=>{entry.drainFailure??=error instanceof Error?error:Error('ARCHIVE_WRITER_DRAIN_FAILED');});
    const original=writer.run(()=>this.launchOwned(row,entry));
    const work=(async()=>{
      let failure:unknown;try{await original;}catch(error){failure=error;}
      writer.finish(entry.drainFailure??failure);
      try{await writer.writerDrained;}catch(error){entry.drainFailure=error instanceof Error?error:Error('ARCHIVE_WRITER_DRAIN_FAILED');}
      if(entry.drainFailure)entry.phase='drain-failed';
      else if(this.active.get(row.id)===entry)this.active.delete(row.id);
      if(failure)throw failure;
    })();entry.work=work;
    work.catch(error=>{if(!this.stopped)console.error('Run completion:',error instanceof Error?error.name:'error');});
    return work;
  }
  private async launchOwned(row:any,entry:ActiveRun){
    let completion:RuntimeCompletion|undefined,runtimeStarted=false;
    try{
      const effectDenial=await lockedRun(this.writers,row.id,async client=>{
        try{await requireResolvedProjectEffectsIn(client,row.project_id);}
        catch(error){if(error instanceof AppError&&error.code==='TOOL_OPERATION_UNRESOLVED')return error;throw error;}
      });
      if(effectDenial)throw effectDenial;
      if(!(await this.runtime.inspect()).ready)throw new AppError(409,'上一运行资源仍在收尾，本次运行尚未启动','RUNTIME_TEARDOWN_PENDING');
      await this.authorizeEffect(row.id,'resume');await assertRunModels(row.snapshot);
      const routes=[];
      for(const route of row.snapshot.modelRoutes){
        const gateway=(await pool.query("SELECT g.credential,g.version,m.data FROM models m JOIN gateways g ON g.id=m.data->>'gatewayId' WHERE m.id=$1 AND g.id=$2",[route.id,route.gatewayId])).rows[0];
        if(!gateway||routeFingerprint(gateway.data,gateway.version)!==route.configurationHash)throw Error('运行快照的模型或中转站配置已变化');routes.push({...route,apiKey:gateway.credential?unseal(gateway.credential):''});
      }
      if(this.stopped)throw new AppError(409,'工作进程已关闭，任务未启动','WORKER_STOPPED');
      let prepareWorkspace:()=>void;
      if(row.snapshot.executionProfile==='task-attempt-openshell-v1'&&row.snapshot.recovery){
        if(!this.preparedRecovery.has(row.id))throw new AppError(409,'恢复启动尚未重新认证来源','TASK_RECOVERY_RUNTIME_INVALID');
        const prepared=await lockedRun(this.writers,row.id,async(client,current)=>{
          if(!isDeepStrictEqual(current.snapshot,row.snapshot))throw new AppError(409,'恢复快照已变化','TASK_RECOVERY_RUNTIME_INVALID');
          const state=await assertTaskRecoveryRuntime(client,this.traceRoot,current);
          if(!state)throw new AppError(409,'缺少完整恢复状态','TASK_RECOVERY_RUNTIME_INVALID');
          return {row:current,state};
        });
        if(!prepared)throw new AppError(409,'恢复运行不存在','TASK_RECOVERY_RUNTIME_INVALID');
        prepareWorkspace=()=>{
          materializeCommittedCanonical({traceRoot:this.traceRoot,writers:this.writers},prepared.row);
          return {kind:'task-recovery-initialized' as const,runId:row.id,initializationDigest:prepared.state.initialization.digest,currentRevision:prepared.state.currentCanonical.ref.revision};
        };
      }
      else if(row.snapshot.recovery?.workspaceCheckpoint)prepareWorkspace=()=>restoreStepWorkspace(this.traceRoot,row.snapshot.recovery.workspaceCheckpoint,join(this.traceRoot,row.id,'artifacts'));
      else {
        const parent=row.parent_run_id&&row.snapshot.approval?.kind!=='retry'?(await pool.query('SELECT * FROM project_runs WHERE id=$1',[row.parent_run_id])).rows[0]:undefined;
        const canonical=parent?await readLiveCanonical(pool,this.traceRoot,parent,readRun(this.traceRoot,parent.id)):undefined;
        prepareWorkspace=()=>prepareImportedWorkspace(this.traceRoot,row.id,row.snapshot.importedFiles??[],row.parent_run_id,row.snapshot.approval?.kind,canonical);
      }
      const started=await this.runtime.start({runId:row.id,approvedSnapshot:row.snapshot,routes,prepareWorkspace});runtimeStarted=true;
      if(!(started.writerDrained instanceof Promise)){
        entry.drainFailure=Object.assign(Error('RUNTIME_WRITER_DRAIN_UNPROVEN'),{code:'RUNTIME_WRITER_DRAIN_UNPROVEN'});
      }else{
        entry.writerDrained=started.writerDrained;
        started.writerDrained.catch(()=>{});
      }
      try{completion=await started.completion;}finally{entry.phase='draining';entry.writer.closeAdmission();}
      for(const usage of completion.usages)await this.recordUsage(row.id,usage);
      await finishRun(this.writers,row.id,this.owner,completion.status,completion.recording==='incomplete'?acceptedRecordingPending:completion.message??null);
    }catch(error){
      if(completion?.status==='completed'){
        entry.drainFailure??=error instanceof Error?error:Error('ARCHIVE_WRITER_DRAIN_FAILED');
        return;
      }
      if(entry.drainFailure)return;
      if(!runtimeStarted&&(error as any)?.code==='RUNTIME_TEARDOWN_PENDING'){
        await deferUnstartedRun(this.writers,row.id,this.owner,{projectId:row.project_id,projectVersion:row.project_version,attempt:row.attempt});
        return;
      }
      const message=error instanceof Error?error.message:'启动失败';
      await finishRun(this.writers,row.id,this.owner,'failed',message,record=>this.traceFinished(record,'failed',message));
    }finally{
      this.preparedRecovery.delete(row.id);
      entry.phase='draining';entry.writer.closeAdmission();
      try{await entry.writerDrained;}catch(error){
        const code=(error as any)?.code==='RUNTIME_WRITER_DRAIN_UNPROVEN'?'RUNTIME_WRITER_DRAIN_UNPROVEN':'RUNTIME_WRITER_DRAIN_FAILED';
        entry.drainFailure??=Object.assign(Error(code),{code});
      }
    }
  }
  async cancel(id:string,authorize?:(db:import('pg').PoolClient,row:any)=>Promise<void>){
    const denial=await this.writers.withWriter([id],()=>this.cancelRequest(id,authorize));
    if(denial)throw denial.denied;
  }
  private async cancelRequest(id:string,authorize?:(db:import('pg').PoolClient,row:any)=>Promise<void>){
    const client=await pool.connect();
    let authorizationDenial:AppError|undefined,discard=false;
    const deny=async(denied:AppError)=>{await client.query('ROLLBACK');return {denied};};
    try{await client.query('BEGIN');const identity=(await client.query('SELECT project_id FROM project_runs WHERE id=$1',[id])).rows[0];if(!identity)return await deny(new AppError(404,'运行不存在'));
      await client.query('SELECT id FROM projects WHERE id=$1 FOR UPDATE',[identity.project_id]);
      const row=(await client.query('SELECT * FROM project_runs WHERE id=$1 FOR UPDATE',[id])).rows[0];if(!row)return await deny(new AppError(404,'运行不存在'));if(!['running','queued'].includes(row.status))return await deny(new AppError(409,'运行已结束'));
      try{await authorize?.(client,row);}catch(error){
        if(error instanceof AppError&&[401,403,404].includes(error.status))authorizationDenial=error;
        throw error;
      }
      if(row.status==='queued'){await client.query("UPDATE project_runs SET status='cancelled',cancel_requested=true,finished_at=now() WHERE id=$1",[id]);await client.query("UPDATE projects SET status='CANCELLED' WHERE id=$1 AND version=$2",[row.project_id,row.project_version]);}
      else await client.query('UPDATE project_runs SET cancel_requested=true WHERE id=$1',[id]);await client.query('COMMIT');
    }catch(e){
      try{await client.query('ROLLBACK');}catch{discard=true;throw e;}
      // Only an authorization denial before mutation, with a proven rollback,
      // may leave the writer scope as a private outcome. Uncertain failures latch.
      if(authorizationDenial&&e===authorizationDenial)return {denied:authorizationDenial};
      throw e;
    }finally{client.release(discard);}
    const entry=this.active.get(id);if(entry&&(!entry.phase||entry.phase==='executing'))await this.cancelOwned(id,entry);
  }
  private cancelOwned(id:string,entry:ActiveRun){
    if(entry.drainFailure)return Promise.resolve();
    const producer=entry.writer.retain('runtime cancellation');
    const work=producer.run(()=>this.runtime.cancel(id));
    work.then(()=>producer.finish(),error=>producer.finish(error));return work;
  }
  close(){
    if(!this.closing){
      this.stopped=true;clearInterval(this.timer);this.timer=undefined;
      this.closing=(async()=>{
        const cancellations=[...this.active].filter(([,entry])=>!entry.phase||entry.phase==='executing').map(([id,entry])=>this.cancelOwned(id,entry));
        const results=await Promise.allSettled(cancellations);
        while(this.ticking)await sleep(50);
        await this.heartbeatWork;
        const work=await Promise.allSettled([...this.active.values()].map(entry=>entry.work));
        const failure=[...this.active.values()].find(entry=>entry.drainFailure)?.drainFailure;
        if(failure)throw failure;
        const rejected=[...results,...work].find(result=>result.status==='rejected');
        if(rejected?.status==='rejected')throw rejected.reason;
      })();
      this.closing.catch(()=>{});
    }
    return this.closing;
  }
}
