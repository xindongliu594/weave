// Acceptance-only fault injection: no model response, budget, tool, or artifact is fabricated.
export function atAcceptedBoundary(original,{projectId,taskId,read,onBoundary}){
 return async function(runId,data,signal){
  const run=read(runId);
  if(run?.snapshot.projectId!==projectId||!run.events.some(e=>e.type==='handoff/accepted'&&e.data.taskId===taskId))return original.call(this,runId,data,signal);
  if(run.integrity!=='ok')throw Error('Invalid archive at acceptance stop');
  signal.throwIfAborted();
  onBoundary({runId,heldTaskId:data.taskId,heldRequestId:data.id,accepted:run.events.filter(e=>e.type==='handoff/accepted').map(e=>e.data),eventCount:run.eventCount});
  // Runs stay held before durable reservation and network dispatch until normal service shutdown.
  await new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
 };
}
