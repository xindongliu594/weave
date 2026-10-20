import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,unlinkSync,linkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {createHash} from 'node:crypto';
import {storeArchiveObjects,readArchiveObject} from './archive-objects.mjs';

const entry=text=>{
  const content=Buffer.from(text);
  return {sha256:createHash('sha256').update(content).digest('hex'),size:content.length,content};
};
function fixture(){
  const parent=resolve(tmpdir()),dir=mkdtempSync(join(parent,'archive-object-test-'));
  return {dir,close(){assert.ok(resolve(dir).startsWith(parent+sep));rmSync(dir,{recursive:true,force:true});}};
}
test('immutable objects persist new and repeated bytes, including an empty object',()=>{
  const f=fixture();
  try{
    const files=[entry('durable'),entry('')],dir=storeArchiveObjects(f.dir,files);
    assert.equal(storeArchiveObjects(f.dir,files),dir);
    for(const file of files)assert.deepEqual(readArchiveObject(dir,file),file.content);
  }finally{f.close();}
});
test('corrupt and hardlinked objects fail closed without replacing their contents',()=>{
  const f=fixture();
  try{
    const file=entry('original'),dir=storeArchiveObjects(f.dir,[file]),path=join(dir,file.sha256);
    writeFileSync(path,'corrupt');
    assert.throws(()=>storeArchiveObjects(f.dir,[file]));
    assert.equal(readFileSync(path,'utf8'),'corrupt');
    unlinkSync(path);writeFileSync(path,file.content);
    linkSync(path,join(f.dir,'alias'));
    assert.throws(()=>readArchiveObject(dir,file));
    assert.throws(()=>storeArchiveObjects(f.dir,[file]));
    assert.equal(readFileSync(path,'utf8'),'original');
  }finally{f.close();}
});
test('a failure after durable blob writes can be reconciled by verifying the same objects',()=>{
  const f=fixture();
  try{
    const file=entry('committed bytes');
    assert.throws(()=>storeArchiveObjects(f.dir,[file],{afterFsync(){throw Error('lost acknowledgement');}}),/lost acknowledgement/);
    const dir=storeArchiveObjects(f.dir,[file]);
    assert.deepEqual(readArchiveObject(dir,file),file.content);
  }finally{f.close();}
});
