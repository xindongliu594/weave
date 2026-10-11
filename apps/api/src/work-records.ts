import {createHash} from 'node:crypto';
import {join} from 'node:path';
import type pg from 'pg';
import {readRun} from '../../../services/agent-runtime/trace-store.mjs';
import {completedTasks,resumeHandoff} from './handoff-checkpoints.ts';
import {AppError} from './provider.ts';
import {workEfficiency} from './work-efficiency.ts';
import {acceptedAdoptions} from '../../../services/agent-runtime/employee-capabilities.mjs';

/** A small index of real work. Raw conversations and employee source files stay in their archives. */
export async function acceptedWorkRecord(db:Pick<pg.Pool,'query'>,traceRoot:string,runId:string){
 const row=(await db.query('SELECT r.status,r.snapshot,r.project_id,p.department_id,d.deleted_at FROM project_runs r JOIN projects p ON p.id=r.project_id JOIN departments d ON d.id=p.department_id WHERE r.id=$1',[runId])).rows[0];
 const run=readRun(traceRoot,runId);
 if(!row||!run)throw new AppError(404,'工作运行不存在');
 if(row.deleted_at)throw new AppError(409,'部门已归档；工作历史仍保留，恢复部门后可查看');
 const snapshot=run.snapshot as any;
 if(row.status!=='completed'||run.status!=='completed'||run.integrity!=='ok'||snapshot.projectId!==row.project_id||snapshot.planVersion!==row.snapshot.planVersion)
  throw new AppError(409,'只有完整且已完成的正式工作可以登记知识');
 let receipts:any[];
 try{const done=completedTasks(run.events,snapshot);if(!done.size||!snapshot.tasks.every((t:any)=>done.has(t.id)))throw Error('存在未核验节点');receipts=resumeHandoff(snapshot,run.events,done,join(traceRoot,runId,'artifacts'));}
 catch(error){throw new AppError(409,'交付证据不能核对：'+(error as Error).message);}
 const files=[...new Map(receipts.flatMap(r=>[...(r.inputs??[]),...(r.outputs??[])]).map(f=>[f.path+':'+f.sha256,{path:f.path,sha256:f.sha256,bytes:f.bytes}])).values()];
 const testCounters=(command:any)=>{const counts=command.evidence?.nodeTests;if(counts?.status!=='available')return {status:'unknown',reason:counts?.reason??'LEGACY_TEST_COUNTS_UNAVAILABLE'};return Object.fromEntries(['status','format','tests','suites','pass','fail','cancelled','skipped','todo'].filter(key=>counts[key]!==undefined).map(key=>[key,counts[key]]));};
 const nodes=snapshot.tasks.map((task:any)=>({id:task.id,subject:task.subject,kind:task.kind??'work',dependencies:task.dependencies??[],criteria:task.acceptanceCriteria??[],commands:(receipts.find(r=>r.taskId===task.id)?.commands??[]).map((c:any)=>({command:c.command,exitCode:c.exitCode,checks:c.acceptanceChecks??[],tests:testCounters(c)}))}));
 const reviews=run.events.filter(e=>e.type==='quality/reviewed').map(e=>({taskId:e.data.taskId,verdict:e.data.verdict}));
 const efficiency=await workEfficiency(db,traceRoot,run);
 const adoptions=acceptedAdoptions(run.events,receipts);
 let content=['# 工作记录',`来源运行：${runId}`,`项目：${row.project_id} · 方案 v${snapshot.planVersion}`,`完成时间：${run.events.findLast(e=>e.type==='run/finished')?.at??'未封存'}`,'','## 需求',String(snapshot.requirement??snapshot.title??'').slice(0,8000),'','## 已核验节点与实际命令','```json',JSON.stringify(nodes,null,2),'```','## 正式审查记录','```json',JSON.stringify(reviews,null,2),'```','## 交付版本索引','```json',JSON.stringify(files,null,2),'```','## 效率与知识复用实测',efficiency.method,efficiency.baseline?'已找到可比较的首次运行。':'尚无同条件的首次运行，暂不计算减少百分比。','```json',JSON.stringify(efficiency,null,2),'```','原始交付、完整命令输出和费用保留在来源运行。此记录可供检索复用，Skill 或工具的采纳仍需独立评估。'].join('\n');
 if(adoptions.length)content+='\n\n## 已采用的固定知识与方法\n员工声明实际采用，来源读取已核对；仅收录已封存成功尝试，不代表已证明方法带来提速。\n```json\n'+JSON.stringify(adoptions,null,2)+'\n```';
 if(Buffer.byteLength(content)>64*1024)throw new AppError(422,'工作记录超过 64 KiB，请先缩小登记范围');
 const knowledge=snapshot.knowledge??{},agents=snapshot.agents??[];
 const everyone=(ids:unknown)=>Array.isArray(ids)&&agents.every((agent:any)=>ids.includes(agent.id)||ids.includes(agent.employeeId??agent.id));
 const legacyPrivate=Object.keys(knowledge).length>0&&knowledge.format!=='document-versions-v2'&&Object.values(knowledge).some(value=>!Array.isArray(value)||value.length>0);
 const shareable=!legacyPrivate&&!(knowledge.documents??[]).some((doc:any)=>!agents.length||agents.some((agent:any)=>!(knowledge.agentDocuments?.[agent.id]??knowledge.agentDocuments?.[agent.employeeId]??[]).includes(doc.documentId)))&&!(knowledge.runInputs??[]).some((input:any)=>!everyone(input.agentIds))&&!(snapshot.importedFiles??[]).some((input:any)=>!everyone(input.agentIds));
 return {runId,projectId:row.project_id,departmentId:row.department_id,planVersion:snapshot.planVersion,title:('工作记录 · '+(snapshot.title??run.title??runId)).slice(0,200),files,nodes,reviews,efficiency,adoptions,content,sha256:createHash('sha256').update(content).digest('hex'),shareable};
}
