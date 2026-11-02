import {createArchiveWriteFence} from '../../services/agent-runtime/archive-write-fence.mjs';
const args=JSON.parse(process.env.ARCHIVE_WRITER_TEST),fence=createArchiveWriteFence(args);
try{const guard=await fence.acquireSource(args.runId,{timeoutMs:100});guard.release();console.log(JSON.stringify({acquired:true}));}
catch(error){if(error.code!=='E_ARCHIVE_FENCE_TIMEOUT')throw error;console.log(JSON.stringify({blocked:true}));}
