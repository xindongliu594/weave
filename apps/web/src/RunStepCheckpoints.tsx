export const stepCheckpointNames:Record<string,string>={'before-tool':'执行工具前已保存','tool-result':'工具结果已保存','cycle-complete':'本轮工作已保存','node-accepted':'阶段交接已保存'};
export function RunStepCheckpoints({events,tasks}:{events:any[];tasks:any[]}) {
  const checkpoints=events.filter(event=>event.type==='step/checkpoint');
  const outcomes=events.filter(event=>['step/evidence-inherited','step/evidence-rejected'].includes(event.type));
  if(!checkpoints.length&&!outcomes.length)return null;
  const reasons:Record<string,string>={FILES_CHANGED:'文件版本发生变化，需要重测',ENVIRONMENT_CHANGED:'沙箱环境发生变化，需要重测',CURRENT_SANDBOX_NOT_ATTESTED:'当前沙箱环境尚未核验',CONTRACT_OR_PERMISSION_CHANGED:'任务要求或权限发生变化',SOURCE_OPERATION_UNKNOWN:'原运行仍有结果未知的操作',NO_REUSABLE_TEST_RECEIPT:'没有符合条件的本地测试回执',TASK_REQUIRES_FRESH_VERIFICATION:'当前任务要求重新验证'};
  const subject=(id:string)=>tasks.find(task=>task.id===id)?.subject??id;
  return <details className="lower"><summary>步骤检查点 · {checkpoints.length} 次保存</summary>
    <p className="subcopy">恢复入口会核对文件、任务要求和沙箱环境。检查点保留进度，不代表任务已经验收通过。</p>
    {outcomes.slice(-10).map(event=><div key={event.seq} className="knowledge-result"><strong>{subject(event.data.taskId)} · {event.type==='step/evidence-inherited'?'已沿用测试证据':'需要重新核验'}</strong>
      {event.data.commands?.map((command:any,index:number)=><p key={index}><code>{command.command}</code> · 来源 <a href={'#run/'+command.inheritedFrom.runId}>{command.inheritedFrom.runId}</a> · 未重复执行</p>)}
      {event.data.reasons?.map((reason:string)=><p key={reason}>{reasons[reason]??'检查点未通过核验，请查看原始记录。'}</p>)}
    </div>)}
    {checkpoints.slice(-10).reverse().map(event=><p key={event.seq}>{subject(event.data.boundary.taskId)} · {stepCheckpointNames[event.data.boundary.trigger]??'进度已保存'} · #{event.seq} · {event.data.files.length} 个文件 · {event.at}</p>)}
    {checkpoints.length>10&&<p className="subcopy">显示最近 10 次；完整记录保留在运行追溯中。</p>}
  </details>;
}
