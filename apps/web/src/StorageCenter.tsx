import {useEffect,useRef,useState} from 'react';
import {api} from './api.ts';
import {TaskStopMaintenance,taskStopScopeKey} from './TaskStopMaintenance.tsx';
import type {MaintenanceHealth} from '../../api/src/maintenance-health.ts';
type Cleanup={id:string;status:string;createdAt:string;preview:{kind?:string;expiresAt:string;bytes:number;candidates:{runId:string;path:string;bytes:number}[];protectedRuns:{runId:string;reason:string}[]};result?:{bytes?:number;savedBytes?:number;state?:string;message?:string;replayed?:boolean;observed?:{runId:string;path:string;state:string}[]}};
const sandboxRetirementNotice='当前自动沙箱回收尚未开放，正式交付保留。';
const confirmations:Record<string,string>={workspace:'CLEAN_WORKSPACE_COPIES',sandbox:'RETIRE_SANDBOX',journal:'ARCHIVE_JOURNAL'};
const bytes=(n:number)=>n>=1024**3?(n/1024**3).toFixed(2)+' GiB':n>=1024**2?(n/1024**2).toFixed(2)+' MiB':n>=1024?(n/1024).toFixed(1)+' KiB':n+' B';
type MaintenanceView=Omit<MaintenanceHealth,'code'>&{code:MaintenanceHealth['code']|'REPORT_FETCH_FAILED'};
export async function loadMaintenanceHealth():Promise<MaintenanceView>{
 try{return await api<MaintenanceHealth>('/storage/maintenance');}
 catch{return {version:1,currentStatus:'unknown',availability:'unavailable',code:'REPORT_FETCH_FAILED',maxAgeHours:48,slots:[]};}
}
const maintenanceStatus=(status?:string)=>({passed:'记录通过',failed:'记录失败',unknown:'待核对'} as Record<string,string>)[status??'unknown']??'待核对';
export function MaintenanceHealthReport({data}:{data?:MaintenanceView}){
 const report=data?.report,unavailable:Record<string,string>={NOT_CONFIGURED:'尚未配置周期维护记录。',REPORTS_MISSING:'尚无周期维护记录。',REPORT_UNAVAILABLE:'现有维护记录均无法使用。',REPORT_DIRECTORY_UNAVAILABLE:'维护记录暂时无法安全读取。',REPORT_FETCH_FAILED:'维护记录暂时无法加载，容量和清理功能仍可使用。'};
 return <details className="lower"><summary>周期维护记录</summary>
  <p>当前状态尚未现场复核。这里只读取已保存的历史报告。</p>
  <p className="subcopy">仅展示最近 48 小时的有效报告；当前恢复能力仍待核对。</p>
  {data?.availability==='degraded'&&<p role="alert" className="banner error">部分维护记录不可用，当前显示其余有效记录。</p>}
  {!report?<p>{data?unavailable[data.code]??'维护记录暂时不可用。':'正在读取维护记录…'}</p>:<>
   <p>历史报告：{new Date(report.checkedAt).toLocaleString('zh-CN')} · {maintenanceStatus(report.status)}</p>
   <p>文件盘点：{maintenanceStatus(report.checks?.storage?.status)}{report.checks?.storage?.bytes!==undefined?' · '+bytes(report.checks.storage.bytes):''}{report.checks?.storage?.files!==undefined?' · '+report.checks.storage.files+' 个文件':''}</p>
   <p>可用空间：{maintenanceStatus(report.checks?.disk?.status)}{report.checks?.disk?.freeBytes!==undefined?' · '+bytes(report.checks.disk.freeBytes):''}</p>
   <p>保留建议：{maintenanceStatus(report.checks?.retention?.status)}{report.checks?.retention?.recommendations!==undefined?' · '+report.checks.retention.recommendations+' 项':''}</p>
   <p>恢复证据：{maintenanceStatus(report.checks?.backup?.status)}{report.checks?.backup?.recordedStatus==='passed'?' · 演练记录曾通过，当前恢复能力仍待核对。':''}</p>
  </>}
  {data?.slots?.some(slot=>slot.state==='stale')&&<p>部分记录已超过 48 小时。</p>}
  {data?.slots?.some(slot=>slot.state==='future')&&<p>部分记录的时间在未来，请核对报告生成机器的时钟。</p>}
 </details>;
}
export function RetentionReport({data,busy,onPreview}:{data:any;busy:boolean;onPreview:(kind:string,id:string)=>void}){return <details className="lower"><summary>保留与维护建议</summary>
 <p>按完成时间给出建议，不自动删除。预览仍会核对费用、授权、原档案和文件版本；失败与结果未知的现场保留。</p>
 <p>完成日志保留 {data.policy.hotJournalHours} 小时后可预览压缩；完成工作区副本保留 {data.policy.completedCopiesDays} 天后可预览回收。</p>
 <p className="subcopy">{sandboxRetirementNotice}</p>
 <p className="subcopy">旧发布建议保留当前版本、最新 {data.policy.releaseKeepLatest} 个版本及全部共享依赖来源；备份保留最近 {data.policy.backupDays} 天和最新 {data.policy.backupKeepLatest} 份。发布、备份和缓存需人工核对归档，本页不执行删除。</p>
 <p className="subcopy">工作区副本预览列出全部符合条件的本机副本，请按预览清单确认。建议列表仅包含最近 50 次运行。</p>
 {data.recommendations.length===0?<p>当前没有达到建议保留时间的资源。</p>:data.recommendations.map((r:any)=><p key={r.runId+'/'+r.kind}><a href={'#run/'+r.runId}>{r.runId}</a> · 完成 {Math.floor(r.ageDays)} 天 · <button disabled={busy||r.kind==='sandbox'} onClick={()=>onPreview(r.kind,r.runId)}>{r.kind==='journal'?'预览日志归档':r.kind==='sandbox'?'预览沙箱回收':'预览全部本机副本'}</button></p>)}
 </details>;}
