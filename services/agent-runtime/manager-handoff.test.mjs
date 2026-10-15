import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HandoffGate, teamTaskPlan } from './handoff.mjs';
import { taskRunEvidence } from './run-evidence.mjs';

const task = { id:'dev', dependencies:[], acceptanceCriteria:['结果正确'], outputs:[{path:'result.txt'}],
  handoff:{sections:[{key:'usage',requirement:'如何使用和核验结果'}]} };
const output = JSON.stringify({summary:'已生成结果',sections:{usage:'读取 result.txt，预期为 ok'},risks:[]});
const update = {status:'completed',output,acceptanceResults:[{criterion:'结果正确',status:'passed',evidence:'核对文件'}]};
async function fixture(work) {
  const root=await mkdtemp(join(tmpdir(),'manager-handoff-'));
  const snapshot={tasks:[task,{id:'qa',dependencies:['dev']},{id:'manager',dependencies:['qa']}]};
  const gate=new HandoffGate({snapshot,sandbox:{root},archive:{id:'run-1',append(){}}});
  try {await writeFile(join(root,'result.txt'),'ok');await work({root,gate,snapshot});}
  finally {await rm(root,{recursive:true,force:true});}
}
test('manager contract rejects missing, oversized or incomplete reports and failed acceptance',()=>fixture(({gate})=>{
  for(const invalid of ['', 'plain text', JSON.stringify({summary:'done',sections:{},risks:[]}),
    JSON.stringify({summary:'done',sections:{usage:'done',unrequested:'extra'},risks:[]}),
    JSON.stringify({summary:'done',sections:{usage:'done'}}),
    JSON.stringify({summary:'x'.repeat(20001),sections:{usage:'done'},risks:[]})])
    assert.throws(()=>gate.prepare('dev','a',{...update,output:invalid}),/HANDOFF_REPORT/);
  assert.throws(()=>gate.prepare('dev','a',{...update,acceptanceResults:[]}),/HANDOFF_REPORT/);
  assert.throws(()=>gate.prepare('dev','a',{...update,acceptanceResults:[{criterion:'结果正确',status:'failed',evidence:'失败'}]}),/HANDOFF_REPORT/);
}));
test('sealed report is separate from host evidence; only direct completed predecessors enter recipient context',()=>fixture(({gate,snapshot})=>{
  const record=gate.prepare('dev','a',update);gate.commit(record);
  assert.equal(record.employeeReport.summary,'已生成结果');
  assert.match(record.employeeReport.contractSha256,/^[a-f0-9]{64}$/);
  assert.match(record.outputs[0].sha256,/^[a-f0-9]{64}$/);
  const state={tasks:[{id:'dev',attemptId:'a',status:'completed',output:'UNTRUSTED_UNSEALED_REPLACEMENT'}]};
  const evidence=id=>taskRunEvidence({snapshot,taskId:id,state,taskIds:new Map(),handoff:gate,runId:'run-1'});
  assert.equal(evidence('qa').completedAncestors[0].employeeReport.summary,'已生成结果');
  assert.equal(evidence('manager').completedAncestors[0].employeeReport,undefined);
  assert.ok(!JSON.stringify(evidence('qa')).includes('UNTRUSTED_UNSEALED_REPLACEMENT'));
  const restored=new HandoffGate({snapshot:{...snapshot,handoffCheckpoints:[record]},sandbox:gate.sandbox,archive:gate.archive});
  assert.deepEqual(restored.committed.get('dev').employeeReport,record.employeeReport);
  state.tasks[0].attemptId='stale';assert.equal(evidence('qa').completedAncestors.length,0);
}));
test('report never replaces real file validation and legacy contracts remain compatible',()=>fixture(async({root,gate})=>{
  await rm(join(root,'result.txt'));assert.throws(()=>gate.prepare('dev','a',update),/MISSING_FILE/);
  const legacy=gate.prepare('qa','b',{output:'legacy text'});assert.equal(legacy.employeeReport,undefined);
  assert.match(teamTaskPlan([task])[0].description,/usage/);
}));
test('identical criterion text is matched by contract order rather than becoming impossible to submit',()=>fixture(({gate})=>{
  gate.tasks.set('dev',{...task,acceptanceCriteria:['same','same']});
  const accepted=gate.prepare('dev','a',{...update,acceptanceResults:[{criterion:'same',status:'passed',evidence:'first'},{criterion:'same',status:'passed',evidence:'second'}]});
  assert.deepEqual(accepted.employeeReport.acceptanceResults.map(item=>item.evidence),['first','second']);
}));
