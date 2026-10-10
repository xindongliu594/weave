import {useEffect,useRef,useState} from 'react';
import {api} from './api.ts';

type Candidate={previewId:string;sourceRunId:string;projectVersion:number;sourceGoalContract:{format:string;sha256:string};ceiling:number;
  proposal:{maxBudget:number;taskCallLimits:Record<string,number>;rationale:string};completedTaskIds:string[]};
const money=(value:number)=>'$'+value.toFixed(6);
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
    <p>保留已核验节点：{candidate.completedTaskIds.join('、')||'无'}。保留未知费用预留 {money(retained)}，旧调用次数继续计入。</p>
    {Object.entries(candidate.proposal.taskCallLimits).map(([id,limit])=><p key={id}>{snapshot.tasks.find((task:any)=>task.id===id)?.subject??id} · 调用上限 {snapshot.tasks.find((task:any)=>task.id===id)?.maxModelCalls??snapshot.policy.maxTaskModelCalls??40} → {limit}</p>)}
    <p>{candidate.proposal.rationale}</p><p>只继续未完成节点；测试命令仍须逐次批准。原运行及项目草案保留。</p>
    <button type="button" disabled={disabled} onClick={onCancel}>取消候选</button>
    <button type="button" className="primary" disabled={disabled} onClick={onConfirm}>确认额度并恢复未完成节点</button>
  </div>;
}
export function RunResourceResume({id,snapshot,disabled,retained,retainUncertainCosts}:{id:string;snapshot:any;disabled:boolean;
  retained:number;retainUncertainCosts:boolean}){
  const [ceiling,setCeiling]=useState(String(snapshot.policy.maxBudget)),[maxCost,setMaxCost]=useState('0.003');
  const [modelId,setModelId]=useState(snapshot.modelRoutes?.[0]?.id??''),[candidate,setCandidate]=useState<Candidate>();
  const [busy,setBusy]=useState(false),[error,setError]=useState('');const active=useRef(true),inFlight=useRef(false);
  useEffect(()=>{active.current=true;return()=>{active.current=false;};},[]);
  const invalidate=()=>{setCandidate(undefined);setError('');};
  const generate=async()=>{
    if(disabled||inFlight.current)return;inFlight.current=true;setBusy(true);invalidate();
    try{const result=await api<Candidate>('/runs/'+id+'/resource-proposal','POST',{modelId,maxBudget:Number(ceiling),maxPlanningCost:Number(maxCost),retainUncertainCosts});
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
    <p>输入你允许的项目累计上限。AI 只规划未完成节点的调用额度；生成候选不启动员工，确认后才续跑。</p>
    <p>原费用与预留继续占用额度。资源规划自身也收费，仍须装入原方案剩余预算；额度不足时不会发送请求。</p>
    <label>规划模型 <select value={modelId} disabled={busy||disabled} onChange={event=>{setModelId(event.target.value);invalidate();}}>{snapshot.modelRoutes?.map((model:any)=><option key={model.id} value={model.id}>{model.name??model.wireModel}</option>)}</select></label>
    <label>允许的项目累计上限（美元） <input type="number" min={snapshot.policy.maxBudget} step="0.01" value={ceiling} disabled={busy||disabled} onChange={event=>{setCeiling(event.target.value);invalidate();}}/></label>
    <label>本次 AI 规划最多费用（美元） <input type="number" min="0.000001" step="0.001" value={maxCost} disabled={busy||disabled} onChange={event=>{setMaxCost(event.target.value);invalidate();}}/></label>
    <button type="button" disabled={busy||disabled||!modelId} onClick={()=>void generate()}>{busy?'正在处理，请等待':'生成资源候选'}</button>
    {error&&<p className="banner error" role="alert">{error}</p>}
    {candidate&&<ResourceResumeConfirmation candidate={candidate} snapshot={snapshot} retained={retained} disabled={busy||disabled} onConfirm={()=>void confirm()} onCancel={invalidate}/>}
  </details>;
}
