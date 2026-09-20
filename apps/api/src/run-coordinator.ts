import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { cpSync, existsSync } from 'node:fs';
import { pool } from './db.ts';
import { unseal } from './vault.ts';
import { AppError } from './provider.ts';
import { ProductDshRuntime } from '../../../services/agent-runtime/product-runtime.mjs';
import { readRun, createRunArchive, openRunArchive } from '../../../services/agent-runtime/trace-store.mjs';
import { command } from '../../../services/agent-runtime/sandbox.mjs';
import { queryKnowledge } from './knowledge-store.ts';
import { reserveCall,settleCall,markCallUncertain,expireReservations } from './cost-control.ts';
import { settings } from './product.ts';
import { assertRunModels,routeFingerprint } from './model-capabilities.ts';
import type { RuntimeUsage } from '../../../services/agent-runtime/openai-compatible.mjs';
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
export class RunCoordinator {
  owner=randomUUID(); runtime:ProductDshRuntime; active=new Map<string,{projectId:string}>(); ticking=false; stopped=false; timer:NodeJS.Timeout;
  constructor(public traceRoot:string){
    this.runtime=new ProductDshRuntime({traceRoot,queryKnowledge,onUsage:(id,u)=>this.recordUsage(id,u),requestApproval:(input,signal)=>this.approveTool(input,signal),beforeRequest:(id,data)=>this.reserve(id,data),onCallError:data=>markCallUncertain(data.id,data.code,data.dispatched)});
    this.timer=setInterval(()=>void this.tick(),1000);this.timer.unref();void this.tick();
  }
  async recordUsage(runId:string,u:RuntimeUsage){
    if((await pool.query('SELECT id FROM model_reservations WHERE id=$1',[u.id])).rowCount){await settleCall(u.id,u.inputTokens,u.outputTokens,u);return;}
    await pool.query(`INSERT INTO usage(id,model_id,project_id,run_id,input_tokens,output_tokens,cost,purpose,agent_id,employee_id,session_id,task_id,attempt_id,request_id,duration_ms)
      SELECT $1,$2,project_id,id,$3,$4,$5,'项目执行',$7,$8,$9,$10,$11,$12,$13 FROM project_runs WHERE id=$6 ON CONFLICT(id) DO NOTHING`,[u.id,u.modelId,u.inputTokens,u.outputTokens,u.cost,runId,u.agentId??null,u.employeeId??null,u.sessionId??null,u.taskId??null,u.attemptId??null,u.requestId??null,u.durationMs??null]);
  }
  async reserve(runId:string,data:any){
    const run=(await pool.query('SELECT project_id,snapshot FROM project_runs WHERE id=$1 AND lease_owner=$2',[runId,this.owner])).rows[0];
    if(!run)throw new AppError(409,'工作进程已失去运行租约');
    await assertRunModels(run.snapshot);
    const model=run.snapshot.modelRoutes.find((m:any)=>m.id===data.modelId);if(!model)throw new AppError(422,'模型不属于批准快照');
    await reserveCall({id:data.id,model,amount:data.reservation,purpose:'项目执行',projectId:run.project_id,runId,context:{agentId:data.agentId,employeeId:data.employeeId,sessionId:data.sessionId,taskId:data.taskId,attemptId:data.attemptId,requestId:data.requestId}});
  }
  async approveTool(input:any,signal?:AbortSignal){
    signal?.throwIfAborted();const id=randomUUID();
    await pool.query('INSERT INTO tool_approvals(id,run_id,agent_id,tool,arguments) VALUES($1,$2,$3,$4,$5)',[id,input.runId,input.agentId,input.tool,input.arguments]);
    openRunArchive(this.traceRoot,input.runId).append('approval/requested',{id,...input});
    try{while(true){signal?.throwIfAborted();const row=(await pool.query('SELECT status FROM tool_approvals WHERE id=$1',[id])).rows[0];if(row?.status==='approved')return;if(row?.status!=='pending')throw Error('工具操作未获批准');await sleep(500);}}
    finally{await pool.query("UPDATE tool_approvals SET status='cancelled',decided_at=now() WHERE id=$1 AND status='pending'",[id]);}
  }
  async recover(){
    await expireReservations();
    const stale=(await pool.query("UPDATE project_runs SET status='interrupted',error='运行进程中断，请检查记录后恢复',lease_owner=NULL,lease_until=NULL,finished_at=now() WHERE status='running' AND (lease_until IS NULL OR lease_until<now()) RETURNING *")).rows;
    for(const row of stale){
      if(/^[a-f0-9-]{36}$/.test(row.id))try{await command(['rm','-f','agent-department-'+row.id],{signal:AbortSignal.timeout(5000)});}catch{}
      const archived=readRun(this.traceRoot,row.id);
      if(archived?.integrity==='ok'){
        for(const event of archived.events.filter(e=>e.type==='billing/usage'))await this.recordUsage(row.id,event.data);
        const finished=archived.events.findLast(e=>e.type==='run/finished');
        if(finished){await pool.query('UPDATE project_runs SET status=$1,error=$2 WHERE id=$3',[finished.data.status,finished.data.message??null,row.id]);await pool.query('UPDATE projects SET status=$1 WHERE id=$2 AND version=$3',[finished.data.status.toUpperCase(),row.project_id,row.project_version]);continue;}
        openRunArchive(this.traceRoot,row.id).append('run/finished',{status:'interrupted',message:'服务租约过期，运行已停止；可从已记录的任务结果恢复。'});
      }
      await pool.query("UPDATE tool_approvals SET status='cancelled',decided_at=now() WHERE run_id=$1 AND status='pending'",[row.id]);
      await pool.query("UPDATE projects SET status='INTERRUPTED' WHERE id=$1 AND version=$2",[row.project_id,row.project_version]);
    }
  }
  async tick(){
    if(this.ticking||this.stopped)return;this.ticking=true;
    try{
      // Heartbeats precede recovery. A dead worker eventually loses its lease.
      if(this.active.size){const held=(await pool.query("UPDATE project_runs SET lease_until=now()+interval '30 seconds' WHERE id=ANY($1::text[]) AND lease_owner=$2 AND status='running' RETURNING id",[[...this.active.keys()],this.owner])).rows.map(r=>r.id);for(const id of this.active.keys())if(!held.includes(id))await this.runtime.cancel(id);}
      const cancel=(await pool.query("SELECT id FROM project_runs WHERE lease_owner=$1 AND cancel_requested=true AND status='running'",[this.owner])).rows;
      for(const row of cancel)await this.runtime.cancel(row.id);
      await this.recover();
      const client=await pool.connect();let job:any;
      try{
        await client.query('BEGIN');
        if(!(await client.query('SELECT pg_try_advisory_xact_lock(918274) AS locked')).rows[0].locked){await client.query('ROLLBACK');return;}
        const limit=(await settings()).data.maxActiveRuns;
        const count=Number((await client.query("SELECT count(*) FROM project_runs WHERE status='running'")).rows[0].count);
        if(count<limit){
          job=(await client.query(`SELECT r.* FROM project_runs r WHERE r.status='queued' AND NOT r.cancel_requested
            AND NOT EXISTS(SELECT 1 FROM project_runs a WHERE a.status='running' AND a.snapshot->>'departmentId'=r.snapshot->>'departmentId')
            ORDER BY r.created_at FOR UPDATE OF r SKIP LOCKED LIMIT 1`)).rows[0];
          if(job){await client.query("UPDATE project_runs SET status='running',lease_owner=$1,lease_until=now()+interval '30 seconds',started_at=now() WHERE id=$2",[this.owner,job.id]);await client.query("UPDATE projects SET status='RUNNING' WHERE id=$1 AND version=$2",[job.project_id,job.project_version]);}
        }
        await client.query('COMMIT');
      }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
      if(job){this.active.set(job.id,{projectId:job.project_id});void this.launch(job);}
    }catch(e){if(!this.stopped)console.error('Run worker:',e instanceof Error?e.name:'error');}finally{this.ticking=false;}
  }
  async launch(row:any){
    try{
      await assertRunModels(row.snapshot);
      const routes=[];
      for(const route of row.snapshot.modelRoutes){
        const gateway=(await pool.query("SELECT g.credential,g.version,m.data FROM models m JOIN gateways g ON g.id=m.data->>'gatewayId' WHERE m.id=$1 AND g.id=$2",[route.id,route.gatewayId])).rows[0];
        if(!gateway||routeFingerprint(gateway.data,gateway.version)!==route.configurationHash)throw Error('运行快照的模型或中转站配置已变化');routes.push({...route,apiKey:gateway.credential?unseal(gateway.credential):''});
      }
      if(row.parent_run_id&&existsSync(join(this.traceRoot,row.parent_run_id,'artifacts')))cpSync(join(this.traceRoot,row.parent_run_id,'artifacts'),join(this.traceRoot,row.id,'artifacts'),{recursive:true});
      const started=await this.runtime.start({runId:row.id,approvedSnapshot:row.snapshot,routes});
      const result=await started.completion;
      for(const usage of result.usages)await this.recordUsage(row.id,usage);
      const updated=await pool.query('UPDATE project_runs SET status=$1,error=$2,finished_at=now(),lease_owner=NULL,lease_until=NULL WHERE id=$3 AND lease_owner=$4',[result.status,result.message??null,row.id,this.owner]);
      if(updated.rowCount)await pool.query('UPDATE projects SET status=$1 WHERE id=$2 AND version=$3',[result.status.toUpperCase(),row.project_id,row.project_version]);
    }catch(error){
      if(!(await pool.query("SELECT id FROM project_runs WHERE id=$1 AND lease_owner=$2 AND status='running'",[row.id,this.owner])).rowCount)return;
      const message=error instanceof Error?error.message:'启动失败';
      try{const existing=readRun(this.traceRoot,row.id);const archive=existing?openRunArchive(this.traceRoot,row.id):createRunArchive(this.traceRoot,row.snapshot,{id:row.id});archive.append('run/finished',{status:'failed',message});}catch{}
      await pool.query("UPDATE project_runs SET status='failed',error=$1,finished_at=now(),lease_owner=NULL,lease_until=NULL WHERE id=$2 AND lease_owner=$3",[message,row.id,this.owner]);
      await pool.query("UPDATE projects SET status='FAILED' WHERE id=$1 AND version=$2",[row.project_id,row.project_version]);
    }finally{this.active.delete(row.id);}
  }
  async cancel(id:string){
    const client=await pool.connect();
    try{await client.query('BEGIN');const row=(await client.query('SELECT * FROM project_runs WHERE id=$1 FOR UPDATE',[id])).rows[0];if(!row)throw new AppError(404,'运行不存在');if(!['running','queued'].includes(row.status))throw new AppError(409,'运行已结束');
      if(row.status==='queued'){await client.query("UPDATE project_runs SET status='cancelled',cancel_requested=true,finished_at=now() WHERE id=$1",[id]);await client.query("UPDATE projects SET status='CANCELLED' WHERE id=$1 AND version=$2",[row.project_id,row.project_version]);}
      else await client.query('UPDATE project_runs SET cancel_requested=true WHERE id=$1',[id]);await client.query('COMMIT');
    }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
    await this.runtime.cancel(id);
  }
  async close(){this.stopped=true;clearInterval(this.timer);await Promise.all([...this.active.keys()].map(id=>this.runtime.cancel(id)));while(this.active.size||this.ticking)await sleep(50);}
}
