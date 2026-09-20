import type pg from 'pg';
import { randomUUID } from 'node:crypto';
import { pool } from './db.ts';
import { AppError,complete,type ChatMessage,type CompletionOptions } from './provider.ts';
import type { Model } from '../../../packages/contracts/index.ts';
type Database=Pick<pg.PoolClient,'query'>;
const today="date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'";
const open="status IN ('pending','uncertain')";
const greater=(a:number,b:number)=>a-b>Number.EPSILON*Math.max(Math.abs(a),Math.abs(b))*8;
export async function shareCostMaintenance(db:Database){await db.query('SELECT pg_advisory_xact_lock_shared(918275)');}

export async function expireReservations(db:Database=pool) {
 await db.query("UPDATE model_capability_tests SET status='interrupted',code='PROBE_INTERRUPTED',finished_at=now() WHERE status='running' AND created_at<now()-interval '6 minutes'");
 await db.query(`UPDATE model_reservations SET status='uncertain',history=history||jsonb_build_array(jsonb_build_object('at',now(),'source','timeout','note','请求租约过期，费用待核对')) WHERE status='pending' AND expires_at<now()`);
}

/** Callers acquire the project row first (if any), then this global admission lock. */
export async function lockCostPolicy(db:Database) {
 return (await db.query('SELECT data FROM product_settings WHERE id=1 FOR UPDATE')).rows[0].data;
}

export async function dailyTotals(db:Database,departmentId:string|null=null) {
 const spent=Number((await db.query(`SELECT COALESCE(sum(u.cost),0) AS n FROM usage u LEFT JOIN projects p ON p.id=u.project_id
   WHERE u.created_at>=${today} AND ($1::text IS NULL OR p.department_id=$1)`,[departmentId])).rows[0].n);
 const runs=Number((await db.query(`SELECT COALESCE(sum(GREATEST(0,(r.snapshot->>'executionBudget')::numeric-
   COALESCE((SELECT sum(u.cost) FROM usage u WHERE u.run_id=r.id),0))),0) AS n FROM project_runs r
   WHERE r.status IN ('queued','running') AND ($1::text IS NULL OR r.snapshot->>'departmentId'=$1)`,[departmentId])).rows[0].n);
 // Calls inside a live run are already covered by that run's remaining reservation.
 const calls=Number((await db.query(`SELECT COALESCE(sum(c.amount),0) AS n FROM model_reservations c WHERE c.${open}
   AND ($1::text IS NULL OR c.department_id=$1) AND NOT EXISTS(SELECT 1 FROM project_runs r WHERE r.id=c.run_id AND r.status IN ('queued','running'))`,[departmentId])).rows[0].n);
 return {spent,reserved:runs+calls};
}

export async function checkDailyBudget(db:Database,config:any,departmentId:string|null,additional:number) {
 const global=await dailyTotals(db);
 if(greater(global.spent+global.reserved+additional,Number(config.dailyBudgetLimit)))throw new AppError(422,'已确认费用和未结算预留将超过全局每日预算（UTC）','DAILY_BUDGET_EXCEEDED');
 if(departmentId){
  const department=(await db.query('SELECT data FROM departments WHERE id=$1',[departmentId])).rows[0];
  if(!department)throw new AppError(404,'部门不存在');
  if(department.data.dailyBudget!==undefined){
   const local=await dailyTotals(db,departmentId);
   if(greater(local.spent+local.reserved+additional,Number(department.data.dailyBudget)))throw new AppError(422,'已确认费用和未结算预留将超过部门每日预算（UTC）','DEPARTMENT_DAILY_BUDGET_EXCEEDED');
  }
 }
}

export async function requireProjectCostReady(db:Database,projectId:string) {
 if((await db.query(`SELECT id FROM model_reservations WHERE project_id=$1 AND ${open} LIMIT 1`,[projectId])).rowCount)
  throw new AppError(409,'项目还有进行中或待核对的模型费用，请先等待返回或在设置中核对费用','COST_PENDING');
}

