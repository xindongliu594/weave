import {createArchiveWriteFence} from '../../services/agent-runtime/archive-write-fence.mjs';
const args=JSON.parse(process.env.ARCHIVE_WRITER_TEST);
const fence=createArchiveWriteFence(args);
let result;
try{const guard=await fence.acquireSource(args.runId,{timeoutMs:100});guard.release();result={acquired:true};}
catch(error){if(error.code!=='E_ARCHIVE_FENCE_TIMEOUT')throw error;result={blocked:true};}
process.send(result);
// Parent observes the response and terminates this exclusively-owned probe.
process.once('message',()=>process.exit(0));
