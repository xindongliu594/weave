import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {setTimeout as pause} from 'node:timers/promises';
import {AsyncResource} from 'node:async_hooks';
import {createArchiveWriterManager} from '../archive-writer-scope.mjs';

const args=JSON.parse(process.env.ARCHIVE_SOURCE_TEST),writers=createArchiveWriterManager(args);
let nextMessage=0,nextCommand=0;
const send=value=>{
  const target=path.join(args.probeRoot,`${++nextMessage}.result.json`),temporary=target+'.tmp';
  fs.writeFileSync(temporary,JSON.stringify(value));fs.renameSync(temporary,target);
};
async function receive(){
  const target=path.join(args.probeRoot,`${++nextCommand}.command.json`);
  for(let attempt=0;attempt<1000;attempt++){if(fs.existsSync(target))return JSON.parse(fs.readFileSync(target,'utf8'));await pause(10);}
  throw Error('Source probe command deadline');
}
if(args.action==='writer-once'){
  await writers.withWriter([args.runId],()=>writers.assertWriter(args.runId),{timeoutMs:0});
  send({writerAcquired:true});assert.equal(await receive(),'exit');
}else if(args.action==='source-hold'){
  await assert.rejects(writers.withSource(args.runId,()=>assert.fail('source overlapped original writer')),{code:'E_ARCHIVE_FENCE_TIMEOUT'});
  send({sourceBlocked:true});assert.equal(await receive(),'acquire');
  await writers.withSource(args.runId,async()=>{
    writers.assertSource(args.runId);
    send({sourceAcquired:true});assert.equal(await receive(),'release');
    writers.assertSource(args.runId);
  });
  send({sourceReleased:true});assert.equal(await receive(),'exit');
}else if(args.action==='failed-writer'){
  const owner=await writers.acquireOwner([args.runId]),original=Error('synthetic unproven original writer');
  assert.throws(()=>owner.run(()=>{throw original;}),error=>error===original);owner.finish();
  await assert.rejects(owner.writerDrained,error=>error===original);
  send({writerFailed:true});assert.equal(await receive(),'exit');
}else{
  let original,swallowed,restore,close,escaped,published=false;
  const pending=writers.withSource(args.runId,()=>{
    writers.assertSource(args.runId);
    escaped=AsyncResource.bind(()=>writers.assertSource(args.runId));
    if(['release-failure','partial-release'].includes(args.action)){
      const logical=process.platform==='win32'?args.traceRoot.toLowerCase():args.traceRoot;
      const namespace=path.join(args.lockRoot,createHash('sha256').update(logical).digest('hex'));
      const identities=(args.action==='partial-release'?['root.gate']:['root.gate',`${args.runId}.lifetime`]).map(name=>fs.statSync(path.join(namespace,name),{bigint:true}));
      close=fs.closeSync;let hits=0;
      fs.closeSync=fd=>{
        const stat=fs.fstatSync(fd,{bigint:true});
        if(identities.some(identity=>identity.ino===stat.ino&&identity.dev===stat.dev)){hits++;throw Object.assign(Error('synthetic native close failure'),{code:'EIO'});}
        return close(fd);
      };
      restore=()=>{fs.closeSync=close;assert.equal(hits,args.action==='partial-release'?1:2);};
    }else{
      const old=args.traceRoot+'-before';fs.renameSync(args.traceRoot,old);fs.mkdirSync(args.traceRoot);
      restore=()=>{fs.rmdirSync(args.traceRoot);fs.renameSync(old,args.traceRoot);};
      if(args.action==='identity-assert'){
        try{writers.assertSource(args.runId);}catch(error){swallowed=error;}
        assert.equal(swallowed?.code,'E_ARCHIVE_FENCE_IDENTITY');
        // Restoring the inode cannot erase an observed native identity failure.
        restore();restore=undefined;
      }
    }
    return 'business read completed';
  });
  try{await pending;published=true;}catch(error){original=error;}finally{restore?.();}
  assert.equal(original?.code,['release-failure','partial-release'].includes(args.action)?'E_ARCHIVE_FENCE_IO':'E_ARCHIVE_FENCE_IDENTITY');
  if(swallowed)assert.equal(original,swallowed);
  assert.throws(()=>writers.assertSource(args.runId),{code:'E_ARCHIVE_WRITER_SCOPE'});
  assert.throws(escaped,{code:'E_ARCHIVE_WRITER_SCOPE'});assert.equal(published,false);
  send(args.action==='partial-release'?{rejected:true,code:original.code,published,authorityExpired:true}:{failedClosed:true,code:original.code});
  assert.equal(await receive(),'exit');
}
