// Private stdio bridge: reuse the host's provider and receipt path; never pass a Key to SkillX.
import {createInterface} from 'node:readline';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {POLICY,quotePilot} from './guard.mjs';

const root=process.env.SKILLX_PILOT_ROOT,release=process.env.WEIWU_RELEASE;
if(root!=='/home/jj/.local/share/weiwu/validation/skillx-pilot-20261015'||
 release!=='/home/jj/.local/share/weiwu/releases/weiwu-recovery-context-20261015')throw Error('PILOT_DIRECTORY_INVALID');
const authorization=JSON.parse(readFileSync(join(root,'authorization.json'),'utf8'));
if(authorization.status!=='approved'||authorization.budget!==.03||authorization.sourceRunId!==POLICY.sourceRunId)throw Error('PILOT_AUTHORIZATION_REQUIRED');
const {completeBudgeted,budgetedRequestEstimate}=await import(pathToFileURL(join(release,'apps/api/src/cost-control.ts')).href);
const {pool}=await import(pathToFileURL(join(release,'apps/api/src/db.ts')).href);
const api=async path=>{const response=await fetch('http://127.0.0.1:4310/api'+path);if(!response.ok)throw Error('PILOT_SOURCE_UNAVAILABLE');return response.json();};
const allUsage=await api('/usage'),allHolds=(await api('/costs')).calls;
if(allUsage.some(u=>String(u.purpose??'').startsWith(POLICY.purpose))||allHolds.some(u=>String(u.purpose??'').startsWith(POLICY.purpose)))throw Error('PILOT_ALREADY_STARTED');
writeFileSync(join(root,'provider-process.lock'),String(process.pid),{flag:'wx',mode:0o600});
let failed=false,index=0;
try{
 for await(const line of createInterface({input:process.stdin,crlfDelay:Infinity})){
  try{
   if(failed)throw Error('PILOT_STOPPED');
   const request=JSON.parse(line);
   if(Object.keys(request).some(k=>!['stage','messages'].includes(k))||!Array.isArray(request.messages)||!request.messages.length||request.messages.length>8||
      request.messages.some(m=>!['system','user','assistant'].includes(m.role)||typeof m.content!=='string'||Object.keys(m).some(k=>!['role','content'].includes(k))))throw Error('PILOT_REQUEST_INVALID');
   const [record,run,models,usage,costs,runs]=await Promise.all([api('/knowledge/work-records/'+POLICY.sourceRunId),api('/runs/'+POLICY.sourceRunId+'/export'),api('/models'),api('/usage'),api('/costs'),api('/runs')]);
   const model=models.find(m=>m.id===POLICY.modelId);if(!model||model.status!=='available')throw Error('PILOT_MODEL_UNAVAILABLE');
   const own=u=>String(u.purpose??'').startsWith(POLICY.purpose),trialUsage=usage.filter(own),trialHolds=costs.calls.filter(own);
   const estimate=budgetedRequestEstimate(model,request.messages,POLICY.stages[request.stage]);
   const state={approved:authorization.status==='approved',sourceRunId:record.runId,sourceStatus:run.status,integrity:run.integrity,shareable:record.shareable,
    modelId:model.id,inputRate:model.inputRate,outputRate:model.outputRate,occupied:usage.reduce((s,u)=>s+u.cost,0)+costs.calls.reduce((s,h)=>s+h.amount,0),
    trialOccupied:trialUsage.reduce((s,u)=>s+u.cost,0)+trialHolds.reduce((s,h)=>s+h.amount,0),callCount:trialUsage.length+trialHolds.length,
    pendingCount:costs.calls.filter(h=>h.status==='pending').length,activeRuns:runs.filter(r=>['queued','running'].includes(r.status)).length};
   quotePilot(state,{stage:request.stage,...estimate});
   const expected='57f22107eb69a4851d0cc0f4cded066937d78dca6c204dfa4d685505d293842f';
   if(!record.files.some(f=>f.path==='inventory-cases.md'&&f.sha256===expected))throw Error('PILOT_SOURCE_CHANGED');
   index++;const path=join(root,`call-${index}.json`),inputSHA=createHash('sha256').update(JSON.stringify(request)).digest('hex');
   writeFileSync(path,JSON.stringify({stage:request.stage,status:'sending',inputSHA,estimate}),{flag:'wx',mode:0o600});
   const response=await completeBudgeted(model,request.messages,POLICY.stages[request.stage],{purpose:POLICY.purpose+'/'+request.stage,
    maxCost:POLICY.budget-state.trialOccupied,timeoutMs:90000,context:{pilotId:POLICY.pilotId,sourceRunId:POLICY.sourceRunId,stage:request.stage,inputSHA}});
   const text=response.choices[0].message.content;
   writeFileSync(path,JSON.stringify({stage:request.stage,status:'returned',inputSHA,estimate,usageId:response.usageId,usage:response.usage,text,finishReason:response.choices[0].finish_reason}));
   if(response.choices[0].finish_reason!=='stop'||typeof text!=='string'||!text.trim())throw Error('PILOT_OUTPUT_INCOMPLETE');
   process.stdout.write(JSON.stringify({text,usageId:response.usageId})+'\n');
  }catch(error){
   failed=true;writeFileSync(join(root,'provider-stopped.json'),JSON.stringify({status:'stopped',code:error.code??error.message,index}));
   process.stdout.write(JSON.stringify({error:error.code??'PILOT_STOPPED'})+'\n');
  }
 }
}finally{await pool.end();}
