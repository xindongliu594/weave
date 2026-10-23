import {useEffect,useState} from 'react';
import {api,ApiError} from './api.ts';

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
 const [recipe,setRecipe]=useState('{\n  "namespace": "example",\n  "package": "@scope/dsh-tool",\n  "version": "1.0.0",\n  "config": {},\n  "files": {"tool_name": {"read": [], "write": []}}\n}');
 const [install,setInstall]=useState<any>(null),[portable,setPortable]=useState<any>(null);
 const refresh=async()=>setItems(await api<any[]>('/capabilities/plugins'));
 const readInstall=async(id:string)=>{try{const value=await api<any>('/capabilities/plugins/install/'+id);setInstall(value);setError('');if(value.stage==='complete')await refresh();}catch(e){if(e instanceof ApiError&&e.status===404){sessionStorage.removeItem('native-install-job');setInstall(null);}else setInstall((previous:any)=>previous??{id,stage:'unavailable'});setError('安装状态暂时无法读取：'+(e as Error).message+'。请重试读取状态。');}};
 useEffect(()=>{refresh().catch(e=>setError(e.message)).finally(()=>setLoading(false));},[]);
 useEffect(()=>{const id=sessionStorage.getItem('native-install-job');if(id)void readInstall(id);},[]);
 useEffect(()=>{if(!install?.id||!['queued','installing','building','verifying'].includes(install.stage))return;const timer=setTimeout(()=>void readInstall(install.id),1200);return()=>clearTimeout(timer);},[install]);
 const start=async()=>{setBusy(true);setError('');try{const request=portable??{kind:'npm',recipe:JSON.parse(recipe)};const state=await api<any>('/capabilities/plugins/install','POST',request);sessionStorage.setItem('native-install-job',state.id);setInstall(state);if(state.stage==='complete')await refresh();}catch(e){setError((e as Error).message);}finally{setBusy(false);}};
 const upload=async(file?:File)=>{setPortable(null);if(!file)return;try{if(file.size>1400000)throw Error('可移植安装包超过当前网页上传限制。');const value=JSON.parse(await file.text());if(!value.id||!value.manifest||!value.compressed||!value.metadata)throw Error('安装包需要 id、manifest、compressed、metadata 字段。');setPortable({kind:'portable',...value});setError('');}catch(e){setError((e as Error).message);}};
 const toggle=async(item:any)=>{setBusy(true);setError('');try{await api('/capabilities/plugins/'+item.id,'PUT',{enabled:!item.enabled});await refresh();}catch(e){setError((e as Error).message);}finally{setBusy(false);}};
 return <section className="panel padded lower"><h2>原生插件工具</h2><p className="subcopy">启用已安装的插件后，在部门员工与项目策略中分配工具。当前支持在 OpenShell 中执行已核对的文件工具型插件；公司 Skill 仍从知识库按授权发现。</p>
  <div className="agent-edit"><h3>安装兼容工具插件</h3><p className="subcopy">输入精确 npm 包版本和逐工具文件权限配置，或选择经审核的可移植安装包。安装完成后先启用版本，再分配给部门员工与项目策略。需要独立网页或后台服务的插件不适用此入口。</p>
  <label>接入配置 JSON<textarea aria-label="插件接入配置 JSON" value={recipe} onChange={e=>{setRecipe(e.target.value);setPortable(null);}} rows={9} style={{width:'100%'}}/></label>
  <label>可移植安装包 JSON<input type="file" accept=".json,application/json" onChange={e=>void upload(e.target.files?.[0])}/></label>
  {portable&&<p>已选择可移植包：{portable.manifest?.package} {portable.manifest?.version}</p>}
  <button disabled={busy||!!install&&['queued','installing','building','verifying'].includes(install.stage)} onClick={()=>void start()}>开始安装</button>
  {install&&<p role="status">安装状态：{({queued:'等待',installing:'下载依赖',building:'构建与工具探测',verifying:'校验',complete:'安装完成，请在目录核对启用和授权状态',failed:'失败',interrupted:'服务重启，已中断',unavailable:'暂时无法读取，请重试'} as Record<string,string>)[install.stage]??install.stage}{install.error?'；'+install.error:''}</p>}</div>
  {install?.id&&<button onClick={()=>void readInstall(install.id)}>重新读取安装状态</button>}
  {error&&<p role="alert" className="form-error">{error}</p>}
  {loading&&<p>正在读取已安装插件…</p>}
  {!loading&&!error&&!items.length&&<p>尚未安装兼容插件。管理员安装原版包并生成经过核对的沙箱安装包后，插件会出现在这里。</p>}
  {items.map(item=><article className="agent-edit" key={item.id}><div className="row"><strong>{item.manifest?.package??item.namespace??'安装文件不可用'} {item.manifest?.version}</strong><span>{item.enabled?'已启用':item.available?'未启用':'校验失败'}</span><button disabled={busy||(!item.available&&!item.enabled)} onClick={()=>void toggle(item)}>{item.enabled?'停用':'启用此版本'}</button></div>
   {item.error?<p role="alert">{item.error}</p>:<><p>来源：{item.manifest.source.kind==='company'?'公司私有':'社区'} · {item.manifest.source.reference}</p><p className="subcopy">{item.manifest.tools.map((tool:any)=>tool.originalName).join('、')}</p><small>固定版本凭证：{item.id.slice(0,16)}。升级仅影响新运行；停用会阻止后续调用。</small></>}
  </article>)}
 </section>;
}
