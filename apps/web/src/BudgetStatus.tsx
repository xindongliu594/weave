import { runCostSummary } from './run-cost.ts';

export function BudgetStatus({snapshot,events}:{snapshot:any;events:any[]}) {
 const cost=runCostSummary(snapshot,events);
 const notices=events.filter(event=>event.type==='budget/warning'||event.type==='budget/stopped');
 return <div className="lower">
  {cost.total!==undefined?<><p><strong>项目累计费用：${cost.total.toFixed(6)}</strong> / 预算 ${cost.limit!.toFixed(6)} · 剩余 ${Math.max(0,cost.limit!-cost.total).toFixed(6)}</p><p className="subcopy">本次运行 ${cost.current.toFixed(6)} · 启动前已用 ${cost.inherited!.toFixed(6)}（含方案规划及此前执行）。按配置单价与已记录用量计算，以中转站账单为准；待核对调用可能尚未计入。</p></>:<p>本次已记录费用：${cost.current.toFixed(6)}。按配置单价计算，以中转站账单为准。</p>}
  {snapshot.policy&&snapshot.budgetVersion===1&&<p className="subcopy">方案调用上限 {snapshot.policy.maxModelCalls??100} 次；每员工每任务默认 {snapshot.policy.maxTaskModelCalls??40} 次。备用模型调用也计次，同一方案重试保留已用次数与任务费用。</p>}
  {notices.map(event=><div key={event.seq} className="notice-box" role={event.type==='budget/stopped'?'alert':'status'}>
   <div><strong>{event.data.scope==='task'?'任务 '+(snapshot.tasks?.find((t:any)=>t.id===event.data.taskId)?.subject??event.data.taskId):'项目累计费用'} · {event.type==='budget/stopped'?'已停止后续执行':`达到 ${event.data.threshold}% 预算`}</strong>
    <p>已记录 ${Number(event.data.spent).toFixed(6)} / ${Number(event.data.limit).toFixed(6)} · 已调用 {event.data.calls} / {event.data.maxCalls} 次</p>
    <p>{event.data.message??(event.data.threshold>=100?'费用已达到上限，不再启动新模型请求。':event.data.threshold>=90?'停止自动切换备用模型，并限制重试。':'请关注剩余任务与费用。')}</p>
   </div>
  </div>)}
 </div>;
}
