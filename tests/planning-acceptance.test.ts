import test from 'node:test';
import assert from 'node:assert/strict';
import { plannedAcceptanceErrors } from '../apps/api/src/execution-prompt.ts';
import type { Plan } from '../packages/contracts/index.ts';

const tasks: Plan['tasks'] = [
 {id:'dev',subject:'更新代码',objective:'增量修改',assigneeId:'developer',dependencies:[],acceptanceCriteria:['语法'],estimatedInputTokens:100,estimatedOutputTokens:100,outputs:[{path:'cli.mjs'}],verify:['node --check cli.mjs'],acceptanceChecks:[{criterionIndex:0,command:'node --check cli.mjs'}]},
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
