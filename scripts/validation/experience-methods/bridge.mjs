import {createInterface} from 'node:readline';import {readFileSync,writeFileSync} from 'node:fs';import {join} from 'node:path';import {pathToFileURL} from 'node:url';import {createHash} from 'node:crypto';import {POLICY,admit} from './policy.mjs';
const root='/home/jj/.local/share/weiwu/validation/experience-methods-20261015',release='/home/jj/.local/share/weiwu/releases/weiwu-recovery-context-20261015';
const api=async p=>{const r=await fetch('http://127.0.0.1:4310/api'+p);if(!r.ok)throw Error('SOURCE_UNAVAILABLE');return r.json();};
const sha=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const {completeBudgeted,budgetedRequestEstimate}=await import(pathToFileURL(join(release,'apps/api/src/cost-control.ts')).href);
const {pool}=await import(pathToFileURL(join(release,'apps/api/src/db.ts')).href);
const old=JSON.parse(readFileSync('/home/jj/.local/share/weiwu/validation/skillx-pilot-20261015/after.json','utf8'));
const candidate=(await api('/automation/knowledge-candidates')).find(c=>c.id===POLICY.candidateId);
if(!candidate||candidate.status!=='pending')throw Error('CANDIDATE_UNAVAILABLE');
const resume=process.argv[2]==='resume-review';
if(resume){
 const saved=JSON.parse(readFileSync(join(root,'call-1.json'),'utf8')),original=JSON.parse(readFileSync(join(root,'candidate-before.json'),'utf8'));
 const usages=await api('/usage'),receipt=usages.find(u=>u.id===saved.usageId);
 if(saved.status!=='returned'||saved.finishReason!=='stop'||saved.stage!=='extract'||!receipt||receipt.purpose!==POLICY.purpose+'/extract'||candidate.version!==original.version||candidate.content!==original.content)throw Error('KNOWN_RESPONSE_REQUIRED');
}else writeFileSync(join(root,'candidate-before.json'),JSON.stringify(candidate,null,2),{flag:'wx',mode:0o600});
writeFileSync(join(root,resume?'provider-continuation.lock':'provider.lock'),String(process.pid),{flag:'wx',mode:0o600});
let stopped=false,index=resume?1:0;
try{for await(const line of createInterface({input:process.stdin,crlfDelay:Infinity})){
 try{
  if(stopped)throw Error('EXPERIENCE_STOPPED');
  const request=JSON.parse(line);
  if(Object.keys(request).some(k=>!['stage','messages'].includes(k))||!Array.isArray(request.messages)||request.messages.length<1||request.messages.length>8||request.messages.some(m=>!['system','user','assistant'].includes(m.role)||typeof m.content!=='string'||Object.keys(m).some(k=>!['role','content'].includes(k))))throw Error('REQUEST_INVALID');
  const [record,run,models,usage,costs,runs]=await Promise.all([api('/knowledge/work-records/'+POLICY.sourceRunId),api('/runs/'+POLICY.sourceRunId+'/export'),api('/models'),api('/usage'),api('/costs'),api('/runs')]);
  const model=models.find(m=>m.id===POLICY.modelId);if(!model||model.status!=='available')throw Error('MODEL_UNAVAILABLE');
  const own=u=>String(u.purpose??'').startsWith(POLICY.purpose),shared=u=>own(u)||String(u.purpose??'').startsWith(POLICY.previousPurpose);
  const amount=(u,h)=>u.reduce((s,x)=>s+x.cost,0)+h.reduce((s,x)=>s+x.amount,0);
  const state={sourceValid:record.shareable&&run.status==='completed'&&run.integrity==='ok'&&sha(run.snapshot)===old.snapshotSHA&&sha(run.events)===old.eventsSHA&&sha(record.files)===sha(old.files),
   pending:costs.calls.filter(h=>h.status==='pending').length,active:runs.filter(r=>['queued','running'].includes(r.status)).length,modelId:model.id,inputRate:model.inputRate,outputRate:model.outputRate,
   count:usage.filter(own).length+costs.calls.filter(own).length,occupied:amount(usage,costs.calls),own:amount(usage.filter(own),costs.calls.filter(own)),shared:amount(usage.filter(shared),costs.calls.filter(shared))};
  const estimate=budgetedRequestEstimate(model,request.messages,POLICY.stages[request.stage]);admit(state,{stage:request.stage,...estimate});
  if(state.count!==index)throw Error('CALL_HISTORY_CHANGED');
  if(index===0)writeFileSync(join(root,'before.json'),JSON.stringify({at:new Date().toISOString(),state,holds:costs.calls,usageCount:usage.length,snapshotSHA:sha(run.snapshot),eventsSHA:sha(run.events),files:record.files}),{flag:'wx',mode:0o600});
  index++;const path=join(root,`call-${index}.json`),inputSHA=sha(request);
  writeFileSync(path,JSON.stringify({stage:request.stage,status:'sending',estimate,inputSHA}),{flag:'wx',mode:0o600});
  const start=Date.now();
  const response=await completeBudgeted(model,request.messages,POLICY.stages[request.stage],{purpose:POLICY.purpose+'/'+request.stage,maxCost:Math.min(POLICY.budget-state.own,POLICY.sharedBudget-state.shared),timeoutMs:90000,context:{trial:'experience-methods-20261015',sourceRunId:POLICY.sourceRunId,stage:request.stage,inputSHA}});
  const text=response.choices[0].message.content;
  writeFileSync(path,JSON.stringify({stage:request.stage,status:'returned',estimate,inputSHA,text,usageId:response.usageId,usage:response.usage,finishReason:response.choices[0].finish_reason,durationMs:Date.now()-start}));
  if(response.choices[0].finish_reason!=='stop'||typeof text!=='string'||!text.trim())throw Error('OUTPUT_INCOMPLETE');
  process.stdout.write(JSON.stringify({text,usageId:response.usageId})+'\n');
 }catch(e){stopped=true;writeFileSync(join(root,'stopped.json'),JSON.stringify({index,code:e.code??e.message}));process.stdout.write(JSON.stringify({error:e.code??'EXPERIENCE_STOPPED'})+'\n');}
}}finally{await pool.end();}
