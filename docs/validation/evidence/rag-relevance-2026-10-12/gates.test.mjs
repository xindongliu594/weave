import test from 'node:test';
import assert from 'node:assert/strict';
import {applyGate,chooseThreshold} from './gates.mjs';

test('calibration separates strong evidence from unsupported candidates',()=>{
  const positive={expected:['right'],hits:[{documentId:'right',content:'evidence',score:.9},{documentId:'wrong',content:'noise',score:.2}]};
  const negative={expected:[],hits:[{documentId:'wrong',content:'noise',score:.3}]};
  const fitted=chooseThreshold([positive,negative]);
  assert.equal(fitted.balancedAccuracy,1);
  assert.deepEqual(applyGate(positive.hits,fitted.threshold).map(h=>h.documentId),['right']);
  assert.deepEqual(applyGate(negative.hits,fitted.threshold),[]);
});
test('equal scores cannot be advertised as perfect answerability separation',()=>{
  const fitted=chooseThreshold([{expected:['right'],hits:[{documentId:'right',content:'',score:.7}]},{expected:[],hits:[{documentId:'wrong',content:'',score:.7}]}]);
  assert.equal(fitted.balancedAccuracy,.5);
});
test('gate rejects invalid scores and leaves candidate metadata intact',()=>{
  const row={id:'fixed',documentId:'versioned',version:1,content:'pinned',score:.8};
  assert.equal(applyGate([row],.5)[0],row);
  assert.throws(()=>applyGate([{...row,score:NaN}],.5),/finite/);
  assert.throws(()=>applyGate([row],-1),/threshold/);
});
