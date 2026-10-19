import test from 'node:test';
import assert from 'node:assert/strict';
import { plannedAcceptanceErrors } from '../apps/api/src/execution-prompt.ts';
import type { Plan } from '../packages/contracts/index.ts';
import {readFileSync} from 'node:fs';

const tasks: Plan['tasks'] = [
 {id:'dev',subject:'更新代码',objective:'增量修改',assigneeId:'developer',dependencies:[],acceptanceCriteria:['自测'],estimatedInputTokens:100,estimatedOutputTokens:100,outputs:[{path:'cli.mjs'}],verify:['node --test smoke.test.mjs'],acceptanceChecks:[{criterionIndex:0,command:'node --test smoke.test.mjs',minimumTests:1}]},
 {id:'qa',subject:'独立测试',objective:'测试更新后的代码',assigneeId:'qa',dependencies:['dev'],acceptanceCriteria:['原17项通过'],estimatedInputTokens:100,estimatedOutputTokens:100,inputs:[{path:'cli.mjs',sha256:'a'.repeat(64)}],verify:['node --test cli.test.mjs'],acceptanceChecks:[{criterionIndex:0,command:'node --test cli.test.mjs',minimumTests:17}]},
];

test('new AI candidate cannot pin an external old hash after an upstream writer',()=>{
 const errors=plannedAcceptanceErrors(tasks);
 assert.ok(errors.some(message=>message.includes('qa')&&message.includes('cli.mjs')&&message.includes('来源任务')),JSON.stringify(errors));
 const correct=structuredClone(tasks);correct[1].inputs=[{path:'cli.mjs',producerTaskId:'dev'}];
 assert.deepEqual(plannedAcceptanceErrors(correct),[]);
});

test('new AI candidate requires a real minimum count for each Node test mapping',()=>{
 const correct=structuredClone(tasks);correct[1].inputs=[{path:'cli.mjs',producerTaskId:'dev'}];delete correct[1].acceptanceChecks![0].minimumTests;
 assert.ok(plannedAcceptanceErrors(correct).some(message=>message.includes('最低测试数')));
 correct[1].acceptanceChecks![0].minimumTests=17;
 assert.deepEqual(plannedAcceptanceErrors(correct),[]);
});

test('fixed source files remain valid when no earlier task writes them',()=>{
 const correct=structuredClone(tasks);correct[1].inputs=[{path:'cli.test.mjs',sha256:'b'.repeat(64)}];
 assert.deepEqual(plannedAcceptanceErrors(correct),[]);
});

test('Node flags cannot bypass the supported test-count parser in a new candidate',()=>{
 const plan=structuredClone(tasks);plan[1].inputs=[{path:'cli.mjs',producerTaskId:'dev'}];
 plan[1].verify=['node --no-warnings --test cli.test.mjs'];
 plan[1].acceptanceChecks=[{criterionIndex:0,command:plan[1].verify[0]}];
 assert.ok(plannedAcceptanceErrors(plan).some(message=>message.includes('node --test')));
 plan[1].acceptanceChecks[0].minimumTests=17;
 assert.ok(plannedAcceptanceErrors(plan).some(message=>message.includes('node --test')),'an unsupported form cannot pretend to be counted');
});

test('untouched real preview cannot require the developer to run a future QA output',()=>{
 const evidence=JSON.parse(readFileSync(new URL('../docs/validation/evidence/delivery-binding-pilot-2026-10-19/real/broker-result.json',import.meta.url),'utf8'));
 const raw=evidence.requests[0].content,plan=JSON.parse(raw).candidate;
 const before=JSON.stringify(plan);
 const errors=plannedAcceptanceErrors(plan.tasks);
 assert.equal(errors.filter(e=>e.includes('后续或并行任务')).length,1,JSON.stringify(errors));
 assert.match(errors.join(';'),/develop.*test\/temperature.test.js.*verify/);
 assert.equal(JSON.stringify(plan),before);assert.equal(evidence.requests[0].content,raw);
});

test('known Node command files must be own outputs or declared inputs from completed predecessors',()=>{
 const make=()=>{const p=structuredClone(tasks);p[0].outputs=[{path:'cli.mjs'}];p[1].outputs=[{path:'tests/cli test.mjs'}];p[1].inputs=[{path:'cli.mjs',producerTaskId:'dev'}];return p;};
 for(const command of ['node --test "tests/cli test.mjs"',"node.exe --check './tests/cli test.mjs'"]){
  const p=make();p[0].verify=[command];p[0].acceptanceChecks=[{criterionIndex:0,command,...(command.includes('--test')?{minimumTests:1}:{})}];
  assert.ok(plannedAcceptanceErrors(p).some(e=>e.includes('后续或并行任务')),command);
  p[0].inputs=[{path:'tests/cli test.mjs',sha256:'a'.repeat(64)}];
  assert.ok(!plannedAcceptanceErrors(p).some(e=>e.includes('后续或并行任务')||e.includes('命令文件')),'a fixed initial file can exist before a later overwrite; syntax mappings are checked separately');
 }
 const p=make();p[1].verify=['node --check cli.mjs'];p[1].acceptanceChecks=[{criterionIndex:0,command:p[1].verify[0]}];p[1].inputs=[];
 assert.ok(plannedAcceptanceErrors(p).some(e=>e.includes('inputs')&&e.includes('cli.mjs')));
 p[1].inputs=[{path:'cli.mjs',producerTaskId:'dev'}];assert.ok(!plannedAcceptanceErrors(p).some(e=>e.includes('inputs')));
 p[1].verify=['node --test "tests/cli test.mjs"'];p[1].acceptanceChecks=[{criterionIndex:0,command:p[1].verify[0],minimumTests:1}];assert.deepEqual(plannedAcceptanceErrors(p),[],'QA may run its own tests');
});

test('narrow literal Node path checks do not pretend to parse flags, shell scripts or unknown files',()=>{
 for(const command of ['npm test','node --test','node --test existing.test.mjs','node --test --test-name-pattern cli.mjs','node --check "$FILE"','node --check cli.mjs && echo ok']){
  const p=structuredClone(tasks);p[1].inputs=[{path:'cli.mjs',producerTaskId:'dev'}];p[1].verify=[command];p[1].acceptanceChecks=[{criterionIndex:0,command,minimumTests:1}];
  assert.ok(!plannedAcceptanceErrors(p).some(e=>e.includes('后续或并行任务')||e.includes('命令文件')),command);
 }
});
