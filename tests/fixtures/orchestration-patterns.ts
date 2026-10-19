import {orchestrationPatterns,type Plan,type Policy,type Model} from '../../packages/contracts/index.ts';

export const orchestrationPatternIds=['pipeline','parallel','router','orchestrator_workers','review_repair','map_reduce','proposal_review'];
export const orchestrationAgent=(id:string,role:'manager'|'member'='member')=>({id,role,name:id,title:id,instructions:'按合同完成工作',modelId:'m',tools:['filesystem','artifact_write','terminal'] as Plan['agents'][number]['tools']});
export const orchestrationTask=(id:string,assigneeId='a',dependencies:string[]=[]):Plan['tasks'][number]=>({id,assigneeId,dependencies,subject:id,objective:`完成 ${id}`,acceptanceCriteria:['证据完整'],handoff:{sections:[{key:'evidence',requirement:'提供依据'}]},estimatedInputTokens:100,estimatedOutputTokens:100,inputs:[],outputs:[]});
const output=(t:Plan['tasks'][number])=>{t.outputs=[{path:`${t.id}.txt`}];return t;};
const reads=(t:Plan['tasks'][number],producers:Plan['tasks'])=>{t.inputs=producers.flatMap(p=>(p.outputs??[]).map(o=>({path:o.path,producerTaskId:p.id})));return t;};
const criterion=(producerTaskIds:string[],checkTaskId:string)=>({id:`delivery_${checkTaskId}`,description:'交付经过独立核对',producerTaskIds,checkTaskId,checkCriteriaIndexes:[0],independent:true});
export const orchestrationPolicy:Policy={maxBudget:10,maxAgents:6,maxConcurrentAgents:3,deadlineSeconds:600,allowedModelIds:['m'],allowedTools:['filesystem','artifact_write','terminal'],allowedKnowledgeSpaceIds:[]};
export const orchestrationModels=[{id:'m',version:1,name:'m',gatewayId:'g',model:'m',inputRate:1,outputRate:1,status:'available',capabilities:{tools:{status:'supported',checkedAt:'2026-10-19',testId:'t',probeVersion:'1'}}}] as Model[];
export function orchestrationFixture(id:string):Plan{
 const a=output(orchestrationTask('a')), b=output(orchestrationTask('b','b')), check=reads(orchestrationTask('check','b',['a']),[a]), manager=orchestrationTask('manager','manager',['check']);
 const plan:Plan={rationale:'固定计划',agents:[orchestrationAgent('a'),orchestrationAgent('b'),orchestrationAgent('manager','manager')],tasks:[a,check,manager],deliveryCriteria:[criterion(['a'],'check')],orchestration:{pattern:'pipeline',rationale:'按冻结绑定交接'}};
 let binding:any={taskIds:['a','check','manager']};
 if(['parallel','orchestrator_workers','map_reduce'].includes(id)){
  const join=reads(orchestrationTask('join','manager',['a','b']),[a,b]);plan.tasks=[a,b,join];plan.orchestration!.pattern='parallel';plan.deliveryCriteria=[criterion(['a','b'],'join')];
  binding=id==='parallel'?{branchTaskIds:['a','b'],joinTaskId:'join'}:id==='orchestrator_workers'?{workItems:[{id:'work_a',taskId:'a',objective:a.objective},{id:'work_b',taskId:'b',objective:b.objective}],joinTaskId:'join'}:{manifest:[{id:'part_a',taskId:'a',input:{path:'input_a.txt',sha256:'a'.repeat(64)}},{id:'part_b',taskId:'b',input:{path:'input_b.txt',sha256:'b'.repeat(64)}}],reduceTaskId:'join'};
  if(id==='map_reduce'){a.inputs=[structuredClone(binding.manifest[0].input)];b.inputs=[structuredClone(binding.manifest[1].input)];}
 }
 if(id==='router')binding={routeKey:'research',selectedTaskIds:['a','check','manager']};
 if(id==='review_repair'){a.kind='implementation';a.inScope=['a.txt'];a.verify=['node --test'];check.kind='review';check.reviewedTaskId='a';check.maxReworkRounds=2;binding={reviewTaskId:'check'};}
 if(id==='proposal_review'){
  const critiqueA=reads(orchestrationTask('critique_a','b',['a','b']),[a,b]),critiqueB=reads(orchestrationTask('critique_b','a',['a','b']),[a,b]);output(critiqueA);output(critiqueB);
  const decision=reads(orchestrationTask('decision','manager',['critique_a','critique_b']),[a,b,critiqueA,critiqueB]);plan.tasks=[a,b,critiqueA,critiqueB,decision];plan.orchestration!.pattern='parallel';plan.deliveryCriteria=[criterion(['a'],'critique_a'),criterion(['b'],'critique_b'),criterion(['critique_a','critique_b'],'decision')];
  binding={proposals:[{proposalTaskId:'a',critiqueTaskId:'critique_a'},{proposalTaskId:'b',critiqueTaskId:'critique_b'}],decisionTaskId:'decision'};
 }
 (plan.orchestration as any).template={schemaVersion:1,id,version:1,definitionHash:orchestrationPatterns.find((p:any)=>p.id===id)?.definitionHash??'0'.repeat(64),...binding};return plan;
}
