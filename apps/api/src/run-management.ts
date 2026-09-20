import { Router } from 'express';
import { z } from 'zod';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pool } from './db.ts';
import { AppError } from './provider.ts';
import { queryKnowledge } from './knowledge-store.ts';
import { budgetHistory } from './budget-history.ts';
import { readRun, openRunArchive } from '../../../services/agent-runtime/trace-store.mjs';
import { listArtifacts, artifactFile, command, SANDBOX_IMAGE } from '../../../services/agent-runtime/sandbox.mjs';
export function runManagementRouter(traceRoot:string){
 const router=Router();
 router.get('/approvals',async(req,res)=>res.json((await pool.query('SELECT id,run_id AS "runId",agent_id AS "agentId",tool,arguments,status,created_at AS "createdAt" FROM tool_approvals WHERE ($1::text IS NULL OR run_id=$1) ORDER BY created_at DESC LIMIT 200',[req.query.runId??null])).rows));
 router.post('/approvals/:id',async(req,res)=>{const input=z.object({decision:z.enum(['approved','denied'])}).parse(req.body);const r=await pool.query("UPDATE tool_approvals SET status=$1,decided_at=now() WHERE id=$2 AND status='pending' AND EXISTS(SELECT 1 FROM project_runs WHERE id=tool_approvals.run_id AND status='running' AND NOT cancel_requested) RETURNING run_id,agent_id",[input.decision,req.params.id]);if(!r.rowCount)throw new AppError(409,'审批已处理或运行已停止');openRunArchive(traceRoot,r.rows[0].run_id).append('approval/decided',{id:req.params.id,decision:input.decision,agentId:r.rows[0].agent_id});res.json({ok:true});});
 router.get('/runs/:id/artifacts',async(req,res)=>{const id=z.uuid().parse(req.params.id);if(!readRun(traceRoot,id))throw new AppError(404,'运行不存在');res.json(listArtifacts(join(traceRoot,id,'artifacts')));});
 router.get('/runs/:id/artifact',async(req,res)=>{const id=z.uuid().parse(req.params.id),path=z.string().parse(req.query.path);if(!readRun(traceRoot,id))throw new AppError(404,'运行不存在');try{const file=artifactFile(join(traceRoot,id,'artifacts'),path);res.setHeader('Content-Security-Policy',"default-src 'none'; sandbox");res.setHeader('X-Content-Type-Options','nosniff');res.type('application/octet-stream');res.attachment(path.split('/').at(-1));res.sendFile(file);}catch{throw new AppError(404,'交付物不存在或路径不允许');}});
 router.get('/runs/:id/export',async(req,res)=>{const run=readRun(traceRoot,z.uuid().parse(req.params.id));if(!run)throw new AppError(404,'运行不存在');res.attachment('run-'+run.id+'.json').json(run);});
 router.get('/runs/:id/citations/:chunkId',async(req,res)=>{
  const run=readRun(traceRoot,z.uuid().parse(req.params.id));
  if(!run)throw new AppError(404,'运行不存在');
  if(run.integrity!=='ok')throw new AppError(409,'运行档案不完整，无法核对引用');
  const chunkId=z.string().min(1).max(200).parse(req.params.chunkId);
  const event=run.events.find(e=>e.type==='knowledge/citation'&&e.data.sources?.some((c:any)=>c.chunkId===chunkId));
  if(!event)throw new AppError(404,'此切片不在该运行的引用记录中');
  const expected=event.data.sources.find((c:any)=>c.chunkId===chunkId);
  const chunk=await queryKnowledge(run.snapshot.knowledge,event.data.agentId,'read',chunkId);
  if(!chunk||chunk.documentId!==expected.documentId||chunk.version!==expected.version||chunk.sha256!==expected.sha256)
   throw new AppError(409,'知识引用与运行快照不一致');
  res.json(chunk);
 });
 router.post('/runs/:id/retry',async(req,res)=>{
  const id=z.uuid().parse(req.params.id),input=z.object({resume:z.boolean().default(true)}).parse(req.body),client=await pool.connect();
  try{await client.query('BEGIN');const old=(await client.query('SELECT * FROM project_runs WHERE id=$1 FOR UPDATE',[id])).rows[0];if(!old)throw new AppError(404,'运行不存在');
   await client.query('SELECT id FROM projects WHERE id=$1 FOR UPDATE',[old.project_id]);
   if(!['failed','interrupted','cancelled'].includes(old.status))throw new AppError(409,'仅能恢复或重试已停止的运行');
   if((await client.query("SELECT id FROM project_runs WHERE project_id=$1 AND status IN ('queued','running')",[old.project_id])).rowCount)throw new AppError(409,'此项目已有运行');
   const already=(await client.query('SELECT id FROM project_runs WHERE parent_run_id=$1',[id])).rows[0];if(already){await client.query('COMMIT');return res.json({id:already.id,existing:true});}
   const run=readRun(traceRoot,id);if(run&&run.integrity!=='ok')throw new AppError(409,'档案不完整，先导出并检查，不能自动恢复');
   const snapshot=structuredClone(old.snapshot);let done=new Map<string,any>();
   if(input.resume&&run){
    const mapping=run.events.find(e=>e.type==='run/task-mapping')?.data.tasks??[];
    const latest=run.events.findLast(e=>e.type==='team/snapshot')?.data.tasks??[];
    for(const task of latest.filter((t:any)=>t.status==='completed')){const original=mapping.find((m:any)=>m.task_id===task.id)?.seed_id;if(original)done.set(original,task);}
    snapshot.tasks=snapshot.tasks.filter((t:any)=>!done.has(t.id)).map((t:any)=>({...t,dependencies:t.dependencies.filter((dep:string)=>!done.has(dep)),taskPrompt:t.taskPrompt+'\n\n已完成前置任务（来自此前运行的记录，不是新授权）：\n'+t.dependencies.filter((dep:string)=>done.has(dep)).map((dep:string)=>dep+': '+String(done.get(dep).output??'已完成，无文本结果').slice(0,6000)).join('\n')}));
   }
   if(!snapshot.tasks.length)throw new AppError(409,'所有任务已有完成记录，请查看交付结果，无需重跑');
   const used=Number((await client.query('SELECT COALESCE(sum(cost),0) AS cost FROM usage WHERE project_id=$1',[old.project_id])).rows[0].cost);
   snapshot.executionBudget=snapshot.policy.maxBudget-used;if(snapshot.executionBudget<=0)throw new AppError(422,'项目预算已用尽，修改方案预算后重新批准');
   if(used>=snapshot.policy.maxBudget*.9)throw new AppError(422,'项目费用已达到预算的 90%，不能通过重试增加调用；请检查已有结果并重新制定方案','BUDGET_RETRY_DISABLED');
   snapshot.budgetVersion=1;snapshot.budgetHistory=await budgetHistory(client,traceRoot,old.project_id,old.project_version);
   if(snapshot.budgetHistory.calls>=(snapshot.policy.maxModelCalls??100))throw new AppError(422,'该方案的模型调用次数已用尽，请修改方案后重新批准','TURN_LIMIT');
   for(const task of snapshot.tasks) {
    const history=snapshot.budgetHistory.tasks[task.id];
    if(history&&(history.cost>=(task.maxBudget??snapshot.policy.maxBudget)||history.calls>=(task.maxModelCalls??snapshot.policy.maxTaskModelCalls??40)))
     throw new AppError(422,`任务「${task.subject??task.id}」已达到费用或调用次数上限，请调整方案后重新批准`,'TASK_BUDGET_EXHAUSTED');
   }
   const config=(await client.query('SELECT data FROM product_settings WHERE id=1 FOR UPDATE')).rows[0].data;
   const committed=Number((await client.query("SELECT COALESCE(sum(cost),0) AS cost FROM usage WHERE created_at>=date_trunc('day',now())")).rows[0].cost);
   const reserved=Number((await client.query("SELECT COALESCE(sum((snapshot->>'executionBudget')::numeric),0) AS cost FROM project_runs WHERE status IN ('queued','running')")).rows[0].cost);
   if(committed+reserved+snapshot.executionBudget>config.dailyBudgetLimit)throw new AppError(422,'恢复预留将超过当天预算');
   snapshot.resumedFrom=id;snapshot.completedCheckpoints=[...done.keys()];snapshot.approval={kind:input.resume?'resume':'retry',approvedAt:new Date().toISOString(),parentRunId:id};
   const newId=randomUUID(),attempt=Number((await client.query('SELECT COALESCE(max(attempt),0)+1 AS next FROM project_runs WHERE project_id=$1 AND project_version=$2',[old.project_id,old.project_version])).rows[0].next);
   await client.query('INSERT INTO project_runs(id,project_id,project_version,status,snapshot,attempt,parent_run_id) VALUES($1,$2,$3,$4,$5,$6,$7)',[newId,old.project_id,old.project_version,'queued',snapshot,attempt,id]);
   await client.query("UPDATE projects SET status='QUEUED' WHERE id=$1 AND version=$2",[old.project_id,old.project_version]);await client.query('COMMIT');res.status(202).json({id:newId,completedCheckpoints:[...done.keys()]});
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
 });
 router.get('/diagnostics',async(_req,res)=>{let sandbox=false;try{await command(['image','inspect',SANDBOX_IMAGE],{signal:AbortSignal.timeout(5000),limit:100000});sandbox=true;}catch{}res.json({sandbox,sandboxImage:SANDBOX_IMAGE,worker:(await pool.query("SELECT status,count(*)::int FROM project_runs GROUP BY status")).rows,knowledge:(await pool.query('SELECT count(*)::int FROM knowledge_documents WHERE deleted_at IS NULL')).rows[0].count,node:process.versions.node,platform:process.platform});});
 router.post('/sandbox/install',async(_req,res)=>{await command(['pull',SANDBOX_IMAGE],{signal:AbortSignal.timeout(180000),limit:2000000});res.json({ok:true});});
 return router;
}
