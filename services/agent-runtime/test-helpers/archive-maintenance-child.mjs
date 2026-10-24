import {createArchiveWriteFence} from '../archive-write-fence.mjs';
import {createArchiveWriterManager} from '../archive-writer-scope.mjs';
const args=JSON.parse(process.env.ARCHIVE_MAINTENANCE_TEST),fence=createArchiveWriteFence(args);
if(args.action==='fail'){
 const writers=createArchiveWriterManager(args),first=Object.freeze(Error('physical outcome unknown'));let caught;
 try{await writers.withMaintenance([args.runId],async()=>{throw first;});}catch(error){caught=error;}
 process.send({firstError:caught===first});process.once('message',()=>process.exit(0));
}else{
 async function blocked(fn){try{const guard=await fn();guard.release();return false;}catch(error){if(error.code!=='E_ARCHIVE_FENCE_TIMEOUT')throw error;return true;}}
 process.send({writerBlocked:await blocked(()=>fence.acquireWriter([args.runId],{timeoutMs:0})),sourceBlocked:await blocked(()=>fence.acquireSource(args.runId))});
 process.once('message',async()=>{const guard=await fence.acquireWriter([args.runId]);guard.release();process.send({acquired:true},()=>process.exit(0));});
}
