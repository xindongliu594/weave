import { useEffect, useState } from 'react';
import { api } from './api.ts';

type SnapshotSummary={id:string;name:string;bytes:number;fileCount:number;createdAt:string};
type FilePreview={path:string;bytes:number;sha256:string;kind:string;text:string;warnings:string[]};
type Snapshot=SnapshotSummary&{files:FilePreview[]};
export type WorkFileSelectionValue={snapshotId:string;paths:string[];agentIds:string[];mode?:'reference'|'workspace'};
const excluded=/(^|\/)(\.git|\.hg|\.svn|\.ssh|\.aws|\.azure|\.kube|\.gnupg|\.npmrc|\.pypirc|\.netrc|\.env(?:\.[^/]*)?|credentials(?:\.[^/]*)?|secrets?(?:\.[^/]*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.[^/]*)?|node_modules|__pycache__)(\/|$)|\.(pem|key|p12|pfx|keystore|lnk|url|exe|dll|so|dylib|class|pyc|pdf|doc|xls|ppt|zip|png|jpg|jpeg|gif|webp)$/i;
async function base64(file:File){const buffer=await file.arrayBuffer();let binary='';for(const byte of new Uint8Array(buffer))binary+=String.fromCharCode(byte);return btoa(binary);}
const bytes=(value:number)=>value>=1048576?(value/1048576).toFixed(1)+' MiB':(value/1024).toFixed(1)+' KiB';

