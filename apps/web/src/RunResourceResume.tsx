import {useEffect,useRef,useState} from 'react';
import {api} from './api.ts';

type Candidate={previewId:string;sourceRunId:string;projectVersion:number;sourceGoalContract:{format:string;sha256:string};ceiling:number;
  taskContinuationLimits?:Record<string,number>;
  proposal:{maxBudget:number;maxModelCalls?:number;contextBytes?:number;taskCallLimits:Record<string,number>;taskBudgetLimits?:Record<string,number>;taskOutputLimits?:Record<string,number>;rationale:string};completedTaskIds:string[]};
const money=(value:number)=>'$'+value.toFixed(6);
type ContinuationTask={id:string;subject:string};
export function resourceContextBytes(value:string,original=64000){
  if(!value.trim())return undefined;
  const bytes=Number(value);
  if(!Number.isSafeInteger(bytes)||bytes<original||bytes>1000000)throw Error(`上下文上限须为 ${original}～1000000 的整数字节数`);
  return bytes;
}
export function resourceContinuationLimits(values:Record<string,string>,tasks?:ContinuationTask[]){
  if(!Object.values(values).some(value=>value.trim()))return undefined;
  if(!tasks?.length||Object.keys(values).some(id=>!tasks.some(task=>task.id===id)))throw Error('请先重新检查恢复条件，再设置本段次数');
  const limits=Object.fromEntries(tasks.map(task=>[task.id,Number(values[task.id])]));
  if(Object.values(limits).some(value=>!Number.isSafeInteger(value)||value<2||value>1000))throw Error('请为全部未完成节点填写 2～1000 的整数，含工作与交接纠正');
  return limits;
}
export function resourceResumeBody(candidate:Candidate,id:string,snapshot:any,retained:boolean){
  if(candidate.sourceRunId!==id||candidate.projectVersion!==snapshot.planVersion||
    candidate.sourceGoalContract.sha256!==snapshot.goalContract?.sha256)throw Error('运行或目标已变化，请重新生成资源方案');
  return {resume:true,retainUncertainCosts:retained,acknowledgeUnknownOperations:false,
    budgetPreviewId:candidate.previewId,confirmation:'APPROVE_RESOURCES_AND_RESUME' as const};
}
export function ResourceResumeConfirmation({candidate,snapshot,retained,disabled,onConfirm,onCancel}:{candidate:Candidate;snapshot:any;
  retained:number;disabled:boolean;onConfirm:()=>void;onCancel:()=>void}){
  return <div className="notice-box lower" role="group" aria-label="确认资源补充与恢复">
    <h3>确认资源补充与恢复</h3><p>原方案 v{snapshot.planVersion} · 只调整本次续跑额度，目标、验收和权限保持。</p>
    <p>项目累计上限 {money(snapshot.policy.maxBudget)} → {money(candidate.proposal.maxBudget)}</p>
    {candidate.proposal.maxModelCalls!==undefined&&<p>项目累计调用上限 {snapshot.policy.maxModelCalls??100} → {candidate.proposal.maxModelCalls}</p>}
    {candidate.proposal.contextBytes!==undefined&&<p>单次上下文上限 {snapshot.policy.contextBytes??64000} → {candidate.proposal.contextBytes} 字节，已按新上限核算费用预留。</p>}
    <p>保留已核验节点：{candidate.completedTaskIds.join('、')||'无'}。保留未知费用预留 {money(retained)}，旧调用次数继续计入。</p>
    {Object.entries(candidate.proposal.taskCallLimits).map(([id,limit])=><p key={id}>{snapshot.tasks.find((task:any)=>task.id===id)?.subject??id} · 调用上限 {snapshot.tasks.find((task:any)=>task.id===id)?.maxModelCalls??snapshot.policy.maxTaskModelCalls??40} → {limit}</p>)}
    {Object.entries(candidate.taskContinuationLimits??{}).map(([id,limit])=><p key={'continuation-'+id}>{snapshot.tasks.find((task:any)=>task.id===id)?.subject??id} · 本段最多新增 {limit} 次调用（重启恢复后继续累计）</p>)}
    {Object.entries(candidate.proposal.taskBudgetLimits??{}).map(([id,limit])=><p key={'budget-'+id}>{snapshot.tasks.find((task:any)=>task.id===id)?.subject??id} · 节点累计费用上限 {money(snapshot.tasks.find((task:any)=>task.id===id)?.maxBudget??snapshot.policy.maxBudget)} → {money(limit)}（仍共享项目总上限）</p>)}
    {Object.entries(candidate.proposal.taskOutputLimits??{}).map(([id,limit])=><p key={'output-'+id}>{snapshot.tasks.find((task:any)=>task.id===id)?.subject??id} · 单次输出上限 {snapshot.tasks.find((task:any)=>task.id===id)?.maxOutputTokens??'原模型额度'} → {limit} Token</p>)}
    {candidate.proposal.taskOutputLimits&&<p>输出上限用于费用预留，最终按实际用量登记；不会每次用满。</p>}
    <p>{candidate.proposal.rationale}</p><p>只继续未完成节点；测试命令仍须逐次批准。原运行及项目草案保留。</p>
    <button type="button" disabled={disabled} onClick={onCancel}>取消候选</button>
    <button type="button" className="primary" disabled={disabled} onClick={onConfirm}>确认额度并恢复未完成节点</button>
  </div>;
}
export function RunResourceResume({id,snapshot,disabled,retained,retainUncertainCosts,continuationTasks}:{id:string;snapshot:any;disabled:boolean;
  retained:number;retainUncertainCosts:boolean;continuationTasks?:ContinuationTask[]}){
  const [ceiling,setCeiling]=useState(String(snapshot.policy.maxBudget)),[maxCost,setMaxCost]=useState('0.003');
  const [totalCalls,setTotalCalls]=useState(String(snapshot.policy.maxModelCalls??100)),[taskCalls,setTaskCalls]=useState(String(snapshot.policy.maxTaskModelCalls??40));
  const [outputLimit,setOutputLimit]=useState(String(Math.max(16384,...snapshot.tasks.map((t:any)=>t.maxOutputTokens??0))));
  const [contextBytes,setContextBytes]=useState('');
  const [modelId,setModelId]=useState(snapshot.modelRoutes?.[0]?.id??''),[candidate,setCandidate]=useState<Candidate>();
  const [continuation,setContinuation]=useState<Record<string,string>>({});
  const [busy,setBusy]=useState(false),[error,setError]=useState('');const active=useRef(true),inFlight=useRef(false);
  useEffect(()=>{active.current=true;return()=>{active.current=false;};},[]);
  const invalidate=()=>{setCandidate(undefined);setError('');};
  const generate=async()=>{
    if(disabled||inFlight.current)return;inFlight.current=true;setBusy(true);invalidate();
    try{const taskContinuationLimits=resourceContinuationLimits(continuation,continuationTasks),requestedContext=resourceContextBytes(contextBytes,snapshot.policy.contextBytes??64000);
      const result=await api<Candidate>('/runs/'+id+'/resource-proposal','POST',{modelId,maxBudget:Number(ceiling),maxPlanningCost:Number(maxCost),retainUncertainCosts,maxModelCalls:Number(totalCalls),maxTaskModelCalls:Number(taskCalls),maxTaskOutputTokens:Number(outputLimit),...(requestedContext===undefined?{}:{contextBytes:requestedContext}),...(taskContinuationLimits?{taskContinuationLimits}:{})});
      resourceResumeBody(result,id,snapshot,retainUncertainCosts);if(active.current)setCandidate(result);
    }catch(error){if(active.current)setError((error as Error).message);}finally{inFlight.current=false;if(active.current)setBusy(false);}
  };
  const confirm=async()=>{
    if(disabled||inFlight.current||!candidate)return;inFlight.current=true;setBusy(true);setError('');
    try{const result=await api<{id:string}>('/runs/'+id+'/retry','POST',resourceResumeBody(candidate,id,snapshot,retainUncertainCosts));
      if(active.current){location.hash='run/'+result.id;location.reload();}
    }catch(error){if(active.current)setError((error as Error).message);}finally{inFlight.current=false;if(active.current)setBusy(false);}
  };
  return <details className="lower"><summary>AI 调整续跑额度</summary>
    <p>输入你允许的项目累计上限。AI 规划未完成节点的调用次数、费用和单次输出额度；生成候选不启动员工，确认后才续跑。</p>
    <p>原费用与预留继续占用额度。资源规划自身也收费，仍须装入原方案剩余预算；额度不足时不会发送请求。</p>
    <label>规划模型 <select value={modelId} disabled={busy||disabled} onChange={event=>{setModelId(event.target.value);invalidate();}}>{snapshot.modelRoutes?.map((model:any)=><option key={model.id} value={model.id}>{model.name??model.wireModel}</option>)}</select></label>
    <label>允许的项目累计上限（美元） <input type="number" min={snapshot.policy.maxBudget} step="0.01" value={ceiling} disabled={busy||disabled} onChange={event=>{setCeiling(event.target.value);invalidate();}}/></label>
    <label>允许的项目累计调用次数 <input type="number" min={snapshot.policy.maxModelCalls??100} max="1000" step="1" value={totalCalls} disabled={busy||disabled} onChange={event=>{setTotalCalls(event.target.value);invalidate();}}/></label>
    <label>允许的单节点累计调用次数 <input type="number" min={snapshot.policy.maxTaskModelCalls??40} max="1000" step="1" value={taskCalls} disabled={busy||disabled} onChange={event=>{setTaskCalls(event.target.value);invalidate();}}/></label>
    <details><summary>限制本段新增调用（可选）</summary>
      <p>留空沿用现有次数规则。需要限定一次续验时，为全部未完成节点填写新增次数；确认后固定，重启不会重置，费用仍受上方总额约束。</p>
      {!continuationTasks?.length&&<p>先点击上方“检查恢复条件”，获取未完成节点后即可填写。</p>}
      {continuationTasks?.map(task=><label key={task.id}>{task.subject} · 本段最多新增调用次数 <input type="number" min="2" max="1000" step="1" value={continuation[task.id]??''} disabled={busy||disabled} onChange={event=>{setContinuation({...continuation,[task.id]:event.target.value});invalidate();}}/></label>)}
      {Object.entries(snapshot.resourceApproval?.taskCallCeilings??{}).map(([id,limit])=><p key={id}>{snapshot.tasks.find((task:any)=>task.id===id)?.subject??id} · 已封存累计上限 {String(limit)} 次</p>)}
    </details>
    <label>允许的单次输出上限（Token） <input type="number" min="1" max="32768" step="1" value={outputLimit} disabled={busy||disabled} onChange={event=>{setOutputLimit(event.target.value);invalidate();}}/></label>
    <p>AI 按任务选择输出空间，可考虑 8192 或 16384；仍受模型支持、上下文和原费用门禁限制。</p>
    <label>本次上下文上限（字节，可选） <input type="number" min={snapshot.policy.contextBytes??64000} max="1000000" step="1" placeholder={String(snapshot.policy.contextBytes??64000)} value={contextBytes} disabled={busy||disabled} onChange={event=>{setContextBytes(event.target.value);invalidate();}}/></label>
    <p>留空沿用原上限。容纳更多资料会提高每次请求的费用预留；生成候选时同时核对模型容量与项目预算。</p>
    <label>本次 AI 规划最多费用（美元） <input type="number" min="0.000001" step="0.001" value={maxCost} disabled={busy||disabled} onChange={event=>{setMaxCost(event.target.value);invalidate();}}/></label>
    <button type="button" disabled={busy||disabled||!modelId} onClick={()=>void generate()}>{busy?'正在处理，请等待':'生成资源候选'}</button>
    {error&&<p className="banner error" role="alert">{error}</p>}
    {candidate&&<ResourceResumeConfirmation candidate={candidate} snapshot={snapshot} retained={retained} disabled={busy||disabled} onConfirm={()=>void confirm()} onCancel={invalidate}/>}
  </details>;
}
