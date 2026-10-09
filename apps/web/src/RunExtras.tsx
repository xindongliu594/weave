import { useEffect,useReducer,useRef,useState } from 'react';
import { api } from './api.ts';
import { downloadJSON } from './SettingsCenter.tsx';
import { BudgetStatus } from './BudgetStatus.tsx';
import { CostContinuation, CostCarryoverChoice, runContinuationBlocked, type CostReadiness, type CostContinuationState } from './CostCarryoverChoice.tsx';
import { RecoveryConditionsView, recoveryConditionsKey, recoveryConditionsResultKey, recoveryConditionsAllow, type RecoveryConditions } from './RecoveryConditions.tsx';
import {hasUnplannedTasks,planningRequiredMessage} from '../../../packages/contracts/index.ts';
import { handoffNotices } from './run-handoff.ts';
import { runTaskView } from './run-detail-view.ts';
import { runResultView } from './run-result-view.ts';
import { createRunRecoveryConfirmation, type RunRecoveryContext, type RunRecoveryIntent } from './run-recovery-confirmation.ts';
import {RunInheritedEvidence} from './RunInheritedEvidence.tsx';
import type {RunLineageEvidence} from '../../../packages/contracts/run-lineage-evidence.ts';
export type RunExtrasErrors = { id: string; operation: string; refresh: string };
type RunExtrasErrorEvent = { id: string; type: 'reset' | 'operation' | 'refresh-failed' | 'refresh-succeeded'; message?: string };
export function runExtrasErrorReducer(state: RunExtrasErrors, event: RunExtrasErrorEvent): RunExtrasErrors {
 if(event.type==='reset')return {id:event.id,operation:'',refresh:''};
 if(event.id!==state.id)return state;
 if(event.type==='operation')return {...state,operation:event.message??''};
 return {...state,refresh:event.type==='refresh-succeeded'?'':event.message??''};
}
const terminalRunNames:Record<string,string>={completed:'已完成',failed:'失败',cancelled:'已取消',interrupted:'已中断'};
const phaseNames:Record<string,string>={working:'工作中',executing_tool:'执行工具',waiting_model:'等待模型',waiting_coordinator:'等待经理处理回复',waiting_approval:'等待你的审批',waiting_capacity:'等待执行名额',idle_unfinished:'任务未完成，员工已空闲'};
export function RunEmployeeStatus({status,runtime,employeeName,taskName}:{status:string;runtime:any;employeeName:(id:string)=>string;taskName:(id:string)=>string}){
 if(!runtime?.employees?.length)return null;
 const terminal=terminalRunNames[status];
 const rows=()=>runtime.employees.map((employee:any)=><p key={employee.sessionId}>{employeeName(employee.agentId)} · {phaseNames[employee.phase]??employee.phase} · {taskName(employee.taskId)}</p>);
 return <div className="lower"><h3>{terminal?'员工状态 · 本次运行'+terminal:'员工运行状态'}</h3>
  {terminal?<><p>本次运行已结束，停止前的等待状态不表示员工现在仍在执行。费用和外部操作结果仍须按下方记录核对。</p><details><summary>查看停止前原始员工状态（历史记录）</summary>{rows()}</details></>:rows()}
 </div>;
}
export function TerminalRunChecks({status,readiness,unknown,pendingApprovals,onRefresh}:{status:string;readiness?:CostReadiness;unknown:any[];pendingApprovals:number;onRefresh:()=>void}){
 if(!terminalRunNames[status]||readiness&&readiness.pendingCount===0&&readiness.uncertainCount===0&&!unknown.length&&!pendingApprovals)return null;
 return <div className="notice-box run-recovery lower" role="status"><strong>运行已结束，以下状态仍需核对</strong>
  {!readiness?<p>当前费用状态尚未读取，不能据此认为全部费用已结算。</p>:<>
   {readiness.pendingCount>0&&<p>仍有 {readiness.pendingCount} 笔进行中的模型费用记录；请等待实际结果并核对。</p>}
   {readiness.uncertainCount>0&&<p>仍有 {readiness.uncertainCount} 笔费用待核对；预留仍占用原预算。</p>}
  </>}
  {unknown.length>0&&<><p>仍有 {unknown.length} 项外部操作结果未知；运行结束不代表这些操作已成功或已撤销，不会自动重放。</p>{unknown.map((operation:any)=><p key={operation.callId}>{operation.name} · <code>{operation.callId}</code></p>)}<p>请核对操作回执及完整追溯记录。</p></>}
  {pendingApprovals>0&&<p>原运行仍有 {pendingApprovals} 项待处理审批记录，请刷新核对；终态不能继续批准旧操作。</p>}
  <a href="#usage">核对用量与费用</a><button type="button" onClick={onRefresh}>刷新核对状态</button>
 </div>;
}
export function RunRecoveryActions({context,busy,checking,check,submit,onError}:{context:RunRecoveryContext;busy:boolean;checking:boolean;check:(intent:RunRecoveryIntent)=>Promise<RecoveryConditions|undefined>;submit:(intent:RunRecoveryIntent)=>Promise<{id:string}>;onError:(message:string)=>void}){
 const controller=useRef(createRunRecoveryConfirmation()),latest=useRef(context);latest.current=context;controller.current.sync(context);
 const active=useRef(true);
 const [,render]=useState(0),[submitting,setSubmitting]=useState(false);
 useEffect(()=>{active.current=true;return()=>{active.current=false;controller.current.cancel();};},[]);
 const intent=controller.current.intent;
 const open=(resume:boolean)=>{if(!busy&&!checking&&controller.current.open(latest.current,resume))render(value=>value+1);};
 const cancel=()=>{controller.current.cancel();render(value=>value+1);};
 const confirm=async()=>{
  if(busy||checking||controller.current.inFlight||!controller.current.intent)return;
  onError('');
  setSubmitting(true);
  try{await controller.current.confirm({current:()=>latest.current,check,dispatch:submit,navigate:runId=>{location.hash='run/'+runId;location.reload();}});}
  catch(error){if(active.current&&latest.current.runId===context.runId)onError((error as Error).message);}
  finally{if(active.current)setSubmitting(false);}
 };
 return <>
  <button type="button" disabled={busy||checking||submitting||!context.allowResume} onClick={()=>open(true)}>恢复未完成任务</button>
  <button type="button" disabled={busy||checking||submitting||!context.allowRetry} onClick={()=>open(false)}>完整重试</button>
  {intent&&<RunRecoveryConfirmationPanel intent={intent} submitting={submitting} disabled={busy||checking||submitting||!(intent.resume?context.allowResume:context.allowRetry)} onCancel={cancel} onConfirm={()=>void confirm()}/>}
 </>;
}
export function RunRecoveryConfirmationPanel({intent,submitting,disabled,onCancel,onConfirm}:{intent:RunRecoveryIntent;submitting:boolean;disabled:boolean;onCancel:()=>void;onConfirm:()=>void}){
 return <div className="notice-box run-recovery lower" role="group" aria-label={intent.resume?'确认恢复未完成任务':'确认完整重试'}>
   <h3>{intent.resume?'确认恢复未完成任务':'确认完整重试'}</h3>
   <p>原运行 <span className="trace-id">{intent.runId}</span> · 原方案 v{intent.version}</p>
   <p>原项目费用上限不变，历史费用和调用次数继续计入；{intent.retainUncertainCosts?'未知费用预留继续占用原预算。':'费用仍按原账本核对。'}</p>
   <p>{intent.resume?'保留已核验的完成节点和文件，只继续未完成任务。':'将重新执行全部任务，可能重复之前的操作，并再次产生费用；原完成记录和文件仍保留在原运行档案。'}</p>
   <p>确认后会重新检查费用、方案和未知操作的核对选择；操作审批与预算规则仍然生效。</p>
   {submitting&&<p role="status">正在重新检查并提交，请等待结果，不要重复提交。取消此确认不会撤销已经提交的运行。</p>}
   <button type="button" onClick={onCancel}>取消</button>
   <button type="button" className="primary" disabled={disabled} onClick={onConfirm}>{intent.resume?'确认恢复':'确认完整重试'}</button>
  </div>;
}
export function RunExtras({id,status,integrity,events,traceEvents,snapshot,recovery,runError,onOpenProject,onRefreshDetail}:{id:string;status:string;integrity?:string;events:any[];traceEvents?:any[];snapshot:any;recovery?:{unknownOperations:any[];checkpointBlocked?:string;planningBlocked?:string;costBlocked?:string;costReadiness?:CostReadiness};runError?:string;onOpenProject:(id:string)=>void;onRefreshDetail?:()=>Promise<void>}){
 const currentId=useRef(id);currentId.current=id;
 const [errors,dispatchError]=useReducer(runExtrasErrorReducer,{id,operation:'',refresh:''});
 const error=errors.id===id?(errors.operation||errors.refresh):'';
 const setError=(message:string)=>dispatchError({id,type:'operation',message});
 const [citation,setCitation]=useState<any>(null);
 const [acknowledged,setAcknowledged]=useState(false);
 const [checkedRecovery,setCheckedRecovery]=useState<{key:string;data:RecoveryConditions}>();
 const [checkingRecovery,setCheckingRecovery]=useState(false),[recoveryError,setRecoveryError]=useState('');
 const recoveryInFlight=useRef(false);
 const [localOperations,setLocalOperations]=useState<any[]>([]);
 const [lineage,setLineage]=useState<RunLineageEvidence>(),[lineageError,setLineageError]=useState('');
 const lineageRequest=useRef(0);
 async function refreshLineage(){
  if(snapshot.recovery?.version!==1)return;
  const request=++lineageRequest.current;
  try{const value=await api<RunLineageEvidence>('/runs/'+id+'/lineage-evidence');if(currentId.current===id&&request===lineageRequest.current){setLineage(value);setLineageError('');}}
  catch(error){if(currentId.current===id&&request===lineageRequest.current){setLineage(undefined);setLineageError((error as Error).message);}}
 }
 // Ancestry journals can be large. Read once per run/status change or explicit
 // refresh, never from the two-second approvals/cost polling loop.
 useEffect(()=>{setLineage(undefined);setLineageError('');void refreshLineage();return()=>{lineageRequest.current++;};},[id,status,snapshot.planVersion]);
 const unknown=recovery?.unknownOperations??[];
 const unknownKey=JSON.stringify(unknown.map((operation:any)=>operation.callId).sort());
 useEffect(()=>{setAcknowledged(false);setCheckedRecovery(undefined);setRecoveryError('');},[id,unknownKey]);
 const [approvals,setApprovals]=useState<any[]>([]),[artifacts,setArtifacts]=useState<any[]>([]),[spaces,setSpaces]=useState<any[]>([]),[spaceId,setSpaceId]=useState(''),[busy,setBusy]=useState(false);
 async function refresh(canCommit=()=>currentId.current===id){const results=await Promise.allSettled([api<any[]>('/approvals?runId='+id).then(value=>{if(canCommit())setApprovals(value);}),api<any[]>('/runs/'+id+'/artifacts').then(value=>{if(canCommit())setArtifacts(value);}),snapshot.executionTarget?.kind==='local'?api<any[]>('/runs/'+id+'/local-operations').then(value=>{if(canCommit())setLocalOperations(value);}):Promise.resolve()]);const failed=results.find((result):result is PromiseRejectedResult=>result.status==='rejected');if(failed)throw failed.reason;if(canCommit())dispatchError({id,type:'refresh-succeeded'});}
 useEffect(()=>{setCitation(null);dispatchError({id,type:'reset'});setApprovals([]);setArtifacts([]);setLocalOperations([]);let active=true,timer:ReturnType<typeof setTimeout>;const canCommit=()=>active&&currentId.current===id;const poll=async()=>{try{await refresh(canCommit);}catch(e){if(canCommit())dispatchError({id,type:'refresh-failed',message:(e as Error).message});}finally{if(active)timer=setTimeout(()=>void poll(),2000);}};void poll();api<any[]>('/knowledge/spaces').then(value=>{if(canCommit())setSpaces(value);}).catch(e=>{if(canCommit())setError(e.message);});return()=>{active=false;clearTimeout(timer);};},[id]);
 async function act(fn:()=>Promise<void>,refreshOnly=false){setBusy(true);if(!refreshOnly)setError('');try{await fn();try{await refresh();}catch(e){dispatchError({id,type:'refresh-failed',message:(e as Error).message});}}catch(e){if(refreshOnly)dispatchError({id,type:'refresh-failed',message:(e as Error).message});else setError((e as Error).name==='TimeoutError'?'预览读取超时，请重试；已有文件和后台执行仍保留。':(e as Error).message);}finally{setBusy(false);}}
 async function checkRecovery(costs:CostContinuationState,acknowledge=acknowledged){
  if(recoveryInFlight.current)return;
  recoveryInFlight.current=true;setCheckingRecovery(true);setRecoveryError('');
  try{
   const data=await api<RecoveryConditions>('/runs/'+id+'/recovery-check?retainUncertainCosts='+costs.retainUncertainCosts+'&acknowledgeUnknownOperations='+acknowledge);
   if(currentId.current!==id)return;
   setCheckedRecovery({data,key:recoveryConditionsResultKey(data)});
   return data;
  }catch(failure){if(currentId.current===id){setCheckedRecovery(undefined);setRecoveryError((failure as Error).message);}}
  finally{recoveryInFlight.current=false;setCheckingRecovery(false);}
 }
 const team=events.findLast(e=>['team/snapshot','team/checkpoint'].includes(e.type))?.data;const finished=events.findLast(e=>e.type==='run/finished')?.data;
 const stopMessage=finished?.message||runError||'请查看下方任务结果和执行记录。';
 const readableStop=/\"code\":\"ABORTED\"/.test(stopMessage)?'执行调用被中断，已完成任务和文件保留。请核对下方费用状态和追溯记录，再恢复未完成任务。':stopMessage;
 const planningBlocked=recovery?.planningBlocked??(hasUnplannedTasks({tasks:snapshot.approvedTasks??snapshot.tasks??[]})?planningRequiredMessage:undefined);
 const tasks=runTaskView(id,snapshot,events,traceEvents);
 const result=runResultView(id,status,integrity,snapshot,events,traceEvents,lineage);
 const failedTasks=tasks.filter((task:any)=>task.status==='failed'&&typeof task.output==='string'&&task.output.trim());
 const employeeName=(agentId:string)=>snapshot.agents?.find((agent:any)=>agent.id===agentId)?.name??agentId;
 const taskName=(taskId:string)=>tasks.find((task:any)=>task.id===taskId||task.runtimeTaskId===taskId)?.subject??snapshot.tasks?.find((task:any)=>task.id===taskId)?.subject??taskId;
 const activeTasks=tasks.filter((task:any)=>['claimed','in_progress'].includes(task.status));
 const executing=['running','unfinished'].includes(status);
 const terminal=!!terminalRunNames[status];
 const taskStates:Record<string,string>={pending:'待调度',claimed:'已分配',in_progress:'执行中',completed:'已完成',awaiting_acceptance:'等待交接核验',failed:'失败',cancelled:'已取消',blocked:'被阻塞'};
 const toolNames:Record<string,string>={terminal:'执行开发命令',terminal_test:'运行测试命令',artifact_write:'写入交付文件',filesystem:'读取工作文件',knowledge_search:'检索知识',knowledge_read:'读取知识原文'};
 const tests=localOperations.filter(operation=>operation.payload.name==='terminal_test'&&operation.result?.exitCode!==undefined);
 const citations=events.filter(e=>e.type==='knowledge/citation').flatMap(e=>e.data.sources??[]);
 const handoff=handoffNotices(events,tasks);
 const escalation=events.findLast(e=>e.type==='quality/escalated')?.data;
 const rework=events.filter(e=>e.type==='quality/rework-created');
 const runtime=events.findLast(e=>e.type==='runtime/status')?.data;
 const anomaly=events.findLast(e=>e.type==='runtime/anomaly')?.data;
 const isolation=localOperations.find(operation=>operation.result?.ok&&operation.result.execution?.kind==='openshell')?.result.execution;
 const anomalyNames:Record<string,string>={REPEATED_ACTION:'相同动作反复出现',REPEATED_ERROR:'同类错误连续出现',NO_PROGRESS:'长时间没有有效进展',EMPLOYEE_IDLE:'员工已空闲，任务尚未完成',OUTCOME_UNKNOWN:'操作结果需要核对'};
 const renderApproval=(a:any)=><div className="knowledge-result" key={a.id}><strong>{employeeName(a.agentId)} · {toolNames[a.tool]??a.tool} · {({pending:'等待审批',approved:'已批准',denied:'已拒绝',cancelled:'已取消'}as any)[a.status]}</strong><pre className="product-pre">{JSON.stringify(a.arguments,null,2)}</pre>{a.status==='pending'&&<><button disabled={busy||terminal} className="primary" onClick={()=>void act(async()=>{await api('/approvals/'+a.id,'POST',{decision:'approved'});})}>批准这次操作</button><button disabled={busy||terminal} onClick={()=>void act(async()=>{await api('/approvals/'+a.id,'POST',{decision:'denied'});})}>拒绝</button></>}</div>;
 return <CostContinuation key={id} projectId={snapshot.projectId} identity={id} initial={recovery?.costReadiness} budgetLimit={snapshot.policy?.maxBudget}>{costs=>{
 const checkKey=recoveryConditionsKey(id,snapshot.planVersion,costs.readiness,costs.retainUncertainCosts,acknowledged,unknown.map((operation:any)=>operation.callId));
 const recoveryStale=!!checkedRecovery&&checkedRecovery.key!==checkKey;
 return <section className="panel padded lower"><div className="section-title"><h2>任务、交付物与审批</h2><div><button disabled={busy} onClick={()=>void act(async()=>{await onRefreshDetail?.();await refreshLineage();costs.refresh();},true)}>刷新审批与交付</button><button onClick={()=>void act(async()=>downloadJSON(await api('/runs/'+id+'/export'),'run-'+id+'.json'))}>导出完整追溯</button></div></div>{error&&<p className="banner error" role="alert">{error}</p>}<BudgetStatus snapshot={snapshot} events={events} costReadiness={costs.readiness}/>{snapshot.resumedFrom&&<p>恢复自 <a href={'#run/'+snapshot.resumedFrom}>{snapshot.resumedFrom}</a></p>}
 {activeTasks.length>0&&<p role="status"><strong>{executing?'当前执行：':'停止时节点：'}</strong>{activeTasks.map((task:any)=>task.subject+'（'+employeeName(task.assignee)+'）').join('、')}</p>}
 {!terminal&&approvals.some(approval=>approval.status==='pending')&&<p className="notice-box" role="status">有 {approvals.filter(approval=>approval.status==='pending').length} 项操作等待你审批。请查看下方员工申请的具体命令。</p>}
 <TerminalRunChecks status={status} readiness={costs.readiness} unknown={unknown} pendingApprovals={approvals.filter(approval=>approval.status==='pending').length} onRefresh={()=>void act(async()=>{await onRefreshDetail?.();costs.refresh();},true)}/>
 {snapshot.demo?.fixture&&<p className="notice-box">Todo 示例在本机独立演示目录执行，仅运行预置 Node 测试。模型响应固定；下方命令输出和交付物来自实际执行。</p>}
 {snapshot.recovery?.version===1&&<details className="lower"><summary>断点恢复 · 保留 {snapshot.recovery.completed.length} 项已完成任务</summary><p>任务关系、历史摘要和工作文件已带入本次运行。员工按需查阅历史，未完成任务重新验证；原审批不会重复使用。</p><p><a href={'#run/'+snapshot.recovery.sourceRunId}>查看上一次运行</a></p>{Object.values(snapshot.recovery.nodes).map((node:any)=><div className="knowledge-result" key={node.taskId}><strong>{snapshot.tasks.find((task:any)=>task.id===node.taskId)?.subject??node.taskId} · {node.status==='completed'?'沿用已完成结果':'从工作现场继续验证'}</strong>{node.output&&<p>{node.output}</p>}{node.errors?.length>0&&<p>上次问题：{node.errors.at(-1).message}</p>}</div>)}<p>带入 {snapshot.recovery.files.length} 个文件，其中 {snapshot.recovery.files.filter((file:any)=>file.state==='unverified').length} 个为待验证资料。完整内容可在下方交付物和原运行记录中查看。</p></details>}
 {['failed','interrupted','cancelled'].includes(status)&&<div className="run-failure" role="status">
   <h3>{status==='failed'?'上次失败原因':'上次停止原因'}</h3>
   <p>{readableStop}</p>{readableStop!==stopMessage&&<details><summary>查看原始错误</summary><pre className="product-pre">{stopMessage}</pre></details>}
   {failedTasks.map((task:any)=><div key={task.id}><strong>{task.subject} · {snapshot.agents?.find((agent:any)=>agent.id===task.assignee)?.name??task.assignee}</strong><p>{task.output}</p></div>)}
   {planningBlocked&&<p>{planningBlocked}直接重试会沿用旧方案。</p>}
   {snapshot.projectId&&<button className="text-button" onClick={()=>onOpenProject(snapshot.projectId)}>返回项目修改方案</button>}
 </div>}
 <RunEmployeeStatus status={status} runtime={runtime} employeeName={employeeName} taskName={taskName}/>
 <RunInheritedEvidence runId={id} snapshot={snapshot} evidence={lineage} error={lineageError} taskName={taskName}/>
 {tests.length>0&&<div className="lower"><h3>真实测试结果</h3><p className="subcopy">以下命令与输出来自本机执行回执，包含实际失败和修复后的复测；以当前文件版本的最终复验为准。</p>{tests.map(operation=><details key={operation.id}><summary>{operation.payload.arguments.command} · {operation.result.exitCode===0?'通过':'失败'} · 退出码 {operation.result.exitCode}</summary><pre className="product-pre">{operation.result.output}</pre></details>)}</div>}
 {snapshot.executionTarget?.kind==='local'&&<div className="lower"><h3>执行环境</h3><p>{snapshot.executionTarget.name} · {snapshot.executionTarget.platform} · {snapshot.executionTarget.label} / {id}</p><p className="subcopy">模型与审批由后端协调；文件和命令在这台设备执行。设备断线后停止在途操作，不自动重放修改或命令。</p>{isolation&&<p className="notice-box">OpenShell 沙箱已有执行回执 · Node {isolation.node} · 用户 {isolation.uid} · 1 核 / 512 MiB<br/>沙箱：{isolation.sandboxId}</p>}<details><summary>执行操作回执（{localOperations.length}）</summary>{localOperations.map(operation=><div className="knowledge-result" key={operation.id}><strong>{operation.payload.name} · {({queued:'等待设备领取',claimed:'设备已领取',started:'已开始',completed:'已完成',failed:'失败',cancelled:'已停止'}as any)[operation.status]??operation.status}</strong><p>{operation.result?.localWorkspace??operation.lateResult?.localWorkspace}</p>{operation.result?.execution?.kind==='openshell'&&<small>OpenShell {operation.result.execution.version} · {operation.result.execution.sandboxName}</small>}{operation.result?.error&&<p>{operation.result.error.message}</p>}{operation.lateResult&&<p>收到迟到回执，未重新执行。{operation.lateResult.ok?'设备报告已完成，请核对本机文件。':operation.lateResult.error?.message}</p>}{(operation.result?.output??operation.lateResult?.output)&&<pre className="product-pre">{operation.result?.output??operation.lateResult?.output}</pre>}</div>)}</details></div>}
 {anomaly&&<div className="banner error" role="status"><strong>运行已停止：{anomalyNames[anomaly.code]??'发现异常'}</strong><p>{anomaly.message}。检查工具结果和产物后，再决定恢复或调整方案。</p></div>}
 {['failed','interrupted','cancelled'].includes(status)&&!planningBlocked&&<div className="notice-box run-recovery">
  <p>{recovery?.checkpointBlocked??'可以保留已核验的完成任务；返工结果须已通过独立复验。'}重试会创建新的运行档案，沿用原项目剩余预算和任务调用上限。</p>
  <CostCarryoverChoice state={costs} disabled={busy}/>
  {recovery?.costBlocked&&!costs.readiness&&<p className="banner error" role="status">{recovery.costBlocked} <a href="#usage">核对调用费用</a></p>}
  {unknown.length>0&&<div><p>以下操作的结果尚未确认，恢复前需要单独检查：</p>{unknown.map(operation=><pre className="product-pre" key={operation.callId}>{operation.name} · {JSON.stringify(operation.arguments)}</pre>)}<label><input type="checkbox" checked={acknowledged} disabled={busy||checkingRecovery} onChange={e=>setAcknowledged(e.target.checked)}/>我已核对这些操作和现有产物，允许未完成部分重新执行。</label></div>}
  <RecoveryConditionsView result={checkedRecovery?.data} stale={recoveryStale} checking={checkingRecovery} error={recoveryError} disabled={busy} staticEstimate={snapshot.estimatedCost} onCheck={()=>void checkRecovery(costs)}/>
  <RunRecoveryActions key={id} busy={busy} checking={checkingRecovery} context={{runId:id,version:snapshot.planVersion,key:checkKey,retainUncertainCosts:costs.retainUncertainCosts,acknowledged,
   allowResume:recoveryConditionsAllow(checkedRecovery?.data,checkedRecovery?.key,checkKey,true)&&!runContinuationBlocked(costs,{busy,legacyCostBlocked:recovery?.costBlocked,checkpointBlocked:recovery?.checkpointBlocked,unknownCount:unknown.length,acknowledged,resume:true}),
   allowRetry:recoveryConditionsAllow(checkedRecovery?.data,checkedRecovery?.key,checkKey,false)&&!runContinuationBlocked(costs,{busy,legacyCostBlocked:recovery?.costBlocked,unknownCount:unknown.length,acknowledged,resume:false})}}
   check={intent=>checkRecovery(costs,intent.acknowledged)} submit={intent=>api<{id:string}>('/runs/'+intent.runId+'/retry','POST',{resume:intent.resume,acknowledgeUnknownOperations:intent.acknowledged,retainUncertainCosts:intent.retainUncertainCosts})} onError={setError}/>
 </div>}
 {escalation&&<div className="banner error" role="status"><strong>返工已停止，需要你处理</strong><p>{escalation.message}</p><p>检查下方问题和现有交付物；需要新增权限、扩大范围或增加额度时，在项目中保存新方案并重新批准。</p></div>}
 {(rework.length>0||escalation)&&<details className="lower"><summary>审查问题与返工记录</summary>{events.filter(e=>['quality/review-submitted','quality/rework-created','quality/reviewed'].includes(e.type)).map(e=><div className="knowledge-result" key={e.seq}><strong>{e.data.reviewTaskId??e.data.taskId} · {e.type==='quality/rework-created'?`返工第 ${e.data.round} 轮`:e.data.verdict==='pass'?'独立复验通过':'审查要求修订'}</strong>{(e.data.findings??[]).map((finding:any)=><p key={finding.id}>{finding.id} · {finding.severity}{finding.file?` · ${finding.file}`:''}<br/>{finding.problem}<br/>修复要求：{finding.requiredFix}</p>)}</div>)}</details>}
 {status!=='completed'&&handoff.current.map(item=><div className="banner error run-handoff-current" role="status" key={item.seq??item.taskId}><strong>{taskName(item.taskId)} · 任务仍未完成，最近交接失败</strong><small>{item.at?new Date(item.at).toLocaleString('zh-CN'):'时间未记录'}</small><p>{item.message}</p></div>)}
 {handoff.history.length>0&&<details className="lower run-handoff-history"><summary>此前交接失败（{handoff.history.length}）</summary><p className="subcopy">以下保留原始失败与时间，当前任务状态和后续核验结果分别列出。</p>{handoff.history.map((item,index)=><details className="knowledge-result" key={item.seq??index}><summary>{taskName(item.taskId)} · {item.at?new Date(item.at).toLocaleString('zh-CN'):'时间未记录'}</summary><p>{item.acceptedLater?'之后交接已核验':item.taskStatus==='completed'?'该任务现已完成':`任务当前：${taskStates[item.taskStatus??'']??item.taskStatus??'状态未记录'}`}</p><pre className="product-pre">{item.message}</pre></details>)}</details>}
 {events.some(e=>e.type==='handoff/accepted'&&e.data.outputs?.length)&&<details className="lower"><summary>已核验的文件版本</summary>{events.filter(e=>e.type==='handoff/accepted').flatMap(e=>(e.data.outputs??[]).map((file:any)=><p key={e.seq+':'+file.path}>{e.data.taskId} · {file.path} · SHA256 {file.sha256.slice(0,12)}</p>))}</details>}
 {events.some(e=>e.type==='billing/unconfirmed')&&<p className="notice-box">本次运行曾有调用未取得完整用量。<a href="#settings">查看当前费用核对状态</a></p>}
 {approvals.filter(a=>a.status==='pending').map(renderApproval)}
 {approvals.some(a=>a.status!=='pending')&&<details className="lower"><summary>已处理审批（{approvals.filter(a=>a.status!=='pending').length}）</summary>{approvals.filter(a=>a.status!=='pending').map(renderApproval)}</details>}
 <div className="task-graph lower">{tasks.map((t:any)=><div className="task-node" key={t.id}><small>{t.id}{t.runtimeTaskId&&`（原生 ${t.runtimeTaskId}）`}{t.unapproved&&' · 未关联批准任务'} · {!executing&&['claimed','in_progress'].includes(t.status)?'停止时'+taskStates[t.status]:taskStates[t.status]??t.status??'待调度'} · {employeeName(t.assignee)}</small><h3>{t.subject}</h3><p>前置：{t.dependencies?.map(taskName).join(' → ')||'无'}</p>{t.output&&<pre className="product-pre">{t.output}</pre>}</div>)}</div>
 {finished&&<><h3 className="lower">{result.kind==='accepted-manager'?'经理验收结果':'运行原始回复'}</h3>
   {result.reason&&<p className="subcopy">{result.reason}</p>}
   {result.kind==='accepted-manager'&&<p className="subcopy">{result.taskSubject} · 宿主已核验并接收{result.acceptanceSeq!==undefined&&` · #${result.acceptanceSeq}`}。完整报告见下方交付物。</p>}
   <pre className="product-pre">{result.text||readableStop}</pre>
   {result.kind==='accepted-manager'&&result.receipt.outputs.map((file:any)=><p className="trace-id" key={file.path}>{file.path} · {file.size} 字节 · SHA256 {file.sha256}</p>)}
   {result.kind==='accepted-manager'&&result.originalSummary&&result.originalSummary!==result.text&&<details><summary>查看原始协调回复</summary><p className="subcopy">这是协调会话最后记录的回复，可能早于任务交付。原文保留供追溯，当前结果以上方宿主核验的经理任务为准。</p><pre className="product-pre">{result.originalSummary}</pre></details>}
 </>}
 <h3 className="lower">交付物</h3>{artifacts.map(f=><div className="document-row" key={f.path}><strong>{f.path}</strong><small>{f.size} 字节 · {f.sha256.slice(0,12)}</small><a href={import.meta.env.BASE_URL+'api/runs/'+id+'/artifact?path='+encodeURIComponent(f.path)} download>下载</a><button onClick={()=>void act(async()=>{const response=await fetch(import.meta.env.BASE_URL+'api/runs/'+id+'/artifact?path='+encodeURIComponent(f.path),{cache:'no-store',signal:AbortSignal.timeout(10000)});if(!response.ok)throw Error('读取失败');const text=await response.text();if(/\.(txt|md|json|js|mjs|cjs|ts|py|css|html|csv|log)$/i.test(f.path)){setError('');const pre=document.getElementById('artifact-preview-'+id);if(pre)pre.textContent=text.slice(0,100000);}else throw Error('此格式请下载后查看');})}>预览文本</button></div>)}<pre id={'artifact-preview-'+id} className="product-pre"/>
 {snapshot.knowledge?.format==='document-versions-v2'&&<p className="subcopy">批准时已固定 {snapshot.knowledge.documents.length} 份知识文档的版本，员工按各自授权检索。笔记后续编辑不改变本次引用。</p>}
 {snapshot.knowledge?.runInputs?.length>0&&<p className="subcopy">另有 {snapshot.knowledge.runInputs.length} 份本次专用资料，按批准的员工名单开放检索；正文和引用随本次档案保留。</p>}
 {citations.length>0&&<details className="lower"><summary>知识引用（{citations.length}）</summary>{citations.map((c:any,i:number)=><p key={i}>{c.title} · v{c.version} · 第 {c.lineStart}–{c.lineEnd} 行 · {c.chunkId?.slice(0,12)} <button disabled={busy} onClick={()=>void act(async()=>{setCitation(null);setCitation(await api('/runs/'+id+'/citations/'+encodeURIComponent(c.chunkId)));})}>查看引用原文</button></p>)}</details>}
 {citation&&<div className="knowledge-result"><div className="section-title"><h3>{citation.title} · v{citation.version}</h3><button onClick={()=>setCitation(null)}>关闭原文</button></div><p>第 {citation.lineStart}–{citation.lineEnd} 行 · {citation.source?.vaultPath}</p><pre className="product-pre">{citation.content}</pre><small>文档 SHA256：{citation.sha256}</small></div>}
 {status==='completed'&&<div className="lower"><h3>沉淀为部门知识</h3><label className="field">目标知识库<select value={spaceId} onChange={e=>setSpaceId(e.target.value)}><option value="">请选择</option>{spaces.filter(s=>s.scope==='company'||s.departmentId===snapshot.departmentId).map(s=><option value={s.id} key={s.id}>{s.name}</option>)}</select></label><button disabled={!spaceId||busy} onClick={()=>void act(async()=>{const text=[result.text,...(team?.tasks??[]).map((t:any)=>t.subject+'\n'+(t.output??''))].filter(Boolean).join('\n\n');if(!text)throw Error('没有可沉淀的文本结果');await api('/knowledge/documents','POST',{spaceId,title:snapshot.title||snapshot.requirement.slice(0,100),content:text.slice(0,250000),source:{runId:id,note:'用户确认沉淀的运行结果'}});setError('运行结果已保存为知识文档。');})}>确认保存运行结果</button></div>}</section>;}}</CostContinuation>;
}
