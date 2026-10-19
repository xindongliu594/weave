import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {spawnSync} from 'node:child_process';
import {getTrial,checkQuote} from './cases.mjs';

test('delivery binding pilot is one request capped at two cents with unchanged cumulative limit',()=>{
 const trial=getTrial('delivery-binding');
 assert.equal(trial.sourceCommit,'a05f034');assert.deepEqual(trial.cases.map(c=>c.id),['bounded-code-review']);
 assert.equal(trial.limits.maxCalls,1);assert.equal(trial.limits.maxTrialCost,.02);assert.equal(trial.limits.maxCumulative,3.41);
 const state={used:0,calls:0,quote:.02,occupied:3.0656229};
 assert.doesNotThrow(()=>checkQuote(state,trial.limits));
 for(const patch of [{calls:1},{quote:.02001},{used:.001},{occupied:3.40},{unknownChanged:true}])assert.throws(()=>checkQuote({...state,...patch},trial.limits));
});

test('delivery pilot replays untouched latest real response and forwards one deduplicated self-review correction',()=>{
 const temp=mkdtempSync(join(tmpdir(),'weiwu-delivery-pilot-')),out=join(temp,'dry'),repo=resolve('.');
 try{
  const run=spawnSync(process.execPath,[join(repo,'scripts/validation/orchestration-planning-pilot/broker.mjs'),'dry-run',repo,out,'delivery-binding'],{cwd:repo,encoding:'utf8',timeout:120000});
  assert.equal(run.status,0,run.stdout+'\n'+run.stderr);
  const report=JSON.parse(readFileSync(join(out,'broker-result.json'),'utf8'));
  const seed=JSON.parse(readFileSync(join(out,'replayed-failure.json'),'utf8'));
  assert.equal(seed.sourceSha256,'60de83d7d1d006743a5325a50fbf429eb8b957f3d0f77b520b56cce8d33f984e');
  assert.equal(seed.modelCalls,0);assert.equal(seed.result.preview,undefined);
  const issue=seed.result.draftIssue.message;
  assert.equal(issue.split('形成自我验收').length-1,1);assert.match(issue,/producerTaskIds/);assert.match(issue,/checkTaskId/);
  assert.equal(report.requests.length,1);assert.equal(report.requests[0].cost,0);assert.equal(report.acceptancePassed,false);
  const messages=report.requests[0].request.messages;
  assert.deepEqual(messages.map(m=>m.role),['system','system','user','user','assistant','user']);
  assert.equal(JSON.parse(messages[2].content).message,issue);assert.equal(messages[4].content,seed.result.reply);
  assert.ok(messages.some(m=>m.content.includes('"deliveryCriteria"')));
  assert.equal(report.workerResult.projectWrites,0);assert.equal(report.workerResult.departmentWrites,0);assert.equal(report.workerResult.replayedResponses,1);
 }finally{assert.equal(dirname(temp),tmpdir());rmSync(temp,{recursive:true,force:true});}
});
