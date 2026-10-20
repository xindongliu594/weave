import { createArchiveWriteFence } from '../archive-write-fence.mjs';
import { createArchiveWriterManager } from '../archive-writer-scope.mjs';
import assert from 'node:assert/strict';
const args=JSON.parse(process.env.ARCHIVE_WRITER_TEST),fence=createArchiveWriteFence(args);
if(args.action==='failed-nested'){
  const writers=createArchiveWriterManager(args);let caught=false,outerError;
  try{
    await writers.withWriter([args.runId],async()=>{
      try{await writers.withWriter([args.runId],args.style==='sync'?()=>{throw Error('nested producer failed');}:async()=>{throw Error('nested producer failed');});}
      catch(error){assert.equal(error.message,'nested producer failed');caught=true;}
    });
  }catch(error){outerError=error.message;}
  process.send({caught,outerError:outerError??null});process.once('message',()=>process.exit(0));
}else if(args.action==='failed-producer'){
  const writers=createArchiveWriterManager(args),owner=await writers.acquireOwner([args.runId]),producer=owner.retain('failed original');
  owner.finish();await assert.rejects(producer.run(async()=>{throw Error('unproven');}),/unproven/);producer.finish();
  await assert.rejects(owner.writerDrained,/unproven/);assert.throws(()=>producer.run(()=>{}),{code:'E_ARCHIVE_WRITER_SCOPE'});
  process.send({latched:true});process.once('message',()=>process.exit(0));
}else{
try{const guard=await fence.acquireSource(args.runId);guard.release();process.send({blocked:false});process.exit(1);}
catch(error){if(error.code!=='E_ARCHIVE_FENCE_TIMEOUT')throw error;process.send({blocked:true});}
process.once('message',async()=>{const guard=await fence.acquireSource(args.runId);guard.release();process.send({acquired:true},()=>process.exit(0));});
}
