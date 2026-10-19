import test from 'node:test';
import assert from 'node:assert/strict';
import {cases,checkQuote} from './cases.mjs';
import * as trials from './cases.mjs';
test('trial refuses excess calls, per-call/phase/cumulative spend and uncertain receipts before dispatch',()=>{
 const valid={used:.12,calls:6,quote:.02,occupied:3.0084915};assert.doesNotThrow(()=>checkQuote(valid));
 for(const patch of [{calls:7},{quote:.02001},{used:.121},{occupied:3.40},{unknownChanged:true},{quote:NaN},{used:-1}])assert.throws(()=>checkQuote({...valid,...patch}));
});
test('seven small distinct scenarios carry only synthetic content and immutable shard references',()=>{
 assert.equal(cases.length,7);assert.equal(new Set(cases.map(c=>c.id)).size,7);assert.ok(cases.every(c=>c.prompt.length<1000));
 assert.ok(cases.find(c=>c.id==='fixed-shards').inputs.every(i=>/^[a-f0-9]{64}$/.test(i.sha256)));
});
test('repair smoke selects only two fixed cases and rejects a third request or more than four cents',()=>{
 assert.equal(typeof trials.getTrial,'function');
 const trial=trials.getTrial('repair-smoke');
 assert.deepEqual(trial.cases.map(c=>c.id),['sequential-report','bounded-code-review']);
 assert.doesNotThrow(()=>checkQuote({used:.02,calls:1,quote:.02,occupied:3.0484323},trial.limits));
 for(const state of [{used:.02,calls:2,quote:.01,occupied:3.05},{used:.03,calls:1,quote:.02,occupied:3.05}])assert.throws(()=>checkQuote(state,trial.limits));
 assert.throws(()=>trials.getTrial('unlimited'));
});
test('repair smoke stops after an invalid real preview but dry-run still assembles both requests',()=>{
 assert.equal(typeof trials.stopAfterResult,'function');
 const trial=trials.getTrial('repair-smoke');
 assert.equal(trials.stopAfterResult(trial,'approved-real',{preview:undefined}),true);
 assert.equal(trials.stopAfterResult(trial,'approved-real',{preview:{}}),false);
 assert.equal(trials.stopAfterResult(trial,'dry-run',{}),false);
 assert.equal(trials.stopAfterResult(trials.getTrial(),'approved-real',{}),false);
});
