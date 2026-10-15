// Read-only: calculate the existing recovery admission rules without a provider call.
import {readFileSync,writeFileSync} from 'node:fs';import {pathToFileURL} from 'node:url';
const release='/home/jj/.local/share/weiwu/releases/weiwu-recovery-context-20261015',root='/home/jj/.local/share/weiwu/validation/experience-methods-20261015';
const load=p=>import(pathToFileURL(release+'/'+p).href);
const {pool}=await load('apps/api/src/db.ts');
try{
 const {budgetHistory}=await load('apps/api/src/budget-history.ts');
 const {recoveryMinimumProjectBudget,recoveryTaskMinimumBudget}=await load('apps/api/src/recovery-resource-plan.ts');
 const {completedTasks}=await load('apps/api/src/handoff-checkpoints.ts');
 const {projectCostReadiness}=await load('apps/api/src/cost-control.ts');
 const run=JSON.parse(readFileSync(root+'/reuse-run.json','utf8')),snapshot=run.snapshot,done=[...completedTasks(run.events,snapshot).keys()];
 const history=await budgetHistory(pool,process.env.TRACE_ROOT,snapshot.projectId,snapshot.planVersion),costs=await projectCostReadiness(pool,snapshot.projectId),ceilings={maxModelCalls:32,maxTaskModelCalls:16};
 const options=[2,3,4,5,6].map(n=>{try{return {remainingCallsEach:n,minimumProjectBudget:recoveryMinimumProjectBudget(snapshot,history,done,ceilings,costs,{'qa-check':n,accept:n})+.0027,taskBudgets:snapshot.tasks.filter(t=>!done.includes(t.id)).map(t=>({id:t.id,minimum:recoveryTaskMinimumBudget(snapshot,t,history.tasks[t.id]?.cost??0,history.tasks[t.id]?.reserved??0,history.tasks[t.id]?.requestOverheadBytes,n)}))};}catch(e){return {remainingCallsEach:n,error:e.code??e.message};}});
 const result={at:new Date().toISOString(),runId:run.id,done,history,costs,options,modelCalls:0};writeFileSync(root+'/recovery-inspection.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{await pool.end();}