export function cleanupCanConfirm(row:Cleanup,busy:boolean){return !busy&&row.preview.kind!=='sandbox'&&row.status==='preview'&&row.preview.candidates.length>0&&Date.parse(row.preview.expiresAt)>Date.now();}
export function StorageReport({data,busy=false,onJournalPreview}:{data:any;busy?:boolean;onJournalPreview?:(id:string)=>void}){return <>
 <p>运行档案：{bytes(data.bytes)} / 1 GiB · 单次运行档案上限：64 MiB</p>
 {(!data.complete||data.groups?.some((g:any)=>!g.complete))&&<p role="alert" className="banner error">扫描不完整：显示已核对的字节下限。链接不跟随；读取失败或条目过多须先核对。</p>}
 {data.disk?.blocked&&<p role="alert" className="banner error">磁盘空间不足 256 MiB，新增工作已阻止。请查看清理预览或将已核对资料归档到其他磁盘。</p>}
 {data.archiveBlocked&&<p role="alert" className="banner error">运行档案已达上限或扫描未完成，请先保存备份并核对历史档案；清理副本不会降低档案占用。</p>}
 <p className="subcopy">{data.disk?.freeBytes!==undefined?'文件系统可用：'+bytes(data.disk.freeBytes):'文件系统可用空间暂未核对'}。统计逻辑文件字节；共享依赖和容器磁盘另计。</p>
 <div className="table-wrap"><table><thead><tr><th>资料</th><th>占用</th><th>文件</th><th>保护规则</th></tr></thead><tbody>{data.groups?.map((g:any)=><tr key={g.id}><td>{g.name}{!g.complete?'（扫描不完整）':''}</td><td>{bytes(g.bytes)}</td><td>{g.files}{g.links?' · '+g.links+' 个链接未跟随':''}</td><td>{g.protection}</td></tr>)}</tbody></table></div>
 {data.deploymentGroups?.length>0&&<details className="lower"><summary>部署目录占用（只读，可能包含上表数据）</summary>{data.deploymentGroups.map((g:any)=><p key={g.id}>{g.name}：{bytes(g.bytes)}{!g.complete?' · 扫描不完整':''} · {g.protection}</p>)}</details>}
 {data.runs?.length>0&&<details className="lower"><summary>最近 50 次运行档案与恢复入口</summary>{data.runs.map((r:any)=><p key={r.id}><a href={'#run/'+r.id}>{r.id}</a> · {r.status} · {bytes(r.bytes)}{r.overLimit?' · 已达单运行档案上限':''}{!r.complete?' · 扫描不完整':''}<small>　{r.parts?.map((p:any)=>p.id+' '+bytes(p.bytes)).join(' · ')}</small>{onJournalPreview&&r.status==='completed'&&r.parts?.some((p:any)=>p.id==='events.jsonl'&&p.bytes>0)&&<button disabled={busy} onClick={()=>onJournalPreview(r.id)}>预览日志归档</button>}</p>)}</details>}
 </>;}
