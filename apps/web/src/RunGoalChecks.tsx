export function RunGoalChecks({snapshot,events}:{snapshot:any;events:any[]}) {
 const seal=snapshot.goalContract,tasks=snapshot.approvedTasks??snapshot.tasks??[];
 const blocked=events.findLast(event=>event.type==='goal/blocked');
 const anchored=events.some(event=>event.type==='goal/anchored'&&event.data.sha256===seal?.sha256);
 return <div className="lower" aria-label="目标与节点检查"><h3>目标与节点检查</h3>
  {!seal?<p className="subcopy">历史运行未启用目标封印；原有文件、测试及恢复规则仍生效。</p>:<>
   <p>{blocked?'目标检查已暂停执行':anchored?'目标合同已固定':'尚未记录目标检查'} · 方案 v{snapshot.planVersion}</p>
   {blocked&&<p className="banner error" role="alert">{blocked.data.message}<br/>请重新制定并批准方案后执行；不会自动重放本次失败操作。</p>}
   <p className="subcopy">固定目标与权限防止摘要改写。交付是否符合业务目标，还须查看真实测试及独立验收证据。</p>
   <details><summary>原目标与节点验收标准（{tasks.length} 个节点）</summary><p>{snapshot.requirement}</p>
    {tasks.map((task:any)=>{
     const checked=events.some(event=>event.type==='goal/node-checked'&&event.data.taskId===task.id&&event.data.sha256===seal.sha256&&event.data.evidence==='handoff/accepted');
     const inherited=snapshot.handoffCheckpoints?.some((record:any)=>record.taskId===task.id);
     return <div className="knowledge-result" key={task.id}><strong>{task.subject??task.id}</strong>
      <p>{checked?'节点交接证据已核验':inherited?'继承原运行经核验的节点交接':'尚未记录节点交接检查'}</p>
      {(task.acceptanceCriteria??[]).map((text:string,index:number)=><p key={index}><code>{task.id}:{index+1}</code> · {text}</p>)}
     </div>;
    })}<small className="trace-id">目标封印 SHA256：{seal.sha256}</small>
   </details>
  </>}
 </div>;
}
