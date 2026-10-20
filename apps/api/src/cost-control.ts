import type pg from 'pg';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pool } from './db.ts';
import { AppError,complete,assertCompletionContext,prepareCompletionRequest,type ChatMessage,type CompletionOptions } from './provider.ts';
import type { Model } from '../../../packages/contracts/index.ts';
import {withFreshLocalAdmission} from './local-admission.ts';
import {assertStorageHeadroom} from '../../../services/agent-runtime/storage-governance.mjs';
import {assertGoalContract} from '../../../packages/contracts/goal-contract.mjs';
import {verifiedResourceEdge} from './recovery-resource-plan.ts';
type Database=Pick<pg.PoolClient,'query'>;
const today="date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'";
const open="status IN ('pending','uncertain')";
const greater=(a:number,b:number)=>a-b>Number.EPSILON*Math.max(Math.abs(a),Math.abs(b))*8;
export async function shareCostMaintenance(db:Database){await db.query('SELECT pg_advisory_xact_lock_shared(918275)');}

export async function costMaintenanceTransaction<T>(work:(db:Database)=>Promise<T>):Promise<T>{
 const client=await pool.connect();let discard=false;
 try{
  await client.query('BEGIN');await shareCostMaintenance(client);
  const result=await work(client);await client.query('COMMIT');return result;
 }catch(error){
  try{await client.query('ROLLBACK');}catch{discard=true;}
  throw error;
 }finally{client.release(discard);}
}

export async function expireReservations() {
 await costMaintenanceTransaction(expireReservationsInTransaction);
}

// Only the owning admission/maintenance transaction calls this after its shared gate.
async function expireReservationsInTransaction(db:Database) {
 await db.query("UPDATE model_capability_tests SET status='interrupted',code='PROBE_INTERRUPTED',finished_at=now() WHERE status='running' AND created_at<now()-interval '6 minutes'");
 await db.query(`UPDATE model_reservations SET status='uncertain',history=history||jsonb_build_array(jsonb_build_object('at',now(),'source','timeout','note','请求租约过期，费用待核对')) WHERE status='pending' AND expires_at<now()`);
}

/** Callers acquire the project row first (if any), then this global admission lock. */
export async function lockCostPolicy(db:Database) {
 return (await db.query('SELECT data FROM product_settings WHERE id=1 FOR UPDATE')).rows[0].data;
}

export async function dailyTotals(db:Database,departmentId:string|null=null) {
 const spent=Number((await db.query(`SELECT COALESCE(sum(u.cost),0) AS n FROM usage u LEFT JOIN projects p ON p.id=u.project_id
   WHERE u.created_at>=${today} AND ($1::text IS NULL OR COALESCE(u.department_id,p.department_id)=$1)
   AND NOT EXISTS(SELECT 1 FROM model_reservations conversation WHERE conversation.id=u.id AND conversation.context->>'accountingMode'='conversation')`,[departmentId])).rows[0].n);
 const runs=departmentId===null
  ?Number((await db.query(`SELECT COALESCE(sum(GREATEST(0,(r.snapshot->>'executionBudget')::numeric-
    COALESCE((SELECT sum(u.cost) FROM usage u WHERE u.run_id=r.id),0))),0) AS n FROM project_runs r WHERE r.status IN ('queued','running')`)).rows[0].n)
  :Number((await db.query(`SELECT COALESCE(sum(GREATEST(0,COALESCE((r.snapshot->'departmentBudgets'->>$1)::numeric,
    CASE WHEN r.snapshot->>'departmentId'=$1 THEN (r.snapshot->>'executionBudget')::numeric ELSE 0 END)-
    COALESCE((SELECT sum(u.cost) FROM usage u LEFT JOIN projects p ON p.id=u.project_id WHERE u.run_id=r.id AND COALESCE(u.department_id,p.department_id)=$1),0),
    COALESCE((SELECT sum(c.amount) FROM model_reservations c WHERE c.run_id=r.id AND c.department_id=$1 AND c.${open}),0))),0) AS n
    FROM project_runs r WHERE r.status IN ('queued','running')`,[departmentId])).rows[0].n);
 // A live run covers its global calls. Its department reservation also covers
 // any open calls exceeding that department's estimated share.
 const calls=Number((await db.query(`SELECT COALESCE(sum(c.amount),0) AS n FROM model_reservations c WHERE c.${open}
   AND ($1::text IS NULL OR c.department_id=$1) AND NOT EXISTS(SELECT 1 FROM project_runs r WHERE r.id=c.run_id AND r.status IN ('queued','running'))`,[departmentId])).rows[0].n);
 return {spent,reserved:runs+calls};
}

