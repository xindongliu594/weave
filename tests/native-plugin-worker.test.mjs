import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { runNativeTool } from '../apps/desktop/native-plugin-worker.cjs';
const hash=value=>createHash('sha256').update(value).digest('hex');
test('native worker binds verified bytes, denies ungranted file reads and writes, returns real result', async()=>{
 const directory=mkdtempSync(join(tmpdir(),'native-worker-')),root=join(directory,'work'),scratch=join(directory,'tmp');mkdirSync(root);mkdirSync(scratch);
 const code=Buffer.from(`import fs from 'node:fs';const chunks=[];for await(const c of process.stdin)chunks.push(c);const r=JSON.parse(Buffer.concat(chunks));try{const value=r.name==='read'?fs.readFileSync(r.arguments.path,'utf8'):fs.writeFileSync(r.arguments.path,'generated');process.stdout.write(JSON.stringify({isError:false,value:value??'written'}));}catch(e){process.stdout.write(JSON.stringify({isError:true,error:{message:e.code}}));}`);
 const compressed=gzipSync(code),metadata=Buffer.from('{}'),bundle={compressed:compressed.toString('base64'),metadata:metadata.toString('base64'),sha256:hash(compressed),codeSha256:hash(code),metadataSha256:hash(metadata)};
 try{
  writeFileSync(join(root,'allowed.txt'),'allowed');writeFileSync(join(root,'private.txt'),'private');
  const input={root,tempRoot:scratch,bundle,originalName:'read',args:{path:'allowed.txt'},callId:'fixture',readPaths:['allowed.txt'],writePaths:[]};
  assert.deepEqual(await runNativeTool(input),{isError:false,value:'allowed'});
  assert.equal((await runNativeTool({...input,args:{path:'private.txt'}})).isError,true);
  assert.equal((await runNativeTool({...input,originalName:'write',args:{path:'out.txt'}})).isError,true);
  assert.equal(existsSync(join(root,'out.txt')),false);
  assert.equal((await runNativeTool({...input,originalName:'write',args:{path:'out.txt'},writePaths:['out.txt']})).isError,false);
  assert.equal(readFileSync(join(root,'out.txt'),'utf8'),'generated');
  await assert.rejects(runNativeTool({...input,originalName:'write',args:{path:'private.txt'},writePaths:['out.txt']}),/NATIVE_UNDECLARED_FILE/);
  assert.equal(readFileSync(join(root,'private.txt'),'utf8'),'private','an unapproved write cannot alter the real workspace');
  await assert.rejects(runNativeTool({...input,originalName:'write',args:{path:'allowed.txt'},writePaths:['out.txt']}),/NATIVE_INPUT_CHANGED/);
  assert.equal(readFileSync(join(root,'allowed.txt'),'utf8'),'allowed');
  await assert.rejects(runNativeTool({...input,readPaths:['private*']}),/NATIVE_PATH/);
  mkdirSync(join(root,'private-dir'));writeFileSync(join(root,'private-dir','secret.txt'),'private');
  await assert.rejects(runNativeTool({...input,readPaths:['private-dir']}),/NATIVE_PATH/);
  await assert.rejects(runNativeTool({...input,bundle:{...bundle,codeSha256:'a'.repeat(64)}}),/NATIVE_BUNDLE_MISMATCH/);
  await assert.rejects(runNativeTool({...input,readPaths:['../outside']}),/NATIVE_PATH/);
 }finally{rmSync(directory,{recursive:true,force:true});}
});
