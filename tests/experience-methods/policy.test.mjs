import test from 'node:test';import assert from 'node:assert/strict';import {POLICY,admit} from '../../scripts/validation/experience-methods/policy.mjs';
const state=()=>({sourceValid:true,pending:0,active:0,modelId:POLICY.modelId,inputRate:.3,outputRate:1.2,count:0,occupied:2.5670568,own:0,shared:.0037584});
const request=()=>({stage:'extract',inputBytes:24000,reservation:.0121152});
test('two worst-case requests fit the shared original allowance including previous trial',()=>{
 const s=state(),first=admit(s,request());assert.ok(Math.abs(first-.0121152)<1e-12);
 const second=admit({...s,count:1,own:first,shared:s.shared+first,occupied:s.occupied+first},{stage:'general-filter',inputBytes:24000,reservation:.0096576});
 assert.ok(first+second<=.022);assert.ok(s.shared+first+second<=.03);
});
test('exact source, outstanding calls, shared cap and call sequence are guarded',()=>{
 for(const patch of [{sourceValid:false},{pending:1},{active:1},{modelId:'other'},{shared:.02},{own:.02},{occupied:2.799},{count:2},{count:-1},{inputRate:0}])assert.throws(()=>admit({...state(),...patch},request()));
});