export async function checkDailyBudget(db:Database,config:any,departmentId:string|null,additional:number,globalAdditional=additional) {
 const global=await dailyTotals(db);
 if(greater(global.spent+global.reserved+globalAdditional,Number(config.dailyBudgetLimit)))throw new AppError(422,'已确认费用和未结算预留将超过全局每日预算（UTC）','DAILY_BUDGET_EXCEEDED');
 if(departmentId){
  const department=(await db.query('SELECT data FROM departments WHERE id=$1',[departmentId])).rows[0];
  if(!department)throw new AppError(404,'部门不存在');
  if(department.data.dailyBudget!==undefined){
   const local=await dailyTotals(db,departmentId);
   if(greater(local.spent+local.reserved+additional,Number(department.data.dailyBudget)))throw new AppError(422,'已确认费用和未结算预留将超过部门每日预算（UTC）','DEPARTMENT_DAILY_BUDGET_EXCEEDED');
  }
 }
}

export type ProjectCostReadiness={recordedCost:number;reserved:number;availableBudget:number;pendingCount:number;uncertainCount:number;receipts:{id:string;amount:number;status:'pending'|'uncertain';runId?:string}[]};
/** One statement gives readers a consistent ledger view without modifying receipts. */
export async function projectCostReadiness(db:Database,projectId:string,maxBudget?:number):Promise<ProjectCostReadiness> {
 const row=(await db.query(`SELECT p.policy->>'maxBudget' AS max_budget,
   (SELECT COALESCE(sum(cost),0) FROM usage WHERE project_id=p.id) AS recorded_cost,
   (SELECT COALESCE(jsonb_agg(jsonb_build_object('id',c.id,'amount',c.amount,'status',c.status,'runId',c.run_id) ORDER BY c.created_at,c.id),'[]'::jsonb)
    FROM model_reservations c WHERE c.project_id=p.id AND c.${open}) AS receipts
   FROM projects p WHERE p.id=$1`,[projectId])).rows[0];
 if(!row)throw new AppError(404,'项目不存在');
 const receipts:ProjectCostReadiness['receipts']=row.receipts.map((receipt:any)=>({id:receipt.id,amount:Number(receipt.amount),status:receipt.status,...(receipt.runId?{runId:receipt.runId}:{})}));
 const recordedCost=Number(row.recorded_cost),reserved=receipts.reduce((total,receipt)=>total+receipt.amount,0);
 return {recordedCost,reserved,availableBudget:(maxBudget??Number(row.max_budget))-recordedCost-reserved,
   pendingCount:receipts.filter(receipt=>receipt.status==='pending').length,uncertainCount:receipts.filter(receipt=>receipt.status==='uncertain').length,receipts};
}

export async function requireProjectCostReady(db:Database,projectId:string,retainUncertainCosts=false,maxBudget?:number) {
 const readiness=await projectCostReadiness(db,projectId,maxBudget);
 if(readiness.pendingCount||(!retainUncertainCosts&&readiness.uncertainCount))
  throw new AppError(409,'项目还有进行中或待核对的模型费用，请先等待返回或在设置中核对费用','COST_PENDING');
 return readiness;
}

export function projectCostCarryover(readiness:ProjectCostReadiness,retained:boolean) {
 return {retained,reserved:readiness.reserved,receipts:readiness.receipts.map(({id,amount,runId})=>({id,amount,...(runId?{runId}:{})})),recordedCost:readiness.recordedCost,availableBudget:readiness.availableBudget};
}

