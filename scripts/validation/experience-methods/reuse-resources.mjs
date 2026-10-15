// The model can allocate resources; it cannot change the task or grant permissions.
export function allocateResources(plan,allocation,available){
 const keys=['id','maxBudget','maxModelCalls','maxOutputTokens','estimatedInputTokens','estimatedOutputTokens'];
 const fail=()=>{throw Error('RESOURCE_ALLOCATION_INVALID');};
 if(!allocation||Object.keys(allocation).join()!=='tasks'||!Array.isArray(allocation.tasks)||allocation.tasks.length!==plan.tasks.length||!Number.isFinite(available)||available<=0)fail();
 let total=0,calls=0;const seen=new Set();
 for(const t of allocation.tasks){
  if(Object.keys(t).length!==keys.length||Object.keys(t).some(k=>!keys.includes(k))||seen.has(t.id)||!plan.tasks.some(p=>p.id===t.id))fail();seen.add(t.id);
  if(!Number.isFinite(t.maxBudget)||t.maxBudget<=0||!Number.isInteger(t.maxModelCalls)||t.maxModelCalls<1||t.maxModelCalls>16||!Number.isInteger(t.maxOutputTokens)||t.maxOutputTokens<2048||t.maxOutputTokens>8192||!Number.isInteger(t.estimatedInputTokens)||t.estimatedInputTokens<1||!Number.isInteger(t.estimatedOutputTokens)||t.estimatedOutputTokens<1)fail();
  total+=t.maxBudget;calls+=t.maxModelCalls;
 }
 if(total>available+1e-10||calls>32)fail();
 const result=structuredClone(plan);for(const t of result.tasks)Object.assign(t,allocation.tasks.find(a=>a.id===t.id));return result;
}
