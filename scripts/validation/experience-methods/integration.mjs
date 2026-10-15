import {readFileSync,writeFileSync,existsSync} from 'node:fs';import {join,resolve} from 'node:path';import {pathToFileURL} from 'node:url';import {createHash} from 'node:crypto';import {POLICY} from './policy.mjs';
export const candidateProposal=(description,content)=>({title:('经验方法：'+description.slice(0,190)).trim(),content:content.trim()});
export function updateDecision(original,current,desired){
 if(!current||['id','runId','documentId','sourceVersion','sourceHash'].some(k=>original[k]!==current[k]))throw Error('CANDIDATE_SOURCE_CHANGED');
 if(current.content===desired.content&&current.title===desired.title&&current.version===original.version+1&&current.status==='pending')return 'already-updated';
 if(current.status!=='pending'||current.version!==original.version||current.content!==original.content||current.title!==original.title)throw Error('CANDIDATE_CHANGED');
 return 'update';
}
async function main(){
 const mode=process.argv[2];if(!['preview','update','publish'].includes(mode))throw Error('INVALID_MODE');
 const root='/home/jj/.local/share/weiwu/validation/experience-methods-20261015';
 const read=name=>JSON.parse(readFileSync(join(root,name),'utf8')),hash=value=>createHash('sha256').update(value).digest('hex');
 const method=read('method.json'),content=readFileSync(join(root,'method.md'),'utf8'),first=read('call-1.json'),second=read('call-2.json'),review=JSON.parse(second.text),original=read('candidate-before.json');
 if(method.sourceRunId!==POLICY.sourceRunId||method.sha256!==hash(content)||!method.independentReviewPassed||review.verdict!=='pass'||review.findings.length||Object.values(review.checks).some(v=>v!==true)||JSON.stringify([...review.checkedSources].sort())!==JSON.stringify(Object.keys(method.sources).sort()))throw Error('METHOD_NOT_VERIFIED');
 const api=async(p,verb='GET',body)=>{const r=await fetch('http://127.0.0.1:4310/api'+p,{method:verb,headers:{'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(30000)});const v=await r.json();if(!r.ok)throw Error(p+': '+v.message);return v;};
 const [usage,record,run,candidates,costs]=await Promise.all([api('/usage'),api('/knowledge/work-records/'+POLICY.sourceRunId),api('/runs/'+POLICY.sourceRunId+'/export'),api('/automation/knowledge-candidates'),api('/costs')]);
 const before=read('before.json');
 if(!record.shareable||run.status!=='completed'||run.integrity!=='ok'||hash(JSON.stringify(run.snapshot))!==before.snapshotSHA||hash(JSON.stringify(run.events))!==before.eventsSHA)throw Error('SOURCE_CHANGED');
 if(!before.holds.every(h=>costs.calls.some(now=>JSON.stringify(now)===JSON.stringify(h))))throw Error('OLD_HOLDS_CHANGED');
 for(const [call,stage] of [[first,'extract'],[second,'general-filter']])if(call.status!=='returned'||call.finishReason!=='stop'||!usage.some(u=>u.id===call.usageId&&u.purpose===POLICY.purpose+'/'+stage))throw Error('RECEIPT_MISSING');
 const current=candidates.find(c=>c.id===POLICY.candidateId),desired=candidateProposal(method.skill.document,content);
 const snapshot={at:new Date().toISOString(),usageCount:usage.length,occupied:usage.reduce((s,u)=>s+u.cost,0)+costs.calls.reduce((s,h)=>s+h.amount,0),holds:costs.calls,receipts:usage.filter(u=>[first.usageId,second.usageId].includes(u.id)),sourcePreserved:true};
 writeFileSync(join(root,'integration-audit.json'),JSON.stringify(snapshot,null,2));
 if(mode==='preview'){
  const decision=updateDecision(original,current,desired);
  writeFileSync(join(root,'candidate-preview.json'),JSON.stringify({id:current.id,version:current.version,...desired,methodSHA:method.sha256,decision},null,2));
  console.log(JSON.stringify({mode,decision,version:current.version,methodSHA:method.sha256,occupied:snapshot.occupied}));return;
 }
 if(mode==='update'){
  const decision=updateDecision(original,current,desired);
  if(decision==='update')await api('/automation/knowledge-candidates/'+current.id,'PUT',{...desired,version:current.version});
  const updated=(await api('/automation/knowledge-candidates')).find(c=>c.id===current.id);
  if(updateDecision(original,updated,desired)!=='already-updated')throw Error('UPDATE_NOT_CONFIRMED');
  writeFileSync(join(root,'candidate-updated.json'),JSON.stringify(updated,null,2));
  console.log(JSON.stringify({mode,id:updated.id,version:updated.version,status:updated.status}));return;
 }
 if(current?.content!==desired.content||current.title!==desired.title||!['pending','publishing','published'].includes(current.status))throw Error('PUBLICATION_CONTENT_CHANGED');
 if(!existsSync(join(root,'candidate-updated.json')))throw Error('UPDATE_RECEIPT_REQUIRED');
 const publication=await api('/automation/knowledge-candidates/'+current.id+'/publish','POST',{version:current.version,reviewed:true});
 const docs=await api('/knowledge/documents'),published=docs.find(d=>d.id===publication.id);
 if(!published||published.sha256!==hash(desired.content)||published.source?.skillName||published.spaceId!==original.spaceId)throw Error('PUBLICATION_NOT_CONFIRMED');
 writeFileSync(join(root,'published.json'),JSON.stringify(published,null,2));
 console.log(JSON.stringify({mode,id:published.id,version:published.version,sha256:published.sha256,scope:'ordinary knowledge, not a Skill grant'}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)await main();
