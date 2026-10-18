import {assertHandoffReport,reportTaskFor} from '../../packages/contracts/handoff-report.mjs';
import {collectAcceptanceChecks} from './acceptance-checks.mjs';
import {conflictingDeliveryWriters} from '../../packages/contracts/delivery-files.mjs';

/** Consumes committed, attempt-matched host receipts, never model prose alone. */
export function evaluateDeliveryCriteria(snapshot,records,effectiveTasks=snapshot.tasks,currentFiles){
 const tasks=new Map((effectiveTasks??[]).map(t=>[t.id,t]));
 return (snapshot.deliveryCriteria??[]).map(c=>{
  const row={criterionId:c.id,description:c.description,status:'unverified',reason:'等待当前产物与独立检查记录',evidenceRefs:[]};
  const check=tasks.get(c.checkTaskId),receipt=records.get(c.checkTaskId);
  if(!check||!receipt)return row;
  for(const id of c.producerTaskIds){
   const producer=tasks.get(id),produced=records.get(id);
   if(!producer||!produced||c.independent&&producer.assigneeId===check.assigneeId)return row;
   for(const output of producer.outputs??[]){
    if(conflictingDeliveryWriters(effectiveTasks,id,output.path).length)return {...row,reason:'产物存在检查未覆盖的后续或无序写入：'+output.path};
    const file=produced.outputs?.find(f=>f.path===output.path);
    if(!file||!receipt.inputs?.some(f=>f.producerTaskId===id&&f.path===file.path&&f.sha256===file.sha256))return {...row,reason:'检查未引用当前产物版本：'+output.path};
    if(currentFiles&&!currentFiles.some(f=>f.path===file.path&&f.sha256===file.sha256))return {...row,reason:'最终文件缺失或已改变，需要重新检查：'+output.path};
   }
  }
  let report;
  try{if(check.handoff)report=assertHandoffReport(reportTaskFor(check,receipt),receipt.employeeReport);}catch{return {...row,reason:'结构化复核报告缺失或与当前要求不符'};}
  const checks=collectAcceptanceChecks(check,receipt.commands??[],receipt.workspaceRevision);
  for(const index of c.checkCriteriaIndexes){
   const rule=check.acceptanceChecks?.find(r=>r.criterionIndex===index),observed=checks.find(r=>r.criterionIndex===index);
   if(rule){
    const seal=receipt.acceptanceChecks?.find(r=>r.criterionIndex===index&&r.ruleSha256===observed?.ruleSha256);
    if(observed?.status!=='passed'||seal?.status!=='passed')return {...row,status:observed?.status==='failed'?'failed':'unverified',reason:observed?.reason||'缺少匹配的命令验收凭据'};
   }else if(!report?.acceptanceResults[index]||report.acceptanceResults[index].criterion!==check.acceptanceCriteria?.[index])return row;
   row.evidenceRefs.push({taskId:check.id,criterionIndex:index,sourceRunId:receipt.runId,attemptId:receipt.attemptId,kind:rule?'command':'employee_review'});
  }
  return {...row,status:'passed',reason:row.evidenceRefs.some(r=>r.kind==='employee_review')?'已收到指定员工的结构化复核；内容判断由检查者承担':'当前产物对应的命令检查通过'};
 });
}
export function assertDeliveryCriteria(snapshot,records,effectiveTasks,currentFiles){
 const rows=evaluateDeliveryCriteria(snapshot,records,effectiveTasks,currentFiles),missing=rows.filter(r=>r.status!=='passed');
 if(missing.length)throw Error('DELIVERY_CRITERIA_UNVERIFIED: '+missing.map(r=>r.criterionId+'：'+r.reason).join('；'));
 return rows;
}
