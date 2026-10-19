export function RunReply({text,summary,collapsed=false}:{text:string;summary?:string;collapsed?:boolean}) {
  return <>{summary&&<p>{summary}</p>}{collapsed?<details><summary>查看原始回复</summary><pre className="product-pre">{text}</pre></details>:<pre className="product-pre">{text}</pre>}</>;
}

/** Reports are historical submissions, not a replacement for live task status
 * or independent acceptance. Only host-accepted records are displayed here. */
export function RunHandoffReports({snapshot,events}:{snapshot:any;events:any[]}) {
  const records=new Map<string,any>();
  for(const record of [...(snapshot.handoffCheckpoints??[]),...events.filter(event=>event.type==='handoff/accepted').map(event=>event.data)]) {
    if(record?.employeeReport?.version===1&&record.taskId&&record.attemptId) records.set(`${record.taskId}:${record.attemptId}`,record);
  }
  if(!records.size)return null;
  return <section className="lower"><h3>员工交接报告</h3><p className="subcopy">以下是已封存的员工陈述，经理按派工要求独立核验。历史交接不代表当前项目已通过；文件和真实测试证据请结合下方记录查看。</p>
    {[...records.values()].map(record=>{
      const task=snapshot.tasks?.find((item:any)=>item.id===record.taskId),report=record.employeeReport;
      return <details key={`${record.taskId}:${record.attemptId}`}><summary>{task?.subject??record.taskId} · {report.summary}</summary>
        <p className="trace-id">来源运行 {record.runId??'旧记录未注明'} · 尝试 {record.attemptId} · 文件版本 {record.workspaceRevision??'未注明'}</p>
        {Object.entries(report.sections??{}).map(([key,value])=><div className="lower-small" key={key}><strong>{task?.handoff?.sections?.find((section:any)=>section.key===key)?.requirement??key}</strong><p>{String(value)}</p></div>)}
        <p>员工报告的风险：{report.risks?.length?report.risks.join('；'):'未报告已知风险（仍需独立核验）'}</p>
        <ul>{(record.outputs??[]).map((file:any)=><li key={file.path}>{file.path} · SHA256 <code>{file.sha256}</code></li>)}</ul>
      </details>;
    })}
  </section>;
}
