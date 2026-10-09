import {verifiedRecoveredReceipt,type RunLineageEvidence} from '../../../packages/contracts/run-lineage-evidence.ts';

export function RunInheritedEvidence({runId,snapshot,evidence,error,taskName}:{runId:string;snapshot:any;evidence?:RunLineageEvidence;error?:string;taskName:(id:string)=>string}){
 if(!snapshot.recovery)return null;
 const bound=evidence?.runId===runId&&evidence.projectId===snapshot.projectId&&evidence.planVersion===snapshot.planVersion?evidence:undefined;
 const receipts=(bound?.receipts??[]).filter(entry=>verifiedRecoveredReceipt(bound,runId,snapshot,entry.taskId,entry.attemptId));
 const tests=(bound?.tests??[]).filter(test=>receipts.some(receipt=>receipt.taskId===test.taskId&&receipt.attemptId===test.attemptId&&receipt.sourceRunId===test.sourceRunId&&receipt.acceptanceSeq===test.acceptanceSeq));
 return <div className="lower">
  {error&&<p className="subcopy" role="status">恢复证据核对失败：{error}。可用“刷新审批与交付”重试读取。</p>}
  {bound?.issues.map((issue,index)=><p className="subcopy" role="status" key={issue.code+':'+index}>{issue.taskId&&taskName(issue.taskId)+' · '}{issue.message}</p>)}
  {receipts.length>0&&<details><summary>恢复沿用的已核验交接（{receipts.length}）</summary><p className="subcopy">已沿恢复来源链核对原始宿主凭据与同一次任务尝试，没有重新执行这些节点。</p>{receipts.map(receipt=><div className="knowledge-result" key={receipt.taskId}><strong>{taskName(receipt.taskId)}</strong><p>来源运行 <a href={'#run/'+receipt.sourceRunId}>{receipt.sourceRunId}</a> · 交接 #{receipt.acceptanceSeq}</p><small>任务尝试 {receipt.attemptId}</small>{receipt.receipt.outputs.map((file:any)=><p className="trace-id" key={file.path}>{file.path} · {file.size} 字节 · SHA256 {file.sha256}</p>)}</div>)}</details>}
  {tests.length>0&&<><h3>恢复沿用的真实测试结果</h3><p className="subcopy">以下是已完成节点原运行的实际操作回执；已核对命令、审批、调用、任务尝试及输出哈希。恢复后未重跑，以对应验收文件版本为准。</p>{tests.map(test=><details key={test.sourceRunId+':'+test.operationId}><summary>{test.command} · {test.exitCode===0?'通过':'失败'} · 退出码 {test.exitCode}{test.nodeTests?.status==='available'&&` · ${test.nodeTests.pass}/${test.nodeTests.tests} 测试通过`}</summary><p>{taskName(test.taskId)} · 来源运行 <a href={'#run/'+test.sourceRunId}>{test.sourceRunId}</a> · 命令观察 #{test.observationSeq}</p><p className="trace-id">操作 {test.operationId} · 输出 SHA256 {test.outputSha256}</p><pre className="product-pre">{test.output||'命令未产生文本输出。'}</pre></details>)}</>}
 </div>;
}
