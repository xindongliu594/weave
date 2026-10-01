import {useEffect,useState} from 'react';
import type {Policy,Model} from '../../../packages/contracts/index.ts';
import {api} from './api.ts';
import {ContextPolicy} from './ContextPolicy.tsx';
import {RecoveryPolicy} from './RecoveryPolicy.tsx';
const tools=[['artifact_write','交付物写入'],['filesystem','工作区文件'],['terminal','开发终端'],['terminal_test','测试终端'],['knowledge_search','知识检索'],['knowledge_read','知识原文']] as const;
export function ProjectPolicy({policy,models,departmentId,departmentIds,onChange}:{policy:Policy;models:Model[];departmentId:string;departmentIds?:string[];onChange?:(value:Policy)=>void}){
 const [spaces,setSpaces]=useState<any[]>([]),[error,setError]=useState('');
 useEffect(()=>{api<any[]>('/knowledge/spaces').then(setSpaces).catch(e=>setError(e.message));},[]);
 const groups=[
  {key:'allowedModelIds',title:'允许的模型（含规划和备用）',options:models.map(m=>({id:m.id,name:m.name}))},
  {key:'allowedTools',title:'允许的工具',options:tools.map(([id,name])=>({id,name}))},
  {key:'allowedKnowledgeSpaceIds',title:'允许的知识空间',options:spaces.filter(s=>s.scope==='company'||(departmentIds??policy.allowedDepartmentIds??[departmentId]).includes(s.departmentId)).map(s=>({id:s.id,name:s.name}))},
 ] as const;
 return <section className="panel padded lower-small"><h3>项目执行策略</h3><p className="subcopy">这是项目可使用的范围。员工还需单独分配权限；私有知识空间仍按所属部门和员工检查。修改策略保存为新版本后，需要重新批准。</p>
  {error&&<p role="alert" className="form-error">{error}</p>}
  {onChange&&<div className="form-grid">{([['maxBudget','项目预算（USD）',.000001,10000],['maxAgents','策略最多员工',1,6],['maxConcurrentAgents','策略并发上限',1,6],['deadlineSeconds','策略执行时限（秒）',60,86400],['maxModelCalls','策略调用上限',1,1000],['maxTaskModelCalls','策略每员工每任务调用上限',1,1000],['contextBytes','策略上下文上限（字节）',4096,1000000]] as const).map(([key,label,min,max])=><label className="field" key={key}>{label}<input type="number" required min={min} max={max} step={key==='maxBudget'?'any':1} value={policy[key]??({maxModelCalls:100,maxTaskModelCalls:40,contextBytes:64000} as any)[key]} onChange={e=>onChange({...policy,[key]:e.target.valueAsNumber})}/></label>)}</div>}
  <ContextPolicy policy={policy} onChange={onChange}/>
  <RecoveryPolicy policy={policy} onChange={onChange}/>
  {groups.map(group=>{const selected=policy[group.key]??[];const options=[...group.options,...selected.filter(id=>!group.options.some(o=>o.id===id)).map(id=>({id,name:id+'（当前目录不可用）'}))];return <fieldset className="lower-small" key={group.key}><legend>{group.title}</legend><div className="tool-options">{options.filter(option=>onChange||selected.some(id=>id===option.id)).map(option=>onChange?<label key={option.id}><input type="checkbox" aria-label={'策略允许：'+option.name} checked={selected.some(id=>id===option.id)} onChange={e=>onChange({...policy,[group.key]:e.target.checked?[...selected,option.id]:selected.filter(id=>id!==option.id)})}/>{option.name}</label>:<span key={option.id}>{option.name}</span>)}</div>{!selected.length&&<small>未授权任何{group.key==='allowedModelIds'?'模型':group.key==='allowedTools'?'工具':'知识空间'}。</small>}</fieldset>;})}
 </section>;
}
