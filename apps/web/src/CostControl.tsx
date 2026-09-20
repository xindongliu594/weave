import { useEffect,useState } from 'react';
import { api } from './api.ts';
export function CostControl(){
 const [data,setData]=useState<any>(null),[error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false);
 const [selected,setSelected]=useState(''),[input,setInput]=useState(''),[output,setOutput]=useState(''),[note,setNote]=useState(''),[confirmed,setConfirmed]=useState(false);
 const refresh=async()=>setData(await api('/costs'));
 useEffect(()=>{void refresh().catch(e=>setError(e.message));const timer=setInterval(()=>void refresh().catch(e=>setError(e.message)),5000);return()=>clearInterval(timer);},[]);
 async function reconcile(){setBusy(true);setError('');setNotice('');try{await api('/costs/'+selected+'/reconcile','POST',{inputTokens:Number(input),outputTokens:Number(output),note,confirmation:'RECONCILE'});setSelected('');setNotice('费用已按请求时的单价核对，记录与核对依据均已保留。');await refresh();}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
 const current=data?.calls.find((call:any)=>call.id===selected);
 return <section className="panel padded lower"><div className="section-title"><h2>每日预算与待核对费用</h2><button onClick={()=>void refresh().catch(e=>setError(e.message))}>刷新费用</button></div>
  {error&&<p className="banner error" role="alert">{error}</p>}{notice&&<p className="banner" role="status">{notice}</p>}
  {data&&<><p>今日已确认 ${Number(data.spent).toFixed(6)} · 未结算预留 ${Number(data.reserved).toFixed(6)} · {data.timezone} 自然日</p>
   <p className="subcopy">规划、连接测试和执行共用每日限额。预留不是账单；请求超时或未返回用量时继续占用额度，等待核对。核对前不会把未知费用算成零。</p>
   {data.departments.map((d:any)=><p key={d.id}>{d.name}：已确认 ${Number(d.spent).toFixed(6)} + 预留 ${Number(d.reserved).toFixed(6)} / {d.limit===null?'沿用全局限制':'$'+d.limit}</p>)}
   {data.calls.length===0?<p className="subcopy">没有进行中或待核对的调用。</p>:data.calls.map((call:any)=><div className="document-row" key={call.id}><strong>{call.modelName} · {call.purpose}</strong><span>{call.status==='pending'?'请求进行中':'费用待核对'} · 预留 ${call.amount.toFixed(6)}</span><small>{new Date(call.createdAt).toLocaleString()}</small>{call.status==='uncertain'&&<button disabled={busy} onClick={()=>{setSelected(call.id);setInput('');setOutput('');setNote('');setConfirmed(false);}}>核对这次费用</button>}</div>)}
   {current&&<form className="lower" onSubmit={e=>{e.preventDefault();void reconcile();}}><h3>核对 {current.modelName} 的这次请求</h3><p className="subcopy">请依据中转站账单填写完整输入与输出 Token。只有确认没有扣费时才将两项都填 0。单价固定为请求时输入 ${current.inputRate}、输出 ${current.outputRate} / 百万 Token。</p><div className="form-grid"><label className="field">账单输入 Token<input required type="number" min={0} max={2147483647} value={input} onChange={e=>setInput(e.target.value)}/></label><label className="field">账单输出 Token<input required type="number" min={0} max={2147483647} value={output} onChange={e=>setOutput(e.target.value)}/></label></div><label className="field">核对依据<textarea required minLength={5} maxLength={1000} value={note} onChange={e=>setNote(e.target.value)} placeholder="例如账单请求编号、查询时间及确认结果"/></label><label><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/>我已核对供应方账单，确认以上用量</label><div className="lower-small"><button className="primary" disabled={busy||!confirmed||input===''||output===''||note.trim().length<5}>确认记录用量</button><button type="button" disabled={busy} onClick={()=>setSelected('')}>取消</button></div></form>}
   <details className="lower"><summary>最近 20 次已结算或未发送的请求</summary>{data.recent.map((call:any)=><details key={call.id}><summary>{call.modelName} · {call.purpose} · {call.status==='released'?'请求未发送':'已结算'}</summary><pre className="product-pre">{JSON.stringify({id:call.id,history:call.history},null,2)}</pre></details>)}</details>
  </>}
 </section>;
}
