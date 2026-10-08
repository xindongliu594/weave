import {claimExpiredRun,finishRun,terminalStatus} from './run-state.ts';
import {assertRunAuthorization} from './execution-policy.ts';
import { executeBrowserMcpTool } from './work-tools-browser.ts';
import { randomUUID } from 'node:crypto';
import { prepareImportedWorkspace } from './work-files.ts';
import { pool } from './db.ts';
import { unseal } from './vault.ts';
import { AppError } from './provider.ts';
import { ProductDshRuntime } from '../../../services/agent-runtime/product-runtime.mjs';
import { readRun, createRunArchive, openRunArchive } from '../../../services/agent-runtime/trace-store.mjs';
import { command } from '../../../services/agent-runtime/sandbox.mjs';
import { queryKnowledge } from './knowledge-store.ts';
import { reserveCall,settleCall,markCallUncertain,expireReservations,recordProviderResponse } from './cost-control.ts';
import { settings } from './product.ts';
import { assertRunModels,routeFingerprint } from './model-capabilities.ts';
import type { RuntimeUsage } from '../../../services/agent-runtime/openai-compatible.mjs';
import {LocalOperationService,LocalRunExecutor} from './local-execution.ts';
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
type Heartbeat={ids:string[];held:string[]};
async function heartbeatForCaller(work:Promise<Heartbeat>,signal?:AbortSignal){
  signal?.throwIfAborted();if(!signal)return work;
  let abort:()=>void;const cancelled=new Promise<never>((_resolve,reject)=>{abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true});});
  try{return await Promise.race([work,cancelled]);}finally{signal.removeEventListener('abort',abort!);}
}
export class RunCoordinator {
  owner=randomUUID(); runtime:ProductDshRuntime; active=new Map<string,{projectId:string}>(); ticking=false; stopped=false; timer:NodeJS.Timeout;heartbeatWork?:Promise<Heartbeat>;
  constructor(public traceRoot:string,createExecutor?:ConstructorParameters<typeof ProductDshRuntime>[0]['createExecutor']){
    const local=new LocalOperationService(traceRoot,this.owner);
    this.runtime=new ProductDshRuntime({traceRoot,queryKnowledge,externalTool:executeBrowserMcpTool,createExecutor:(archive,snapshot)=>createExecutor?.(archive,snapshot)??(snapshot.executionTarget?.kind==='local'?new LocalRunExecutor(archive,snapshot,local):undefined),onUsage:(id,u)=>this.recordUsage(id,u),requestApproval:(input,signal)=>this.approveTool(input,signal),beforeRequest:(id,data,signal)=>this.reserve(id,data,signal),onResponse:data=>recordProviderResponse(data.id,data),onCallError:async data=>{await recordProviderResponse(data.id,data);await markCallUncertain(data.id,data.code,data.dispatched);}});
    this.timer=setInterval(()=>{void this.heartbeat().catch(e=>{if(!this.stopped)console.error('Run heartbeat:',e instanceof Error?e.name:'error');});void this.tick();},1000);this.timer.unref();void this.tick();
  }
  async heartbeat(){
    if(this.stopped)return {ids:[],held:[]};if(this.heartbeatWork)return this.heartbeatWork;
    const ids=[...this.active.keys()];if(!ids.length)return {ids,held:[]};
    this.heartbeatWork=(async()=>{
      const held=(await pool.query("UPDATE project_runs SET lease_until=clock_timestamp()+interval '30 seconds' WHERE id=ANY($1::text[]) AND lease_owner=$2 AND status='running' RETURNING id",[ids,this.owner])).rows.map(r=>r.id);
      // Cancellation may wait for model settlement; it must not hold the shared
      // heartbeat promise that an admission callback itself is awaiting.
      for(const id of ids)if(!held.includes(id))void this.runtime.cancel(id).catch(e=>{if(!this.stopped)console.error('Run lease cancellation:',e instanceof Error?e.name:'error');});
      return {ids,held};
    })();
    try{return await this.heartbeatWork;}finally{this.heartbeatWork=undefined;}
  }
  async recordUsage(runId:string,u:RuntimeUsage){
    if((await pool.query('SELECT id FROM model_reservations WHERE id=$1',[u.id])).rowCount){await settleCall(u.id,u.inputTokens,u.outputTokens,u);return;}
    const run=(await pool.query('SELECT snapshot FROM project_runs WHERE id=$1',[runId])).rows[0];
    const agent=run?.snapshot?.agents?.find((item:any)=>item.id===u.agentId||item.employeeId===u.employeeId);
    const departmentId=agent?.sourceDepartmentId??run?.snapshot?.departmentId??null;
    await pool.query(`INSERT INTO usage(id,model_id,project_id,department_id,run_id,input_tokens,output_tokens,cost,purpose,agent_id,employee_id,session_id,task_id,attempt_id,request_id,duration_ms)
      SELECT $1,$2,project_id,$7,id,$3,$4,$5,$15,$8,$9,$10,$11,$12,$13,$14 FROM project_runs WHERE id=$6 ON CONFLICT(id) DO NOTHING`,[u.id,u.modelId,u.inputTokens,u.outputTokens,u.cost,runId,departmentId,u.agentId??null,u.employeeId??null,u.sessionId??null,u.taskId??null,u.attemptId??null,u.requestId??null,u.durationMs??null,u.requestPurpose==='compaction'?'上下文摘要':'项目执行']);
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
    await reserveCall({id:data.id,model,amount:data.reservation,purpose:data.requestPurpose==='compaction'?'上下文摘要':'项目执行',projectId:run.project_id,runId,leaseOwner:this.owner,billingDepartmentId,signal,authorize:async(db,row)=>{await assertRunModels(row.snapshot,db);await assertRunAuthorization(row,db);},context:{agentId:data.agentId,employeeId:data.employeeId,sourceDepartmentId:billingDepartmentId,sourceAgentId:agent.sourceAgentId,sessionId:data.sessionId,taskId:data.taskId,runtimeTaskId:data.runtimeTaskId,reworkRound:data.reworkRound,attemptId:data.attemptId,requestId:data.requestId,requestPurpose:data.requestPurpose}});
  }
  async approveTool(input:any,signal?:AbortSignal){
    signal?.throwIfAborted();const id=randomUUID();
    await pool.query('INSERT INTO tool_approvals(id,run_id,agent_id,tool,arguments) VALUES($1,$2,$3,$4,$5)',[id,input.runId,input.agentId,input.tool,input.arguments]);
    openRunArchive(this.traceRoot,input.runId).append('approval/requested',{id,...input});
    try{while(true){signal?.throwIfAborted();const row=(await pool.query('SELECT status FROM tool_approvals WHERE id=$1',[id])).rows[0];if(row?.status==='approved')return id;if(row?.status!=='pending')throw Error('工具操作未获批准');await sleep(500);}}
    finally{await pool.query("UPDATE tool_approvals SET status='cancelled',decided_at=now() WHERE id=$1 AND status='pending'",[id]);}
  }
  async recover(){
    await expireReservations();
    const stale=(await pool.query("SELECT id FROM project_runs WHERE status='running' AND (lease_until IS NULL OR lease_until<clock_timestamp())")).rows;
    for(const candidate of stale){
      // Recheck under the existing project/run locks. An event-loop or pool
      // stall cannot turn this coordinator's still-active job into a dead one.
      const row=await claimExpiredRun(candidate.id,current=>current.lease_owner===this.owner&&this.active.has(current.id));if(!row)continue;
      await pool.query("UPDATE local_operations SET status='cancelled',finished_at=now() WHERE run_id=$1 AND status IN ('queued','claimed','started')",[row.id]);
      if(row.snapshot.executionTarget?.kind!=='local'&&/^[a-f0-9-]{36}$/.test(row.id))try{await command(['rm','-f','agent-department-'+row.id],{signal:AbortSignal.timeout(5000)});}catch{}
      const archived=readRun(this.traceRoot,row.id);
      if(archived?.integrity==='ok'){
        for(const event of archived.events.filter(e=>e.type==='billing/usage'))await this.recordUsage(row.id,event.data);
        const finished=archived.events.findLast(e=>e.type==='run/finished');
        if(finished&&terminalStatus(finished.data.status)){await finishRun(row.id,row.lease_owner,finished.data.status,finished.data.message??null);continue;}
      }
      await finishRun(row.id,row.lease_owner,'interrupted','运行进程中断，请检查记录后恢复',record=>this.traceFinished(record,'interrupted','服务租约过期，运行已停止；可从已记录的任务结果恢复。'));
    }
  }
  traceFinished(row:any,status:string,message:string){
    try{const existing=readRun(this.traceRoot,row.id);const archive=existing?openRunArchive(this.traceRoot,row.id):createRunArchive(this.traceRoot,row.snapshot,{id:row.id});archive.append('run/finished',{status,message});}catch{}
  }

