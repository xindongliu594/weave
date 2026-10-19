import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {audit} from './ab-audit.mjs';
const prior=JSON.parse(readFileSync(new URL('../../../docs/validation/evidence/delivery-binding-pilot-2026-10-19/real/broker-result.json',import.meta.url)));
test('unaltered real failure is schema-valid but not contract-valid',async()=>{
 const entry=prior.requests[0],before=JSON.stringify(entry),r=await audit(entry);
 assert.equal(r.schemaValid,true);assert.equal(r.contractValid,false);assert.ok(r.futureFileErrors.some(e=>e.includes('test/temperature.test.js')));assert.equal(JSON.stringify(entry),before);
});
test('invalid JSON is not counted as a valid plan or future-file success',async()=>{
 const r=await audit({...prior.requests[0],content:'invalid JSON'});assert.equal(r.schemaValid,false);assert.equal(r.contractValid,false);assert.equal(r.futureFileErrors,null);
});
test('transport rejection is unavailable, not a model planning error',async()=>{
 const r=await audit({...prior.requests[0],content:undefined,error:{code:'GATEWAY_REJECTED',message:'HTTP 400'}});
 assert.equal(r.responseStatus,'unavailable');assert.equal(r.schemaValid,null);assert.equal(r.contractValid,null);assert.equal(r.futureFileErrors,null);
});
