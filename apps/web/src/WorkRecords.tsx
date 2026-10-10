import {useEffect,useState} from 'react';
import {api} from './api.ts';

type Space={id:string;name:string;scope:string;departmentId:string|null};
type Source={runId:string;projectId:string;departmentId:string;title:string;planVersion:string;status:string};
type Record={runId:string;departmentId:string;planVersion:number;title:string;shareable:boolean;content:string;nodes:any[];files:{path:string;sha256:string}[];efficiency:{current:any;baseline:any;comparison:any;method:string}};

export function WorkRecords({spaces,onPublished}:{spaces:Space[];onPublished:()=>Promise<void>}){
 const [sources,setSources]=useState<Source[]>([]),[runId,setRunId]=useState(''),[record,setRecord]=useState<Record|null>(null),[spaceId,setSpaceId]=useState(''),[error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false);
 const [storage,setStorage]=useState<{bytes:number;maxBytes:number;runMaxBytes:number}|null>(null);
 async function refresh(){const [rows,usage]=await Promise.all([api<Source[]>('/knowledge/work-records'),api<{bytes:number;maxBytes:number;runMaxBytes:number}>('/storage')]);setSources(rows);setStorage(usage);}
 useEffect(()=>{void refresh().catch(e=>setError(e.message));},[]);
 useEffect(()=>{let current=true;setRecord(null);setSpaceId('');setError('');setNotice('');if(runId)void api<Record>('/knowledge/work-records/'+runId).then(value=>{if(current)setRecord(value);}).catch(e=>{if(current)setError(e.message);});return()=>{current=false;};},[runId]);
 const available=spaces.filter(s=>s.scope==='department'&&s.departmentId===record?.departmentId);
 async function publish(){if(!record||record.runId!==runId||!record.shareable||!available.some(s=>s.id===spaceId)||busy)return;setBusy(true);setError('');setNotice('');try{const result=await api<{existing?:boolean}>('/knowledge/work-records/'+runId+'/publish','POST',{spaceId});setNotice(result.existing?'这份工作记录已登记，复用原知识版本。':'已登记到部门知识空间，可按员工授权检索。');await onPublished();}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
 return <section className="panel padded lower"><h2>工作记录</h2><p className="subcopy">每次运行保留一个来源节点。已完成工作可登记需求、验收与交付版本索引；原文件和日志留在执行记录。归档部门后隐藏节点，历史关联保留。</p>
 <label className="field">工作来源运行<select aria-label="工作来源运行" disabled={busy} value={runId} onChange={e=>setRunId(e.target.value)}><option value="">选择已完成的工作</option>{sources.map(s=><option key={s.runId} value={s.runId} disabled={s.status!=='completed'}>{(s.title??s.runId).slice(0,65)} · v{s.planVersion} · {s.status}</option>)}</select></label>
 <button type="button" disabled={busy} onClick={()=>void refresh().catch(e=>setError(e.message))}>刷新工作记录</button>
 {storage&&<p className="subcopy">运行档案 {(storage.bytes/1024/1024).toFixed(1)} / {storage.maxBytes/1024/1024} MiB；单次运行在 {storage.runMaxBytes/1024/1024} MiB 后停止新增模型调用和命令申请，保留历史与检查点。工作知识最多 500 份 / 8 MiB，重复登记复用原记录。</p>}
 {record?.runId===runId&&<><h3>{record.title}</h3><p>方案 v{record.planVersion} · {record.nodes.length} 个已核验节点 · {record.files.length} 个文件版本 · <a href={'#run/'+record.runId}>查看来源运行</a></p>
 <h3>效率与知识复用</h3><p className="subcopy">{record.efficiency.current.knowledgeVersions.length} 份固定知识版本 · {record.efficiency.current.citations.length} 条实际检索 / 读取引用。{!record.efficiency.current.usageComplete?'用量未齐，暂不计算收益。':!record.efficiency.baseline?'尚无同条件的首次运行，暂不计算减少百分比。':'对照首次成功运行 '+record.efficiency.baseline.runId}</p>
 <table><thead><tr><th>指标</th><th>本次</th><th>比首次减少</th></tr></thead><tbody>{([['wallMs','总耗时'],['activeMs','扣除审批等待'],['modelMs','模型响应耗时之和'],['inputTokens','输入 Token'],['outputTokens','输出 Token'],['totalTokens','总 Token'],['modelCalls','模型调用'],['cost','登记费用']] as const).map(([key,label])=>{const value=record.efficiency.current[key],change=record.efficiency.comparison?.changes[key];const format=(n:number|null)=>n===null?'未知':key.endsWith('Ms')?(n/1000).toFixed(1)+' 秒':key==='cost'?'$'+n.toFixed(7):n.toLocaleString();return <tr key={key}><td>{label}</td><td>{format(value)}</td><td>{change?.saved===null||!change?'未验证':format(change.saved)+(change.savedPercent===null?'':' / '+change.savedPercent.toFixed(1)+'%')}</td></tr>;})}</tbody></table><p className="subcopy">{record.efficiency.method}</p>
 <details><summary>查看登记内容与知识引用</summary><pre className="product-pre">{record.content}</pre></details>
 <label className="field">工作记录知识空间<select aria-label="工作记录知识空间" disabled={busy} value={spaceId} onChange={e=>setSpaceId(e.target.value)}><option value="">选择来源部门的知识空间</option>{available.map(s=><option value={s.id} key={s.id}>{s.name}</option>)}</select></label>
 {!record.shareable&&<p role="status">来源含员工定向资料，需先审查私有资料边界。</p>}{!available.length&&<p>请先为来源部门创建知识空间。</p>}<button disabled={busy||!record.shareable||!spaceId} onClick={()=>void publish()}>登记工作知识</button></>}
 {error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
 </section>;
}
