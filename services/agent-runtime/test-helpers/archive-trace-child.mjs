import assert from 'node:assert/strict';
import {createArchiveWriteFence} from '../archive-write-fence.mjs';
import * as scopes from '../archive-writer-scope.mjs';
import {openRunArchive} from '../trace-store.mjs';
const args=JSON.parse(process.env.ARCHIVE_TRACE_TEST);
if(args.action==='hold-journal'){
  const fence=createArchiveWriteFence(args),guard=await fence.acquireWriter([args.runId]);
  fence.withJournalAppendSync(guard,args.runId,()=>{process.send({ready:true});Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,args.holdMs);});
  guard.release();process.disconnect();
}else{
  const writers=scopes.createArchiveWriterManager(args);scopes.registerArchiveWriterRoot(writers);
  if(args.action==='blocked-writer'){
    await assert.rejects(writers.withWriter([args.runId],async()=>{openRunArchive(args.traceRoot,args.runId).append('forbidden');}),{code:'E_ARCHIVE_FENCE_TIMEOUT'});
    process.send({ready:true});process.disconnect();
  }else{
    await writers.withWriter([args.runId],async()=>{
      const archive=openRunArchive(args.traceRoot,args.runId);
      process.send({ready:true});await new Promise(resolve=>process.once('message',resolve));
      for(let i=0;i<40;i++){
        archive.append('shared',{i},{sourceKey:'shared:'+i});
        archive.append('unique',{i,label:args.label},{sourceKey:args.label+':'+i});
      }
    });process.disconnect();
  }
}
