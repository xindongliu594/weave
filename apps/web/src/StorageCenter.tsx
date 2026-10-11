import {useEffect,useRef,useState} from 'react';
import {api} from './api.ts';
type Cleanup={id:string;status:string;createdAt:string;preview:{expiresAt:string;bytes:number;candidates:{runId:string;path:string;bytes:number}[];protectedRuns:{runId:string;reason:string}[]};result?:{bytes?:number;message?:string;replayed?:boolean;observed?:{runId:string;path:string;state:string}[]}};
const bytes=(n:number)=>n>=1024**3?(n/1024**3).toFixed(2)+' GiB':n>=1024**2?(n/1024**2).toFixed(2)+' MiB':n>=1024?(n/1024).toFixed(1)+' KiB':n+' B';
export function cleanupCanConfirm(row:Cleanup,busy:boolean){return !busy&&row.status==='preview'&&row.preview.candidates.length>0&&Date.parse(row.preview.expiresAt)>Date.now();}
export function StorageReport({data}:{data:any}){return <>
 <p>运行档案：{bytes(data.bytes)} / 1 GiB · 单次运行档案上限：64 MiB</p>
 {(!data.complete||data.groups?.some((g:any)=>!g.complete))&&<p role="alert" className="banner error">扫描不完整：显示已核对的字节下限。链接不跟随；读取失败或条目过多须先核对。</p>}
 {data.disk?.blocked&&<p role="alert" className="banner error">磁盘空间不足 256 MiB，新增工作已阻止。请查看清理预览或将已核对资料归档到其他磁盘。</p>}
 {data.archiveBlocked&&<p role="alert" className="banner error">运行档案已达上限或扫描未完成，请先保存备份并核对历史档案；清理副本不会降低档案占用。</p>}
 <p className="subcopy">{data.disk?.freeBytes!==undefined?'文件系统可用：'+bytes(data.disk.freeBytes):'文件系统可用空间暂未核对'}。统计逻辑文件字节；共享依赖和容器磁盘另计。</p>
 <div className="table-wrap"><table><thead><tr><th>资料</th><th>占用</th><th>文件</th><th>保护规则</th></tr></thead><tbody>{data.groups?.map((g:any)=><tr key={g.id}><td>{g.name}{!g.complete?'（扫描不完整）':''}</td><td>{bytes(g.bytes)}</td><td>{g.files}{g.links?' · '+g.links+' 个链接未跟随':''}</td><td>{g.protection}</td></tr>)}</tbody></table></div>
 {data.deploymentGroups?.length>0&&<details className="lower"><summary>部署目录占用（只读，可能包含上表数据）</summary>{data.deploymentGroups.map((g:any)=><p key={g.id}>{g.name}：{bytes(g.bytes)}{!g.complete?' · 扫描不完整':''} · {g.protection}</p>)}</details>}
 {data.runs?.length>0&&<details className="lower"><summary>最近 50 次运行档案与恢复入口</summary>{data.runs.map((r:any)=><p key={r.id}><a href={'#run/'+r.id}>{r.id}</a> · {r.status} · {bytes(r.bytes)}{r.overLimit?' · 已达单运行档案上限':''}{!r.complete?' · 扫描不完整':''}<small>　{r.parts?.map((p:any)=>p.id+' '+bytes(p.bytes)).join(' · ')}</small></p>)}</details>}
 </>;}
export function CleanupPreview({row,busy,onConfirm}:{row:Cleanup;busy:boolean;onConfirm:()=>void}){return <div className="lower">
 <h3>已完成本机工作区副本</h3><p>{row.preview.candidates.length} 个文件 · 可回收 {bytes(row.preview.bytes)}</p>
 <p className="subcopy">逐文件核对与正式交付一致后回收副本。交付档案、检查点和费用记录保留。预览 30 分钟有效，执行前再次核对。</p>
 {row.preview.candidates.length===0?<p>当前没有可安全回收的副本。</p>:<ul>{row.preview.candidates.slice(0,100).map(c=><li key={c.runId+'/'+c.path}><a href={'#run/'+c.runId}>{c.runId}</a> / {c.path} · {bytes(c.bytes)}</li>)}</ul>}
 {row.preview.candidates.length>100&&<p>其余 {row.preview.candidates.length-100} 个文件记录在当前预览中。</p>}
 <button disabled={!cleanupCanConfirm(row,busy)} onClick={onConfirm}>确认清理上述副本</button>
 <details className="lower"><summary>保留的现场与原因（{row.preview.protectedRuns.length}）</summary>{row.preview.protectedRuns.map((p,i)=><p key={p.runId+':'+i}>{p.runId} · {p.reason}</p>)}</details>
 </div>;}
