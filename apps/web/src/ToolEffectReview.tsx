import {useEffect,useState,useSyncExternalStore} from 'react';
import {identitySession} from './identity-session.ts';
import {canReviewToolEffect,createToolEffectReviewClient} from './tool-effect-review-client.ts';
const effects={read:'读取资料',workspace:'修改运行或工作区状态',external:'操作外部服务',unknown:'效果尚未核对'};
const statuses={unreviewed:'待审核',reviewed:'已审核',retired:'已停用'};

export function ToolEffectReview(){
 const identity=useSyncExternalStore(identitySession.subscribe,identitySession.getSnapshot,identitySession.getSnapshot);
 if(identity.status==='local-owner')return <section className="panel padded lower"><h2>工具效果审核</h2><p className="subcopy">企业工具合同需要已登录的组织管理员审核。本机模式继续沿用已有工具授权。</p></section>;
 if(identity.status!=='authenticated')return null;
 return <ReviewPanel key={identity.generation}/>;
}
function ReviewPanel(){
 const [client]=useState(()=>createToolEffectReviewClient()),state=useSyncExternalStore(client.subscribe,client.getSnapshot,client.getSnapshot),[open,setOpen]=useState(false);
 useEffect(()=>()=>client.dispose(),[client]);
 const item=state.selected,contract=item?.contract;
 function toggle(){const value=!open;setOpen(value);client.setActive(value);if(value)void client.catalog();}
 return <section className="panel padded lower"><h2>工具效果审核</h2><p className="subcopy">核对工具当前版本会读取或修改什么，再允许项目选用。员工仍需独立工具授权；审核不会启动任务或增加预算。</p>
  <button aria-expanded={open} onClick={toggle}>{open?'收起审核目录':'查看待核对工具'}</button>
  {open&&<><div className="row lower"><select aria-label="选择工具效果合同" disabled={state.busy} value={item?JSON.stringify({namespace:contract!.namespace,toolName:contract!.toolName}):''} onChange={event=>{const key=JSON.parse(event.target.value);void client.select(key);}}>
   <option value="" disabled>选择一个工具，读取当前审核状态</option>{state.items.map(source=><option key={source.capabilityId} value={JSON.stringify({namespace:source.namespace,toolName:source.toolName})}>{source.toolName} · {effects[source.effect]}</option>)}
  </select><button disabled={state.busy} onClick={()=>void client.catalog()}>刷新目录</button></div>
  {state.busy&&<p role="status">正在核对当前版本…</p>}{state.error&&<p role="alert" className="form-error">{state.error} 未自动重试，请先刷新并核对状态。</p>}
  {item&&contract&&<article className="agent-edit"><h3>{contract.toolName} · {statuses[item.status]}</h3><p>{effects[contract.effect]}；{contract.cost.kind==='free'?'没有独立付费服务调用，本机资源与后续模型预算仍照常管理':'费用尚未核对'}。</p>
   <p>来源：{contract.namespace}<br/>版本：{contract.source.version}</p><p className="subcopy">所需权限：{contract.permissions.join('、')}<br/>重试方式：{contract.retry==='never'?'结果未确认时不自动重放':contract.retry==='bounded-read'?'仅允许有界读取重试':'需供应商幂等支持'}</p>
   {contract.effect==='unknown'&&<p>此来源还没有可核对的效果说明，暂不能审核为可执行。</p>}
   <button disabled={state.busy||!canReviewToolEffect(item)} onClick={()=>void client.review()}>审核并允许选用此版本</button>{item.status==='reviewed'&&<button disabled={state.busy} onClick={()=>void client.retire()}>停用此合同</button>}
   <small>版本凭证：{item.digest}。停用后新调用会被拒绝，历史记录保留。</small>
  </article>}
  </>}
 </section>;
}
