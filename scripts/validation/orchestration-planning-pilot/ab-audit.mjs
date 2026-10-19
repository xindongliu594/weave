// Read-only offline contract audit, not an execution or quality acceptance verdict.
import {readFileSync,writeFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {organizationCandidateV2Schema} from '../../../packages/contracts/organization.ts';
import {policySchema,validatePlan} from '../../../packages/contracts/index.ts';
import {resolveOrganizationCandidate} from '../../../apps/api/src/organization-routing.ts';
import {organizationTaskContractErrors} from '../../../apps/api/src/organization-draft-diagnostics.ts';
import {plannedAcceptanceErrors} from '../../../apps/api/src/execution-prompt.ts';
export async function audit(entry){
 const r={id:entry.id,responseStatus:'received',schemaValid:false,contractValid:false,futureFileErrors:null,errors:[]};
 if(typeof entry.content!=='string')return {...r,responseStatus:'unavailable',schemaValid:null,contractValid:null,errors:[entry.error?.message??'No model response']};
 try{
  const parsed=JSON.parse(entry.content),candidate=organizationCandidateV2Schema.parse(parsed.candidate);r.schemaValid=true;
  r.futureFileErrors=plannedAcceptanceErrors(candidate.tasks).filter(e=>e.includes('后续或并行任务'));
  const constraints=JSON.parse(entry.request.messages[1].content),policy=policySchema.parse(constraints.policy);
  const models=constraints.availableModels.map(m=>({...m,status:'available',version:1,gatewayId:'fixed-employee-catalog'}));
  const plan={agents:candidate.target.department?.agents??[],rationale:candidate.rationale,tasks:candidate.tasks,orchestration:candidate.orchestration,deliveryCriteria:candidate.deliveryCriteria};
  r.errors.push(...validatePlan(plan,policy,models,false).errors,...organizationTaskContractErrors(plan.tasks,plan.agents));
  try{await resolveOrganizationCandidate(candidate,policy,{query(){throw Error('No production lookup allowed');}});}catch(e){r.errors.push(e.message);}
  if(!plan.orchestration?.template&&plan.tasks.some(t=>(t.maxReworkRounds??0)>0))r.errors.push('No template authorizes planned rework');
  r.errors=[...new Set(r.errors)];r.contractValid=r.errors.length===0;r.template=plan.orchestration?.template?.id??null;
  r.tasks=plan.tasks.map(t=>({id:t.id,assigneeId:t.assigneeId,kind:t.kind,dependencies:t.dependencies,outputs:t.outputs,inputs:t.inputs,verify:t.verify,acceptanceCriteria:t.acceptanceCriteria,acceptanceChecks:t.acceptanceChecks,maxReworkRounds:t.maxReworkRounds}));
 }catch(e){r.errors.push(e.message);}
 return r;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const report=JSON.parse(readFileSync(process.argv[2]));const results=[];for(const e of report.requests)results.push({...await audit(e),model:e.model,variant:e.variant,usage:e.usage,cost:e.cost,milliseconds:e.milliseconds});
 writeFileSync(process.argv[3],JSON.stringify({notice:'Only static contract checks; semantic audit and execution are separate.',results},null,2));
 console.log(JSON.stringify(results.map(({tasks,...r})=>r),null,2));
}
