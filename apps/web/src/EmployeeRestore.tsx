import {useState} from 'react';
import type {Agent,Department} from '../../../packages/contracts/index.ts';
import {api} from './api.ts';
type Removed={agent:Agent;sourceVersion:number};
export function EmployeeRestore({department,onSaved}:{department:Department;onSaved:()=>Promise<void>}){
 const [data,setData]=useState<{departmentVersion:number;employees:Removed[]}|null>(null),[chosen,setChosen]=useState<Removed|null>(null),[role,setRole]=useState<'member'|'manager'>('member'),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 async function load(){setData(await api('/departments/'+department.id+'/removed-employees'));}
 async function act(fn:()=>Promise<void>){setBusy(true);setError('');setNotice('');try{await fn();}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
 return <div className="lower-small"><button disabled={busy} onClick={()=>void act(load)}>恢复已移除员工 · {department.name}</button>
  {error&&<p role="alert" className="form-error">{error}</p>}{notice&&<p role="status">{notice}</p>}
  {data&&<div className="panel padded lower-small"><div className="row"><h3>{department.name} · 已移除员工</h3><button onClick={()=>{setData(null);setChosen(null);}}>关闭员工恢复</button></div><p className="subcopy">从最后保留的配置恢复单个员工，保留其身份、职责、模型、工具和知识空间。不会改写已有项目或运行快照。</p>
   {data.employees.length?data.employees.map(item=><div className="document-row" key={item.agent.id}><strong>{item.agent.name}</strong><small>{item.agent.title} · 部门配置 v{item.sourceVersion} · 岗位 v{item.agent.roleVersion??1}</small><button disabled={busy} onClick={()=>{setChosen(item);setRole(item.agent.role);}}>查看并恢复 {item.agent.name}</button></div>):<p>没有可恢复的员工。</p>}
   {chosen&&<section className="lower"><h3>恢复配置：{chosen.agent.name}</h3><p>{chosen.agent.instructions}</p><p className="subcopy">系统约束：{chosen.agent.systemConstraints||'未设置'} · 输出规范：{chosen.agent.outputFormat||'未设置'}</p><details><summary>查看原始配置</summary><pre className="product-pre">{JSON.stringify(chosen.agent,null,2)}</pre></details><label className="field">恢复后的角色<select value={role} onChange={e=>setRole(e.target.value as 'member'|'manager')}><option value="member">团队员工</option><option value="manager">部门经理（当前经理改为员工）</option></select></label>{role==='manager'&&<p>恢复后，{department.agents.find(a=>a.role==='manager')?.name} 将改为团队员工，部门仍保留一位经理。</p>}
    <button disabled={busy} className="primary" onClick={()=>void act(async()=>{await api('/departments/'+department.id+'/restore-employee','POST',{agentId:chosen.agent.id,sourceVersion:chosen.sourceVersion,departmentVersion:data.departmentVersion,role});setChosen(null);await load();await onSaved();setNotice('员工已恢复，新的部门和岗位版本已保存。');})}>确认恢复员工</button>
   </section>}
  </div>}
 </div>;
}
