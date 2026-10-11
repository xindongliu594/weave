const policy=Object.freeze({hotJournalHours:24,completedCopiesDays:7,releaseKeepLatest:3,backupDays:30,backupKeepLatest:3});
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function retentionAdvice(runs,now=Date.now()){
 if(!Number.isFinite(now))throw new TypeError('Invalid retention clock');
 const recommendations=[];
 for(const run of runs.slice(0,50)){
  if(!uuid.test(run.id)||run.status!=='completed'||run.blocked!==false||typeof run.finishedAt!=='string')continue;
  const finished=Date.parse(run.finishedAt);if(!Number.isFinite(finished)||finished>now)continue;
  const ageDays=(now-finished)/86400000;
  if(run.journal===true&&ageDays>=policy.hotJournalHours/24)recommendations.push({runId:run.id,kind:'journal',ageDays});
  if(ageDays>=policy.completedCopiesDays)for(const kind of ['workspace','sandbox'])if(run[kind]===true)recommendations.push({runId:run.id,kind,ageDays});
 }
 return {mode:'suggestion-only',automaticDeletion:false,policy,recommendations};
}
