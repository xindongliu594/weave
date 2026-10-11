import type pg from 'pg';
import { AppError } from './provider.ts';
import { readRun } from '../../../services/agent-runtime/trace-store.mjs';

export const callsBasis = 'durable-admissions-and-archived-wire-requests' as const;

/** Count each run's own durable attempts, never its inherited snapshot history.
 * Released or undispatched admissions still consumed the approved call quota. */
export async function durableCallHistory(db:Pick<pg.PoolClient,'query'>,traceRoot:string,projectId:string,version:number) {
  const runs=(await db.query('SELECT id,project_id,project_version,status,started_at FROM project_runs WHERE project_id=$1 AND project_version=$2 ORDER BY attempt',[projectId,version])).rows;
  const admissions=(await db.query(`SELECT c.id,c.run_id,c.project_id,c.context->>'taskId' AS task_id
    FROM model_reservations c JOIN project_runs r ON r.id=c.run_id
    WHERE r.project_id=$1 AND r.project_version=$2`,[projectId,version])).rows;
  const runIds=new Set(runs.map(row=>row.id)),seen=new Set<string>(),registered=new Map<string,any[]>();
  const invalid=()=>new AppError(409,'此前调用登记或档案归属无法核对，不能重置调用上限','BUDGET_HISTORY_MISSING');
  const validId=(value:any):value is string=>typeof value==='string'&&value.length>0&&value.length<=240;
  for(const row of admissions) {
    if(!validId(row.id)||seen.has(row.id)||!runIds.has(row.run_id)||row.project_id!==projectId||row.task_id!==null&&!validId(row.task_id))throw invalid();
    seen.add(row.id);if(!registered.has(row.run_id))registered.set(row.run_id,[]);registered.get(row.run_id)!.push(row);
  }
  const tasks:Record<string,number>=Object.create(null),requestOverheadBytes:Record<string,number>=Object.create(null);let calls=0;
  for(const run of runs) {
    if(run.project_id!==projectId||run.project_version!==version)throw invalid();
    const receipts=registered.get(run.id)??[];
    const archive=readRun(traceRoot,run.id);
    if(!archive) {
      if(run.status==='cancelled'&&!run.started_at&&receipts.length===0)continue;
      throw new AppError(409,'缺少此前执行档案，无法核对模型调用上限，请先恢复备份','BUDGET_HISTORY_MISSING');
    }
    if(archive.integrity!=='ok')throw new AppError(409,'此前执行档案不完整，不能重置模型调用上限','BUDGET_HISTORY_MISSING');
    // Legacy archives may omit planVersion; the exact owning run row supplies
    // that version. Any explicitly recorded conflicting owner/version fails.
    const snapshot=archive.snapshot as typeof archive.snapshot & {projectId?:string};
    if(archive.id!==run.id||snapshot.projectId!==projectId||snapshot.planVersion!==undefined&&snapshot.planVersion!==version)throw invalid();
    const mapping=new Map<string,string>(archive.events.filter(e=>e.type==='run/task-mapping').flatMap(e=>e.data.tasks??[]).map((t:any)=>[t.task_id,t.seed_id]));
    const sessions=new Map<string,string>(),wireTasks=new Map<string,number>(),admissionTasks=new Map<string,number>();let wires=0;
    const add=(counts:Map<string,number>,id:any)=>{
      if(!validId(id))throw invalid();const taskId=mapping.get(id)??id;counts.set(taskId,(counts.get(taskId)??0)+1);
    };
    for(const event of archive.events) {
      if(event.type==='model/request'&&event.sessionId&&event.taskId)sessions.set(event.sessionId,mapping.get(event.taskId)??event.taskId);
      if(event.type!=='model/wire-request')continue;
      wires++;
      const taskId=event.data.taskId??(event.sessionId?sessions.get(event.sessionId):undefined);
      if(taskId!==undefined){
        add(wireTasks,taskId);
        const body=event.data.body;
        // Preserve actual schemas/configuration from integrity-checked wires;
        // only messages/input vary with the bounded conversation on recovery.
        if(body&&typeof body==='object'&&!Array.isArray(body)&&(Array.isArray(body.messages)||Array.isArray(body.input))){
          const envelope={...body,...(Array.isArray(body.messages)?{messages:[]}:{input:[]})},id=mapping.get(taskId)??taskId;
          requestOverheadBytes[id]=Math.max(requestOverheadBytes[id]??0,Buffer.byteLength(JSON.stringify(envelope))-2);
        }
      }
    }
    for(const row of receipts)if(row.task_id!==null)add(admissionTasks,row.task_id);
    const runCalls=Math.max(wires,receipts.length),merged=new Map<string,number>();
    for(const taskId of new Set([...wireTasks.keys(),...admissionTasks.keys()]))merged.set(taskId,Math.max(wireTasks.get(taskId)??0,admissionTasks.get(taskId)??0));
    // Conflicting partial legacy attribution must not create negative
    // unattributed calls or silently manufacture a zero remainder.
    if([...merged.values()].reduce((sum,value)=>sum+value,0)>runCalls)throw invalid();
    calls+=runCalls;for(const [taskId,count] of merged)tasks[taskId]=(tasks[taskId]??0)+count;
  }
  return {calls,tasks,callsBasis,requestOverheadBytes};
}

/** A retry uses the same approved task IDs; a new plan version has its own task counters. */
export async function budgetHistory(db:Pick<pg.PoolClient,'query'>,traceRoot:string,projectId:string,version:number) {
  const history=await durableCallHistory(db,traceRoot,projectId,version);
  const tasks:Record<string,{cost:number;calls:number;reserved?:number;requestOverheadBytes?:number}>=Object.fromEntries(Object.entries(history.tasks).map(([id,calls])=>[id,{cost:0,calls,
    ...(history.requestOverheadBytes[id]===undefined?{}:{requestOverheadBytes:history.requestOverheadBytes[id]})}]));
  const costs=(await db.query(`SELECT u.task_id,sum(u.cost) AS cost FROM usage u JOIN project_runs r ON r.id=u.run_id
    WHERE r.project_id=$1 AND r.project_version=$2 AND u.task_id IS NOT NULL GROUP BY u.task_id`,[projectId,version])).rows;
  for(const row of costs)(tasks[row.task_id]??={cost:0,calls:0}).cost=Number(row.cost);
  // Global carryover already retains these amounts. Also retain their task
  // attribution so a restart cannot make a capped task look cheaper locally.
  const holds=(await db.query(`SELECT c.context->>'taskId' AS task_id,sum(c.amount) AS amount
    FROM model_reservations c JOIN project_runs r ON r.id=c.run_id
    WHERE r.project_id=$1 AND r.project_version=$2 AND c.context->>'taskId' IS NOT NULL
      AND c.status IN ('pending','uncertain') GROUP BY c.context->>'taskId'`,[projectId,version])).rows;
  for(const row of holds)(tasks[row.task_id]??={cost:0,calls:0}).reserved=Number(row.amount);
  return {calls:history.calls,tasks,callsBasis:history.callsBasis};
}