  async tick(){
    if(this.ticking||this.stopped)return;this.ticking=true;
    try{
      // Heartbeats precede recovery. A dead worker eventually loses its lease.
      await this.heartbeat();
      const cancel=(await pool.query("SELECT id FROM project_runs WHERE lease_owner=$1 AND cancel_requested=true AND status='running'",[this.owner])).rows;
      for(const row of cancel)await this.runtime.cancel(row.id);
      await this.recover();
      if(this.stopped)return;
      const client=await pool.connect();let job:any;
      try{
        await client.query('BEGIN');
        if(!(await client.query('SELECT pg_try_advisory_xact_lock(918274) AS locked')).rows[0].locked){await client.query('ROLLBACK');return;}
        const limit=(await settings(client)).data.maxActiveRuns;
        const count=Number((await client.query("SELECT count(*) FROM project_runs WHERE status='running'")).rows[0].count);
        if(count<limit&&!this.stopped){
          const candidate=(await client.query(`SELECT r.id,r.project_id FROM project_runs r WHERE r.status='queued' AND NOT r.cancel_requested
            AND NOT EXISTS(SELECT 1 FROM project_runs a WHERE a.status='running' AND
              COALESCE(NULLIF(a.department_ids,'{}'),ARRAY[a.snapshot->>'departmentId']) && COALESCE(NULLIF(r.department_ids,'{}'),ARRAY[r.snapshot->>'departmentId']))
            ORDER BY r.created_at LIMIT 1`)).rows[0];
          // All operations lock project before run; skip an in-flight edit instead of inverting that order.
          if(candidate&&(await client.query('SELECT id FROM projects WHERE id=$1 FOR UPDATE SKIP LOCKED',[candidate.project_id])).rowCount)
            job=(await client.query("SELECT * FROM project_runs WHERE id=$1 AND status='queued' AND NOT cancel_requested FOR UPDATE SKIP LOCKED",[candidate.id])).rows[0];
          if(job){await client.query("UPDATE project_runs SET status='running',lease_owner=$1,lease_until=clock_timestamp()+interval '30 seconds',started_at=now() WHERE id=$2",[this.owner,job.id]);await client.query("UPDATE projects SET status='RUNNING' WHERE id=$1 AND version=$2",[job.project_id,job.project_version]);}
        }
        await client.query('COMMIT');
      }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
      if(job&&this.stopped){await finishRun(job.id,this.owner,'interrupted','工作进程关闭，任务尚未启动',row=>this.traceFinished(row,'interrupted','工作进程关闭，任务尚未启动'));return;}
      if(job){this.active.set(job.id,{projectId:job.project_id});void this.launch(job);}
    }catch(e){if(!this.stopped)console.error('Run worker:',e instanceof Error?e.name:'error');}finally{this.ticking=false;}
  }
  async launch(row:any){
    try{
      await assertRunAuthorization(row);await assertRunModels(row.snapshot);
      const routes=[];
      for(const route of row.snapshot.modelRoutes){
        const gateway=(await pool.query("SELECT g.credential,g.version,m.data FROM models m JOIN gateways g ON g.id=m.data->>'gatewayId' WHERE m.id=$1 AND g.id=$2",[route.id,route.gatewayId])).rows[0];
        if(!gateway||routeFingerprint(gateway.data,gateway.version)!==route.configurationHash)throw Error('运行快照的模型或中转站配置已变化');routes.push({...route,apiKey:gateway.credential?unseal(gateway.credential):''});
      }
      if(this.stopped)throw new AppError(409,'工作进程已关闭，任务未启动','WORKER_STOPPED');
      prepareImportedWorkspace(this.traceRoot,row.id,row.snapshot.importedFiles??[],row.parent_run_id,row.snapshot.approval?.kind);
      const started=await this.runtime.start({runId:row.id,approvedSnapshot:row.snapshot,routes});
      const result=await started.completion;
      for(const usage of result.usages)await this.recordUsage(row.id,usage);
      await finishRun(row.id,this.owner,result.status,result.message??null);
    }catch(error){
      const message=error instanceof Error?error.message:'启动失败';
      await finishRun(row.id,this.owner,'failed',message,record=>this.traceFinished(record,'failed',message));
    }finally{this.active.delete(row.id);}
  }
  async cancel(id:string){
    const client=await pool.connect();
    try{await client.query('BEGIN');const identity=(await client.query('SELECT project_id FROM project_runs WHERE id=$1',[id])).rows[0];if(!identity)throw new AppError(404,'运行不存在');
      await client.query('SELECT id FROM projects WHERE id=$1 FOR UPDATE',[identity.project_id]);
      const row=(await client.query('SELECT * FROM project_runs WHERE id=$1 FOR UPDATE',[id])).rows[0];if(!row)throw new AppError(404,'运行不存在');if(!['running','queued'].includes(row.status))throw new AppError(409,'运行已结束');
      if(row.status==='queued'){await client.query("UPDATE project_runs SET status='cancelled',cancel_requested=true,finished_at=now() WHERE id=$1",[id]);await client.query("UPDATE projects SET status='CANCELLED' WHERE id=$1 AND version=$2",[row.project_id,row.project_version]);}
      else await client.query('UPDATE project_runs SET cancel_requested=true WHERE id=$1',[id]);await client.query('COMMIT');
    }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
    await this.runtime.cancel(id);
  }
  async close(){this.stopped=true;clearInterval(this.timer);await Promise.all([...this.active.keys()].map(id=>this.runtime.cancel(id)));while(this.active.size||this.ticking||this.heartbeatWork)await sleep(50);}
}
