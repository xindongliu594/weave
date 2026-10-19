import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { plannedAcceptanceErrors } from '../apps/api/src/execution-prompt.ts';
import { organizationPlanningTaskExample } from '../apps/api/src/organization-task-planning.ts';
import { taskContractErrors } from '../packages/contracts/task-contracts.mjs';
import { isNodeSyntaxCheck } from '../packages/contracts/acceptance-commands.ts';

test('three untouched real stage-clarified replies cannot use syntax as acceptance proof', () => {
 const evidence=JSON.parse(readFileSync(new URL('../docs/validation/evidence/planning-ab-2026-10-19/deepseek-only/broker-result.json',import.meta.url),'utf8'));
 for(const index of [0,1,4]) {
  const candidate=JSON.parse(evidence.requests[index].content).candidate;
  const before=JSON.stringify(candidate);
  assert.ok(plannedAcceptanceErrors(candidate.tasks).some(e=>e.includes('语法检查')&&e.includes('acceptanceChecks')),String(index));
  assert.equal(JSON.stringify(candidate),before);
 }
});

function plan(){const tasks=structuredClone(organizationPlanningTaskExample);delete tasks[0].acceptanceChecks;return tasks;}
test('implementation syntax self-check stays executable with independent downstream QA',()=>{
 const tasks=plan();assert.deepEqual(plannedAcceptanceErrors(tasks),[]);assert.deepEqual(taskContractErrors(tasks),[]);
 for(const command of ['node --check cli.mjs','node -c cli.mjs','node.exe --no-warnings --check cli.mjs']) {
  tasks[0].verify=[command];assert.deepEqual(plannedAcceptanceErrors(tasks),[]);
  tasks[0].acceptanceChecks=[{criterionIndex:0,command}];
  assert.ok(plannedAcceptanceErrors(tasks).some(e=>e.includes('语法检查')));delete tasks[0].acceptanceChecks;
 }
});
test('self-check exemption cannot omit independent QA, current outputs or real QA mappings',()=>{
 for(const change of [
  (t:ReturnType<typeof plan>)=>{t.splice(1,1);},
  (t:ReturnType<typeof plan>)=>{t[1].assigneeId=t[0].assigneeId;},
  (t:ReturnType<typeof plan>)=>{t[1].dependencies=[];},
  (t:ReturnType<typeof plan>)=>{t[1].inputs=[];},
  (t:ReturnType<typeof plan>)=>{delete t[1].acceptanceChecks;},
  (t:ReturnType<typeof plan>)=>{t[1].verify=['node --check cli.mjs'];t[1].acceptanceChecks=[{criterionIndex:0,command:t[1].verify[0]}];},
 ]) {const tasks=plan();change(tasks);assert.ok(plannedAcceptanceErrors(tasks).some(e=>e.includes('独立 QA')));}
 const tasks=plan();tasks[0].verify=['npm test'];assert.ok(plannedAcceptanceErrors(tasks).some(e=>e.includes('逐项命令映射')));
});
test('direct Node value-taking options and quoted flags cannot hide syntax-only checks',()=>{
 for(const command of ['node --require node:fs --check cli.mjs','node -r node:fs -c cli.mjs','node --import "./register.mjs" --check cli.mjs',"node '--check' cli.mjs"]) {
  assert.equal(isNodeSyntaxCheck(command),true,command);
  const tasks=plan();tasks[0].verify=[command];tasks[0].acceptanceChecks=[{criterionIndex:0,command}];
  assert.ok(plannedAcceptanceErrors(tasks).some(e=>e.includes('语法检查')),command);
 }
 for(const command of ['node app.mjs --check','node --require node:fs app.mjs --check','node --eval "--check"','node --test app.test.mjs','npm test','node --check app.mjs && npm test'])assert.equal(isNodeSyntaxCheck(command),false,command);
});
