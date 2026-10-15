import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {taskSchema} from '../packages/contracts/index.ts';
import {HandoffGate,inspectArtifact} from '../services/agent-runtime/handoff.mjs';
import {resumeHandoff} from '../apps/api/src/handoff-checkpoints.ts';
import {planningAcceptanceInstructions} from '../apps/api/src/execution-prompt.ts';
import {createHandoffReport} from '../packages/contracts/handoff-report.mjs';
import {taskRunEvidence} from '../services/agent-runtime/run-evidence.mjs';

const task={id:'qa',subject:'核验',objective:'独立核验',assigneeId:'tester',dependencies:[],acceptanceCriteria:['符合需求'],estimatedInputTokens:2000,estimatedOutputTokens:2000,
  inputs:[],outputs:[],handoff:{sections:[{key:'coverage',requirement:'说明覆盖范围和不足'}]}};
test('manager handoff survives plan schema; invalid and duplicate keys are rejected',()=>{
  assert.deepEqual(taskSchema.parse(task).handoff,task.handoff);
  for(const sections of [[],[...task.handoff.sections,...task.handoff.sections],[{key:'../private',requirement:'bad'}]])
    assert.equal(taskSchema.safeParse({...task,handoff:{sections}}).success,false);
  assert.match(planningAcceptanceInstructions,/handoff.sections/);
});
test('authorized repaired reports survive independent review and two recovery admissions',async()=>{
  const root=await mkdtemp(join(tmpdir(),'handoff-report-rework-'));
  try {
    await writeFile(join(root,'result.txt'),'repaired');
    const source={...task,id:'dev',kind:'implementation',assignee:'dev',inScope:['result.txt'],verify:['check'],outputs:[{path:'result.txt'}]};
    const review={id:'review',kind:'review',assignee:'qa',reviewedTaskId:'dev',dependencies:['dev'],maxReworkRounds:1,inputs:[{path:'result.txt',producerTaskId:'dev'}],outputs:[]};
    const repair={...source,kind:'repair',acceptanceCriteria:['修正已发现的问题'],reworkRound:1};
    const report=createHandoffReport(repair,{output:JSON.stringify({summary:'已修正',sections:{coverage:'修复问题并复测'},risks:[]}),acceptanceResults:[{criterion:repair.acceptanceCriteria[0],status:'passed',evidence:'复测'}]});
    const record={taskId:'dev',attemptId:'repair',employeeReport:report,inputs:[],outputs:[inspectArtifact(root,{path:'result.txt'})],commands:[]};
    const snapshot:any={tasks:[source,review],agents:[]};
    const done=new Map([['dev',{attemptId:'repair',status:'completed'}],['review',{attemptId:'recheck',status:'completed',verdict:'pass'}]]);
    const events:any[]=[{type:'quality/rework-created',data:{reviewTaskId:'review',round:1,repairContract:repair,reviewContract:review}},
      {type:'handoff/accepted',data:record},{type:'handoff/accepted',data:{taskId:'review',attemptId:'recheck',outputs:[]}},
      {type:'quality/reviewed',data:{taskId:'review',attemptId:'recheck',verdict:'pass'}}];
    const first=resumeHandoff(snapshot,events,done,root);
    const restored={...snapshot,handoffCheckpoints:first};
    assert.deepEqual(resumeHandoff(restored,[],done,root)[0].employeeReport,report);
    const gate=new HandoffGate({snapshot:restored,sandbox:{root},archive:{append(){}}});
    const context=taskRunEvidence({snapshot:restored,taskId:'review',state:{tasks:[{id:'dev',attemptId:'repair',status:'completed'}]},taskIds:new Map(),handoff:gate,runId:'restored'});
    assert.equal(context.completedAncestors[0].employeeReport.summary,'已修正');
    const changed=structuredClone(restored);changed.tasks[0].handoff.sections[0].requirement='改变经理要求';
    assert.throws(()=>resumeHandoff(changed,[],done,root),/HANDOFF_REPORT/);
  } finally {await rm(root,{recursive:true,force:true});}
});
test('recovery preserves contracted report and rejects absent seals or changed manager requirements',async()=>{
  const root=await mkdtemp(join(tmpdir(),'handoff-report-recovery-'));
  try {
    const snapshot={tasks:[task],agents:[]};
    const gate=new HandoffGate({snapshot,sandbox:{root},archive:{id:'source',append(){}}});
    const record=gate.prepare('qa','a',{status:'completed',output:JSON.stringify({summary:'通过',sections:{coverage:'已核对全部标准，无已知缺口'},risks:[]}),acceptanceResults:[{criterion:'符合需求',status:'passed',evidence:'独立核对结果'}]});
    const completed=new Map([['qa',{attemptId:'a',status:'completed'}]]);
    const events=[{type:'handoff/accepted',data:record}];
    assert.deepEqual(resumeHandoff(snapshot,events,completed,root)[0].employeeReport,record.employeeReport);
    assert.throws(()=>resumeHandoff(snapshot,[],completed,root),/HANDOFF_REPORT/);
    const inherited={...snapshot,handoffCheckpoints:[record]};
    assert.deepEqual(resumeHandoff(inherited,[],completed,root)[0].employeeReport,record.employeeReport);
    const changed=structuredClone(snapshot);changed.tasks[0].handoff.sections[0].requirement='另一个交接要求';
    assert.throws(()=>resumeHandoff(changed,events,completed,root),/HANDOFF_REPORT/);
    const tampered=structuredClone(record);tampered.employeeReport.sections={};
    assert.throws(()=>resumeHandoff(snapshot,[{type:'handoff/accepted',data:tampered}],completed,root),/HANDOFF_REPORT/);
  } finally {await rm(root,{recursive:true,force:true});}
});
