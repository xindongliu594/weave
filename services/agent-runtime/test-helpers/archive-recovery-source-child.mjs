import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {setTimeout as pause} from 'node:timers/promises';
import {createArchiveWriterManager} from '../archive-writer-scope.mjs';

const args=JSON.parse(process.env.ARCHIVE_RECOVERY_TEST),writers=createArchiveWriterManager(args);
function send(value){const target=path.join(args.probeRoot,'result.json'),temporary=target+'.tmp';fs.writeFileSync(temporary,JSON.stringify(value));fs.renameSync(temporary,target);}
async function wait(){for(let attempt=0;attempt<1000;attempt++){if(fs.existsSync(path.join(args.probeRoot,'exit')))return;await pause(10);}throw Error('Recovery scope child deadline');}
const A=args.sourceRunId,B=args.childRunId,C=args.otherRunId,timeout={code:'E_ARCHIVE_FENCE_TIMEOUT'};
if(args.action==='probe'){
  let blocked=0;
  for(const runId of [A,B]){
    await assert.rejects(writers.withWriter([runId],()=>assert.fail('writer overlapped recovery'),{timeoutMs:0}),timeout);blocked++;
    await assert.rejects(writers.withSource(runId,()=>assert.fail('source overlapped recovery'),{timeoutMs:0}),timeout);blocked++;
  }
  for(const [source,child] of [[A,B],[B,A]]){await assert.rejects(writers.withRecoverySource(source,child,()=>assert.fail('initializers overlapped'),{timeoutMs:0}),timeout);blocked++;}
  await assert.rejects(writers.withRootExclusive(()=>assert.fail('root overlapped recovery'),{timeoutMs:0}),timeout);blocked++;
  await writers.withWriter([C],()=>writers.assertWriter(C),{timeoutMs:0});send({blocked,otherWriter:true});await wait();
}else if(args.action==='hold'){
  await writers.withRecoverySource(A,B,async()=>{writers.assertSource(A);writers.assertWriter(B);send({acquired:true});await wait();});
}else{
  const original=Error('original initializer write result unknown');let observed;
  try{await writers.withRecoverySource(A,B,async()=>{
    if(args.action==='callback-failure')throw original;
    if(args.action==='caught-nested-failure'){
      try{await writers.withWriter([B],async()=>{throw original;});}catch(error){assert.equal(error,original);}return;
    }
    const previous=args.traceRoot+'-old';fs.renameSync(args.traceRoot,previous);fs.mkdirSync(args.traceRoot);
    try{args.action==='identity-child-failure'?writers.assertWriter(B):writers.assertSource(A);}catch(error){observed=error;}
    fs.rmdirSync(args.traceRoot);fs.renameSync(previous,args.traceRoot);assert.equal(observed?.code,'E_ARCHIVE_FENCE_IDENTITY');
  });assert.fail('failed scope returned successfully');}catch(error){assert.equal(error,args.action.startsWith('identity-')?observed:original);}
  assert.throws(()=>writers.assertSource(A),{code:'E_ARCHIVE_WRITER_SCOPE'});send({failedClosed:true});await wait();
}
