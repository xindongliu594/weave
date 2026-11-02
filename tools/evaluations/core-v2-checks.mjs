import {observeAcceptanceChecks,collectAcceptanceChecks} from '../../services/agent-runtime/acceptance-checks.mjs';
import {chunkDocument,searchKnowledge} from '../../services/agent-runtime/knowledge.mjs';
import {nodeTestCounts} from '../../services/agent-runtime/run-evidence.mjs';
import {ExecutionBudget} from '../../services/agent-runtime/budget.mjs';
import {deliveryCriteriaErrors} from '../../packages/contracts/orchestration.ts';
import {permissionChecks} from '../../packages/contracts/index.ts';

const task={id:'qa',acceptanceCriteria:['CLI returns 77'],acceptanceChecks:[{criterionIndex:0,command:'node cli.mjs 25',expectedOutput:'77\n'}]};
const summary='# tests 1\n# suites 0\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n';
export function runProductCheck(c){
 const i=c.input;
 switch(c.check){
  case 'acceptance':return observeAcceptanceChecks(task,'node cli.mjs 25',i)[0].status;
  case 'minimum-tests':return observeAcceptanceChecks({...task,acceptanceChecks:[{criterionIndex:0,command:'node --test',minimumTests:i.minimumTests}]},'node --test',i)[0].status;
  case 'revision':{const result={command:'node cli.mjs 25',exitCode:0,workspaceRevision:i.observedRevision,acceptanceChecks:observeAcceptanceChecks(task,'node cli.mjs 25',{exitCode:0,output:'77\n'})};return collectAcceptanceChecks(task,i.noObservation?[]:[result],i.currentRevision)[0].status;}
  case 'search':{const chunks=i.documents.flatMap(([id,v,text])=>chunkDocument(id,v,text));return searchKnowledge(chunks,i.query,5).map(r=>c.id==='rag-version'?`${r.documentId}:${r.version}`:r.documentId);}
  case 'summary':return nodeTestCounts('node --test checks.mjs',i.duplicate?summary+summary:i.output).status;
  case 'plan':{
   const writer={id:'write',assigneeId:'writer',dependencies:[],outputs:[{path:'result.txt'}],acceptanceCriteria:[]};
   const qa={...task,assigneeId:'qa',dependencies:['write'],inputs:[{path:'result.txt',producerTaskId:'write'}],outputs:[]};
   const manager={id:'accept',assigneeId:'manager',dependencies:['qa'],outputs:[],acceptanceCriteria:[]};
   const criterion={id:'delivered',description:'checked',producerTaskIds:['write'],checkTaskId:'qa',checkCriteriaIndexes:[0],independent:true};
   if(i.variant==='self')criterion.checkTaskId='write';if(i.variant==='unordered')qa.dependencies=[];
   return deliveryCriteriaErrors({tasks:[writer,qa,manager],agents:[{id:'manager',role:'manager'}],deliveryCriteria:[criterion]}).length===0;
  }
  case 'budget':{
   const b=new ExecutionBudget({maxBudget:1,maxModelCalls:2,priorModelCalls:i.variant==='calls'?2:0});
   try{if(i.variant==='settle'){b.reserve(.5).settle(.25);return {spent:b.run.spent,reserved:b.run.reserved,calls:b.run.calls};}b.reserve(i.variant==='cap'?2:.1);return 'unexpected-admission';}catch(e){return e.code;}
  }
  case 'permissions':{
   const agent={modelId:'model',tools:[i.variant==='tool'?'terminal':'knowledge_search'],knowledgeSpaceIds:['public'],sourceDepartmentId:i.variant==='department'?'B':'A'};
   return permissionChecks([agent],{allowedModelIds:['model'],allowedTools:['knowledge_search'],allowedKnowledgeSpaceIds:['public'],allowedDepartmentIds:['A']}).every(r=>r.pass);
  }
  default:throw Error('unsupported-product-check');
 }
}
