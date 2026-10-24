import React,{useEffect,useRef,useState,useSyncExternalStore} from 'react';
import {identityAuthorized,identitySession} from './identity-session.ts';
import {createAuditHistoryReader,type AuditFilters,type AuditPage} from './audit-history-client.ts';

const actionNames:Record<string,string>={'project.approve':'批准项目','project.plan':'修改方案','project.message':'项目消息','run.cancel':'停止运行','run.recover':'恢复运行','department.configure':'修改部门','file.create':'登记文件','tool.dispatch':'派发工具','tool.result':'工具结果','tool.reconcile':'核对工具结果','tool.approval':'工具审批','task.merge':'提交任务成果','audit.read':'查询审计','knowledge.publish':'发布知识','knowledge.withdraw':'撤回知识','identity.membership.updated':'调整部门权限','identity.membership.removed':'移除部门权限','identity.user.updated':'修改真人账号','identity.sessions.revoked':'撤销会话','identity.login':'登录','identity.logout':'退出登录'};
const outcomes:Record<string,string>={success:'已记录成功',denied:'已拒绝',failure:'已记录失败',unknown:'结果未知'};

export function AuditHistoryRows({page}:{page:AuditPage}) {
 return <>{page.items.length===0?<p>所选范围内没有审计记录。</p>:page.items.map((row,index)=>{
  if(!('action' in row))return <div className="document-row" key={index}><p>{new Date(row.occurredAt).toLocaleString('zh-CN')} · {row.integrity==='legacy-unverified'?'历史记录缺少可验证摘要':'此记录的摘要校验失败'}。原记录保留，未推测执行人或结果。</p></div>;
  const actor=row.actor.kind==='human'?`真人 ${row.actor.userId}`:row.actor.kind==='local-owner'?'本机所有者':row.actor.kind==='device'?`设备 ${row.actor.deviceId}`:row.actor.kind==='system'?`系统 ${row.actor.service}`:'身份未识别';
  return <div className="document-row" key={row.sourceEventId}><div>
   <strong>{actionNames[row.action]??row.action} · {outcomes[row.outcome]}</strong><small>{new Date(row.occurredAt).toLocaleString('zh-CN')} · {actor}</small>
   <small>对象：{row.resource.type} / {row.resource.id}</small>
   {'runId' in row.correlation&&row.correlation.runId&&<small>运行：{row.correlation.runId}</small>}
   {row.reasonCode&&<small>原因代码：{row.reasonCode}</small>}
   <small>记录：{row.sourceEventId}</small>
  </div></div>;
 })}</>;
}

export function AuditHistory() {
 const identity=useSyncExternalStore(identitySession.subscribe,identitySession.getSnapshot,identitySession.getSnapshot);
 if(!identityAuthorized(identity))return null;
 return <AuditPanel key={identity.generation}/>;
}
function AuditPanel(){
 const [reader]=useState(()=>createAuditHistoryReader()),state=useSyncExternalStore(reader.subscribe,reader.getSnapshot,reader.getSnapshot);
 const [open,setOpen]=useState(false),[runId,setRunId]=useState(''),[correlationId,setCorrelationId]=useState(''),[outcome,setOutcome]=useState(''),[days,setDays]=useState('7');
 const query=useRef<AuditFilters>({});
 useEffect(()=>()=>reader.dispose(),[reader]);
 function refresh(){const before=new Date(),after=new Date(before.getTime()-Number(days)*86400000);query.current={runId:runId.trim(),correlationId:correlationId.trim(),outcome,after:after.toISOString(),before:before.toISOString()};void reader.load(query.current);}
 function toggle(){const value=!open;setOpen(value);reader.setActive(value);if(value)refresh();}
 return <section className="panel padded lower"><h2>审计记录</h2><p className="subcopy">查看已保存的批准、修改、撤权和执行结果摘要。历史成功记录不代表资源当前状态；仅在展开和手动翻页时读取。</p>
  <button aria-expanded={open} onClick={toggle}>{open?'收起并清空审计记录':'查看审计记录'}</button>
  {open&&<><form className="lower" onSubmit={event=>{event.preventDefault();refresh();}}>
   <div className="product-columns"><label className="field">运行 ID<input maxLength={128} value={runId} disabled={state.loading} onChange={event=>setRunId(event.target.value)}/></label><label className="field">关联 ID<input maxLength={128} value={correlationId} disabled={state.loading} onChange={event=>setCorrelationId(event.target.value)}/></label></div>
   <div className="row"><label>时间范围 <select value={days} disabled={state.loading} onChange={event=>setDays(event.target.value)}><option value="1">最近一天</option><option value="7">最近七天</option><option value="30">最近三十天</option></select></label>
    <label>结果 <select value={outcome} disabled={state.loading} onChange={event=>setOutcome(event.target.value)}><option value="">全部</option><option value="success">已记录成功</option><option value="denied">已拒绝</option><option value="failure">已记录失败</option><option value="unknown">结果未知</option></select></label><button disabled={state.loading}>查询 / 刷新第一页</button></div>
  </form>
  {state.loading&&<p role="status">正在读取审计摘要…</p>}{state.error&&<p role="alert" className="banner error">{state.error} 未自动重试。</p>}
  {state.page&&<><p className="subcopy">查询范围：{new Date(state.page.range.after).toLocaleString('zh-CN')} 至 {new Date(state.page.range.before).toLocaleString('zh-CN')}</p><AuditHistoryRows page={state.page}/>
   <button className="lower" disabled={state.loading||!state.page.nextCursor} onClick={()=>void reader.load(query.current,state.page?.nextCursor??undefined)}>下一页</button></>}
  </>}
 </section>;
}
