import type {Plan} from '../../../packages/contracts/index.ts';

export function OrganizationDepartmentScope({departments,allowed,onChange}:{departments:{id:string;name:string}[];allowed:string[];onChange:(ids:string[])=>void}){
 return <fieldset className="lower-small"><legend>允许本次组队使用的部门</legend><p className="subcopy">勾选可参与的部门后，AI 按任务选择员工。未勾选时只提出新部门草案；不会修改已有员工或扩大工具权限。</p><div className="organization-tool-options">{departments.map(d=><label key={d.id}><input type="checkbox" checked={allowed.includes(d.id)} disabled={!allowed.includes(d.id)&&allowed.length>=20} onChange={e=>onChange(e.target.checked?[...allowed,d.id]:allowed.filter(id=>id!==d.id))}/>{d.name}</label>)}</div></fieldset>;
}
export function OrganizationRecommendation({plan,existing}:{plan:Plan;existing?:boolean}){
 if(!plan.orchestration&&!plan.deliveryCriteria)return null;
 const names=(ids:string[])=>ids.map(id=>{const task=plan.tasks.find(t=>t.id===id);return plan.agents.find(a=>a.id===task?.assigneeId)?.name??id;}).join('、');
 return <section aria-label="协作方式与交付检查" className="lower-small">
  {plan.orchestration&&<><strong>{existing===undefined?'协作方案':existing?'已有部门组队':'新部门草案'} · {{single:'单人执行与验收',pipeline:'顺序交接',parallel:'并行汇总'}[plan.orchestration.pattern]}</strong><p className="subcopy">{plan.orchestration.rationale}</p></>}
  {!!plan.deliveryCriteria?.length&&<><strong>交付要求与检查者</strong><ul>{plan.deliveryCriteria.map(c=><li key={c.id}><span>{c.description}</span><small style={{display:'block'}}>产出：{names(c.producerTaskIds)} · {c.independent?'独立检查':'检查'}：{names([c.checkTaskId])}</small></li>)}</ul></>}
 </section>;
}
