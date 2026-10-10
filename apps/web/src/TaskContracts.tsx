import { useState } from 'react';
import type { Plan } from '../../../packages/contracts/index.ts';
import {AcceptanceCheckEditor} from './AcceptanceCheckEditor.tsx';

type Task = Plan['tasks'][number];
const names = {work:'普通任务',requirements:'需求确认',implementation:'实现',verification:'验证',review:'独立审查',repair:'修复',integration:'集成'};
function JsonValues({value,onChange}:{value:Record<string,string|number|boolean|null>|undefined;onChange:(value:Record<string,string|number|boolean|null>|undefined)=>void}) {
  const [text,setText]=useState(value?JSON.stringify(value,null,2):''),[error,setError]=useState('');
  return <label className="field">JSON 字段预期值（可选）<textarea rows={2} placeholder={'例如：{"accepted":true}'} value={text} onChange={event=>{
    const next=event.target.value;setText(next);
    try {
      const parsed=next.trim()?JSON.parse(next):undefined;
      if(parsed!==undefined&&(parsed===null||typeof parsed!=='object'||Array.isArray(parsed)||Object.keys(parsed).length>30||Object.values(parsed).some(v=>v!==null&&!['string','number','boolean'].includes(typeof v))))throw Error('请填写字段名到文本、数字、布尔值或 null 的 JSON 对象');
      if(parsed===null)throw Error('请填写 JSON 对象');
      setError('');event.currentTarget.setCustomValidity('');onChange(parsed);
    }catch{const message='请输入有效的 JSON 对象，字段值只能是文本、数字、布尔值或 null';setError(message);event.currentTarget.setCustomValidity(message);}
  }}/>{error&&<small className="validation-error">{error}</small>}</label>;
}
export function TaskContractSummary({task}:{task:Task}) {
  if(!task.inputs?.length&&!task.outputs?.length&&!task.kind)return null;
  return <p className="subcopy">{names[task.kind??'work']}{task.inputs?.length?` · 读取：${task.inputs.map(f=>f.path).join('、')}`:''}{task.outputs?.length?` · 交付：${task.outputs.map(f=>f.path).join('、')}`:''}{task.maxReworkRounds?` · 最多返工 ${task.maxReworkRounds} 轮`:''}</p>;
}
export function TaskContracts({task,tasks,update}:{task:Task;tasks:Task[];update:(patch:Partial<Task>)=>void}) {
  const inputs=task.inputs??[],outputs=task.outputs??[];
  const requiresScope=['implementation','repair'].includes(task.kind??'work');
  const showScope=requiresScope||task.inScope!==undefined||task.outOfScope!==undefined||outputs.length>0;
  const lines=(text:string)=>text.split('\n').map(s=>s.trim()).filter(Boolean);
  return <details className="lower-small"><summary>文件交接与质量检查</summary>
    <AcceptanceCheckEditor task={task} update={update}/>
    <label className="field">任务类型<select value={task.kind??'work'} onChange={e=>update({kind:e.target.value as Task['kind'],...(['implementation','review'].includes(e.target.value)?{inputs:task.inputs??[],outputs:task.outputs??[]}:{}),maxReworkRounds:undefined})}>{Object.entries(names).map(([key,label])=><option value={key} key={key}>{label}</option>)}</select></label>
    <p className="subcopy">声明输出后，文件写入仅限这些路径。上游实际文件、版本和检查结果满足合同后，才允许下游开始工作。</p>
    <div className="section-title"><h4>需要的文件</h4><button type="button" onClick={()=>update({inputs:[...inputs,{path:''}]})}>添加输入</button></div>
    {inputs.map((file,i)=><fieldset key={i}><legend>输入 {i+1}</legend><label className="field">工作区文件路径<input required value={file.path} placeholder="例如 lib/money.mjs" onChange={e=>update({inputs:inputs.map((f,j)=>i===j?{...f,path:e.target.value}:f)})}/></label>
      <label className="field">来源任务<select value={file.producerTaskId??''} onChange={e=>{const id=e.target.value;update({inputs:inputs.map((f,j)=>i===j?{...f,producerTaskId:id||undefined}:f),dependencies:id?[...new Set([...task.dependencies,id])]:task.dependencies});}}><option value="">已固定版本的工作区文件</option>{tasks.filter(t=>t.id!==task.id).map(t=><option key={t.id} value={t.id}>{t.subject||t.id}</option>)}</select></label>
      <label className="field">SHA256（无来源任务时必填）<input required={!file.producerTaskId} pattern="[a-f0-9]{64}" value={file.sha256??''} onChange={e=>update({inputs:inputs.map((f,j)=>i===j?{...f,sha256:e.target.value||undefined}:f)})}/></label>
      {!file.producerTaskId&&<small>文件必须已经存在于工作区，例如恢复运行时保留的文件；填写哈希不会自动导入文件。</small>}
      <button type="button" onClick={()=>update({inputs:inputs.filter((_,j)=>j!==i)})}>删除输入</button></fieldset>)}
    <div className="section-title lower-small"><h4>交付的文件</h4><button type="button" onClick={()=>update({outputs:[...outputs,{path:'',format:'text'}]})}>添加输出</button></div>
    {outputs.map((file,i)=><fieldset key={i}><legend>输出 {i+1}</legend><label className="field">工作区文件路径<input required value={file.path} placeholder="例如 report.json" onChange={e=>update({outputs:outputs.map((f,j)=>i===j?{...f,path:e.target.value}:f)})}/></label>
      <label className="field">文件格式<select value={file.format??'text'} onChange={e=>update({outputs:outputs.map((f,j)=>i===j?{...f,format:e.target.value as 'text'|'json',requiredKeys:undefined,expectedValues:undefined}:f)})}><option value="text">文本</option><option value="json">JSON</option></select></label>
      {file.format==='json'&&<><label className="field">必须包含的顶层字段（英文逗号分隔）<input value={file.requiredKeys?.join(',')??''} onChange={e=>update({outputs:outputs.map((f,j)=>i===j?{...f,requiredKeys:e.target.value.split(',').map(s=>s.trim()).filter(Boolean)}:f)})}/></label><JsonValues value={file.expectedValues} onChange={expectedValues=>update({outputs:outputs.map((f,j)=>i===j?{...f,expectedValues}:f)})}/></>}
      <button type="button" onClick={()=>update({outputs:outputs.filter((_,j)=>j!==i)})}>删除输出</button></fieldset>)}
    {showScope&&<><label className="field">允许修改的文件或目录（每行一项{requiresScope?'，必填':'，可选'}）<textarea required={requiresScope} value={task.inScope?.join('\n')??''} placeholder={'server.mjs\ntests\nREADME.md'} onChange={e=>update({inScope:lines(e.target.value)})}/><small>只填写工作区相对路径。任务说明和验收描述请写在目标中；声明的交付文件必须在允许范围内。</small></label><label className="field">禁止修改的文件或目录（可选）<textarea value={task.outOfScope?.join('\n')??''} onChange={e=>update({outOfScope:lines(e.target.value)})}/></label></>}
    {task.kind&&task.kind!=='work'&&<>
      <label className="field">验证命令（每行一条，实现／修复必填）<textarea required={['implementation','repair'].includes(task.kind)} value={task.verify?.join('\n')??''} onChange={e=>update({verify:lines(e.target.value)})}/><small>命令仍需工具审批；系统核对实际退出码及执行时的文件版本。</small></label>
      {['review','repair'].includes(task.kind)&&<label className="field">{task.kind==='review'?'被审查的任务':'修复来源任务'}<select required value={(task.kind==='review'?task.reviewedTaskId:task.sourceTaskId)??''} onChange={e=>update({[task.kind==='review'?'reviewedTaskId':'sourceTaskId']:e.target.value,dependencies:[...new Set([...task.dependencies,e.target.value])]})}><option value="">请选择</option>{tasks.filter(t=>t.id!==task.id).map(t=><option key={t.id} value={t.id}>{t.subject||t.id}</option>)}</select></label>}
      {task.kind==='repair'&&<label className="field">需要修复的问题编号（每行一项）<textarea required value={task.sourceFindingIds?.join('\n')??''} onChange={e=>update({sourceFindingIds:lines(e.target.value)})}/></label>}
      {task.kind==='review'&&<label className="field">允许自动返工<select value={task.maxReworkRounds??0} onChange={e=>update({maxReworkRounds:Number(e.target.value)})}><option value={0}>停止并交给我处理</option><option value={1}>最多 1 轮</option><option value={2}>最多 2 轮</option></select><small>原员工修复，原审查员工独立复验；共用原任务费用和调用上限。需声明实现的输入输出，审查只读全部输出；下游等待审查。越界、超限或明确拒绝时停止。</small></label>}
      <p className="subcopy">质量任务需要结构化验收。批准的自动返工沿用文件范围和验证命令，终端仍需审批。未授权的修订需重新批准方案。</p>
    </>}
  </details>;
}
