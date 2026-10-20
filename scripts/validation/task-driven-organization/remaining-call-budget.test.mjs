import test from 'node:test';
import assert from 'node:assert/strict';
import { assertRemainingCall } from './remaining-call-budget.mjs';
const options={sessionId:'only-this',inputRate:.3,outputRate:1.2,allowance:.02};
test('remaining real planning request is bounded before reserve or dispatch',()=>{
 const body={model:'deepseek-v4.1-flash',messages:[{role:'user',content:'中文'}],max_tokens:4000};
 const quote=assertRemainingCall('only-this',body,options);
 assert.ok(quote<.02);assert.equal(assertRemainingCall('another',body,options),undefined);
 assert.throws(()=>assertRemainingCall('only-this',{...body,messages:[{role:'user',content:'x'.repeat(60000)}]},options),/allowance/);
 assert.throws(()=>assertRemainingCall('only-this',{...body,max_tokens:0},options),/invalid/);
});
test('over-budget rejection exposes bounded quote metadata for the local acceptance controller',()=>{
 const body={model:'fixture',messages:[{role:'user',content:'x'.repeat(60000)}],max_tokens:4000};
 assert.throws(()=>assertRemainingCall('only-this',body,options),error=>{
  assert.equal(error.code,'ACCEPTANCE_PLANNING_BUDGET');assert.ok(error.quote>options.allowance);assert.equal(error.allowance,options.allowance);
  assert.equal(error.modelDispatched,false);assert.equal(error.body,undefined);return true;
 });
});
