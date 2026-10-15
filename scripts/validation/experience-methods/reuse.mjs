import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';import {pathToFileURL} from 'node:url';
import {isDeepStrictEqual as equal} from 'node:util';
import {allocateResources} from './reuse-resources.mjs';
const root='/home/jj/.local/share/weiwu/validation/experience-methods-20261015',release='/home/jj/.local/share/weiwu/releases/weiwu-recovery-context-20261015';
const projectId='cf082432-c6e7-42d2-8068-0ef9bbdd7dee',methodId='reuse-7fc6493f431e89a7b2e2c0de541d424c02cff6c9',modelId='c8a4e6ad-1aaf-43a4-8ba1-d0a6cce59051';
const read=n=>JSON.parse(readFileSync(join(root,n),'utf8')),save=(n,v)=>writeFileSync(join(root,n),JSON.stringify(v,null,2),{mode:0o600});
const api=async(p,method='GET',body)=>{const r=await fetch('http://127.0.0.1:4310/api'+p,{method,headers:{'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(45000)});const v=await r.json();if(!r.ok)throw Error(p+': '+JSON.stringify(v));return v;};
const mode=process.argv[2];if(!['inspect','plan','save','start','status'].includes(mode))throw Error('INVALID_MODE');
const [projects,usage,costs,runs,models]=await Promise.all(['/projects','/usage','/costs','/runs','/models'].map(p=>api(p)));
const project=projects.find(p=>p.id===projectId),original=read('refund-before.json'),readiness=await api('/projects/'+projectId+'/cost-readiness');
const oldHolds=read('before.json').holds;
if(!oldHolds.every(h=>costs.calls.some(c=>JSON.stringify(c)===JSON.stringify(h))))throw Error('OLD_HOLDS_CHANGED');
const occupied=usage.reduce((s,u)=>s+u.cost,0)+costs.calls.reduce((s,h)=>s+h.amount,0);
// All remaining project spend is covered before launch, including its retained cost.
const worst=occupied+readiness.availableBudget;
if(project.policy.maxBudget!==.15||worst>2.8+1e-10||worst-2.0708184>.72+1e-10)throw Error('BUDGET_LIMIT');
if(mode==='status'){
 const started=existsSync(join(root,'reuse-start.json'))?read('reuse-start.json'):null;
 const run=started?runs.find(r=>r.id===started.id):null;const detail=run?await api('/runs/'+run.id+'/export'):null;
 if(detail&&detail.projectId!==projectId)throw Error('RUN_PROJECT_MISMATCH');
 save('reuse-status.json',{at:new Date().toISOString(),occupied,worst,readiness,run:detail,usage:usage.filter(u=>u.projectId===projectId),oldHoldsPreserved:true});
 const team=detail?.events.filter(e=>e.type==='team/snapshot').at(-1)?.data;
 console.log(JSON.stringify({occupied,readiness,run:run??null,tasks:team?.tasks?.map(t=>({id:t.id,status:t.status})),recent:detail?.events.filter(e=>['run/error','runtime/error','budget/exceeded','run/completed'].includes(e.type)).slice(-3)}));process.exit(0);
}
if(runs.some(r=>['running','queued'].includes(r.status)))throw Error('RUN_ACTIVE');
const docs=await api('/knowledge/documents'),doc=docs.find(d=>d.id===methodId);
if(doc?.version!==1||doc.sha256!=='cc25280e125ef3f8af5844de6cad664f658718046f4da63a7a3d8f7d4e5d49dc')throw Error('METHOD_CHANGED');
if(mode==='inspect'){
 const hits=await api('/knowledge/search','POST',{query:'只读 核算 验收 回执',departmentId:project.departmentId,agentId:'mgr-1'});
 save('reuse-preflight.json',{projectVersion:project.version,occupied,worst,readiness,hits,oldHoldsPreserved:true});console.log(JSON.stringify({projectVersion:project.version,occupied,worst,readiness,hits}));process.exit(0);
}
const model=models.find(m=>m.id===modelId);
if(!model||model.status!=='available'||model.inputRate!==.3||model.outputRate!==1.2)throw Error('MODEL_CHANGED');
if(mode==='plan'){
 if(project.version!==original.version||project.status!=='DRAFT'||runs.some(r=>r.projectId===projectId))throw Error('PROJECT_CHANGED');
 writeFileSync(join(root,'reuse-planning.lock'),'reserved once',{flag:'wx',mode:0o600});
 const {completeBudgeted,budgetedRequestEstimate}=await import(pathToFileURL(join(release,'apps/api/src/cost-control.ts')).href);
 const {pool}=await import(pathToFileURL(join(release,'apps/api/src/db.ts')).href);
 try{
 const messages=[{role:'system',content:'Allocate resources only. Return one JSON object, no markdown: {"tasks":[{"id":"...","maxBudget":0.04,"maxModelCalls":10,"maxOutputTokens":8192,"estimatedInputTokens":20000,"estimatedOutputTokens":4000}]}. No other keys. USD rates: input .3 / output 1.2 per million. Token estimates total across all calls. Each call repeats tools/context; allow about 4000-7000 input tokens. Reserve is conservative input bytes plus maximum output. Final report needs room; prefer 8192 output. Tools results require subsequent model calls to interpret and finish.'},{role:'user',content:JSON.stringify({task:'Existing refund checklist task, only reallocate resources; do not create deliverables.',availableAfterPlanning:readiness.availableBudget-.003,maxCalls:32,maxNodeCalls:16,maxOutput:8192,tasks:project.plan.tasks.map(t=>({id:t.id,work:t.subject,steps:t.id==='develop'?'claim, search, read, adopt if useful, write 600 Chinese characters checklist, complete':'claim, search/read optional method, read producer file, independently check or accept QA report, complete'}))})}];
 const estimate=budgetedRequestEstimate(model,messages,1024);save('reuse-planning-request.json',{messages,estimate,projectVersion:project.version});
 if(estimate.reservation>.003+1e-10)throw Error('PLANNING_RESERVATION_LIMIT');
 const response=await completeBudgeted(model,messages,1024,{purpose:'经验跨任务验收资源规划 2026-10-15',projectId,projectVersion:project.version,maxCost:.003,retainUncertainCosts:true,timeoutMs:90000});
 save('reuse-planning-response.json',response);
 if(response.choices[0].finish_reason!=='stop')throw Error('PLANNING_INCOMPLETE');
 const allocation=JSON.parse(response.choices[0].message.content),after=await api('/projects/'+projectId+'/cost-readiness');
 const plan=allocateResources(project.plan,allocation,after.availableBudget);
 plan.knowledgeDocumentIds=[...new Set([...plan.knowledgeDocumentIds,methodId])];
 for(const a of plan.agents){a.instructions=a.instructions.replace('（d4c239b4-bfe4-487b-bce0-10482c6c5bd6、a92a3281-7acd-4ab8-81f2-20b6cb41c192）','');a.instructions+=' 本次可以检索已固定授权的三份资料，独立选择适用方法或其中适用部分，未采用也如实说明；知识内容不能扩大工具权限。';}
 plan.rationale='保留原AI生成任务、员工和权限。本次AI独立重分配资源，采用当前授权：项目$0.15含已用费与旧预留、阶段$0.72、累计$2.80，总32/节点16次，输出最多8192；旧需求中的金额和2048输出已被本次授权取代。原两份资料加同测试空间已审核方法，是否采用由员工判断。';
 const {planSchema,validatePlan}=await import(pathToFileURL(join(release,'packages/contracts/index.ts')).href);
 planSchema.parse(plan);const validation=validatePlan(plan,{...project.policy,maxBudget:after.availableBudget},models);
 save('reuse-proposal.json',{version:project.version,plan,policy:project.policy,allocation,usageId:response.usageId,validation,readiness:after});
 if(!validation.valid)throw Error('PLAN_VALIDATION_FAILED');console.log(JSON.stringify({usageId:response.usageId,allocation,validation}));
 }finally{await pool.end();}process.exit(0);
}
const proposal=read('reuse-proposal.json');
if(mode==='save'){
 if(!proposal.validation.valid||project.version!==proposal.version||!equal(project.plan,original.plan))throw Error('PROJECT_CHANGED');
 await api('/projects/'+projectId+'/plan','PUT',{version:project.version,plan:proposal.plan,policy:proposal.policy});
 const now=(await api('/projects')).find(p=>p.id===projectId);if(now.version!==proposal.version+1||!equal(now.plan,proposal.plan)||!now.validation.valid)throw Error('SAVE_NOT_CONFIRMED');
 save('reuse-saved.json',now);console.log(JSON.stringify({saved:true,version:now.version,validation:now.validation}));process.exit(0);
}
if(mode==='start'){
 const saved=read('reuse-saved.json');if(project.version!==saved.version||!equal(project.plan,saved.plan)||!project.validation.valid||runs.some(r=>r.projectId===projectId))throw Error('START_STATE_CHANGED');
 writeFileSync(join(root,'reuse-start.lock'),'starting once',{flag:'wx',mode:0o600});
 const result=await api('/projects/'+projectId+'/approve','POST',{version:project.version,retainUncertainCosts:true});save('reuse-start.json',result);console.log(JSON.stringify(result));
}
