import type {Plan} from '../../../packages/contracts/index.ts';
type Task=Plan['tasks'][number];
export function AcceptanceCheckEditor({task,update}:{task:Task;update:(patch:Partial<Task>)=>void}){
 const checks=task.acceptanceChecks;
 const change=(index:number,patch:Partial<NonNullable<Task['acceptanceChecks']>[number]>)=>update({acceptanceChecks:checks?.map(c=>c.criterionIndex===index?{...c,...patch}:c)});
 return <details className="lower-small"><summary>逐项验收证据</summary><p className="subcopy">将每条验收要求绑定实际命令。启用后全部检查通过才可交接；用例是否覆盖需求仍需独立 QA 和经理审查。</p>
  <label><input type="checkbox" checked={checks!==undefined} onChange={e=>update({acceptanceChecks:e.target.checked?task.acceptanceCriteria.map((_,criterionIndex)=>({criterionIndex,command:task.verify?.[0]??''})):undefined})}/>启用逐项检查</label>
  {checks!==undefined&&task.acceptanceCriteria.map((criterion,index)=>{const check=checks.find(c=>c.criterionIndex===index);return <fieldset key={index}><legend>验收项 {index+1}：{criterion}</legend>
   {!check?<button type="button" onClick={()=>update({acceptanceChecks:[...checks,{criterionIndex:index,command:task.verify?.[0]??''}].filter(c=>c.criterionIndex<task.acceptanceCriteria.length)})}>补充此项检查</button>:<>
    <label className="field">批准的验证命令<select required value={check.command} onChange={e=>change(index,{command:e.target.value})}><option value="">选择 verify 中的命令</option>{task.verify?.map(command=><option key={command} value={command}>{command}</option>)}</select></label>
    <label className="field">预期退出码<input type="number" min={0} max={255} value={check.expectedExitCode??0} onChange={e=>change(index,{expectedExitCode:Number(e.target.value)})}/></label>
    <label className="field">完整输出预期（可选，精确匹配）<textarea maxLength={16000} value={check.expectedOutput??''} onChange={e=>change(index,{expectedOutput:e.target.value||undefined})}/><small>比较实际合并输出；仅统一 Windows/Linux 换行。</small></label>
    <label className="field">最低通过测试数（仅 Node --test，可选）<input type="number" min={1} max={100000} value={check.minimumTests??''} onChange={e=>change(index,{minimumTests:e.target.value?Number(e.target.value):undefined})}/><small>有失败、取消、跳过或待办测试时不通过。</small></label>
   </>}
  </fieldset>})}
 </details>;
}
