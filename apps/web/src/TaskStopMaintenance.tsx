import {useEffect,useRef,useState} from 'react';
import {api} from './api.ts';
import {taskStopMaintenanceSchema,taskStopReconcileInputSchema,type TaskStopMaintenanceScope} from '../../../packages/contracts/task-stop-maintenance.ts';

type ActionState={pending:boolean;error:string};
type Request=(path:string,method?:string,body?:unknown)=>Promise<unknown>;
const names:Record<TaskStopMaintenanceScope['state'],string>={stopped:'已确认停止',prepared:'已记录停止意向',dispatching:'已派发，待核对',unknown:'停止结果未知', 'no-intent':'尚未建立停止意向',unverified:'维护记录未核对'};
const reasons:Record<string,string>={TASK_STOP_UNVERIFIED:'记录尚未核对',TASK_STOP_ARCHIVE_UNAVAILABLE:'原运行档案不可读',TASK_STOP_SCOPE_MISSING:'准确任务记录缺失',TASK_STOP_IDENTITY_INVALID:'沙箱身份尚未核对',TASK_STOP_MARKER_INVALID:'原停止记录需要核对',TASK_STOP_EVIDENCE_INVALID:'原验收与检查点证据不完整',TASK_STOP_SCOPE_RETIRED:'历史任务现场受保护',TASK_STOP_NO_INTENT:'没有原停止请求可核对',TASK_STOP_PREPARED:'原停止意向尚未确认',TASK_STOP_DISPATCHING:'原停止派发结果待核对',TASK_STOP_UNKNOWN:'原停止结果仍未知',TASK_STOP_LIMIT:'记录超过本次核对限额',TASK_STOP_AMBIGUOUS:'存在重复或冲突的任务定位'};
function readScope(scope:unknown):TaskStopMaintenanceScope|undefined{
 const stopped=!!scope&&typeof scope==='object'&&'state' in scope&&scope.state==='stopped';
 const parsed=taskStopMaintenanceSchema.safeParse({version:1,state:stopped?'stopped':'pending',scopes:[scope]});
 return parsed.success?parsed.data.scopes[0]:undefined;
}
export function taskStopScopeKey(value:unknown){
 const scope=readScope(value);
 return !scope?'unverified':scope.state==='unverified'?scope.displayKey:JSON.stringify([scope.key.runId,scope.key.taskId,scope.key.attemptId,scope.key.generation,scope.sandboxId]);
}

/** One component's in-flight observation lock; no retries, cache or local stop facts. */
export function createTaskStopReconciler(runId:string,notify:(state:ActionState)=>void,refresh:(runId:string)=>Promise<void>,request:Request=api){
 let active=true,pending=false;
 return {
  dispose(){active=false;},
  async reconcile(value:unknown){
   const scope=readScope(value);
   if(!active||pending||!scope||scope.state==='unverified'||!scope.canReconcile||scope.key.runId!==runId)return;
   const body=taskStopReconcileInputSchema.safeParse({key:scope.key,sandboxId:scope.sandboxId,workspaceRevision:scope.workspaceRevision,stopId:scope.stopId});
   if(!body.success)return;
   pending=true;notify({pending:true,error:''});let error='';
   try{
    const response=await request('/runs/'+runId+'/task-stops/reconcile','POST',body.data);
    if(!response||typeof response!=='object'||!('replayed' in response)||response.replayed!==false||!('maintenance' in response)||!taskStopMaintenanceSchema.safeParse(response.maintenance).success)throw Error('维护核对响应不完整，请刷新原记录。');
   }catch(failure){error=failure instanceof Error?failure.message:'维护核对失败，请刷新原记录。';}
   finally{
    if(active)try{await refresh(runId);}catch{error+=(error?'；':'')+'维护记录刷新失败，请稍后刷新。';}
    pending=false;if(active)notify({pending:false,error});
   }
  },
 };
}

function ScopeView({scope,pending,disabled,onReconcile}:{scope:TaskStopMaintenanceScope;pending:boolean;disabled:boolean;onReconcile:()=>void}){
 const key='key' in scope?scope.key:undefined,sandbox='sandboxId' in scope?scope.sandboxId:undefined,revision='workspaceRevision' in scope?scope.workspaceRevision:undefined;
 return <div className="lower">
  <p><strong>{names[scope.state]}</strong>{key&&<> · 任务 {key.taskId} · 尝试 {key.attemptId} · 代次 {key.generation}</>}{'unresolvedCount' in scope&&<> · {scope.unresolvedCount} 项记录待核对</>}</p>
  {sandbox&&<p className="trace-id">沙箱：{sandbox}</p>}{revision&&<p className="trace-id">部分工作版本：{revision}</p>}
  {scope.reasonCode&&<p className="subcopy">{reasons[scope.reasonCode]}（{scope.reasonCode}）</p>}
  <p className="subcopy">{scope.state==='stopped'?'运行槽位已确认停止，文件与磁盘资料仍保留。':'运行占用尚未确认释放，文件与磁盘资料保留。'}本页不回收磁盘。</p>
  {scope.state==='no-intent'&&<p className="subcopy">尚无原停止请求可核对，现场受保护。</p>}
  {scope.state!=='unverified'&&scope.canReconcile&&<button disabled={disabled||pending} onClick={onReconcile}>{pending?'正在核对原停止结果…':'核对原停止结果'}</button>}
 </div>;
}

export function TaskStopMaintenance({runId,maintenance,onRefresh,disabled=false}:{runId:string;maintenance:unknown;onRefresh:(runId:string)=>Promise<void>;disabled?:boolean}){
 const parsed=taskStopMaintenanceSchema.safeParse(maintenance),[state,setState]=useState<ActionState&{runId:string}>({runId,pending:false,error:''});
 const record=parsed.success&&parsed.data.scopes.every(scope=>!('key' in scope)||!scope.key||scope.key.runId===runId)?parsed.data:undefined;
 const currentRun=useRef(runId),refresh=useRef(onRefresh),action=useRef<ReturnType<typeof createTaskStopReconciler>|undefined>(undefined);
 currentRun.current=runId;refresh.current=onRefresh;
 useEffect(()=>{
  const owner=runId,handler=createTaskStopReconciler(owner,next=>{if(currentRun.current===owner)setState({runId:owner,...next});},async id=>{if(currentRun.current===owner)await refresh.current(id);});
  action.current=handler;setState({runId:owner,pending:false,error:''});
  return()=>{handler.dispose();if(action.current===handler)action.current=undefined;};
 },[runId]);
 if(record?.state==='not-applicable')return null;
 const visible=state.runId===runId?state:{pending:false,error:''};
 return <section className="lower" aria-label="任务沙箱维护"><div className="section-title"><h3>任务沙箱维护</h3><span className={'tag '+(record?.state==='stopped'?'green':'amber')}>{record?.state==='stopped'?'维护已确认停止':'维护待核对'}</span></div>
  {!record?<p className="subcopy">维护记录未核对，文件与磁盘现场保留。</p>:record.scopes.map(scope=><ScopeView key={taskStopScopeKey(scope)} scope={scope} pending={visible.pending} disabled={disabled} onReconcile={()=>void action.current?.reconcile(scope)}/>)}
  {visible.error&&<p role="alert" className="banner error">{visible.error}</p>}
 </section>;
}
