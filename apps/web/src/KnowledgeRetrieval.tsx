import {useEffect,useState} from 'react';
import {api} from './api.ts';
export function KnowledgeRetrieval(){
 const [state,setState]=useState<any>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const refresh=async()=>setState(await api('/knowledge/retrieval'));
 useEffect(()=>{void refresh().catch(e=>setError(e.message));const timer=setInterval(()=>void refresh().catch(e=>setError(e.message)),5000);return()=>clearInterval(timer);},[]);
 async function act(fn:()=>Promise<unknown>){setBusy(true);setError('');try{await fn();await refresh();}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
 return <section className="panel padded lower"><h2>知识检索方式</h2>{error&&<p className="banner error" role="alert">{error}</p>}{state&&<>
  <p>当前：{state.mode==='hybrid'?'关键词 + 本地语义混合检索':'关键词检索'} · 已索引 {state.indexed} / {state.total} 个当前资料切片{state.running?' · 正在建立索引':''}</p>
  <p className="subcopy">语义检索帮助找到用不同措辞表达的资料。文字和查询均在 Mac 后端处理，不发送到外部模型 API。排序分数表示相对匹配程度，不能作为答案正确性的证明。</p>
  {state.installed?<p className="subcopy">本地模型已安装：{state.model}</p>:<p className="notice-box">尚未安装语义模型。在后端项目目录运行 <code>python3 scripts/install-embedding-model.py</code> 下载并校验约 136 MB 模型文件，然后刷新。下载只传输公开模型文件，不传输知识资料。</p>}
  {state.error&&<p className="banner error" role="alert">{state.error}</p>}
  <button disabled={busy||state.mode==='hybrid'||!state.installed} onClick={()=>void act(()=>api('/knowledge/retrieval','PUT',{mode:'hybrid',version:state.version}))}>启用混合检索</button>
  <button disabled={busy||state.mode==='keyword'} onClick={()=>void act(()=>api('/knowledge/retrieval','PUT',{mode:'keyword',version:state.version}))}>使用关键词检索</button>
  <button disabled={busy||!state.installed||state.running} onClick={()=>void act(()=>api('/knowledge/index','POST',{}))}>补建语义索引</button>
  <button disabled={busy} onClick={()=>void act(refresh)}>刷新索引状态</button>
  <p className="subcopy">新笔记会自动补建索引；首次查询历史版本或临时资料可能较慢。设置影响交互检索和以后批准的运行；已批准运行保留当时的检索方式及模型版本，模型不可用时明确报错。</p>
 </>}</section>;
}
