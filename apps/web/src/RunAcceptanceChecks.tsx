import type {RunLineageEvidence} from '../../../packages/contracts/run-lineage-evidence.ts';
export function RunAcceptanceChecks({runId,snapshot,evidence}:{runId:string;snapshot:any;evidence?:RunLineageEvidence}){
 const report=evidence?.runId===runId&&evidence.projectId===snapshot.projectId&&evidence.planVersion===snapshot.planVersion?evidence.acceptance:undefined;
 const bound=report?.runId===runId&&report.planVersion===snapshot.planVersion?report:undefined;
 return <section className="lower"><h3>逐项验收证据</h3><p className="subcopy">命令结果由宿主核对；测试内容是否覆盖需求仍需独立 QA 和经理审查。历史方案未启用时不补写通过结论。</p>
  {!!snapshot.deliveryCriteria?.length&&<div aria-label="用户交付要求">{snapshot.deliveryCriteria.map((criterion:any)=>{
   const row=bound?.deliveryCriteria?.find(r=>r.criterionId===criterion.id&&r.description===criterion.description);
   return <div className="lower-small" key={criterion.id}><strong>{criterion.description}</strong><p>{row?.status==='passed'?'交付检查通过':row?.status==='failed'?'检查失败':'未验证'}{row?.reason?' · '+row.reason:''}</p>{row?.evidenceRefs.map((ref,index)=><small className="trace-id" key={index}>{ref.kind==='employee_review'?'员工内容复核':'实际命令检查'} · {ref.taskId} · 来源运行 {ref.sourceRunId} · 尝试 {ref.attemptId}</small>)}</div>;
  })}</div>}
  {(snapshot.tasks??[]).map((task:any)=><details key={task.id}><summary>{task.subject||task.id}</summary>{task.acceptanceChecks===undefined?<p>此方案未定义逐项命令映射，请查看原 QA 测试和经理验收记录。</p>:(task.acceptanceCriteria??[]).map((criterion:string,index:number)=>{
   const rows=bound?.rows.filter(row=>row.taskId===task.id&&row.criterionIndex===index&&row.criterion===criterion)??[];
   const row=rows.length===1?rows[0]:undefined;
   return <div className="lower-small" key={index}><strong>{index+1}. {criterion}</strong><p>{row?.status==='passed'?'命令证据通过':row?.status==='failed'?'检查失败':row?.status==='blocked'?'受阻':'未验证'}{row?.reason?' · '+row.reason:''}</p>{row?.command&&<code>{row.command}</code>}{row?.sourceRunId&&<p className="trace-id">来源运行 {row.sourceRunId} · 尝试 {row.attemptId} · 文件版本 {row.workspaceRevision}</p>}</div>;
  })}</details>)}
 </section>;
}
