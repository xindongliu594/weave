import {loadCoreDataset} from './core-v2-provider.mjs';
import {hash} from './files.mjs';
export function gradeCore(e){
 try{
  const c=loadCoreDataset().cases.find(c=>c.id===e.caseId);if(!c)throw Error('unknown-case');
  if(e.datasetVersion!=='2'||e.modelExecuted!==false||e.fresh!==false||e.executionKind!==c.layer||e.inputDigest!==hash(JSON.stringify(c.input)))throw Error('invalid-provenance');
  if(c.layer==='pending')return {pass:false,score:0,reason:'PENDING: '+c.reason};
  if(e.status!=='observed'||!Array.isArray(e.evidence)||e.evidence.length!==1||e.evidence[0].kind!=='product-return'||e.evidence[0].check!==c.check||e.evidence[0].inputDigest!==e.inputDigest||e.evidence[0].actualDigest!==hash(JSON.stringify(e.actual)))throw Error('missing-product-evidence');
  const pass=JSON.stringify(e.actual)===JSON.stringify(c.oracle.equals);
  return {pass,score:pass?1:0,reason:pass?'Product function matches independent oracle; synthetic input, no model':'Product function oracle mismatch'};
 }catch(e){return {pass:false,score:0,reason:e.message};}
}
export default output=>{try{return gradeCore(typeof output==='string'?JSON.parse(output):output);}catch(e){return {pass:false,score:0,reason:e.message};}};
