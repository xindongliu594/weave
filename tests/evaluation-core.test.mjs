import test from 'node:test';
import assert from 'node:assert/strict';
import {loadCoreDataset, CoreProvider} from '../tools/evaluations/core-v2-provider.mjs';
import {gradeCore} from '../tools/evaluations/core-v2-assertion.mjs';
import {coreBindings, createCoreManifest, checkCoreGate} from '../tools/evaluations/core-v2-gate.mjs';
import {buildCoreConfig,runCore} from '../tools/evaluations/core-v2-run.mjs';

test('core runner only builds controlled offline config and rejects execution and paths',async()=>{
 const config=buildCoreConfig(process.cwd());assert.equal(config.providers.length,1);assert.equal(config.tests.length,32);
 assert.equal(config.sharing,false);assert.equal(config.evaluateOptions.maxConcurrency,1);
 await assert.rejects(runCore({mode:'execute'}),/LIVE_AUTHORIZATION_REQUIRED/);
 await assert.rejects(runCore({outputDir:'.private/outside'}),/unsafe-output-path/);
});

test('core declares 32 unique cases, seven dimensions, concrete pending contracts',()=>{
 const d=loadCoreDataset();assert.equal(d.cases.length,32);assert.equal(new Set(d.cases.map(c=>c.id)).size,32);
 assert.deepEqual(Object.values(Object.groupBy(d.cases,c=>c.dimension)).map(a=>a.length),[4,8,4,4,4,4,4]);
 assert.equal(d.cases.filter(c=>c.layer==='pending').length,9);
 for(const c of d.cases){assert.ok(c.input);assert.ok(c.oracle);assert.ok(c.requiredEvidence.length);}
});
test('product functions run; pending never passes; case oracle cannot be replaced by caller',async()=>{
 const p=new CoreProvider();let passed=0,pending=0;
 for(const c of loadCoreDataset().cases){const e=JSON.parse((await p.callApi(c.id)).output),g=gradeCore(e);if(e.status==='pending'){pending++;assert.equal(g.pass,false);}else{assert.equal(g.pass,true,`${c.id}: ${g.reason}`);passed++;}}
 assert.equal(passed,23);assert.equal(pending,9);
 const c=loadCoreDataset().cases[0],e=JSON.parse((await p.callApi(c.id)).output);e.actual='forged';assert.equal(gradeCore(e).pass,false);
 assert.ok((await new CoreProvider({config:{mode:'product-function',basePath:process.cwd()}}).callApi(c.id)).output,'Promptfoo injects basePath metadata');
 await assert.rejects(new CoreProvider({config:{mode:'execute'}}).callApi(c.id),/LIVE_AUTHORIZATION_REQUIRED/);
});
test('core complete gate refuses pending and tampering; integrity verifies all raw results',async()=>{
 const p=new CoreProvider(),results=[];
 for(const c of loadCoreDataset().cases){const response=await p.callApi(c.id),g=gradeCore(JSON.parse(response.output));results.push({vars:{caseId:c.id},response,success:g.pass,failureReason:g.pass?0:1,score:g.score,cost:0,gradingResult:{...g,componentResults:[g]}});}
 const raw={results:{results}},bindings=coreBindings(),m=createCoreManifest(raw,bindings),gate=checkCoreGate(m,raw,bindings);
 assert.equal(gate.integrity,true);assert.equal(gate.complete,false);assert.equal(gate.counts.pending,9);assert.equal(gate.counts.passed,23);assert.equal(gate.counts.failed,0);
 const cliShape=structuredClone(raw);for(const row of cliShape.results.results)if(!row.success)row.error=row.gradingResult.reason;
 assert.equal(checkCoreGate(createCoreManifest(cliShape,bindings),cliShape,bindings).integrity,true,'Promptfoo assertion failures carry error text, pending is not a transport error');
 const conflictingPending=[
  ['unknown status',r=>{r.status='mystery';}],['skipped',r=>{r.skipped=true;}],['blocked',r=>{r.blocked=true;}],
  ['response skipped',r=>{r.response.skipped=true;}],['response blocked',r=>{r.response.blocked=true;}],
  ['response error',r=>{r.response.error='transport failed';}],['response unknown status',r=>{r.response.status='mystery';}],
  ['grading error',r=>{r.gradingResult.error='judge failed';}],['component error',r=>{r.gradingResult.componentResults[0].error='judge failed';}],
  ['grading skipped',r=>{r.gradingResult.skipped=true;}],['component blocked',r=>{r.gradingResult.componentResults[0].blocked=true;}],
  ['grading unknown status',r=>{r.gradingResult.status='mystery';}],['component unknown status',r=>{r.gradingResult.componentResults[0].status='mystery';}],
  ['missing grading',r=>{delete r.gradingResult;}],['grading pass',r=>{r.gradingResult.pass=true;}],
  ['grading score',r=>{r.gradingResult.score=1;}],['grading reason',r=>{r.gradingResult.reason='unrelated failure';}],
  ['component pass',r=>{r.gradingResult.componentResults[0].pass=true;}],['component score',r=>{r.gradingResult.componentResults[0].score=1;}],
  ['component reason',r=>{r.gradingResult.componentResults[0].reason='unrelated failure';}],['missing component',r=>{r.gradingResult.componentResults=[];}],
  ['raw transport failure',r=>{r.failureReason=2;}],['component transport failure',r=>{r.gradingResult.componentResults[0].failureReason=2;}],
  ['wrong raw error',r=>{r.error='transport failed';}],
 ];
 const acceptedConflicts=[];
 for(const [shape,base] of [['without error',raw],['with error',cliShape]])for(const [label,mutate] of conflictingPending){
  const changed=structuredClone(base),pending=changed.results.results.find(r=>JSON.parse(r.response.output).status==='pending');mutate(pending);
  if(checkCoreGate(createCoreManifest(changed,bindings),changed,bindings).integrity)acceptedConflicts.push(`${shape}: ${label}`);
 }
 assert.deepEqual(acceptedConflicts,[],'pending requires consistent raw status, provenance and grading even after rehashing');
 assert.equal(checkCoreGate(m,raw,bindings,{requireLive:true}).complete,false);
 for(const mutate of [r=>r.results.results.pop(),r=>r.results.results.push(r.results.results[0]),r=>{r.results.results[0].response.output='{}';},r=>{r.results.results[0].score=NaN;}]){const r=structuredClone(raw);mutate(r);assert.equal(checkCoreGate(m,r,bindings).integrity,false);}
 for(const mutate of [x=>{x.bindings.dataset='0'.repeat(64);},x=>{x.cases[0].fresh=true;},x=>{x.cases[0].evidence=[];},x=>{x.sourceStable=false;}]){const x=structuredClone(m);mutate(x);assert.equal(checkCoreGate(x,raw,bindings).complete,false);assert.equal(checkCoreGate(x,raw,bindings).integrity,false);}
 const allGreen=structuredClone(raw);for(const r of allGreen.results.results){r.success=true;r.score=1;r.failureReason=0;r.gradingResult={pass:true,score:1,componentResults:[{pass:true,score:1}]};}
 assert.equal(checkCoreGate(createCoreManifest(allGreen,bindings),allGreen,bindings).integrity,false);
 const swapped=structuredClone(raw);swapped.results.results[4].response=swapped.results.results[5].response;
 assert.equal(checkCoreGate(createCoreManifest(swapped,bindings),swapped,bindings).integrity,false,'case evidence cannot be borrowed from another passing case');
});
