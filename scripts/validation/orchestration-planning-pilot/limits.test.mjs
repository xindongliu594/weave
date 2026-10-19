import test from 'node:test';
import assert from 'node:assert/strict';
import {cases,checkQuote} from './cases.mjs';
test('trial refuses excess calls, per-call/phase/cumulative spend and uncertain receipts before dispatch',()=>{
 const valid={used:.12,calls:6,quote:.02,occupied:3.0084915};assert.doesNotThrow(()=>checkQuote(valid));
 for(const patch of [{calls:7},{quote:.02001},{used:.121},{occupied:3.40},{unknownChanged:true},{quote:NaN},{used:-1}])assert.throws(()=>checkQuote({...valid,...patch}));
});
test('seven small distinct scenarios carry only synthetic content and immutable shard references',()=>{
 assert.equal(cases.length,7);assert.equal(new Set(cases.map(c=>c.id)).size,7);assert.ok(cases.every(c=>c.prompt.length<1000));
 assert.ok(cases.find(c=>c.id==='fixed-shards').inputs.every(i=>/^[a-f0-9]{64}$/.test(i.sha256)));
});
