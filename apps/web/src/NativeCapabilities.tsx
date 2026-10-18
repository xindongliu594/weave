import {useEffect,useState} from 'react';
import {api} from './api.ts';

export const builtinToolOptions=[['artifact_write','交付物写入'],['filesystem','工作区文件'],['terminal','开发终端'],['terminal_test','测试终端'],['knowledge_search','知识检索'],['knowledge_read','知识原文'],['browser_read','网页读取'],['mcp_call_readonly','只读 MCP']].map(([id,name])=>({id,name}));
export function useToolOptions():{error:string;options:{id:string;name:string}[]}{
 const [plugins,setPlugins]=useState<any[]>([]),[error,setError]=useState('');
 useEffect(()=>{let active=true;api<any[]>('/capabilities/plugins').then(value=>{if(active)setPlugins(value);}).catch(e=>{if(active)setError(e.message);});return()=>{active=false;};},[]);
 return {error,options:[...builtinToolOptions,...plugins.filter(p=>p.available&&p.enabled).flatMap(p=>p.manifest.tools.map((tool:any)=>({id:tool.name,name:`${p.manifest.namespace} · ${tool.originalName} (${p.manifest.version})`})))]};
}
export function ToolPicker({value,onChange}:{value:string[];onChange:(value:string[])=>void}){
 const {options,error}=useToolOptions();
 const all=[...options,...value.filter(id=>!options.some(item=>item.id===id)).map(id=>({id,name:id+'（当前不可用）'}))];
 return <><div className="tool-options">{all.map(tool=><label key={tool.id}><input type="checkbox" checked={value.includes(tool.id)} onChange={e=>onChange(e.target.checked?[...value,tool.id]:value.filter(id=>id!==tool.id))}/>{tool.name}</label>)}</div>{error&&<small role="alert">工具目录加载失败：{error}</small>}</>;
}
export function NativeCapabilities(){
 const [items,setItems]=useState<any[]>([]),[error,setError]=useState(''),[busy,setBusy]=useState(false),[loading,setLoading]=useState(true);
 const refresh=async()=>setItems(await api<any[]>('/capabilities/plugins'));
 useEffect(()=>{refresh().catch(e=>setError(e.message)).finally(()=>setLoading(false));},[]);
 const toggle=async(item:any)=>{setBusy(true);setError('');try{await api('/capabilities/plugins/'+item.id,'PUT',{enabled:!item.enabled});await refresh();}catch(e){setError((e as Error).message);}finally{setBusy(false);}};
 return <section className="panel padded lower"><h2>原生插件工具</h2><p className="subcopy">启用已安装的插件后，在部门员工与项目策略中分配工具。当前支持在 OpenShell 中执行已核对的文件工具型插件；公司 Skill 仍从知识库按授权发现。</p>
  {error&&<p role="alert" className="form-error">{error}</p>}
  {loading&&<p>正在读取已安装插件…</p>}
  {!loading&&!error&&!items.length&&<p>尚未安装兼容插件。管理员安装原版包并生成经过核对的沙箱安装包后，插件会出现在这里。</p>}
  {items.map(item=><article className="agent-edit" key={item.id}><div className="row"><strong>{item.manifest?.package??item.namespace??'安装文件不可用'} {item.manifest?.version}</strong><span>{item.enabled?'已启用':item.available?'未启用':'校验失败'}</span><button disabled={busy||(!item.available&&!item.enabled)} onClick={()=>void toggle(item)}>{item.enabled?'停用':'启用此版本'}</button></div>
   {item.error?<p role="alert">{item.error}</p>:<><p>来源：{item.manifest.source.kind==='company'?'公司私有':'社区'} · {item.manifest.source.reference}</p><p className="subcopy">{item.manifest.tools.map((tool:any)=>tool.originalName).join('、')}</p><small>固定版本凭证：{item.id.slice(0,16)}。升级仅影响新运行；停用会阻止后续调用。</small></>}
  </article>)}
 </section>;
}
