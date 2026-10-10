import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {archiveStorageUsage,assertArchiveCapacity} from './archive-storage.mjs';

test('archive quota includes nested sessions and artifacts, refuses further admission and never deletes evidence',()=>{
 const root=mkdtempSync(join(tmpdir(),'archive-quota-'));
 try{
  mkdirSync(join(root,'sessions'));writeFileSync(join(root,'sessions','context.json'),'x'.repeat(1024));writeFileSync(join(root,'events.jsonl'),'y'.repeat(1024));
  assert.equal(archiveStorageUsage(root).bytes,2048);
  assert.doesNotThrow(()=>assertArchiveCapacity(root,4096));
  assert.throws(()=>assertArchiveCapacity(root,2048),e=>e.code==='ARCHIVE_STORAGE_LIMIT');
  assert.equal(readFileSync(join(root,'events.jsonl'),'utf8'),'y'.repeat(1024));
  assert.equal(readFileSync(join(root,'sessions','context.json'),'utf8'),'x'.repeat(1024));
  assert.equal(archiveStorageUsage(join(root,'not-created')).bytes,0);
 }finally{rmSync(root,{recursive:true,force:true});}
});
