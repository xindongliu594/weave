import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {syncBuiltinESMExports} from 'node:module';
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {createArchiveWriteFence} from '../archive-write-fence.mjs';
import {createArchiveWriterManager,registerArchiveWriterRoot} from '../archive-writer-scope.mjs';
import {createRunArchive,openRunArchive} from '../trace-store.mjs';
import {storeArchiveObjects} from '../archive-objects.mjs';

const args=JSON.parse(process.env.ARCHIVE_PHYSICAL_TEST);
const send=value=>new Promise((resolve,reject)=>process.send({...value,pid:process.pid},error=>error?reject(error):resolve()));
if(args.action==='source'){
  const fence=createArchiveWriteFence(args);
  let acquired=false,code;const started=performance.now();
  try{const source=await fence.acquireSource(args.runId,{timeoutMs:200});acquired=true;source.release();}
  catch(error){code=error.code;if(code!=='E_ARCHIVE_FENCE_TIMEOUT')throw error;}
  await send({kind:'source',acquired,code,elapsedMs:performance.now()-started});process.disconnect();
}else{
  const writers=createArchiveWriterManager(args);registerArchiveWriterRoot(writers);
  const owner=await writers.acquireOwner([args.runId]);
  fs.writeFileSync(path.join(args.base,'OWNER.json'),JSON.stringify({pid:process.pid,nonce:args.nonce,traceRoot:args.traceRoot,runId:args.runId}),'utf8');
  const dir=path.join(args.traceRoot,args.runId),content=Buffer.from('synthetic checkpoint object bytes'),sha256=createHash('sha256').update(content).digest('hex');
  if(args.operation!=='create')owner.run(()=>{createRunArchive(args.traceRoot,{}, {id:args.runId});});
  const target=args.operation==='create'?path.join(dir,'snapshot.json'):args.operation==='append'?path.join(dir,'events.jsonl'):path.join(dir,'checkpoint-objects',sha256);
  const initialBytes=fs.existsSync(target)?fs.statSync(target).size:0;
  const original={openSync:fs.openSync,writeSync:fs.writeSync,fsyncSync:fs.fsyncSync};
  const injected=Object.assign(Error(`synthetic physical ${args.operation} ${args.fault} failure`),{code:'EIO',syscall:args.fault,path:target});
  let targetFd,writeCalls=0,fsyncCalls=0,bytesWritten=0,hits=0,physicalStack,swallowed;
  fs.openSync=function(file,...rest){const fd=original.openSync(file,...rest);if(path.resolve(String(file))===target)targetFd=fd;return fd;};
  fs.writeSync=function(fd,buffer,offset,length,...rest){
    if(fd!==targetFd)return original.writeSync(fd,buffer,offset,length,...rest);
    writeCalls++;
    if(args.fault==='write'&&writeCalls===2){hits++;physicalStack=new Error().stack;throw injected;}
    const n=original.writeSync(fd,buffer,offset,args.fault==='write'?Math.min(length??buffer.length-offset,7):length,...rest);bytesWritten+=n;return n;
  };
  fs.fsyncSync=function(fd){
    if(fd===targetFd){fsyncCalls++;if(args.fault==='fsync'){hits++;physicalStack=new Error().stack;throw injected;}}
    return original.fsyncSync(fd);
  };
  syncBuiltinESMExports();
  try{
    // The business callback resolves successfully: only the registered binding can latch the swallowed I/O error.
    assert.equal(owner.run(()=>{
      try{
        if(args.operation==='create')createRunArchive(args.traceRoot,{}, {id:args.runId});
        else if(args.operation==='append')openRunArchive(args.traceRoot,args.runId).append('uncertain-write',{synthetic:true});
        else storeArchiveObjects(dir,[{content,size:content.length,sha256}]);
      }catch(error){swallowed=error;}
      return 'business swallowed the error';
    }),'business swallowed the error');
  }finally{Object.assign(fs,original);syncBuiltinESMExports();}
  assert.equal(hits,1);assert.equal(swallowed,injected);
  assert.match(physicalStack,args.operation==='object'?/archive-objects\.mjs/:/durableWrite/);
  assert.throws(()=>writers.assertOwner(owner,args.runId),{code:'E_ARCHIVE_WRITER_SCOPE'});
  assert.throws(()=>owner.run(()=>assert.fail('failed owner entered callback')),{code:'E_ARCHIVE_WRITER_SCOPE'});
  assert.throws(()=>owner.retain('must stay failed'),{code:'E_ARCHIVE_WRITER_SCOPE'});
  owner.finish();
  await assert.rejects(owner.writerDrained,error=>error===injected);
  await send({kind:'failed-owner',operation:args.operation,fault:args.fault,target,nonce:args.nonce,sha256,contentBytes:content.length,initialBytes,writeCalls,fsyncCalls,bytesWritten,hits,physicalStack,
    originalError:{message:swallowed.message,code:swallowed.code,syscall:swallowed.syscall,path:swallowed.path},swallowed:true,finished:true,drainedOriginalError:true});
  // Deliberately retain the process and native handles until the parent terminates this PID.
  process.on('message',()=>{});
}