type CallInput={id?:string;model:Pick<Model,'id'|'inputRate'|'outputRate'>;amount:number;purpose:string;projectId?:string;projectVersion?:number;runId?:string;leaseOwner?:string;authorize?:(db:Database,row:any)=>Promise<void>;maxCost?:number;context?:Record<string,any>};
export async function reserveCall(input:CallInput) {
 const id=input.id??randomUUID(),client=await pool.connect();
 try{
  await client.query('BEGIN');
  await shareCostMaintenance(client);
  const project=input.projectId?(await client.query('SELECT * FROM projects WHERE id=$1 FOR UPDATE',[input.projectId])).rows[0]:null;
  if(input.projectId&&!project)throw new AppError(404,'项目不存在');
  if(input.projectVersion!==undefined&&project.version!==input.projectVersion)throw new AppError(409,'方案版本已变化');
  const config=await lockCostPolicy(client);await expireReservations(client);
  if(input.context?.probeId&&!(await client.query("SELECT id FROM model_capability_tests WHERE id=$1 AND status='running' AND created_at>now()-interval '3 minutes' FOR SHARE",[input.context.probeId])).rowCount)throw new AppError(409,'能力测试已中断或超时，请重新开始','PROBE_EXPIRED');
  const existing=(await client.query('SELECT id FROM model_reservations WHERE id=$1',[id])).rows[0];
  if(existing)throw new AppError(409,'该模型请求已创建费用预留');
  if(!Number.isFinite(input.amount)||input.amount<0)throw new AppError(422,'请求预留费用无效');
  if(input.maxCost!==undefined&&greater(input.amount,input.maxCost))throw new AppError(422,'本次模型请求预留超过单次费用上限','CALL_BUDGET_EXCEEDED');
  if(project&&!input.runId){
   await requireProjectCostReady(client,project.id);
   if((await client.query("SELECT id FROM project_runs WHERE project_id=$1 AND status IN ('queued','running')",[project.id])).rowCount)throw new AppError(409,'项目正在执行，暂不能另外调用规划模型');
   const spent=Number((await client.query('SELECT COALESCE(sum(cost),0) AS n FROM usage WHERE project_id=$1',[project.id])).rows[0].n);
   if(greater(spent+input.amount,project.policy.maxBudget))throw new AppError(422,'规划预留超过项目剩余预算','BUDGET_EXCEEDED');
  }
  if(input.runId){
   const run=(await client.query("SELECT * FROM project_runs WHERE id=$1 AND project_id=$2 AND status='running' AND NOT cancel_requested FOR UPDATE",[input.runId,input.projectId])).rows[0];
   if(!run)throw new AppError(409,'运行已停止，不能再发起模型请求');
   if(input.leaseOwner&&(run.lease_owner!==input.leaseOwner||!run.lease_until||new Date(run.lease_until).getTime()<=Date.now()))throw new AppError(409,'工作进程已失去运行租约','LEASE_LOST');
   if(input.authorize)await input.authorize(client,run);
   const committed=Number((await client.query('SELECT COALESCE(sum(cost),0) AS n FROM usage WHERE run_id=$1',[input.runId])).rows[0].n);
   const held=Number((await client.query(`SELECT COALESCE(sum(amount),0) AS n FROM model_reservations WHERE run_id=$1 AND ${open}`,[input.runId])).rows[0].n);
   if(greater(committed+held+input.amount,run.snapshot.executionBudget))throw new AppError(422,'请求与待核对费用超过运行剩余预算','BUDGET_EXCEEDED');
   const task=run.snapshot.tasks.find((t:any)=>t.id===input.context?.taskId);
   if(task){
    const taskCost=Number((await client.query(`SELECT COALESCE(sum(u.cost),0) AS n FROM usage u JOIN project_runs r ON r.id=u.run_id WHERE r.project_id=$1 AND r.project_version=$2 AND u.task_id=$3`,[project.id,run.snapshot.planVersion,task.id])).rows[0].n);
    const taskHeld=Number((await client.query(`SELECT COALESCE(sum(c.amount),0) AS n FROM model_reservations c JOIN project_runs r ON r.id=c.run_id WHERE r.project_id=$1 AND r.project_version=$2 AND c.context->>'taskId'=$3 AND c.${open}`,[project.id,run.snapshot.planVersion,task.id])).rows[0].n);
    if(greater(taskCost+taskHeld+input.amount,task.maxBudget??project.policy.maxBudget))throw new AppError(422,'任务请求与待核对费用超过任务上限','TASK_BUDGET_EXCEEDED');
   }
  }
  await checkDailyBudget(client,config,project?.department_id??null,input.runId?0:input.amount);
  await client.query(`INSERT INTO model_reservations(id,model_id,project_id,department_id,run_id,purpose,amount,input_rate,output_rate,context)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[id,input.model.id,input.projectId??null,project?.department_id??null,input.runId??null,input.purpose,input.amount,input.model.inputRate,input.model.outputRate,input.context??{}]);
  await client.query('COMMIT');return id;
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}

async function receiptTransaction(id:string,work:(db:Database,row:any)=>Promise<any>) {
 // Identity fields never change while a call is pending. Adoption into an organization happens after settlement.
 const client=await pool.connect();
 try{await client.query('BEGIN');await shareCostMaintenance(client);
  const identity=(await client.query('SELECT project_id FROM model_reservations WHERE id=$1',[id])).rows[0];if(!identity)throw new AppError(404,'费用预留不存在');
  if(identity.project_id)await client.query('SELECT id FROM projects WHERE id=$1 FOR UPDATE',[identity.project_id]);await lockCostPolicy(client);
  const row=(await client.query('SELECT * FROM model_reservations WHERE id=$1 FOR UPDATE',[id])).rows[0];if(!row)throw new AppError(404,'费用预留不存在');
  const result=await work(client,row);await client.query('COMMIT');return result;
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}

export async function markCallUncertain(id:string,note:string,dispatched=true) {
 return receiptTransaction(id,async(db,row)=>{
  if(row.status!=='pending')return;
  await db.query("UPDATE model_reservations SET status=$2,history=history||$3::jsonb WHERE id=$1",[id,dispatched?'uncertain':'released',JSON.stringify([{at:new Date().toISOString(),source:'runtime',note}])]);
 });
}

export async function settleCall(id:string,inputTokens:number,outputTokens:number,metadata:any={},manualNote?:string) {
 return receiptTransaction(id,async(db,row)=>{
  if(manualNote!==undefined&&row.status!=='uncertain')throw new AppError(409,'仅能核对待确认的费用，请刷新');
  const cost=(inputTokens*Number(row.input_rate)+outputTokens*Number(row.output_rate))/1e6;
  const last=row.history.at(-1);
  if(manualNote===undefined&&row.status==='settled'&&last?.source==='provider'&&last.inputTokens===inputTokens&&last.outputTokens===outputTokens)return {cost,reserved:Number(row.amount)};
  const context={...row.context,...metadata};
  await db.query(`INSERT INTO usage(id,model_id,project_id,run_id,input_tokens,output_tokens,cost,purpose,agent_id,employee_id,session_id,task_id,attempt_id,request_id,duration_ms)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
    ON CONFLICT(id) DO UPDATE SET input_tokens=EXCLUDED.input_tokens,output_tokens=EXCLUDED.output_tokens,cost=EXCLUDED.cost,duration_ms=EXCLUDED.duration_ms`,
    [id,row.model_id,row.project_id,row.run_id,inputTokens,outputTokens,cost,row.purpose,context.agentId??null,context.employeeId??null,context.sessionId??null,context.taskId??null,context.attemptId??null,context.requestId??null,context.durationMs??null]);
  const entry={at:new Date().toISOString(),source:manualNote===undefined?'provider':'manual',inputTokens,outputTokens,cost,...(manualNote===undefined?{}:{note:manualNote})};
  // A late authoritative receipt can replace an earlier manual reconciliation; the history preserves both.
  await db.query("UPDATE model_reservations SET status='settled',history=history||$2::jsonb WHERE id=$1",[id,JSON.stringify([entry])]);
  return {cost,reserved:Number(row.amount)};
 });
}

export async function completeBudgeted(model:Model,messages:ChatMessage[],maxTokens:number,options:{purpose:string;projectId?:string;projectVersion?:number;maxCost?:number;context?:Record<string,any>},request:CompletionOptions={}) {
 const amount=((Buffer.byteLength(JSON.stringify({messages,...request}))+1024)*model.inputRate+maxTokens*model.outputRate)/1e6;
 const id=await reserveCall({model,amount,...options});
 let received=false;
 try{
  const response=await complete(model,messages,maxTokens,async usage=>{
   const receipt=await settleCall(id,usage.prompt_tokens,usage.completion_tokens);received=true;
   if(greater(receipt.cost,amount))throw new AppError(422,'实际费用超过本次保守预留，已记录用量并停止后续操作','CALL_BUDGET_EXCEEDED');
  },request);
  if(!response.usage)throw new AppError(502,'中转站未返回用量，费用预留保留为待核对','USAGE_MISSING');
  return {...response,usageId:id};
 }catch(error){if(!received)await markCallUncertain(id,error instanceof AppError?error.code:'CALL_INTERRUPTED');throw error;}
}
