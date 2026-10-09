import { useEffect,useState } from 'react';
import type { Plan } from '../../../packages/contracts/index.ts';
import { api } from './api.ts';
type Option={id:string;title:string;version:number;agentIds:string[]};
export function RunInputSummary({projectId,plan}:{projectId:string;plan:Plan}){
 const [docs,setDocs]=useState<Option[]>([]),[error,setError]=useState('');
 useEffect(()=>{setError('');api<Option[]>('/projects/'+projectId+'/knowledge-options').then(setDocs).catch(e=>setError(e.message));},[projectId,plan]);
 return <section className="panel padded lower"><h3>批准后可用的资料</h3>{error&&<p role="alert">{error}</p>}
  <p>{plan.knowledgeDocumentIds===undefined?'使用批准时全部已授权的长期资料。':plan.knowledgeDocumentIds.length?`仅使用选中的 ${plan.knowledgeDocumentIds.length} 份长期资料。`:'本次不使用长期资料。'} 每位员工仍只能检索自己获授权的部分。</p>
  {plan.knowledgeDocumentIds?.map(id=><p key={id}>{docs.find(d=>d.id===id)?.title??'资料已失效或目录尚未加载'}</p>)}
  {(plan.runInputs??[]).map(input=><details key={input.id}><summary>{input.title} · {input.skillName?`工作方法 ${input.skillName}`:'本次专用'} · {input.agentIds.map(id=>plan.agents.find(a=>a.id===id)?.name??'员工已移除').join('、')}</summary><pre className="product-pre">{input.content}</pre></details>)}
 </section>;
}
export function RunInputEditor({projectId,plan,onChange}:{projectId:string;plan:Plan;onChange:(plan:Plan)=>void}){
 const [docs,setDocs]=useState<Option[]>([]),[error,setError]=useState('');
 useEffect(()=>{api<Option[]>('/projects/'+projectId+'/knowledge-options').then(setDocs).catch(e=>setError(e.message));},[projectId]);
 const inputs=plan.runInputs??[];
 function patch(index:number,value:Partial<NonNullable<Plan['runInputs']>[number]>){onChange({...plan,runInputs:inputs.map((input,i)=>i===index?{...input,...value}:input)});}
 return <section className="lower"><h3>本次运行的资料范围</h3><p className="subcopy">长期资料仍受员工原有授权限制。选择和临时文本随方案版本保存，批准时固定内容；不会自动写入 Obsidian 长期知识库。</p>
  {error&&<p role="alert" className="banner error">{error}</p>}
  <label className="field">长期知识资料<select value={plan.knowledgeDocumentIds===undefined?'all':'selected'} onChange={e=>onChange({...plan,knowledgeDocumentIds:e.target.value==='all'?undefined:[]})}><option value="all">全部已授权资料（批准时固定）</option><option value="selected">仅选中的资料（不选则不使用长期资料）</option></select></label>
  {plan.knowledgeDocumentIds!==undefined&&<div>{docs.map(doc=><label className="inline-check" key={doc.id}><input type="checkbox" checked={plan.knowledgeDocumentIds!.includes(doc.id)} onChange={e=>onChange({...plan,knowledgeDocumentIds:e.target.checked?[...plan.knowledgeDocumentIds!,doc.id]:plan.knowledgeDocumentIds!.filter(id=>id!==doc.id)})}/>{doc.title} · v{doc.version} · {doc.agentIds.map(id=>plan.agents.find(a=>a.id===id)?.name??id).join('、')}</label>)}{plan.knowledgeDocumentIds.filter(id=>!docs.some(d=>d.id===id)).map(id=><p key={id}>资料 {id} 不在当前授权目录中。<button type="button" onClick={()=>onChange({...plan,knowledgeDocumentIds:plan.knowledgeDocumentIds!.filter(value=>value!==id)})}>移除失效选择</button></p>)}</div>}
  <div className="section-title lower"><h3>仅本次使用的文本资料</h3><button type="button" disabled={inputs.length>=20} onClick={()=>onChange({...plan,runInputs:[...inputs,{id:'input_'+crypto.randomUUID().slice(0,8),title:'',content:'',agentIds:plan.agents.map(a=>a.id)}]})}>添加本次资料</button></div>
  <p className="subcopy">支持 Markdown、TXT、CSV、JSON。资料最多 50,000 字符，工作方法最多 16,000 字符；总计最多 20 份、250,000 字符。资料供检索；工作方法批准后可按需加载，员工须开启“知识检索”和“知识原文”，执行权限仍以方案为准。</p>
  {inputs.map((input,index)=><div className="agent-edit" key={input.id}>
    <label className="field">资料标题<input required maxLength={200} value={input.title} onChange={e=>patch(index,{title:e.target.value})}/></label>
    <label className="field">使用方式<select value={input.skillName===undefined?'reference':'skill'} onChange={e=>patch(index,{skillName:e.target.value==='skill'?input.id.replaceAll('_','-'):undefined})}><option value="reference">知识资料</option><option value="skill">工作方法（Skill）</option></select></label>
    {input.skillName!==undefined&&<label className="field">工作方法名称<input required maxLength={80} pattern="[a-z0-9]+(-[a-z0-9]+)*" value={input.skillName} onChange={e=>patch(index,{skillName:e.target.value})}/><small>使用小写字母、数字和连字符；正文填写经审核的步骤与适用条件。</small></label>}
    <label className="field">导入本次文本<input type="file" accept=".md,.txt,.csv,.json" onChange={e=>{const file=e.target.files?.[0];if(!file)return;if(file.size>200000||!(/\.(md|txt|csv|json)$/i.test(file.name))){setError('请选择 200 KB 内的文本文件');return;}file.text().then(content=>{if(content.length>50000||content.includes('\0'))throw Error('资料超过 50,000 字符或包含二进制内容');patch(index,{title:file.name,content});setError('');}).catch(e=>setError(e.message));}}/></label>
    <label className="field">本次资料正文<textarea required rows={5} maxLength={input.skillName===undefined?50000:16000} value={input.content} onChange={e=>patch(index,{content:e.target.value})}/></label>
    {input.skillName!==undefined&&input.agentIds.some(id=>!plan.agents.find(agent=>agent.id===id)?.tools.includes('knowledge_read'))&&<p role="alert">工作方法的接收员工还须在方案中开启“知识原文”，否则无法批准执行。</p>}
    <div className="field"><span>可检索这份资料的员工</span>{plan.agents.map(agent=><label className="inline-check" key={agent.id}><input type="checkbox" checked={input.agentIds.includes(agent.id)} onChange={e=>patch(index,{agentIds:e.target.checked?[...input.agentIds,agent.id]:input.agentIds.filter(id=>id!==agent.id)})}/>{agent.name}</label>)}</div>
    {!input.agentIds.length&&<p role="alert">请至少选择一名员工。</p>}
    <button type="button" onClick={()=>onChange({...plan,runInputs:inputs.filter((_,i)=>i!==index)})}>移除这份资料</button>
  </div>)}
 </section>;
}
