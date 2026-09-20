export function BudgetStatus({snapshot,events}:{snapshot:any;events:any[]}) {
 const notices=events.filter(event=>event.type==='budget/warning'||event.type==='budget/stopped');
 if(!snapshot.policy||snapshot.budgetVersion!==1)return null;
 return <div className="lower">
  <p className="subcopy">方案调用上限 {snapshot.policy.maxModelCalls??100} 次；每员工每任务默认 {snapshot.policy.maxTaskModelCalls??40} 次。备用模型调用也计次，同一方案重试保留已用次数与任务费用。</p>
  {notices.map(event=><div key={event.seq} className="notice-box" role={event.type==='budget/stopped'?'alert':'status'}>
   <div><strong>{event.data.scope==='task'?'任务 '+(snapshot.tasks?.find((t:any)=>t.id===event.data.taskId)?.subject??event.data.taskId):'项目累计费用'} · {event.type==='budget/stopped'?'已停止后续执行':`达到 ${event.data.threshold}% 预算`}</strong>
    <p>已记录 ${Number(event.data.spent).toFixed(6)} / ${Number(event.data.limit).toFixed(6)} · 已调用 {event.data.calls} / {event.data.maxCalls} 次</p>
    <p>{event.data.message??(event.data.threshold>=100?'费用已达到上限，不再启动新模型请求。':event.data.threshold>=90?'停止自动切换备用模型，并限制重试。':'请关注剩余任务与费用。')}</p>
   </div>
  </div>)}
 </div>;
}
