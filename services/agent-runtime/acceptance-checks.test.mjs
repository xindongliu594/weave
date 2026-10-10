import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {HandoffGate} from './handoff.mjs';
import {taskContractErrors} from '../../packages/contracts/task-contracts.mjs';

const output=(pass=1,skipped=0)=>`# tests ${pass+skipped}\n# suites 0\n# pass ${pass}\n# fail 0\n# cancelled 0\n# skipped ${skipped}\n# todo 0\n`;
function fixture(work,patch={}){
 const root=mkdtempSync(join(tmpdir(),'acceptance-'));
 const task={id:'qa',kind:'verification',dependencies:[],acceptanceCriteria:['符合需求'],verify:['node --test cli.test.mjs'],acceptanceChecks:[{criterionIndex:0,command:'node --test cli.test.mjs',minimumTests:1}],...patch};
 const events=[],gate=new HandoffGate({snapshot:{tasks:[task]},sandbox:{root},archive:{id:'run',append:(type,data)=>{events.push({type,data});return {seq:events.length};}}});
 const observe=result=>gate.observe('qa','attempt','terminal_test',{command:task.verify[0]},result,gate.beforeFile('qa','attempt','terminal_test',{}));
 try{return work({gate,root,task,observe});}finally{rmSync(root,{recursive:true,force:true});}
}
test('no fabricated completion, empty test suite, skipped tests or truncated output can pass',()=>fixture(({gate,observe})=>{
 assert.throws(()=>gate.prepare('qa','attempt',{acceptanceChecks:[{status:'passed'}]}),/UNVERIFIED_COMMAND/);
 for(const result of [{exitCode:0,output:output(0)},{exitCode:0,output:output(1,1)},{exitCode:0,output:output(),outputTruncated:true}]){
  observe(result);assert.throws(()=>gate.prepare('qa','attempt',{}),/ACCEPTANCE_CHECK_FAILED/);
 }
 observe({exitCode:0,output:output()});assert.equal(gate.prepare('qa','attempt',{}).acceptanceChecks[0].status,'passed');
}));
test('new failure supersedes success and changed files require another execution',()=>fixture(({gate,root,observe})=>{
 observe({exitCode:0,output:output()});assert.equal(gate.prepare('qa','attempt',{}).acceptanceChecks.length,1);
 observe({exitCode:1,output:'failed'});assert.throws(()=>gate.prepare('qa','attempt',{}),/UNVERIFIED_COMMAND/);
 observe({exitCode:0,output:output()});writeFileSync(join(root,'new.txt'),'changed');assert.throws(()=>gate.prepare('qa','attempt',{}),/UNVERIFIED_COMMAND/);
 observe({exitCode:0,output:output()});assert.equal(gate.prepare('qa','attempt',{}).acceptanceChecks[0].status,'passed');
}));
test('expected failure exit and exact output are checks, not arbitrary success claims',()=>fixture(({gate,observe})=>{
 observe({exitCode:1,output:'invalid\r\n'});assert.equal(gate.prepare('qa','attempt',{}).acceptanceChecks[0].status,'passed');
 observe({exitCode:1,output:'almost invalid\n'});assert.throws(()=>gate.prepare('qa','attempt',{}),/ACCEPTANCE_CHECK_FAILED/);
},{verify:['node cli.mjs bad'],acceptanceChecks:[{criterionIndex:0,command:'node cli.mjs bad',expectedExitCode:1,expectedOutput:'invalid\n'}]}));
test('legacy contracts stay unchanged and checks cover only approved commands and every criterion',()=>{
 assert.deepEqual(taskContractErrors([{id:'old',dependencies:[],acceptanceCriteria:['legacy']}]),[]);
 const base={id:'qa',dependencies:[],acceptanceCriteria:['one','two'],verify:['check']};
 for(const checks of [null,{},[],[{criterionIndex:0,command:'check'}],[{criterionIndex:0,command:'check'},{criterionIndex:0,command:'check'}]])assert.ok(taskContractErrors([{...base,acceptanceChecks:checks}]).length);
 assert.ok(taskContractErrors([{...base,acceptanceChecks:[{criterionIndex:0,command:'other'},{criterionIndex:1,command:'check'}]}]).some(error=>error.includes('verify')));
 assert.deepEqual(taskContractErrors([{...base,acceptanceChecks:[{criterionIndex:0,command:'check'},{criterionIndex:1,command:'check'}]}]),[]);
});
