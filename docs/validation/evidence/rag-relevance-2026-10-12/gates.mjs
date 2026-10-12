import assert from 'node:assert/strict';
export function applyGate(hits,threshold){
  assert.ok(Number.isFinite(threshold)&&threshold>=0&&threshold<=1,'Invalid threshold');
  assert.ok(hits.every(h=>Number.isFinite(h.score)),'Scores must be finite');
  return hits.filter(h=>h.score>=threshold).slice(0,3);
}
export const relevant=(row,example)=>example.expected.includes(row.documentId)&&(!example.requiredText||row.content.includes(example.requiredText));
export function chooseThreshold(examples){
  const positive=examples.filter(e=>e.expected.length),negative=examples.filter(e=>!e.expected.length);
  assert.ok(positive.length&&negative.length,'Both calibration classes are required');
  const values=[...new Set(examples.flatMap(e=>e.hits.map(h=>h.score)).filter(s=>s>=0&&s<=1))].sort((a,b)=>a-b);
  const thresholds=[0,1,...values.slice(1).map((v,i)=>(v+values[i])/2)];
  let best;
  for(const threshold of thresholds){
    const rows=examples.map(e=>({e,hits:applyGate(e.hits,threshold)}));
    const top1=rows.filter(({e,hits})=>e.expected.length&&hits[0]&&relevant(hits[0],e)).length/positive.length;
    const specificity=rows.filter(({e,hits})=>!e.expected.length&&!hits.length).length/negative.length;
    const recall=rows.filter(({e,hits})=>e.expected.length&&hits.some(h=>relevant(h,e))).length/positive.length;
    const irrelevant=rows.reduce((n,{e,hits})=>n+hits.filter(h=>!relevant(h,e)).length,0);
    const candidate={threshold,balancedAccuracy:(top1+specificity)/2,top1,specificity,recall,irrelevant};
    if(!best||candidate.balancedAccuracy>best.balancedAccuracy||candidate.balancedAccuracy===best.balancedAccuracy&&(candidate.recall>best.recall||candidate.recall===best.recall&&(candidate.irrelevant<best.irrelevant||candidate.irrelevant===best.irrelevant&&candidate.threshold>best.threshold)))best=candidate;
  }
  return best;
}
