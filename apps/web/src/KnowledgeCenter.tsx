import { KnowledgeRetrieval } from './KnowledgeRetrieval.tsx';
import { useEffect, useRef, useState } from 'react';
import { api } from './api.ts';
import type { Agent, Department } from '../../../packages/contracts/index.ts';
type Space={id:string;name:string;scope:string;departmentId:string|null;agentIds:string[];version:number};
type Doc={id:string;spaceId:string;title:string;content:string;version:number;sha256:string;source:any};
type SearchRecord={status:'loading'|'completed'|'failed';departmentId:string;departmentName:string;agentId:string;agentName:string;query:string;at:string;message?:string};
function EmployeeKnowledgeSearch({departments,departmentId,agentId,query,results,busy,onDepartmentChange,onAgentChange,onQueryChange,onResultsChange,act}:{departments:Department[];departmentId:string;agentId:string;query:string;results:any[];busy:boolean;onDepartmentChange:(value:string)=>void;onAgentChange:(value:string)=>void;onQueryChange:(value:string)=>void;onResultsChange:(value:any[])=>void;act:(fn:()=>Promise<void>)=>Promise<void>}){
  const [record,setRecord]=useState<SearchRecord|null>(null),[hasSearched,setHasSearched]=useState(false);
  const serial=useRef(0),inFlight=useRef(false),conditions=useRef('');
  const conditionKey=JSON.stringify([departmentId,agentId,query]);
  conditions.current=conditionKey;
  const department=departments.find(d=>d.id===departmentId);
  const currentRecord=record&&record.departmentId===departmentId&&record.agentId===agentId&&record.query===query?record:null;
  useEffect(()=>{
    serial.current+=1;inFlight.current=false;setRecord(null);onResultsChange([]);
    return()=>{serial.current+=1;};
  },[departmentId,agentId,query,onResultsChange]);
  function change(fn:()=>void){serial.current+=1;inFlight.current=false;setRecord(null);onResultsChange([]);fn();}
  async function search(){
    if(busy||inFlight.current||!departmentId||!agentId||!query.trim())return;
    const ticket=++serial.current,identity={departmentId,departmentName:department?.name??departmentId,agentId,agentName:department?.agents.find(a=>a.id===agentId)?.name??agentId,query,at:new Date().toLocaleString('zh-CN')};
    inFlight.current=true;setHasSearched(true);setRecord({...identity,status:'loading'});onResultsChange([]);
    try{await act(async()=>{
      try{
        const found=await api<any[]>('/knowledge/search','POST',{query,departmentId,agentId});
        if(ticket===serial.current&&conditions.current===conditionKey){onResultsChange(found);setRecord({...identity,status:'completed'});}
      }catch(failure){
        if(ticket===serial.current&&conditions.current===conditionKey){
          const message=failure instanceof TypeError&&/fetch/i.test(failure.message)?'后端连接失败，请检查本机服务后重新检索。':failure instanceof Error?failure.message:'检索失败，请稍后重试。';
          setRecord({...identity,status:'failed',message});throw failure;
        }
      }
    });}finally{if(ticket===serial.current)inFlight.current=false;}
  }
  return <section className="panel padded lower"><h2>以员工身份测试检索</h2><p className="subcopy">只检索该员工获授权的知识空间。请在“部门与员工”编辑页绑定知识库。</p>
    <form onSubmit={e=>{e.preventDefault();void search();}}><div className="form-grid"><label className="field">部门<select required value={departmentId} onChange={e=>change(()=>{onDepartmentChange(e.target.value);onAgentChange('');})}><option value="">请选择</option>{departments.map(d=><option key={d.id} value={d.id}>{d.name}</option>)}</select></label><label className="field">员工<select required value={agentId} onChange={e=>change(()=>onAgentChange(e.target.value))}><option value="">请选择</option>{department?.agents.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select></label></div><label className="field">查询<input required value={query} onChange={e=>change(()=>onQueryChange(e.target.value))}/></label><button disabled={busy||currentRecord?.status==='loading'||!departmentId||!agentId||!query.trim()}>{currentRecord?.status==='loading'?'正在检索…':'检索'}</button></form>
    <div className="knowledge-search-state" role="status" aria-live="polite">
      {currentRecord?<><strong>{currentRecord.status==='loading'?'正在检索':currentRecord.status==='failed'?'本次检索失败':results.length?`找到 ${results.length} 条结果`:'没有匹配结果'}</strong><p>检索员工：{currentRecord.agentName} · 部门：{currentRecord.departmentName}</p><p>实际查询：{currentRecord.query}</p><small>{currentRecord.at}</small>{currentRecord.status==='completed'&&results.length===0&&<p>本次检索没有返回匹配内容。请检查该员工的知识库授权及查询词。</p>}{currentRecord.status==='failed'&&<p>{currentRecord.message}</p>}</>:<p>{hasSearched?'检索条件已变更，尚未按当前条件检索。':'尚未检索。请选择员工并输入查询，再点击“检索”。'}</p>}
    </div>
    {currentRecord?.status==='completed'&&results.map(r=><article className="knowledge-result" key={r.id}><strong>{r.title} · v{r.version} · 第 {r.lineStart}–{r.lineEnd} 行</strong><pre className="product-pre">{r.content}</pre><small>{r.matchedBy?.length?'召回：'+r.matchedBy.map((m:string)=>m==='vector'?'语义':'关键词').join(' + ')+' · ':''}引用 {r.documentId}:{r.version}:{r.id.slice(0,12)}</small></article>)}
  </section>;
}
export function AgentKnowledge({agent,departmentId,onChange}:{agent:Agent;departmentId?:string;onChange:(patch:Partial<Agent>)=>void}){
  const [spaces,setSpaces]=useState<Space[]>([]);const [error,setError]=useState('');
  useEffect(()=>{api<Space[]>('/knowledge/spaces').then(setSpaces).catch(e=>setError(e.message));},[]);
  return <div className="field"><span>授权知识库</span>{error&&<small>{error}</small>}{spaces.filter(s=>s.scope==='company'||(s.departmentId===departmentId&&(s.scope==='department'||s.agentIds.includes(agent.id)))).map(s=><label className="inline-check" key={s.id}><input type="checkbox" checked={(agent.knowledgeSpaceIds??[]).includes(s.id)} onChange={e=>onChange({knowledgeSpaceIds:e.target.checked?[...(agent.knowledgeSpaceIds??[]),s.id]:(agent.knowledgeSpaceIds??[]).filter(id=>id!==s.id)})}/>{s.name}</label>)}<small>先选择可访问的知识库，再开启知识检索工具。授权会进入每次运行的独立快照。</small></div>;
}
export function KnowledgeCenter({departments}:{departments:Department[]}){
  const [vault,setVault]=useState<any>(null);
  const [spaces,setSpaces]=useState<Space[]>([]),[docs,setDocs]=useState<Doc[]>([]),[spaceId,setSpaceId]=useState('');
  const [name,setName]=useState(''),[scope,setScope]=useState('department'),[departmentId,setDepartmentId]=useState(departments[0]?.id??''),[agentId,setAgentId]=useState('');
  const [title,setTitle]=useState(''),[content,setContent]=useState(''),[editing,setEditing]=useState<Doc|null>(null);
  const [error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false),[query,setQuery]=useState(''),[results,setResults]=useState<any[]>([]),[versions,setVersions]=useState<any[]>([]);
  const department=departments.find(d=>d.id===departmentId);
  async function refresh(){const [s,d,v]=await Promise.all([api<Space[]>('/knowledge/spaces'),api<Doc[]>('/knowledge/documents'),api('/knowledge/vault')]);setVault(v);setSpaces(s);setDocs(d);setSpaceId(current=>s.some(s=>s.id===current)?current:s[0]?.id??'');}
  useEffect(()=>{refresh().catch(e=>setError(e.message));},[]);
  async function act(fn:()=>Promise<void>){setError('');setNotice('');setBusy(true);try{await fn();await refresh();}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
  return <><div className="page-head"><div><div className="eyebrow">KNOWLEDGE LIBRARY</div><h1>把经验留给下一次协作</h1><p>使用 Obsidian 管理 Markdown 原文件，按公司、部门或员工授权检索。</p></div></div>{error&&<p className="banner error" role="alert">{error}</p>}{notice&&<p className="banner">{notice}</p>}
  {vault&&<section className="panel padded"><div className="section-title"><h2>Obsidian Vault</h2><button disabled={busy} onClick={()=>void act(async()=>{const r=await api<any>('/knowledge/vault/sync','POST',{});setNotice(`同步完成：更新 ${r.indexed} 份笔记`);if(r.errors.length)setError(r.errors.join('；'));})}>立即同步笔记</button></div><p className="subcopy">{vault.instructions}</p><code>{vault.root}</code><p className="subcopy">每 10 秒检查变化；Markdown 是资料源，数据库保留检索索引和历史引用。最后同步：{vault.lastSync?.at?new Date(vault.lastSync.at).toLocaleString():'尚未同步'}</p></section>}
  <KnowledgeRetrieval/>
  <div className="product-columns lower"><section className="panel padded"><h2>知识空间</h2>{spaces.map(s=><div className="row lower-small" key={s.id}><button className={s.id===spaceId?'primary':''} onClick={()=>setSpaceId(s.id)}>{s.name}</button><small>{({company:'公司',department:'部门',employee:'员工'} as any)[s.scope]}</small><button disabled={busy} onClick={()=>{if(confirm('归档这个知识空间？已批准运行中的资料快照仍会保留。'))void act(async()=>{await api('/knowledge/spaces/'+s.id,'DELETE',{version:s.version});});}}>归档</button></div>)}<form className="lower" onSubmit={e=>{e.preventDefault();void act(async()=>{const r=await api<{id:string}>('/knowledge/spaces','POST',{name,scope,departmentId:scope==='company'?null:departmentId,agentIds:scope==='employee'?[agentId]:[]});setSpaceId(r.id);setName('');});}}><label className="field">新空间名称<input required value={name} onChange={e=>setName(e.target.value)}/></label><label className="field">范围<select value={scope} onChange={e=>setScope(e.target.value)}><option value="company">公司共享</option><option value="department">部门</option><option value="employee">员工私有</option></select></label>{scope!=='company'&&<label className="field">所属部门<select required value={departmentId} onChange={e=>{setDepartmentId(e.target.value);setAgentId('');}}><option value="">请选择</option>{departments.map(d=><option value={d.id} key={d.id}>{d.name}</option>)}</select></label>}{scope==='employee'&&<label className="field">授权员工<select required value={agentId} onChange={e=>setAgentId(e.target.value)}><option value="">请选择</option>{department?.agents.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select></label>}<button disabled={busy}>创建知识空间</button></form></section>
  <section className="panel padded"><h2>{editing?'编辑资料 · 保存新版本':'导入资料'}</h2><p className="subcopy">支持 TXT、Markdown、CSV、JSON 文本，单份最多 250,000 字符。资料作为引用内容，不作为执行指令。</p><form onSubmit={e=>{e.preventDefault();void act(async()=>{await api('/knowledge/documents'+(editing?'/'+editing.id:''),editing?'PUT':'POST',{spaceId:editing?.spaceId??spaceId,title,content,...(editing?{version:editing.version}:{})});setTitle('');setContent('');setEditing(null);setNotice('资料已写入 Obsidian Vault 并完成本地索引。');});}}><label className="field">知识空间<select required disabled={!!editing} value={editing?.spaceId??spaceId} onChange={e=>setSpaceId(e.target.value)}><option value="">请选择空间</option>{spaces.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}</select></label><label className="field">选择文本文件<input type="file" accept=".txt,.md,.csv,.json" onChange={e=>{const f=e.target.files?.[0];if(!f)return;if(f.size>500000||!(/\.(txt|md|csv|json)$/i.test(f.name))){setError('请选择 500 KB 以内的文本文件');return;}f.text().then(t=>{if(t.includes('\u0000'))throw Error('不支持二进制内容');setTitle(f.name);setContent(t);}).catch(e=>setError(e.message));}}/></label><label className="field">标题<input required value={title} onChange={e=>setTitle(e.target.value)}/></label><label className="field">正文<textarea required rows={10} maxLength={250000} value={content} onChange={e=>setContent(e.target.value)}/></label><button className="primary" disabled={busy||!spaceId}>保存并索引</button>{editing&&<button type="button" onClick={()=>{setEditing(null);setTitle('');setContent('');}}>取消编辑</button>}</form></section></div>
  <section className="panel padded lower"><h2>空间中的资料</h2>{docs.filter(d=>d.spaceId===spaceId).map(d=><div className="document-row" key={d.id}><div><strong>{d.title}</strong><small>版本 {d.version} · SHA256 {d.sha256.slice(0,12)}</small></div><button onClick={()=>{setEditing(d);setTitle(d.title);setContent(d.content);}}>查看 / 编辑</button><button onClick={()=>void act(async()=>setVersions(await api<any[]>('/knowledge/documents/'+d.id+'/versions')))}>历史</button><button onClick={()=>{if(confirm('归档此文档？历史版本和运行快照会保留。'))void act(async()=>{await api('/knowledge/documents/'+d.id,'DELETE',{version:d.version});});}}>归档</button></div>)}{!docs.some(d=>d.spaceId===spaceId)&&<p className="compact-empty">这里还没有资料。</p>}{versions.length>0&&<details open><summary>文档历史 <button onClick={()=>setVersions([])}>关闭</button></summary>{versions.map(v=><details key={v.version}><summary>版本 {v.version} · {new Date(v.createdAt).toLocaleString()}</summary><pre className="product-pre">{v.content}</pre></details>)}</details>}</section>
  <EmployeeKnowledgeSearch departments={departments} departmentId={departmentId} agentId={agentId} query={query} results={results} busy={busy} onDepartmentChange={setDepartmentId} onAgentChange={setAgentId} onQueryChange={setQuery} onResultsChange={setResults} act={act}/></>;
}
