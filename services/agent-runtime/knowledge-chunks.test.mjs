import test from 'node:test';
import assert from 'node:assert/strict';
import {chunkDocument} from './knowledge.mjs';
test('identical fragments of one long line retain distinct stable chunk identities',()=>{
 const body='x'.repeat(16001),chunks=chunkDocument('document',1,body);
 assert.equal(chunks.map(c=>c.content).join(''),body);
 assert.equal(new Set(chunks.map(c=>c.id)).size,chunks.length);
 assert.deepEqual(chunkDocument('document',1,body),chunks);
 assert.ok(chunks.every(c=>c.lineStart===1&&c.lineEnd===1));
});