type CallInput={id?:string;model:Pick<Model,'id'|'inputRate'|'outputRate'>;amount:number;purpose:string;projectId?:string;projectVersion?:number;runId?:string;resourcePlanningRunId?:string;leaseOwner?:string;billingDepartmentId?:string;authorize?:(db:Database,row:any)=>Promise<void>;maxCost?:number;context?:Record<string,any>;retainUncertainCosts?:boolean;signal?:AbortSignal;accountingMode?:'conversation'};
export async function reserveCall(input:CallInput) {
 const id=input.id??randomUUID();
 return withFreshLocalAdmission(()=>reserveCallAttempt({...input,id}),input.signal);
}
async function reserveCallAttempt(input:CallInput) {
 try{assertStorageHeadroom(resolve(process.env.TRACE_ROOT??'.data/runs'));}
 catch(error:any){if(error.code==='STORAGE_FREE_LIMIT')throw new AppError(422,error.message,error.code);throw error;}
 const conversation=input.accountingMode==='conversation';
 if(conversation&&(input.purpose!=='组织需求对话'||input.amount!==0||input.projectId!==undefined||input.projectVersion!==undefined||input.runId!==undefined||input.billingDepartmentId!==undefined||input.maxCost!==undefined))throw new AppError(400,'需求对话用量记录不能用于项目预算调用','INVALID_CONVERSATION_ACCOUNTING');
 const id=input.id??randomUUID(),client=await pool.connect();
 try{
  input.signal?.throwIfAborted();
  await client.query('BEGIN');
  await shareCostMaintenance(client);
  const project=input.projectId?(await client.query('SELECT * FROM projects WHERE id=$1 FOR UPDATE',[input.projectId])).rows[0]:null;
  if(input.projectId&&!project)throw new AppError(404,'项目不存在');
  if(input.projectVersion!==undefined&&project.version!==input.projectVersion)throw new AppError(409,'方案版本已变化');
  const config=await lockCostPolicy(client);
  let planningBudget=project?.policy.maxBudget;
  if(input.resourcePlanningRunId!==undefined){
   const invalid=()=>new AppError(409,'资源规划必须使用当前同项目同版本、已停止且已批准的最新运行','RESOURCE_PLANNING_SOURCE_INVALID');
   if(!project||input.runId||input.projectVersion===undefined||input.purpose!=='预算补充规划'||conversation)throw invalid();
   const source=(await client.query(`SELECT r.*,p.snapshot AS parent_snapshot FROM project_runs r LEFT JOIN project_runs p ON p.id=r.parent_run_id
     WHERE r.id=$1 AND r.project_id=$2 AND r.project_version=$3 AND r.status IN ('failed','interrupted','cancelled')
       AND NOT EXISTS(SELECT 1 FROM project_runs child WHERE child.parent_run_id=r.id) FOR SHARE OF r`,
     [input.resourcePlanningRunId,project.id,input.projectVersion])).rows[0];
   try{
    if(!source||source.snapshot.projectId!==project.id||source.snapshot.planVersion!==input.projectVersion||!source.snapshot.approval)throw invalid();
    assertGoalContract(source.snapshot);
    if(source.snapshot.resourceApproval){
     if(!source.parent_snapshot||!verifiedResourceEdge(source.snapshot,source.parent_snapshot,source.parent_run_id,source.snapshot.completedCheckpoints??[]))throw invalid();
     planningBudget=source.snapshot.policy.maxBudget;
    }else planningBudget=Math.min(source.snapshot.policy.maxBudget,project.policy.maxBudget);
   }catch{throw invalid();}
  }
  // A planning opt-in applies to receipts already known to be uncertain. A
  // pending request cannot become admissible merely because maintenance would
  // expire its lease between the read-only quote and this locked admission.
  if(project&&!input.runId)await requireProjectCostReady(client,project.id,input.retainUncertainCosts===true,planningBudget);
  await expireReservationsInTransaction(client);
  if(input.context?.probeId&&!(await client.query("SELECT id FROM model_capability_tests WHERE id=$1 AND status='running' AND created_at>now()-interval '3 minutes' FOR SHARE",[input.context.probeId])).rowCount)throw new AppError(409,'能力测试已中断或超时，请重新开始','PROBE_EXPIRED');
  const existing=(await client.query('SELECT id FROM model_reservations WHERE id=$1',[id])).rows[0];
  if(existing)throw new AppError(409,'该模型请求已创建费用预留');
  if(!Number.isFinite(input.amount)||input.amount<0)throw new AppError(422,'请求预留费用无效');
  if(input.maxCost!==undefined&&greater(input.amount,input.maxCost))throw new AppError(422,'本次模型请求预留超过单次费用上限','CALL_BUDGET_EXCEEDED');
  const billingDepartmentId=input.billingDepartmentId??project?.department_id??null;
  let departmentAdditional=input.amount;
  let offlineError:unknown;
  let planningCarryover:ReturnType<typeof projectCostCarryover>|undefined;
  if(project&&!input.runId){
   const readiness=await requireProjectCostReady(client,project.id,input.retainUncertainCosts===true,planningBudget);
   if((await client.query("SELECT id FROM project_runs WHERE project_id=$1 AND status IN ('queued','running')",[project.id])).rowCount)throw new AppError(409,'项目正在执行，暂不能另外调用规划模型');
   if(greater(readiness.recordedCost+readiness.reserved+input.amount,planningBudget))throw new AppError(422,'规划预留与已登记费用、未知预留超过项目已批准预算','BUDGET_EXCEEDED');
   if(input.retainUncertainCosts===true)planningCarryover=projectCostCarryover(readiness,true);
  }
  if(input.runId){
   const run=(await client.query("SELECT * FROM project_runs WHERE id=$1 AND project_id=$2 AND status='running' AND NOT cancel_requested FOR UPDATE",[input.runId,input.projectId])).rows[0];
   if(!run)throw new AppError(409,'运行已停止，不能再发起模型请求');
   if(input.leaseOwner&&(run.lease_owner!==input.leaseOwner||!run.lease_until||new Date(run.lease_until).getTime()<=Date.now()))throw new AppError(409,'工作进程已失去运行租约','LEASE_LOST');
   if(input.authorize)try{await input.authorize(client,run);}catch(error){
    if((error as any)?.code!=='LOCAL_DEVICE_OFFLINE')throw error;
    // Finish the remaining hard checks before permitting an outside-transaction
    // wait for a fresh heartbeat. Nothing has been reserved or dispatched.
    offlineError=error;
   }
   if(input.billingDepartmentId&&!(run.department_ids?.length?run.department_ids:run.snapshot.departmentIds??[run.snapshot.departmentId]).includes(input.billingDepartmentId))throw new AppError(422,'费用归属部门不在批准快照中','POLICY_DEPARTMENT_DENIED');
   // A late bill from an earlier run can exceed its retained amount. Recheck
   // the whole project under the same lock used by receipt settlement.
   const projectCosts=await projectCostReadiness(client,project.id,run.snapshot.policy.maxBudget);
   if(greater(projectCosts.recordedCost+projectCosts.reserved+input.amount,run.snapshot.policy.maxBudget))throw new AppError(422,'项目已确认费用与未结算预留将超过原批准预算','BUDGET_EXCEEDED');
   const committed=Number((await client.query('SELECT COALESCE(sum(cost),0) AS n FROM usage WHERE run_id=$1',[input.runId])).rows[0].n);
   const held=Number((await client.query(`SELECT COALESCE(sum(amount),0) AS n FROM model_reservations WHERE run_id=$1 AND ${open}`,[input.runId])).rows[0].n);
   if(greater(committed+held+input.amount,run.snapshot.executionBudget))throw new AppError(422,'请求与待核对费用超过运行剩余预算','BUDGET_EXCEEDED');
   const task=run.snapshot.tasks.find((t:any)=>t.id===input.context?.taskId);
   if(task){
    const taskCost=Number((await client.query(`SELECT COALESCE(sum(u.cost),0) AS n FROM usage u JOIN project_runs r ON r.id=u.run_id WHERE r.project_id=$1 AND r.project_version=$2 AND u.task_id=$3`,[project.id,run.snapshot.planVersion,task.id])).rows[0].n);
    const taskHeld=Number((await client.query(`SELECT COALESCE(sum(c.amount),0) AS n FROM model_reservations c JOIN project_runs r ON r.id=c.run_id WHERE r.project_id=$1 AND r.project_version=$2 AND c.context->>'taskId'=$3 AND c.${open}`,[project.id,run.snapshot.planVersion,task.id])).rows[0].n);
    if(greater(taskCost+taskHeld+input.amount,task.maxBudget??run.snapshot.policy.maxBudget))throw new AppError(422,'任务请求与待核对费用超过任务上限','TASK_BUDGET_EXCEEDED');
   }
   if(billingDepartmentId){
    const departmentCost=Number((await client.query(`SELECT COALESCE(sum(u.cost),0) AS n FROM usage u LEFT JOIN projects p ON p.id=u.project_id WHERE u.run_id=$1 AND COALESCE(u.department_id,p.department_id)=$2`,[input.runId,billingDepartmentId])).rows[0].n);
    const departmentHeld=Number((await client.query(`SELECT COALESCE(sum(amount),0) AS n FROM model_reservations WHERE run_id=$1 AND department_id=$2 AND ${open}`,[input.runId,billingDepartmentId])).rows[0].n);
    const departmentBudget=Number(run.snapshot.departmentBudgets?.[billingDepartmentId]??(run.snapshot.departmentId===billingDepartmentId?run.snapshot.executionBudget:0));
    const covered=Math.max(0,departmentBudget-departmentCost);
    departmentAdditional=Math.max(covered,departmentHeld+input.amount)-Math.max(covered,departmentHeld);
   }
  }
  if(!conversation)await checkDailyBudget(client,config,billingDepartmentId,departmentAdditional,input.runId?0:input.amount);
  const billing=(await client.query(`SELECT g.id,g.version,g.data,m.data->>'model' AS wire_model FROM models m JOIN gateways g ON g.id=m.data->>'gatewayId' WHERE m.id=$1`,[input.model.id])).rows[0];
  const context={...input.context,...(input.resourcePlanningRunId?{resourcePlanningRunId:input.resourcePlanningRunId}:{}),accountingMode:conversation?'conversation':'budgeted',...(planningCarryover?{costCarryover:planningCarryover}:{}),...(billing?{billingRoute:{gatewayId:billing.id,gatewayVersion:billing.version,baseUrl:billing.data.baseUrl,wireModel:billing.wire_model,autoReconcile:billing.data.pricingSource==='new-api',...(billing.data._billingUnit?{billingUnit:billing.data._billingUnit}:{})}}:{})};
  input.signal?.throwIfAborted();
  if(offlineError)throw offlineError;
  await client.query(`INSERT INTO model_reservations(id,model_id,project_id,department_id,run_id,purpose,amount,input_rate,output_rate,context)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[id,input.model.id,input.projectId??null,billingDepartmentId,input.runId??null,input.purpose,input.amount,input.model.inputRate,input.model.outputRate,context]);
  input.signal?.throwIfAborted();
  await client.query('COMMIT');return id;
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}

export async function receiptTransaction(id:string,work:(db:Database,row:any)=>Promise<any>) {
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
  await db.query("UPDATE model_reservations SET status=$2,context=context||$3::jsonb,history=history||$4::jsonb WHERE id=$1",[id,dispatched?'uncertain':'released',JSON.stringify({dispatched}),JSON.stringify([{at:new Date().toISOString(),source:'runtime',note,dispatched}])]);
 });
}

const receiptId=(value:unknown)=>typeof value==='string'&&/^[A-Za-z0-9._:/-]{1,128}$/.test(value)&&!/^sk-/i.test(value)?value:undefined;
export async function recordProviderResponse(id:string,metadata:{providerRequestId?:string;upstreamRequestId?:string;responseRequestId?:string;providerStatus?:number}){
 return receiptTransaction(id,async(db,row)=>{
  if(!['pending','uncertain'].includes(row.status))return;
  const saved:Record<string,unknown>={};
  for(const key of ['providerRequestId','upstreamRequestId','responseRequestId'] as const){const value=receiptId(metadata[key]);if(value)saved[key]=value;}
  if(Number.isInteger(metadata.providerStatus)&&metadata.providerStatus!>=100&&metadata.providerStatus!<=599)saved.providerStatus=metadata.providerStatus;
  if(Object.keys(saved).length)await db.query('UPDATE model_reservations SET context=context||$2::jsonb WHERE id=$1',[id,JSON.stringify(saved)]);
 });
}

export async function settleCall(id:string,inputTokens:number,outputTokens:number,metadata:any={},manualNote?:string) {
 return receiptTransaction(id,async(db,row)=>{
  if(manualNote!==undefined&&row.status!=='uncertain')throw new AppError(409,'仅能核对待确认的费用，请刷新');
  const providerBill=metadata.providerBill;
  if(metadata.reconciliationToken){
   if(row.status==='settled')return {cost:Number((await db.query('SELECT cost FROM usage WHERE id=$1',[id])).rows[0]?.cost??0),reserved:Number(row.amount),alreadySettled:true};
   if(row.status!=='uncertain'||row.context.providerReconciliation?.token!==metadata.reconciliationToken)throw new AppError(409,'本次账单查询已被另一轮查询替代，费用仍待核对','RECONCILIATION_CLAIM_LOST');
  }
  const priorBill=row.history.findLast((entry:any)=>entry.source==='new-api');
  const billed=providerBill&&providerBill.source==='new-api'&&Number.isSafeInteger(providerBill.quota)&&providerBill.quota>=0&&Number.isFinite(providerBill.quotaPerUSD)&&providerBill.quotaPerUSD>0;
  if(providerBill&&!billed)throw new AppError(422,'供应方账单的额度或换算依据无效','INVALID_BILLING_EVIDENCE');
  const cost=billed?providerBill.quota/providerBill.quotaPerUSD:manualNote===undefined&&priorBill?priorBill.cost:(inputTokens*Number(row.input_rate)+outputTokens*Number(row.output_rate))/1e6;
  if(!Number.isFinite(cost)||cost<0)throw new AppError(422,'账单金额无效，保留费用预留','INVALID_BILLING_EVIDENCE');
  const last=row.history.at(-1);
  if(manualNote===undefined&&row.status==='settled'&&last?.source==='provider'&&last.inputTokens===inputTokens&&last.outputTokens===outputTokens)return {cost,reserved:Number(row.amount)};
  const context={...row.context,...metadata};
  await db.query(`INSERT INTO usage(id,model_id,project_id,department_id,run_id,input_tokens,output_tokens,cost,purpose,agent_id,employee_id,session_id,task_id,attempt_id,request_id,duration_ms)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
    ON CONFLICT(id) DO UPDATE SET input_tokens=EXCLUDED.input_tokens,output_tokens=EXCLUDED.output_tokens,cost=EXCLUDED.cost,duration_ms=EXCLUDED.duration_ms`,
    [id,row.model_id,row.project_id,row.department_id,row.run_id,inputTokens,outputTokens,cost,row.purpose,context.agentId??null,context.employeeId??null,context.sessionId??null,context.taskId??null,context.attemptId??null,context.requestId??null,context.durationMs??null]);
  const entry={at:new Date().toISOString(),source:billed?'new-api':manualNote===undefined?'provider':'manual',inputTokens,outputTokens,cost,...(billed?{providerBill}:{}),...(manualNote===undefined?{}:{note:manualNote})};
  // A late authoritative receipt can replace an earlier manual reconciliation; the history preserves both.
  const reconciliation=billed?{status:'settled',message:'已按中转站消费记录核对并结算；调用次数继续保留。',checkedAt:entry.at,requestId:providerBill.requestId,providerQuota:providerBill.quota,cost,inputTokens,outputTokens,attempts:row.context.providerReconciliation?.attempts??1}:row.context.providerReconciliation?{status:'settled',message:manualNote!==undefined?'费用已人工核对，保留核对依据。':'已收到模型用量回执，费用记录已更新。',checkedAt:entry.at,cost,inputTokens,outputTokens,attempts:row.context.providerReconciliation.attempts}:undefined;
  await db.query("UPDATE model_reservations SET status='settled',context=context||$2::jsonb,history=history||$3::jsonb WHERE id=$1",[id,JSON.stringify(reconciliation?{providerReconciliation:reconciliation}:{}),JSON.stringify([entry])]);
  return {cost,reserved:Number(row.amount)};
 });
}

export function budgetedRequestEstimate(model:Pick<Model,'inputRate'|'outputRate'> & Partial<Pick<Model,'protocol'|'model'|'thinkingMode'>>,messages:ChatMessage[],maxTokens:number,request:CompletionOptions={}) {
 const envelope=model.protocol==='responses'||model.thinkingMode!==undefined?prepareCompletionRequest(model,messages,maxTokens,request).body:{messages,...request};
 const inputBytes=Buffer.byteLength(JSON.stringify(envelope))+1024;
 return {inputBytes,reservation:(inputBytes*model.inputRate+maxTokens*model.outputRate)/1e6};
}
export async function completeBudgeted(model:Model,messages:ChatMessage[],maxTokens:number,options:{purpose:string;projectId?:string;projectVersion?:number;resourcePlanningRunId?:string;maxCost?:number;context?:Record<string,any>;timeoutMs?:number;retainUncertainCosts?:boolean},request:CompletionOptions={}) {
 const estimate=budgetedRequestEstimate(model,messages,maxTokens,request),amount=estimate.reservation;
 assertCompletionContext(model,estimate.inputBytes,maxTokens);
 const {timeoutMs,...reservation}=options;
 const id=await reserveCall({model,amount,...reservation});
 let received=false;
 try{
  const response=await complete(model,messages,maxTokens,async usage=>{
   const receipt=await settleCall(id,usage.prompt_tokens,usage.completion_tokens);received=true;
   if(greater(receipt.cost,amount))throw new AppError(422,'实际费用超过本次保守预留，已记录用量并停止后续操作','CALL_BUDGET_EXCEEDED');
  },request,{timeoutMs,sessionId:options.context?.sessionId??(options.context?.probeId?'probe:'+options.context.probeId:options.projectId?'project:'+options.projectId+':'+options.purpose+':'+options.projectVersion:'request:'+id),onResponse:async response=>recordProviderResponse(id,{providerRequestId:response.headers.get('x-oneapi-request-id')??undefined,upstreamRequestId:response.headers.get('x-upstream-request-id')??undefined,responseRequestId:response.headers.get('x-request-id')??undefined,providerStatus:response.status})});
  if(!response.usage)throw new AppError(502,'中转站未返回用量，费用预留保留为待核对','USAGE_MISSING');
  return {...response,usageId:id};
 }catch(error){if(!received)await markCallUncertain(id,error instanceof AppError?error.code:'CALL_INTERRUPTED');throw error;}
}

/** Demand discussion records native usage without estimating, reserving, or
 * admitting spend against project budgets. Existing execution calls remain budgeted. */
export async function completeOrganizationConversation(model:Model,messages:ChatMessage[],maxTokens:number,options:{sessionId:string;timeoutMs?:number},request:CompletionOptions={}) {
 const prepared=prepareCompletionRequest(model,messages,maxTokens,request);
 assertCompletionContext(model,Buffer.byteLength(JSON.stringify(prepared.body))+1024,maxTokens);
 const id=await reserveCall({model,amount:0,purpose:'组织需求对话',accountingMode:'conversation',context:{sessionId:options.sessionId}});
 let received=false;
 try{
  const response=await complete(model,messages,maxTokens,async usage=>{
   await settleCall(id,usage.prompt_tokens,usage.completion_tokens);received=true;
  },request,{timeoutMs:options.timeoutMs,sessionId:options.sessionId,onResponse:async response=>recordProviderResponse(id,{providerRequestId:response.headers.get('x-oneapi-request-id')??undefined,upstreamRequestId:response.headers.get('x-upstream-request-id')??undefined,responseRequestId:response.headers.get('x-request-id')??undefined,providerStatus:response.status})});
  if(!response.usage)throw new AppError(502,'中转站未返回用量，本轮实际费用待核对（需求对话未做预算预留）','USAGE_MISSING');
  return {...response,usageId:id};
 }catch(error){if(!received)await markCallUncertain(id,error instanceof AppError?error.code:'CALL_INTERRUPTED');throw error;}
}
