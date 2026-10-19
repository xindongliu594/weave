import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {HandoffGate} from './handoff.mjs';

test('real syntax self-check allows handoff but independent behavior failure cannot pass QA',async()=>{
 const root=await mkdtemp(join(tmpdir(),'weiwu-selfcheck-regression-'));
 try {
  // Deliberately wrong synthetic fixture; never an employee delivery.
  await writeFile(join(root,'temperature.mjs'),'export const fahrenheit = c => 0;\n');
  const tasks=[
   {id:'dev',kind:'implementation',dependencies:[],inputs:[],outputs:[{path:'temperature.mjs'}],inScope:['temperature.mjs'],verify:['node --check temperature.mjs']},
   {id:'qa',kind:'verification',dependencies:['dev'],inputs:[{path:'temperature.mjs',producerTaskId:'dev'}],outputs:[{path:'temperature.test.mjs'}],verify:['node --test temperature.test.mjs'],acceptanceCriteria:['0C equals 32F'],acceptanceChecks:[{criterionIndex:0,command:'node --test temperature.test.mjs',minimumTests:1}]},
  ];
  const gate=new HandoffGate({snapshot:{tasks},sandbox:{root},archive:{id:'synthetic-regression',append:()=>{}}});
  assert.throws(()=>gate.prepare('dev','d',{changedPaths:[]}),/UNVERIFIED_COMMAND/);
  const execute=(task,attempt,flag,file)=>{
   const before=gate.beforeFile(task,attempt,'terminal_test',{});
   const env={...process.env};delete env.NODE_TEST_CONTEXT;
   const result=spawnSync(process.execPath,[flag,file],{cwd:root,encoding:'utf8',env});
   assert.equal(result.error,undefined);
   const output={exitCode:result.status,output:result.stdout+result.stderr};
   gate.observe(task,attempt,'terminal_test',{command:`node ${flag} ${file}`},output,before);
   return output;
  };
  assert.equal(execute('dev','d','--check','temperature.mjs').exitCode,0);
  const receipt=gate.prepare('dev','d',{changedPaths:[]});
  assert.equal(receipt.acceptanceChecks,undefined);assert.equal(receipt.commands.length,1);gate.commit(receipt);
  gate.begin('qa','q');
  await writeFile(join(root,'temperature.test.mjs'),"import test from 'node:test';import assert from 'node:assert/strict';import {fahrenheit} from './temperature.mjs';test('freezing point',()=>assert.equal(fahrenheit(0),32));\n");
  const result=execute('qa','q','--test','temperature.test.mjs');
  assert.equal(result.exitCode,1);assert.match(result.output,/0 !== 32/);
  assert.throws(()=>gate.prepare('qa','q',{}),/UNVERIFIED_COMMAND/);
 } finally {await rm(root,{recursive:true,force:true});}
});
