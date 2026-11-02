import {fixtureFile,readJson,hash} from './files.mjs';
import {runProductCheck} from './core-v2-checks.mjs';
export function loadCoreDataset(){
 const d=readJson(fixtureFile('core-v2.json'));
 if(d.id!=='weiwu-core'||d.version!=='2'||d.cases?.length!==32||new Set(d.cases.map(c=>c.id)).size!==32)throw Error('invalid-core-dataset');
 return d;
}
export default class CoreProvider{
 constructor(options={}){this.config=options.config??{};}
 id(){return 'weiwu:product-function:core-v2';}
 async callApi(prompt,context={}){
  if(this.config.mode==='execute')throw Error('LIVE_AUTHORIZATION_REQUIRED');
  // Promptfoo 0.124.1 injects basePath metadata; it never selects inputs here.
  if(Object.keys(this.config).some(k=>!['mode','basePath'].includes(k))||this.config.mode&&this.config.mode!=='product-function')throw Error('controlled-core-provider-required');
  const c=loadCoreDataset().cases.find(c=>c.id===(context.vars?.caseId??prompt));if(!c)throw Error('unknown-core-case');
  const e={caseId:c.id,datasetVersion:'2',executionKind:c.layer,modelExecuted:false,fresh:false,inputDigest:hash(JSON.stringify(c.input)),status:c.layer==='pending'?'pending':'observed',evidence:[]};
  if(c.layer==='pending')e.reason=c.reason;
  else{e.actual=runProductCheck(c);e.evidence=[{kind:'product-return',check:c.check,inputDigest:e.inputDigest,actualDigest:hash(JSON.stringify(e.actual))}];}
  return {output:JSON.stringify(e),cost:0,tokenUsage:{total:0,prompt:0,completion:0}};
 }
}
export {CoreProvider};
