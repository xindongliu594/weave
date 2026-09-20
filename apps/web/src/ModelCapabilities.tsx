import {useState} from 'react';
import type {Model} from '../../../packages/contracts/index.ts';
import {api} from './api.ts';
export function ModelCapabilities({model,onSaved}:{model:Model;onSaved:()=>Promise<void>}){
 const [busy,setBusy]=useState(false),[limit,setLimit]=useState(.1),[error,setError]=useState(''),[notice,setNotice]=useState(''),[history,setHistory]=useState<any[]|null>(null);
 const evidence=model.capabilities?.tools;
 async function test(){setBusy(true);setError('');setNotice('');try{const result=await api<{message:string}>('/models/'+model.id+'/test-tools','POST',{maxCost:limit});setNotice(result.message);}catch(e){setError((e as Error).message);}finally{try{await onSaved();}catch(e){setError((e as Error).message);}finally{setBusy(false);}}}
 return <div className="lower-small"><p><strong>工具调用：{evidence?.status==='supported'?'往返测试通过':evidence?.status==='failed'?'上次测试未通过':'尚未验证'}</strong>{evidence&&<small>{new Date(evidence.checkedAt).toLocaleString()}</small>}</p>
  <p className="subcopy">DSH 团队调度也需要工具调用。测试最多发起两次收费请求，仅检查协议，不执行文件或终端操作。</p>
  <label className="field">工具测试费用上限（USD）<input type="number" min={.000001} max={10} step="any" value={limit} onChange={e=>setLimit(e.target.valueAsNumber)}/></label>
  <button disabled={busy||model.status!=='available'||!Number.isFinite(limit)||limit<=0||limit>10} onClick={()=>void test()}>{busy?'正在测试工具往返…':'测试工具能力'}</button>
  <button disabled={busy} onClick={()=>void api<any[]>('/models/'+model.id+'/capability-tests').then(setHistory).catch(e=>setError(e.message))}>查看能力测试记录</button>
  {error&&<p className="banner error" role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
  {history&&<details open><summary>最近的工具测试 <button onClick={()=>setHistory(null)}>关闭</button></summary>{history.length?history.map(test=><p key={test.id}>{new Date(test.createdAt).toLocaleString()} · {({supported:'通过',failed:'未通过',running:'进行中',not_applied:'未应用'} as any)[test.status]??test.status}<small>配置 v{test.modelVersion} · {test.requestIds.length} 次请求 · {test.code??test.probeVersion}</small></p>):<p>尚无记录。</p>}</details>}
 </div>;
}