export function WorkFilesCenter(){
  const [snapshots,setSnapshots]=useState<SnapshotSummary[]>([]),[selected,setSelected]=useState<Snapshot|null>(null),[preview,setPreview]=useState<FilePreview|null>(null);
  const [name,setName]=useState(''),[pending,setPending]=useState<{file:File;path:string}[]>([]),[skipped,setSkipped]=useState<string[]>([]),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const [format,setFormat]=useState<'docx'|'xlsx'|'csv'>('docx'),[outputName,setOutputName]=useState('工作文档'),[content,setContent]=useState(''),[rows,setRows]=useState('[["项目","状态"],["示例","待办"]]');
  async function refresh(){setSnapshots(await api<SnapshotSummary[]>('/work-files'));}
  useEffect(()=>{void refresh().catch(e=>setError(e.message));},[]);
  async function act(fn:()=>Promise<void>){setError('');setNotice('');setBusy(true);try{await fn();await refresh();}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
  async function open(id:string){const data=await api<Snapshot>('/work-files/'+id);setSelected(data);setPreview(data.files[0]??null);}
  function choose(files:FileList|null){
    if(!files)return;const accepted:{file:File;path:string}[]=[],rejected:string[]=[];
    for(const file of Array.from(files)){const path=file.webkitRelativePath||file.name;if(excluded.test(path)||path.length>240||path.split('/').some(part=>part.toLowerCase().startsWith('.agent'))||file.size>2*1024*1024)rejected.push(path);else accepted.push({file,path});}
    setPending(accepted);setSkipped(rejected);setName(accepted[0]?.path.split('/')[0]??'');setError('');setNotice('');
  }
  return <><div className="page-head"><div><div className="eyebrow">WORK FILES</div><h1>项目素材与办公文件</h1><p>导入已有目录的独立副本，保留相对路径；在项目方案中选择文件和获授权员工。</p></div></div>
    {error&&<p className="banner error" role="alert">{error}</p>}{notice&&<p className="banner" role="status">{notice}</p>}
    <div className="product-columns"><section className="panel padded"><h2>导入文件或项目目录</h2><p className="subcopy">最多 100 个文件，单文件 2 MiB，单次合计 8 MiB。支持 UTF-8 代码/文本、CSV、DOCX、XLSX 和 PPTX 正文；不会修改原目录。素材只作为参考，不会自动执行其中的脚本。</p>
      <div className="form-grid"><label className="field">选择文件<input type="file" multiple disabled={busy} onChange={e=>choose(e.target.files)}/></label><label className="field">选择项目目录<input type="file" multiple disabled={busy} ref={node=>{node?.setAttribute('webkitdirectory','');}} onChange={e=>choose(e.target.files)}/></label></div>
      {!!skipped.length&&<details><summary>已排除 {skipped.length} 个凭证、依赖、不支持或过大文件</summary><pre className="product-pre">{skipped.join('\n')}</pre></details>}
      {!!pending.length&&<form onSubmit={e=>{e.preventDefault();void act(async()=>{if(pending.length>100||pending.reduce((sum,item)=>sum+item.file.size,0)>8*1024*1024)throw Error('请选择最多 100 个文件，合计不超过 8 MiB。');const files=[];for(const item of pending)files.push({path:item.path,base64:await base64(item.file),kind:'file'});const result=await api<{id:string}>('/work-files','POST',{name,files});await open(result.id);setPending([]);setNotice('已保存独立快照。在项目方案中选用并授权后，员工才能读取。');});}}><label className="field">快照名称<input required maxLength={100} value={name} onChange={e=>setName(e.target.value)}/></label><p>{pending.length} 个文件 · {bytes(pending.reduce((n,item)=>n+item.file.size,0))}</p><details><summary>检查将导入的文件</summary><ul>{pending.map(item=><li key={item.path}>{item.path} <button type="button" disabled={busy} onClick={()=>setPending(p=>p.filter(f=>f!==item))}>移除</button></li>)}</ul></details><button className="primary lower" disabled={busy}>保存独立快照</button></form>}
      <p className="subcopy">自动排除常见密钥路径，仍请检查目录中的业务敏感信息。暂不支持 PDF、旧版 Office 或二进制项目资源。素材库最多保存 200 份快照 / 128 MiB。</p>
    </section><section className="panel padded"><h2>生成办公文件</h2><p className="subcopy">将正文生成 DOCX，或将表格数组生成 CSV / XLSX。员工可先交付 Markdown / CSV，再在这里转换。最小版仅保留文字与单元格，不生成排版、图表或公式。</p>
      <form onSubmit={e=>{e.preventDefault();void act(async()=>{const result=await api<{id:string}>('/work-files/generate','POST',{format,name:outputName,title:outputName,...(format==='docx'?{text:content}:{rows:JSON.parse(rows)})});await open(result.id);setNotice('文件已生成并保存，点击下方“下载原文件”。');});}}><label className="field">文件名称<input required maxLength={80} value={outputName} onChange={e=>setOutputName(e.target.value)}/></label><label className="field">格式<select value={format} onChange={e=>setFormat(e.target.value as typeof format)}><option value="docx">Word 文档（DOCX）</option><option value="xlsx">Excel 表格（XLSX）</option><option value="csv">CSV 表格</option></select></label>{format==='docx'?<label className="field">正文<textarea rows={7} maxLength={250000} value={content} onChange={e=>setContent(e.target.value)}/></label>:<label className="field">二维 JSON 表格数组<textarea required rows={7} value={rows} onChange={e=>setRows(e.target.value)}/><small>例如 [["姓名","数量"],["张三",3]]。最多 2,000 行、100 列和 20,000 个单元格。</small></label>}<button disabled={busy} className="primary">生成并保存</button></form>
    </section></div>
    <section className="panel padded lower"><h2>已保存的素材快照</h2>{!snapshots.length&&<p className="compact-empty">还没有导入素材。</p>}{snapshots.map(item=><div className="document-row" key={item.id}><div><strong>{item.name}</strong><small>{item.fileCount} 个文件 · {bytes(item.bytes)} · {new Date(item.createdAt).toLocaleString()}</small></div><button disabled={busy} onClick={()=>void act(()=>open(item.id))}>查看文件</button></div>)}</section>
    {selected&&<section className="panel padded lower"><h2>{selected.name}</h2><div className="product-columns"><div>{selected.files.map((file,index)=><div className="lower-small" key={file.path}><button style={{maxWidth:'100%',overflowWrap:'anywhere',textAlign:'left'}} onClick={()=>setPreview(file)}>{file.path}</button> <a href={import.meta.env.BASE_URL+'api/work-files/'+selected.id+'/files/'+index+'/download'} download>下载原文件</a><small style={{display:'block'}}>{bytes(file.bytes)} · {file.kind}</small></div>)}</div>{preview&&<div style={{minWidth:0}}><h3 style={{overflowWrap:'anywhere'}}>{preview.path}</h3>{preview.warnings.map(w=><p className="subcopy" key={w}>{w}</p>)}<pre className="product-pre" style={{maxHeight:420,overflow:'auto',whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{preview.text||'（没有可提取正文）'}</pre><small>SHA256：{preview.sha256.slice(0,16)}…</small></div>}</div></section>}
  </>;
}

export function WorkFileSelection({value,onChange,agents,disabled=false}:{value:WorkFileSelectionValue[];onChange:(value:WorkFileSelectionValue[])=>void;agents:{id:string;name:string}[];disabled?:boolean}){
  const [snapshots,setSnapshots]=useState<SnapshotSummary[]>([]),[details,setDetails]=useState<Record<string,Snapshot>>({}),[error,setError]=useState(''),[loading,setLoading]=useState(false);
  useEffect(()=>{let active=true;api<SnapshotSummary[]>('/work-files').then(items=>{if(active)setSnapshots(items);}).catch(e=>{if(active)setError(e.message);});return()=>{active=false;};},[]);
  useEffect(()=>{let active=true;for(const selection of value)if(!details[selection.snapshotId])void api<Snapshot>('/work-files/'+selection.snapshotId).then(item=>{if(active)setDetails(current=>({...current,[item.id]:item}));}).catch(e=>{if(active)setError(e.message);});return()=>{active=false;};},[value,details]);
  async function add(id:string){if(!id)return;setLoading(true);setError('');try{const snapshot=await api<Snapshot>('/work-files/'+id);setDetails(current=>({...current,[id]:snapshot}));onChange([...value,{snapshotId:id,paths:[],agentIds:[]}]);}catch(e){setError((e as Error).message);}finally{setLoading(false);}}
  function patch(index:number,part:Partial<WorkFileSelectionValue>){onChange(value.map((item,i)=>i===index?{...item,...part}:item));}
  return <fieldset className="panel padded lower" disabled={disabled||loading}><legend>选用导入素材</legend><p className="subcopy">只有明确勾选的文件和员工进入本次运行。每次最多 20 份 / 250,000 字符，单份最多 50,000 字符；员工需开启知识检索。目录里的文本文件可复制到独立 Run 工作区继续制作。</p>{error&&<p role="alert" className="banner error">{error}</p>}
    <label className="field">添加素材快照<select value="" onChange={e=>void add(e.target.value)}><option value="">请选择已导入的快照</option>{snapshots.filter(s=>!value.some(v=>v.snapshotId===s.id)).map(s=><option key={s.id} value={s.id}>{s.name}（{s.fileCount} 个文件）</option>)}</select></label>{!snapshots.length&&<p className="subcopy">请先在“项目素材”中导入文件或目录。</p>}
    {value.map((selection,index)=><div className="lower" key={selection.snapshotId}>
      <div className="section-title"><strong>{details[selection.snapshotId]?.name??snapshots.find(s=>s.id===selection.snapshotId)?.name??'读取快照…'}</strong><button type="button" onClick={()=>onChange(value.filter((_,i)=>i!==index))}>移除</button></div>
      <div style={{maxHeight:220,overflow:'auto'}}>{details[selection.snapshotId]?.files.map(file=><label className="inline-check" key={file.path}><input type="checkbox" checked={selection.paths.includes(file.path)} disabled={!file.text.trim()||file.text.length>50000} onChange={e=>patch(index,{paths:e.target.checked?[...selection.paths,file.path]:selection.paths.filter(path=>path!==file.path)})}/><span style={{overflowWrap:'anywhere'}}>{file.path}（{file.text.length.toLocaleString()} 字符）</span></label>)}</div>
      <label className="inline-check lower-small"><input type="checkbox" checked={selection.mode==='workspace'} onChange={e=>patch(index,{mode:e.target.checked?'workspace':'reference'})}/>复制文本文件到独立运行工作区</label>
      {selection.mode==='workspace'&&<p className="subcopy">代码 / CSV 的副本对本项目所有具备文件或终端工具的员工共享，请将这些员工全部勾选授权；不会修改原目录。Office 文件只提供提取正文。</p>}
      <p className="subcopy">授权员工</p>{agents.map(agent=><label className="inline-check" key={agent.id}><input type="checkbox" checked={selection.agentIds.includes(agent.id)} onChange={e=>patch(index,{agentIds:e.target.checked?[...selection.agentIds,agent.id]:selection.agentIds.filter(id=>id!==agent.id)})}/>{agent.name}</label>)}
      {(!selection.paths.length||!selection.agentIds.length)&&<small>请选择至少一个文件和一位员工。</small>}
    </div>)}
  </fieldset>;
}
