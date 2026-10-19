import type {Plan} from '../../../packages/contracts/index.ts';
import {isNodeSyntaxCheck} from '../../../packages/contracts/acceptance-commands.ts';
type Task=Plan['tasks'][number];
export function AcceptanceCheckEditor({task,update}:{task:Task;update:(patch:Partial<Task>)=>void}){
 const checks=task.acceptanceChecks;
 const commands=task.verify?.filter(command=>!isNodeSyntaxCheck(command))??[];
 const change=(index:number,patch:Partial<NonNullable<Task['acceptanceChecks']>[number]>)=>update({acceptanceChecks:checks?.map(c=>c.criterionIndex===index?{...c,...patch}:c)});
 return <details className="lower-small"><summary>逐项验收证据</summary><p className="subcopy">语法检查保留为开发自检，不作为功能验收证据。功能要求由独立 QA 的实际测试核对，经理审查覆盖范围。启用逐项检查后，请分别选择能够证明该项要求的命令。</p>
  <label><input type="checkbox" checked={checks!==undefined} disabled={checks===undefined&&!commands.length} onChange={e=>update({acceptanceChecks:e.target.checked?task.acceptanceCriteria.map((_,criterionIndex)=>({criterionIndex,command:''})):undefined})}/>启用逐项检查</label>
  {checks!==undefined&&task.acceptanceCriteria.map((criterion,index)=>{const check=checks.find(c=>c.criterionIndex===index);return <fieldset key={index}><legend>验收项 {index+1}：{criterion}</legend>
   {!check?<button type="button" onClick={()=>update({acceptanceChecks:[...checks,{criterionIndex:index,command:''}].filter(c=>c.criterionIndex<task.acceptanceCriteria.length)})}>补充此项检查</button>:<>
    {isNodeSyntaxCheck(check.command)&&<p role="alert">此项错误地使用语法自检作为验收证据，请改用实际功能测试；仅有语法自检的开发节点可关闭逐项检查，由后续独立 QA 验收。</p>}
    <label className="field">批准的验证命令<select required value={commands.includes(check.command)?check.command:''} onChange={e=>change(index,{command:e.target.value})}><option value="">选择 verify 中的功能检查命令</option>{commands.map(command=><option key={command} value={command}>{command}</option>)}</select></label>
    <label className="field">预期退出码<input type="number" min={0} max={255} value={check.expectedExitCode??0} onChange={e=>change(index,{expectedExitCode:Number(e.target.value)})}/></label>
    <label className="field">完整输出预期（可选，精确匹配）<textarea maxLength={16000} value={check.expectedOutput??''} onChange={e=>change(index,{expectedOutput:e.target.value||undefined})}/><small>比较实际合并输出；仅统一 Windows/Linux 换行。</small></label>
    <label className="field">最低通过测试数（仅 Node --test，可选）<input type="number" min={1} max={100000} value={check.minimumTests??''} onChange={e=>change(index,{minimumTests:e.target.value?Number(e.target.value):undefined})}/><small>有失败、取消、跳过或待办测试时不通过。</small></label>
   </>}
  </fieldset>})}
 </details>;
}