export function SandboxStorageReport({data,busy,onInspect,onPreview,onTaskRefresh}:{data:any;busy:boolean;onInspect:(id:string)=>void;onPreview:(id:string)=>void;onTaskRefresh?:()=>Promise<void>}){return <details className="lower"><summary>OpenShell 沙箱可写目录</summary><p className="subcopy">应用层容量监管：/sandbox 20 MiB、/tmp 64 MiB；不构成硬磁盘配额。镜像层和 Docker 日志另计。旧运行沙箱的容量核对会启动原工作负载，只检查文件，不调用模型。任务停止核对只观察原请求，文件与磁盘资料保留。</p><p className="subcopy">{sandboxRetirementNotice}</p>{!data?.available?<p>OpenShell 维护尚未连接。</p>:data.scopes.length===0?<p>当前没有已登记沙箱。</p>:data.scopes.map((s:any,i:number)=>s.scopeKind==='task'?<div key={taskStopScopeKey(s.taskStopMaintenance)==='unverified'?'invalid-task-'+i:taskStopScopeKey(s.taskStopMaintenance)} className="lower"><p><a href={'#run/'+s.runId}>{s.runId}</a></p><TaskStopMaintenance runId={s.runId} maintenance={{version:1,state:s.taskStopMaintenance?.state==='stopped'?'stopped':'pending',scopes:[s.taskStopMaintenance]}} disabled={busy||!onTaskRefresh} onRefresh={async()=>{await onTaskRefresh?.();}}/>{s.storage?<p>/sandbox {bytes(s.storage.workspace?.bytes??0)} · /tmp {bytes(s.storage.temp?.bytes??0)} · 上次核对 {new Date(s.storage.checkedAt).toLocaleString('zh-CN')}</p>:<p>目录占用尚未实测</p>}</div>:<div key={s.runId??i} className="lower"><p>{s.runId&&<a href={'#run/'+s.runId}>{s.runId}</a>} · {({ready:'就绪',stopped:'已停止',unknown:'结果未知，保留现场',retiring:'回收待核对',retired:'历史回收回执，待物理复核',unverified:'映射未核对'} as Record<string,string>)[s.phase]??s.phase} · {s.sandboxId}</p>{s.storage?<p>/sandbox {bytes(s.storage.workspace?.bytes??0)} · /tmp {bytes(s.storage.temp?.bytes??0)} · 上次核对 {new Date(s.storage.checkedAt).toLocaleString('zh-CN')}</p>:<p>目录占用尚未实测</p>}{s.error&&<p>{s.error}</p>}{s.runId&&['ready','stopped'].includes(s.phase)&&<><button disabled={busy} onClick={()=>onInspect(s.runId)}>核对容量与文件版本</button>{' '}<button disabled onClick={()=>onPreview(s.runId)}>预览回收</button></>}</div>)}</details>;}
export function CleanupPreview({row,busy,onConfirm}:{row:Cleanup;busy:boolean;onConfirm:()=>void}){const kind=row.preview.kind??'workspace';return <div className="lower">
 <h3>{kind==='journal'?'完成运行日志归档':kind==='sandbox'?'沙箱回收（未开放）':'已完成本机工作区副本'}</h3><p>{row.preview.candidates.length} 项 · {kind==='journal'?'原日志':kind==='sandbox'?'已核对可写目录':'可回收'} {bytes(row.preview.bytes)}</p>
 <p className="subcopy">{kind==='journal'?'压缩并校验原事件后封存，仍可查看；封存日志不再追加。':kind==='sandbox'?sandboxRetirementNotice:'逐文件核对与正式交付一致后回收副本。'}交付档案、检查点和费用记录保留。预览 30 分钟有效，执行前再次核对。</p>
 {row.preview.candidates.length===0?<p>当前没有可安全回收的副本。</p>:<ul>{row.preview.candidates.slice(0,100).map(c=><li key={c.runId+'/'+c.path}><a href={'#run/'+c.runId}>{c.runId}</a> / {c.path} · {bytes(c.bytes)}</li>)}</ul>}
 {row.preview.candidates.length>100&&<p>其余 {row.preview.candidates.length-100} 个文件记录在当前预览中。</p>}
 <button disabled={!cleanupCanConfirm(row,busy)} onClick={onConfirm}>{kind==='journal'?'确认压缩归档':kind==='sandbox'?'确认回收沙箱':'确认清理上述副本'}</button>
 <details className="lower"><summary>保留的现场与原因（{row.preview.protectedRuns.length}）</summary>{row.preview.protectedRuns.map((p,i)=><p key={p.runId+':'+i}>{p.runId} · {p.reason}</p>)}</details>
 </div>;}
