import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateDeliveryCriteria,assertDeliveryCriteria} from './delivery-criteria.mjs';
import {createHandoffReport} from '../../packages/contracts/handoff-report.mjs';
const writer={id:'write',assigneeId:'author',outputs:[{path:'report.txt'}]},check={id:'check',assigneeId:'qa',acceptanceCriteria:['内容有依据'],handoff:{sections:[{key:'evidence',requirement:'说明依据与风险'}]}};
const snapshot={tasks:[writer,check],deliveryCriteria:[{id:'r1',description:'真实资料报告',producerTaskIds:['write'],checkTaskId:'check',checkCriteriaIndexes:[0],independent:true}]};
function receipts(){const employeeReport=createHandoffReport(check,{output:JSON.stringify({summary:'完成核对',sections:{evidence:'逐条核对原始材料'},risks:[]}),acceptanceResults:[{criterion:'内容有依据',status:'passed',evidence:'已读取 report.txt 并比对原始资料'}]});return new Map([
 ['write',{taskId:'write',attemptId:'w',runId:'run',outputs:[{path:'report.txt',sha256:'a'.repeat(64)}]}],
 ['check',{taskId:'check',attemptId:'q',runId:'run',inputs:[{path:'report.txt',producerTaskId:'write',sha256:'a'.repeat(64)}],employeeReport}],
]);}
test('independent content review is explicitly labelled as employee evidence and survives receipt reload',()=>{
 const records=receipts(),rows=evaluateDeliveryCriteria(snapshot,records);assert.equal(rows[0].status,'passed');assert.equal(rows[0].evidenceRefs[0].kind,'employee_review');
 assert.deepEqual(evaluateDeliveryCriteria(snapshot,new Map(JSON.parse(JSON.stringify([...records])))),rows);assert.doesNotThrow(()=>assertDeliveryCriteria(snapshot,records));
});
test('missing, stale or fabricated statements cannot satisfy delivery',()=>{
 for(const mutate of [r=>r.delete('write'),r=>delete r.get('check').employeeReport,r=>r.get('check').inputs[0].sha256='b'.repeat(64),r=>r.get('check').employeeReport.acceptanceResults[0].criterion='别的要求']){
  const records=receipts();mutate(records);assert.equal(evaluateDeliveryCriteria(snapshot,records)[0].status,'unverified');assert.throws(()=>assertDeliveryCriteria(snapshot,records),/r1/);
 }
 const changed=structuredClone(snapshot);changed.tasks[1].assigneeId='author';assert.throws(()=>assertDeliveryCriteria(changed,receipts()),/r1/);
});
test('a replacement repair output needs a matching new review; legacy runs get no invented evidence',()=>{
 const records=receipts();records.get('write').outputs[0].sha256='c'.repeat(64);assert.throws(()=>assertDeliveryCriteria(snapshot,records));
 records.get('check').inputs[0].sha256='c'.repeat(64);assert.doesNotThrow(()=>assertDeliveryCriteria(snapshot,records));
 assert.deepEqual(evaluateDeliveryCriteria({tasks:[]},new Map()),[]);
});

test('a later writer or changed final file invalidates historical review evidence',()=>{
 const changed=structuredClone(snapshot),records=receipts();
 changed.tasks.push({id:'deliver',assigneeId:'manager',dependencies:['check'],outputs:[{path:'report.txt'}]});
 records.set('deliver',{outputs:[{path:'report.txt',sha256:'b'.repeat(64)}]});
 assert.equal(evaluateDeliveryCriteria(changed,records)[0].status,'unverified');
 for(const files of [[],[{path:'report.txt',sha256:'b'.repeat(64)}]])assert.throws(()=>assertDeliveryCriteria(snapshot,receipts(),snapshot.tasks,files),/report.txt/);
 assert.doesNotThrow(()=>assertDeliveryCriteria(snapshot,receipts(),snapshot.tasks,[{path:'report.txt',sha256:'a'.repeat(64)}]));
});
