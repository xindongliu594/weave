import test from 'node:test';import assert from 'node:assert/strict';import {updateDecision,candidateProposal} from '../../scripts/validation/experience-methods/integration.mjs';
const original={id:'candidate',runId:'run',documentId:'doc',sourceVersion:1,sourceHash:'hash',version:2,status:'pending',title:'old',content:'old'};
const desired={title:'model method',content:'model text'};
test('original pending version is updated once and a known lost response is read back',()=>{
 assert.equal(updateDecision(original,original,desired),'update');
 assert.equal(updateDecision(original,{...original,...desired,version:3},desired),'already-updated');
});
test('concurrent edits, published candidates and changed provenance cannot be overwritten',()=>{
 for(const patch of [{version:3},{content:'human edit'},{title:'human title'},{status:'published'},{sourceHash:'different'},{runId:'other'}])assert.throws(()=>updateDecision(original,{...original,...patch},desired));
});
test('readback accepts the API trimmed payload without repeating its update',()=>{
 const proposal=candidateProposal('title','\nmodel text\n');
 const current={...original,title:proposal.title,content:'model text',version:3};
 assert.equal(updateDecision(original,current,proposal),'already-updated');
});
