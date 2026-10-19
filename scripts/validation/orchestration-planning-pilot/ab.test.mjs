import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {matrix,limits,bodyFor,stageClarification,runMatrix,assertBaselineRequest,independentCells} from './ab.mjs';
import {checkQuote} from './cases.mjs';
const prior=JSON.parse(readFileSync(new URL('../../../docs/validation/evidence/delivery-binding-pilot-2026-10-19/real/broker-result.json',import.meta.url)));
test('baseline request mutation fails even when historical response stays unchanged',()=>{
 assert.doesNotThrow(()=>assertBaselineRequest(prior.requests[0].request));
 const changed=structuredClone(prior.requests[0].request);changed.messages[3].content+=' changed';
 assert.throws(()=>assertBaselineRequest(changed),/baseline request/);
});
test('independent continuation only selects five unattempted DeepSeek cells and retains previous hold',()=>{
 const previous=JSON.parse(readFileSync(new URL('../../../docs/validation/evidence/planning-ab-2026-10-19/real/broker-result.json',import.meta.url)));
 const cells=independentCells(previous);assert.equal(cells.length,5);assert.ok(cells.every(c=>c.model==='deepseek-v4.1-flash'&&!previous.requests.some(e=>e.id===c.id)));
 const changed=structuredClone(previous);changed.after.holds=changed.before.holds;assert.throws(()=>independentCells(changed));
 const unexpected=structuredClone(previous);unexpected.requests[1].id='wrong';assert.throws(()=>independentCells(unexpected));
});
test('fixed balanced matrix and budget boundaries',()=>{
 assert.equal(matrix.length,12);assert.equal(new Set(matrix.map(c=>c.id)).size,12);
 for(const model of ['deepseek-v4.1-flash','glm-5.3-flash'])for(const variant of ['original','clarified'])assert.equal(matrix.filter(c=>c.model===model&&c.variant===variant).length,3);
 for(const patch of [{calls:12},{quote:.0201},{used:.239},{occupied:3.40},{unknownChanged:true}])assert.throws(()=>checkQuote({used:0,calls:0,quote:.02,occupied:3.0712296,...patch},limits));
});
test('only prompt clarification and backend model differ; prior fixture untouched',()=>{
 const raw=JSON.stringify(prior.requests[0].request),a=bodyFor('deepseek-v4.1-flash','original'),b=bodyFor('glm-5.3-flash','clarified');
 assert.equal(JSON.stringify(a),raw);assert.equal(b.messages[0].content,a.messages[0].content+'\n'+stageClarification);
 assert.deepEqual(b.messages.slice(1),a.messages.slice(1));b.messages[0].content=a.messages[0].content;b.model=a.model;assert.deepEqual(b,a);
 assert.equal(JSON.stringify(prior.requests[0].request),raw);assert.throws(()=>bodyFor('unknown','original'));
});
test('paid output failure keeps its receipt and stops without retry',async()=>{
 const entries=[];let calls=0;
 await assert.rejects(runMatrix({before:async()=>.01,save(){},entries,dispatch:async()=>{calls++;throw Error('truncated');},receipt:async()=>[{id:'paid',status:'settled',cost:.005,inputTokens:10,outputTokens:20}]}),/truncated/);
 assert.equal(calls,1);assert.equal(entries[0].cost,.005);assert.equal(entries[0].usageId,'paid');
});
test('unresolved receipt stops even when text arrived',async()=>{
 const entries=[];let calls=0;
 await assert.rejects(runMatrix({before:async()=>.01,save(){},entries,dispatch:async()=>{calls++;return {choices:[{message:{content:'{}'},finish_reason:'stop'}]};},receipt:async()=>[{id:'pending',status:'uncertain'}]}),/Unresolved/);
 assert.equal(calls,1);assert.equal(entries[0].content,'{}');
});
test('invalid plan texts are preserved and do not change next fixed prompt',async()=>{
 const entries=[];
 await runMatrix({before:async()=>.01,save(){},entries,dispatch:async()=>({choices:[{message:{content:'invalid candidate'},finish_reason:'stop'}]}),receipt:async e=>[{id:e.requestId,status:'settled',cost:.001,inputTokens:10,outputTokens:20}]});
 assert.equal(entries.length,12);assert.ok(entries.every(e=>e.content==='invalid candidate'));assert.equal(entries[4].request.messages[0].content,entries[2].request.messages[0].content);
});
