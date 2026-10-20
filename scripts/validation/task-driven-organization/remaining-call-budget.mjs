// Acceptance-only spending guard. Does not modify ordinary product discussion semantics.
export function assertRemainingCall(sessionId,body,options){
 if(sessionId!==options.sessionId)return;
 const {inputRate,outputRate,allowance}=options;
 if(![inputRate,outputRate,allowance].every(n=>Number.isFinite(n)&&n>0)||!Number.isSafeInteger(body.max_tokens)||body.max_tokens<1)
  throw Error('invalid acceptance quote');
 const quote=((Buffer.byteLength(JSON.stringify(body))+1024)*inputRate+body.max_tokens*outputRate)/1e6;
 if(quote>allowance)throw Object.assign(Error('acceptance request exceeds remaining allowance; no model dispatch'),{code:'ACCEPTANCE_PLANNING_BUDGET',quote,allowance,modelDispatched:false});
 return quote;
}