const statuses:Record<string,string>={preview:'待确认预览',started:'结果待核对',completed:'清理完成',partial:'部分清理中止',interrupted:'中断结果已核对（未续删）'};
export function CleanupHistory({rows,busy,onReconcile}:{rows:Cleanup[];busy:boolean;onReconcile:(id:string)=>void}){return <details className="lower"><summary>清理记录（最近 50 次）</summary><p className="subcopy">服务中断后只核对文件与交付档案，不会自动续删。</p>{rows.map(row=><div className="lower" key={row.id}>
 <p>{statuses[row.status]??row.status} · {new Date(row.createdAt).toLocaleString('zh-CN')} · {row.id}</p>
 {row.result?.bytes!==undefined&&<p>已记录回收 {bytes(row.result.bytes)}</p>}{row.result?.message&&<p>{row.result.message}</p>}
 {['started','partial'].includes(row.status)&&<button disabled={busy} onClick={()=>onReconcile(row.id)}>核对中断结果</button>}
 {row.result?.observed?.map(o=><p key={o.runId+'/'+o.path}>{o.runId}/{o.path}：{({present:'副本仍在',changed:'副本已变化',unverified:'暂未核对','missing-copy':'副本已不存在，交付档案保留'} as Record<string,string>)[o.state]??o.state}</p>)}
 </div>)}</details>;}
export function StorageCenter(){
 const [data,setData]=useState<any>(),[rows,setRows]=useState<Cleanup[]>([]),[preview,setPreview]=useState<Cleanup>(),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const lock=useRef(false),mounted=useRef(true);
 async function refresh(){const [report,history]=await Promise.all([api('/storage'),api<Cleanup[]>('/storage/cleanups')]);if(mounted.current){setData(report);setRows(history);}}
 useEffect(()=>{mounted.current=true;void refresh().catch(e=>{if(mounted.current)setError(e.message);});return()=>{mounted.current=false;};},[]);
 async function act(fn:()=>Promise<void>){if(lock.current)return;lock.current=true;setBusy(true);setError('');setNotice('');try{await fn();}catch(e){if(mounted.current)setError((e as Error).message);}finally{try{await refresh();}catch(e){if(mounted.current)setError((e as Error).message);}lock.current=false;if(mounted.current)setBusy(false);}}
 return <section className="panel padded lower"><h2>文件与数据容量</h2><p className="subcopy">先核对占用，再确认清理。原始执行记录、交付、知识和操作收据长期保护；旧发布、缓存和 OpenShell 元数据仅盘点。容器内部磁盘尚未统计。</p>
 {error&&<p role="alert" className="banner error">{error}</p>}{notice&&<p role="status" className="banner">{notice}</p>}{data?<StorageReport data={data}/>:<p>正在核对容量…</p>}
 <button disabled={busy} onClick={()=>void act(refresh)}>刷新容量</button>{' '}<button disabled={busy} onClick={()=>void act(async()=>{const saved=await api<Cleanup>('/storage/preview','POST',{});if(mounted.current)setPreview(saved);})}>生成清理预览</button>
 {preview&&<CleanupPreview row={preview} busy={busy} onConfirm={()=>void act(async()=>{const saved=await api<Cleanup>('/storage/cleanups/'+preview.id+'/confirm','POST',{confirmation:'CLEAN_WORKSPACE_COPIES'});if(mounted.current){setPreview(saved);setNotice(saved.status==='completed'?'清理记录已保存，交付和恢复档案保留。':'请查看清理记录并核对结果。');}})}/>}
 <CleanupHistory rows={rows} busy={busy} onReconcile={id=>void act(async()=>{await api('/storage/cleanups/'+id+'/reconcile','POST',{});if(mounted.current)setNotice('现状核对已保存，没有续删或重放。');})}/>
 </section>;
}
