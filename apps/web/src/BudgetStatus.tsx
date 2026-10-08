import { runCostSummary } from './run-cost.ts';
import type { CostCarryover, CostReadiness } from './CostCarryoverChoice.tsx';

const noticeNumber=(value:unknown)=>typeof value==='number'&&Number.isFinite(value)?value:undefined;
const noticeMoney=(value:number|undefined)=>value===undefined?'未记录':`$${value.toFixed(6)}`;

export function BudgetStatus({snapshot,events,costReadiness}:{snapshot:any;events:any[];costReadiness?:CostReadiness}) {
 const cost=runCostSummary(snapshot,events);
 const carryover:CostCarryover|undefined=snapshot.costCarryover;
 const inherited=carryover&&Number.isFinite(carryover.recordedCost)?carryover.recordedCost:cost.inherited;
 const total=costReadiness?.recordedCost??(inherited===undefined?undefined:inherited+cost.current);
 const notices=events.filter(event=>event.type==='budget/warning'||event.type==='budget/stopped');
 return <div className="lower">
  {total!==undefined&&cost.limit!==undefined?<><p><strong>项目累计费用：${total.toFixed(6)}</strong> / 预算 ${cost.limit.toFixed(6)}{costReadiness?` · 未结算预留 $${costReadiness.reserved.toFixed(6)} · 可用 $${costReadiness.availableBudget.toFixed(6)}`:carryover?' · 当前可用预算请查看项目费用状态':` · 剩余 $${Math.max(0,cost.limit-total).toFixed(6)}（未扣除待核对预留）`}</p><p className="subcopy">本次运行 ${cost.current.toFixed(6)}{inherited!==undefined&&` · 启动前已用 $${inherited.toFixed(6)}（含方案规划及此前执行）`}。按配置单价与已记录用量计算，以中转站账单为准；待核对调用可能尚未计入。</p></>:<p>本次已记录费用：${cost.current.toFixed(6)}。按配置单价计算，以中转站账单为准。</p>}
  {carryover?.retained&&<details className="lower-small"><summary>本次批准时保留了未知费用预留</summary><p className="subcopy">以下为批准时的费用审核依据；之后的账单核对可能改变当前费用状态。本记录不代表再次同意继续执行。</p><p>启动前已记录 ${carryover.recordedCost.toFixed(6)} · 保留预留 ${carryover.reserved.toFixed(6)} · 当时可用 ${carryover.availableBudget.toFixed(6)}</p>{carryover.receipts.map(receipt=><p key={receipt.id}><code>{receipt.id}</code> · 预留 ${receipt.amount.toFixed(6)}{receipt.runId&&<> · <a href={'#run/'+receipt.runId}>原运行</a></>}</p>)}</details>}
  {snapshot.policy&&snapshot.budgetVersion===1&&<p className="subcopy">方案调用上限 {snapshot.policy.maxModelCalls??100} 次；每员工每任务默认 {snapshot.policy.maxTaskModelCalls??40} 次。备用模型调用也计次，同一方案重试保留已用次数与任务费用。</p>}
  {notices.map(event=>{
   const spent=noticeNumber(event.data.spent),reserved=noticeNumber(event.data.reserved);
   const occupied=spent!==undefined&&reserved!==undefined?spent+reserved:undefined;
   const calls=noticeNumber(event.data.calls),maxCalls=noticeNumber(event.data.maxCalls);
   return <div key={event.seq} className="notice-box" role={event.type==='budget/stopped'?'alert':'status'}>
   <div><strong>{event.data.scope==='task'?'任务 '+(snapshot.tasks?.find((t:any)=>t.id===event.data.taskId)?.subject??event.data.taskId):'项目'} · 历史预算通知 · {event.type==='budget/stopped'?'当时停止后续执行':`达到 ${event.data.threshold}% 预算`}</strong>
    <p>{occupied!==undefined?`通知时预算占用（含预留） ${noticeMoney(occupied)}`:`通知时预算占用未完整记录（已占用 ${noticeMoney(spent)}；在途预留 ${noticeMoney(reserved)}）`} / {noticeMoney(noticeNumber(event.data.limit))} · 当时已调用 {calls??'未记录'} / {maxCalls??'未记录'} 次</p>
    <p className="subcopy">这是历史阈值通知，请结合上方当前费用状态查看。</p>
    <p>{event.data.message??(event.data.threshold>=100?'费用已达到上限，不再启动新模型请求。':event.data.threshold>=90?'停止自动切换备用模型，并限制重试。':'请关注剩余任务与费用。')}</p>
   </div>
  </div>})}
 </div>;
}
