import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {spawnSync} from 'node:child_process';
import {getTrial,checkQuote} from './cases.mjs';

test('feedback correction refuses a second dispatch and a quote above its two-cent allocation',()=>{
 const trial=getTrial('feedback-correction');
 assert.deepEqual(trial.cases.map(c=>c.id),['bounded-code-review']);
 const state={used:0,calls:0,quote:.02,occupied:3.06};
 assert.doesNotThrow(()=>checkQuote(state,trial.limits));
 for(const patch of [{calls:1},{quote:.02001},{used:.001},{occupied:3.40}])assert.throws(()=>checkQuote({...state,...patch},trial.limits));
});

test('actual isolated worker replays original failure then sends one correction with the product feedback',()=>{
 const temp=mkdtempSync(join(tmpdir(),'weiwu-feedback-test-')),out=join(temp,'dry'),repo=resolve('.');
 try{
  const run=spawnSync(process.execPath,[join(repo,'scripts/validation/orchestration-planning-pilot/broker.mjs'),'dry-run',repo,out,'feedback-correction'],{cwd:repo,encoding:'utf8',timeout:120000});
  assert.equal(run.status,0,run.stdout+'\n'+run.stderr);
  const report=JSON.parse(readFileSync(join(out,'broker-result.json'),'utf8'));
  const seed=JSON.parse(readFileSync(join(out,'replayed-failure.json'),'utf8'));
  assert.equal(seed.sourceSha256,'492a6d51d11205e81b4bc0cd7ef9dce3ac1dfd015cf60e4f87fb6f132516fbbb');
  assert.equal(seed.modelCalls,0);assert.equal(seed.result.preview,undefined);
  assert.match(seed.result.draftIssue.message,/handoff/);assert.match(seed.result.draftIssue.message,/clarify/);assert.match(seed.result.draftIssue.message,/develop/);assert.match(seed.result.draftIssue.message,/verify/);
  assert.equal(report.requests.length,1);assert.equal(report.requests[0].cost,0);assert.equal(report.acceptancePassed,false);
  const messages=report.requests[0].request.messages;
  assert.deepEqual(messages.map(m=>m.role),['system','system','user','user','assistant','user']);
  assert.equal(JSON.parse(messages[2].content).message,seed.result.draftIssue.message);
  assert.equal(messages[4].content,seed.result.reply);
  assert.equal(report.workerResult.projectWrites,0);assert.equal(report.workerResult.departmentWrites,0);
  assert.equal(report.workerResult.replayedResponses,1);
 }finally{assert.equal(dirname(temp),tmpdir());rmSync(temp,{recursive:true,force:true});}
});