const statuses:Record<string,string>={preview:'待确认预览',started:'结果待核对',completed:'清理完成',partial:'部分清理中止',interrupted:'中断结果已核对（未续删）'};
export function CleanupHistory({rows,busy,onReconcile}:{rows:Cleanup[];busy:boolean;onReconcile:(id:string)=>void}){return <details className="lower"><summary>清理记录（最近 50 次）</summary><p className="subcopy">服务中断后只核对文件与交付档案，不会自动续删。</p>{rows.map(row=>{const historicalRetirement=row.result?.state==='retired'||row.preview.kind==='sandbox'&&row.status==='completed';return <div className="lower" key={row.id}>
 <p>{historicalRetirement?'历史沙箱回收回执，待物理复核':statuses[row.status]??row.status} · {new Date(row.createdAt).toLocaleString('zh-CN')} · {row.id}</p>
 {row.result?.bytes!==undefined&&<p>{historicalRetirement?'历史回执字节':'已记录回收'} {bytes(row.result.bytes)}</p>}{!historicalRetirement&&row.result?.message&&<p>{row.result.message}</p>}
 {row.result?.savedBytes!==undefined&&<p>压缩节省 {bytes(row.result.savedBytes)}</p>}{row.result?.state&&<p>{({retired:'原沙箱物理状态待复核',present:'原沙箱仍在，未重发删除',archived:'原事件已核对归档','plain-retained':'原日志仍在，未继续删除',unverified:'归档状态尚未核对'} as Record<string,string>)[row.result.state]??row.result.state}</p>}
 {(['started','partial'].includes(row.status)||row.status==='interrupted'&&['present','unverified'].includes(row.result?.state??''))&&<button disabled={busy} onClick={()=>onReconcile(row.id)}>核对中断结果</button>}
 {row.result?.observed?.map(o=><p key={o.runId+'/'+o.path}>{o.runId}/{o.path}：{({present:'副本仍在',changed:'副本已变化',unverified:'暂未核对','missing-copy':'副本已不存在，交付档案保留'} as Record<string,string>)[o.state]??o.state}</p>)}
 </div>;})}</details>;}
