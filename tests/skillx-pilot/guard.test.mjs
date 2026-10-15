import test from 'node:test';
import assert from 'node:assert/strict';
import {quotePilot,POLICY} from '../../scripts/validation/skillx-pilot/guard.mjs';

const state=()=>({approved:true,sourceRunId:POLICY.sourceRunId,sourceStatus:'completed',integrity:'ok',shareable:true,
  modelId:POLICY.modelId,inputRate:.3,outputRate:1.2,occupied:2.5632984,trialOccupied:0,callCount:0,pendingCount:0,activeRuns:0});
const validRequest=()=>({stage:'extract',inputBytes:20000,reservation:(20000*.3+4096*1.2)/1e6});
test('complete three-request worst-case fits the unchanged pilot cap',()=>{
 const s=state();let sum=0;
 for(const [index,stage] of ['extract','general-filter','tool-filter'].entries()){
  const amount=(24000*.3+({extract:4096,'general-filter':1024,'tool-filter':1024}[stage])*1.2)/1e6;
  assert.equal(quotePilot({...s,callCount:index,trialOccupied:sum},{stage,inputBytes:24000,reservation:amount}),amount);sum+=amount;
 }
 assert.ok(sum<.03);assert.equal(sum,.0289728);
});
test('budget, pending and dispatch ceilings fail closed before the provider',()=>{
 assert.ok(quotePilot(state(),validRequest())>0);
 for(const patch of [{occupied:2.799},{trialOccupied:.029},{callCount:3},{pendingCount:1},{activeRuns:1}])
  assert.throws(()=>quotePilot({...state(),...patch},validRequest()));
});
test('source, price, stage and request size cannot be widened by a runner',()=>{
 for(const patch of [{approved:false},{sourceRunId:'other'},{shareable:false},{integrity:'broken'},{modelId:'other'},{inputRate:0},{outputRate:0}])
  assert.throws(()=>quotePilot({...state(),...patch},validRequest()));
 for(const request of [{stage:'unknown',inputBytes:1,reservation:.001},{stage:'extract',inputBytes:24001,reservation:.001},{stage:'extract',inputBytes:1,reservation:NaN}])
  assert.throws(()=>quotePilot(state(),request));
});
