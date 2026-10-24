import {createArchiveWriteFence} from '../archive-write-fence.mjs';
import {createArchiveWriterManager} from '../archive-writer-scope.mjs';
const args=JSON.parse(process.env.ARCHIVE_ROOT_TEST),fence=createArchiveWriteFence(args);
if(args.action==='fail'){
 const writers=createArchiveWriterManager(args),first=Object.freeze(Error('unknown root producer'));let caught;
 try{await writers.withRootExclusive(async()=>{throw first;});}catch(error){caught=error;}
 process.send({original:caught===first});process.once('message',()=>process.exit(0));
}else{
 async function blocked(fn){try{const guard=await fn();guard.release();return false;}catch(error){if(error.code!=='E_ARCHIVE_FENCE_TIMEOUT')throw error;return true;}}
 process.send({writer:await blocked(()=>fence.acquireWriter([args.runId],{timeoutMs:0})),source:await blocked(()=>fence.acquireSource(args.runId)),maintenance:await blocked(()=>fence.acquireMaintenance([args.runId])),root:await blocked(()=>fence.acquireRootExclusive())});
 process.once('message',async()=>{const guard=await fence.acquireWriter([args.runId]);guard.release();process.send({acquired:true},()=>process.exit(0));});
}
