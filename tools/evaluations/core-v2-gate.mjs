import {resolve} from 'node:path';
import {hash,readBounded,toolRoot} from './files.mjs';
import {sourceIdentity,normalizeResults} from './report-manifest.mjs';
import {loadCoreDataset} from './core-v2-provider.mjs';
import {gradeCore} from './core-v2-assertion.mjs';
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
function validPendingRaw(row,c){
 const reason=`PENDING: ${c.reason}`,grade=row.gradingResult,components=grade?.componentResults;
 // Only a coherent ordinary assertion failure is pending; no transport or skip override.
 const unconflicted=node=>node&&typeof node==='object'&&
  (node.status===undefined||node.status==='fail')&&
  (node.skipped===undefined||node.skipped===false)&&(node.blocked===undefined||node.blocked===false);
 const failedGrade=node=>unconflicted(node)&&!Object.hasOwn(node,'error')&&node.pass===false&&node.score===0&&node.reason===reason&&
  (node.failureReason===undefined||node.failureReason===1);
 return unconflicted(row)&&row.success===false&&row.failureReason===1&&row.score===0&&
  (!Object.hasOwn(row,'error')||row.error===reason)&&unconflicted(row.response)&&!Object.hasOwn(row.response,'error')&&
  failedGrade(grade)&&Array.isArray(components)&&components.length===1&&failedGrade(components[0])&&
  components[0].componentResults===undefined;
}
function normalizeCoreRaw(raw){
 const rows=normalizeResults(raw);
 return rows.map((row,index)=>{
  const original=raw.results.results[index],c=loadCoreDataset().cases.find(c=>c.id===row.caseId);
  // Fixed Promptfoo also puts ordinary assertion failure reasons in error.
  if(c?.layer==='pending'&&validPendingRaw(original,c))return {...row,status:'fail'};
  return row;
 });
}
export function coreBindings(){
 return {dataset:hash(readBounded(resolve(toolRoot,'datasets/core-v2.json'))),criteria:hash(Buffer.concat(['core-v2-checks.mjs','core-v2-provider.mjs','core-v2-assertion.mjs','core-v2-gate.mjs','core-v2-run.mjs'].map(n=>readBounded(resolve(toolRoot,n))))),source:sourceIdentity(),evaluator:{version:'0.124.1',lockDigest:hash(readBounded(resolve(toolRoot,'package-lock.json')))}};
}
export function createCoreManifest(raw,bindings,{sourceStable=true}={}){
 return {schemaVersion:2,datasetId:'weiwu-core',datasetVersion:'2',evaluatedAt:new Date().toISOString(),executionKind:'product-function-and-pending',modelExecuted:false,fresh:false,bindings,sourceStable,rawDigest:hash(JSON.stringify(raw)),cases:normalizeCoreRaw(raw)};
}
export function checkCoreGate(m,raw,bindings,{requireLive=false}={}){
 const reasons=[],counts={passed:0,failed:0,pending:0};
 try{
  if(m.schemaVersion!==2||m.datasetId!=='weiwu-core'||m.datasetVersion!=='2'||!Number.isFinite(Date.parse(m.evaluatedAt))||m.executionKind!=='product-function-and-pending'||m.modelExecuted!==false||m.fresh!==false)throw Error('invalid-core-manifest');
  if(!bindings||!same(m.bindings,bindings))reasons.push('version-binding-mismatch');
  if(m.sourceStable!==true)reasons.push('source-changed-during-evaluation');
  if(m.rawDigest!==hash(JSON.stringify(raw)))throw Error('raw-digest-mismatch');
  const rows=normalizeCoreRaw(raw),cases=loadCoreDataset().cases;
  if(!same(m.cases,rows))throw Error('normalized-results-mismatch');
  if(rows.length!==32||new Set(rows.map(r=>r.caseId)).size!==32||!same(rows.map(r=>r.caseId).sort(),cases.map(c=>c.id).sort()))throw Error('required-case-set-mismatch');
  for(const [index,row] of rows.entries()){
   const c=cases.find(c=>c.id===row.caseId),e=row.evidence,g=gradeCore(e);
   if(e?.caseId!==row.caseId)throw Error('case-evidence-binding-mismatch');
   if(!Number.isFinite(row.score)||row.evaluatorCost!==0||row.providerCost!==0)throw Error('invalid-score-or-cost');
   if(c.layer==='pending'){
    counts.pending++;
    if(!validPendingRaw(raw.results.results[index],c))throw Error('invalid-pending-raw-result');
    if(e?.caseId!==c.id||e.datasetVersion!=='2'||e.status!=='pending'||e.executionKind!=='pending'||e.modelExecuted!==false||e.fresh!==false||e.inputDigest!==hash(JSON.stringify(c.input))||e.reason!==c.reason||!same(e.evidence,[])||Object.hasOwn(e,'actual')||row.status!=='fail'||row.score!==0||!g.reason.startsWith('PENDING:'))throw Error('pending-misrepresented');
   }else if(g.pass&&row.status==='pass'&&row.score===1)counts.passed++;
   else{counts.failed++;reasons.push(`case-failed:${c.id}`);}
  }
 }catch(e){reasons.push(e.message);}
 const integrity=reasons.length===0;
 return {integrity,complete:integrity&&counts.pending===0&&counts.failed===0&&!requireLive,counts,reasons:[...reasons,...(counts.pending?['pending-evidence-required']:[]),...(requireLive?['live-evidence-required']:[])],meaning:'Product-function checks on synthetic input only; pending is not passed; no fresh model quality or savings claim.'};
}
