import type pg from 'pg';
import { AppError } from './provider.ts';
import { readRun } from '../../../services/agent-runtime/trace-store.mjs';

/** A retry uses the same approved task IDs; a new plan version has its own task counters. */
export async function budgetHistory(db:Pick<pg.PoolClient,'query'>,traceRoot:string,projectId:string,version:number) {
  const runs=(await db.query('SELECT id,status,started_at FROM project_runs WHERE project_id=$1 AND project_version=$2 ORDER BY attempt',[projectId,version])).rows;
  const tasks:Record<string,{cost:number;calls:number}>={};let calls=0;
  for(const run of runs) {
    const archive=readRun(traceRoot,run.id);
    if(!archive) {
      if(run.status==='cancelled'&&!run.started_at)continue; // A queue entry cancelled before starting has no model requests.
      throw new AppError(409,'缺少此前执行档案，无法核对模型调用上限，请先恢复备份','BUDGET_HISTORY_MISSING');
    }
    if(archive.integrity!=='ok')throw new AppError(409,'此前执行档案不完整，不能重置模型调用上限','BUDGET_HISTORY_MISSING');
    const mapping=new Map<string,string>(archive.events.filter(e=>e.type==='run/task-mapping').flatMap(e=>e.data.tasks??[]).map((t:any)=>[t.task_id,t.seed_id]));
    const sessions=new Map<string,string>();
    for(const event of archive.events) {
      if(event.type==='model/request'&&event.sessionId&&event.taskId)sessions.set(event.sessionId,mapping.get(event.taskId)??event.taskId);
      if(event.type!=='model/wire-request')continue;
      calls++;
      const taskId=event.data.taskId??(event.sessionId?sessions.get(event.sessionId):undefined);
      if(taskId)(tasks[taskId]??={cost:0,calls:0}).calls++;
    }
  }
  const costs=(await db.query(`SELECT u.task_id,sum(u.cost) AS cost FROM usage u JOIN project_runs r ON r.id=u.run_id
    WHERE r.project_id=$1 AND r.project_version=$2 AND u.task_id IS NOT NULL GROUP BY u.task_id`,[projectId,version])).rows;
  for(const row of costs)(tasks[row.task_id]??={cost:0,calls:0}).cost=Number(row.cost);
  return {calls,tasks};
}