export function StorageCenter(){
 const [data,setData]=useState<any>(),[sandboxes,setSandboxes]=useState<any>(),[retention,setRetention]=useState<any>(),[maintenance,setMaintenance]=useState<MaintenanceView>(),[rows,setRows]=useState<Cleanup[]>([]),[preview,setPreview]=useState<Cleanup>(),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const lock=useRef(false),mounted=useRef(true),maintenanceRequest=useRef(0);
 async function refresh(){const request=++maintenanceRequest.current;void loadMaintenanceHealth().then(value=>{if(mounted.current&&request===maintenanceRequest.current)setMaintenance(value);});const [report,history,sandboxReport,advice]=await Promise.all([api('/storage'),api<Cleanup[]>('/storage/cleanups'),api('/storage/sandboxes'),api('/storage/retention')]);if(mounted.current){setData(report);setRows(history);setSandboxes(sandboxReport);setRetention(advice);}}
 useEffect(()=>{mounted.current=true;void refresh().catch(e=>{if(mounted.current)setError(e.message);});return()=>{mounted.current=false;};},[]);
 async function act(fn:()=>Promise<void>){if(lock.current)return;lock.current=true;setBusy(true);setError('');setNotice('');try{await fn();}catch(e){if(mounted.current)setError((e as Error).message);}finally{try{await refresh();}catch(e){if(mounted.current)setError((e as Error).message);}lock.current=false;if(mounted.current)setBusy(false);}}
 async function makePreview(body:any){const saved=await api<Cleanup>('/storage/preview','POST',body);if(mounted.current)setPreview(saved);}
 return <section className="panel padded lower"><h2>文件与数据容量</h2><p className="subcopy">先核对占用，再确认维护。交付、知识和操作收据保护；完成日志可校验压缩。旧发布与缓存只读盘点；沙箱只统计获授权的可写目录。</p>
 {error&&<p role="alert" className="banner error">{error}</p>}{notice&&<p role="status" className="banner">{notice}</p>}{data?<StorageReport data={data} busy={busy} onJournalPreview={id=>void act(()=>makePreview({kind:'journal',runId:id}))}/>:<p>正在核对容量…</p>}
 <button disabled={busy} onClick={()=>void act(refresh)}>刷新容量</button>{' '}<button disabled={busy} onClick={()=>void act(async()=>{const saved=await api<Cleanup>('/storage/preview','POST',{});if(mounted.current)setPreview(saved);})}>生成清理预览</button>
 <MaintenanceHealthReport data={maintenance}/>
 {retention&&<RetentionReport data={retention} busy={busy} onPreview={(kind,id)=>void act(()=>makePreview(kind==='workspace'?{}:{kind,runId:id}))}/>}
 <SandboxStorageReport data={sandboxes} busy={busy} onTaskRefresh={refresh} onInspect={id=>void act(async()=>{await api('/storage/sandboxes/'+id+'/inspect','POST',{});if(mounted.current)setNotice('容量与当前文件版本已核对，未删除沙箱。');})} onPreview={id=>void act(()=>makePreview({kind:'sandbox',runId:id}))}/>
 {preview&&<CleanupPreview row={preview} busy={busy} onConfirm={()=>void act(async()=>{const saved=await api<Cleanup>('/storage/cleanups/'+preview.id+'/confirm','POST',{confirmation:confirmations[preview.preview.kind??'workspace']});if(mounted.current){setPreview(saved);setNotice(saved.status==='completed'?'维护记录已保存，正式交付和恢复证据保留。':'请查看维护记录并核对结果。');}})}/>}
 <CleanupHistory rows={rows} busy={busy} onReconcile={id=>void act(async()=>{await api('/storage/cleanups/'+id+'/reconcile','POST',{});if(mounted.current)setNotice('现状核对已保存，没有续删或重放。');})}/>
 </section>;
}
