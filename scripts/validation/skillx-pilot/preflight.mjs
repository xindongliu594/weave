// Read-only quote and before/after evidence. The authorize mode only seals the already-approved pilot scope.
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {POLICY,quotePilot} from './guard.mjs';
const root='/home/jj/.local/share/weiwu/validation/skillx-pilot-20261015';
const release='/home/jj/.local/share/weiwu/releases/weiwu-recovery-context-20261015';
const mode=process.argv[2];if(!['before','after','authorize'].includes(mode))throw Error('INVALID_MODE');
const api=async p=>{const r=await fetch('http://127.0.0.1:4310/api'+p);if(!r.ok)throw Error('SOURCE_UNAVAILABLE');return r.json();};
const [record,run,models,usage,costs,runs]=await Promise.all([api('/knowledge/work-records/'+POLICY.sourceRunId),api('/runs/'+POLICY.sourceRunId+'/export'),api('/models'),api('/usage'),api('/costs'),api('/runs')]);
const model=models.find(m=>m.id===POLICY.modelId),own=u=>String(u.purpose??'').startsWith(POLICY.purpose);
const ownUsage=usage.filter(own),ownHolds=costs.calls.filter(own);
const sha=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const snapshot={at:new Date().toISOString(),sourceRunId:record.runId,status:run.status,integrity:run.integrity,shareable:record.shareable,
 snapshotSHA:sha(run.snapshot),eventsSHA:sha(run.events),files:record.files,
 usageCount:usage.length,usageCost:usage.reduce((s,u)=>s+u.cost,0),holds:costs.calls,
 occupied:usage.reduce((s,u)=>s+u.cost,0)+costs.calls.reduce((s,h)=>s+h.amount,0),
 trialOccupied:ownUsage.reduce((s,u)=>s+u.cost,0)+ownHolds.reduce((s,h)=>s+h.amount,0),trialUsage:ownUsage,
 pendingCount:costs.calls.filter(h=>h.status==='pending').length,activeRuns:runs.filter(r=>['queued','running'].includes(r.status)).length};
if(mode==='after'){
 const before=JSON.parse(readFileSync(join(root,'before.json'),'utf8'));
 snapshot.preserved={snapshot:before.snapshotSHA===snapshot.snapshotSHA,events:before.eventsSHA===snapshot.eventsSHA,
  files:sha(before.files)===sha(snapshot.files),oldHolds:before.holds.every(h=>snapshot.holds.some(current=>sha(h)===sha(current)))};
}else{
 if(ownUsage.length||ownHolds.length)throw Error('PILOT_ALREADY_STARTED');
 const {budgetedRequestEstimate}=await import(pathToFileURL(join(release,'apps/api/src/cost-control.ts')).href);
 const {pool}=await import(pathToFileURL(join(release,'apps/api/src/db.ts')).href);
 const request=JSON.parse(readFileSync(join(root,'requests-inspect.json'),'utf8'))[0];
 try{
  const estimate=budgetedRequestEstimate(model,request.messages,POLICY.stages.extract);
  snapshot.firstQuote=quotePilot({...snapshot,approved:true,sourceStatus:snapshot.status,modelId:model.id,inputRate:model.inputRate,outputRate:model.outputRate,callCount:0},{stage:'extract',...estimate});
  snapshot.inputBytes=estimate.inputBytes;snapshot.threeRequestMaximum=.0289728;
 }finally{await pool.end();}
}
if(mode==='authorize'){
 writeFileSync(join(root,'authorization.json'),JSON.stringify({status:'approved',budget:POLICY.budget,sourceRunId:POLICY.sourceRunId,sharedSlot:'existing future $0.03',authorization:'User approved the isolated SkillX pilot, then asked to continue; existing $2.80 total unchanged',at:snapshot.at}),{flag:'wx',mode:0o600});
}else writeFileSync(join(root,mode+'.json'),JSON.stringify(snapshot,null,2),{flag:'wx',mode:0o600});
console.log(JSON.stringify({mode,inputBytes:snapshot.inputBytes,firstQuote:snapshot.firstQuote,occupied:snapshot.occupied,trialOccupied:snapshot.trialOccupied,pending:snapshot.pendingCount,activeRuns:snapshot.activeRuns,usageCount:snapshot.usageCount,holdCount:snapshot.holds.length,preserved:snapshot.preserved}));
