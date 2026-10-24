// This adapter accepts persistence-owned inputs, never a raw HTTP DTO. It reads
// selected own data descriptors only; ignored bodies are never traversed.
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const actors=new Set(['human','local-owner','device','system','unidentified']);
const outcomes=new Set(['success','denied','failure','unknown']);
const reasons=new Set(['unauthenticated','forbidden','csrf-invalid','invalid-request','authority-revoked','conflict','not-found','storage-unavailable','execution-failed','result-unknown','existing-administration','disabled-bootstrap-identity','legacy-reason-unclassified']);
export const observationPhases=Object.freeze(['working','executing_tool','waiting_model','waiting_approval','waiting_capacity','waiting_coordinator','idle_unfinished']);
const phases=new Set(observationPhases);
const auditActions=['identity.mode.activated','identity.bootstrap','identity.bootstrap.closed','identity.login','identity.logout','identity.user.updated','identity.sessions.revoked','identity.membership.updated','identity.membership.removed','project.plan','department.configure','employee.restore','project.message','file.create','project.approve','run.cancel','run.recover','run.authority','tool.approval','tool.dispatch','tool.result','tool.reconcile','task.merge','budget.policy.updated','knowledge.publish','knowledge.withdraw','capability.configure','device.configure','model.configure','backup.create','backup.restore','storage.cleanup','audit.read','audit.export'];
const traceNames=Object.freeze({'run/created':'run.created','run/finished':'run.finished','tool/start':'tool.started','tool/result':'tool.result','runtime/operation-start':'operation.started','runtime/operation-finished':'operation.finished','runtime/operation-failed':'operation.failed','runtime/outcome-unknown':'operation.unknown','billing/usage':'billing.usage','billing/unconfirmed':'billing.unknown','runtime/status':'runtime.status','runtime/anomaly':'runtime.anomaly','task/merge-committed':'task.merge','team/checkpoint':'task.checkpoint','handoff/accepted':'task.accepted'});
export const observationNames=Object.freeze([...Object.values(traceNames),...auditActions.map(action=>'audit.'+action)]);
const names=new Set(observationNames),auditNames=new Set(auditActions);
const correlationKeys=Object.freeze(['correlationId','requestId','modelRequestId','projectId','runId','taskId','attemptId','operationId','parentOperationId','approvalId','mergeId']);
const fields=new Set(['schema','sourceEventId','at','name','correlation','actorKind','outcome','reasonCode','phase','durationMs','inputTokens','outputTokens','confirmedCost','costUnknown','capabilityId','capabilityVersion','capabilitySha256']);
function record(value){if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw Error('OBSERVATION_INVALID');return value;}
function get(value,key){if(value===undefined||value===null)return undefined;const descriptor=Object.getOwnPropertyDescriptor(record(value),key);if(!descriptor)return undefined;if(!Object.hasOwn(descriptor,'value'))throw Error('OBSERVATION_INVALID');return descriptor.value;}
const safeId=value=>typeof value==='string'&&uuid.test(value);
const number=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=Number.MAX_SAFE_INTEGER;
const instant=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
export function observationCorrelation(value){
 try{if(value==null)return Object.freeze({});record(value);if(Reflect.ownKeys(value).length>16)return Object.freeze({});const result={};for(const key of correlationKeys){const selected=get(value,key);if(safeId(selected))result[key]=selected;}return Object.freeze(result);}catch{return Object.freeze({});}
}
export function validateObservationSummary(input){
 try{
  record(input);const keys=Reflect.ownKeys(input);if(keys.length>fields.size||keys.some(key=>!fields.has(key)))return null;
  const out={};for(const key of keys){const value=get(input,key);if(value===undefined)return null;out[key]=value;}
  if(out.schema!==1||!names.has(out.name)||!instant(out.at)||typeof out.sourceEventId!=='string'||out.sourceEventId.length>128)return null;
  const id=out.sourceEventId;if(id.startsWith('audit:')){if(!safeId(id.slice(6))||!out.name.startsWith('audit.'))return null;}
  else{const match=/^trace:([^:]+):([1-9]\d*)$/.exec(id);if(!match||!safeId(match[1])||!Number.isSafeInteger(Number(match[2]))||out.name.startsWith('audit.'))return null;}
  record(out.correlation);const correlation={};for(const key of Reflect.ownKeys(out.correlation)){if(!correlationKeys.includes(key))return null;const value=get(out.correlation,key);if(!safeId(value))return null;correlation[key]=value;}
  if(id.startsWith('trace:')&&correlation.runId!==id.split(':')[1])return null;
  out.correlation=Object.freeze(correlation);
  for(const [key,set] of [['actorKind',actors],['outcome',outcomes],['reasonCode',reasons],['phase',phases]])if(key in out&&!set.has(out[key]))return null;
  for(const key of ['durationMs','inputTokens','outputTokens','confirmedCost'])if(key in out&&(!number(out[key])||key.endsWith('Tokens')&&!Number.isSafeInteger(out[key])))return null;
  if('costUnknown' in out&&typeof out.costUnknown!=='boolean')return null;
  if('capabilityId' in out&&!safeId(out.capabilityId))return null;
  if('capabilityVersion' in out&&(typeof out.capabilityVersion!=='string'||!/^\d{1,10}(?:\.\d{1,10}){0,2}$/.test(out.capabilityVersion)))return null;
  if('capabilitySha256' in out&&(typeof out.capabilitySha256!=='string'||!/^\w{64}$/.test(out.capabilitySha256)||!/^[a-f0-9]+$/.test(out.capabilitySha256)))return null;
  if(keys.length-1+Object.keys(correlation).length>32||Object.values(out).some(value=>typeof value==='string'&&value.length>128)||Buffer.byteLength(JSON.stringify(out))>4096)return null;
  return Object.freeze(out);
 }catch{return null;}
}
export function summarizeObservation(source){
 try{
  const kind=get(source,'kind');let out;
  if(kind==='audit'){
   const p=get(source,'projection'),action=get(p,'action');if(!auditNames.has(action))return null;
   const id=get(p,'sourceEventId');if(!safeId(id))return null;
   out={schema:1,sourceEventId:'audit:'+id,at:get(p,'occurredAt'),name:'audit.'+action,correlation:observationCorrelation(get(p,'correlation'))};
   const actor=get(get(p,'actor'),'kind'),outcome=get(p,'outcome'),reason=get(p,'reasonCode');
   if(actors.has(actor))out.actorKind=actor;if(outcomes.has(outcome))out.outcome=outcome;if(reasons.has(reason))out.reasonCode=reason;
  }else if(kind==='trace'){
   const event=get(source,'event'),type=get(event,'type');if(typeof type!=='string'||!Object.hasOwn(traceNames,type))return null;
   const runId=get(source,'runId'),seq=get(event,'seq');if(!safeId(runId)||!Number.isSafeInteger(seq)||seq<1)return null;
   out={schema:1,sourceEventId:`trace:${runId}:${seq}`,at:get(event,'at'),name:traceNames[type],correlation:{...observationCorrelation(get(source,'correlation')),runId}};
   const data=get(event,'data');
   switch(type){
    case 'run/finished': {const status=get(data,'status');if(status==='completed')out.outcome='success';else if(['failed','cancelled'].includes(status))out.outcome='failure';break;}
    case 'tool/result': {const error=get(get(data,'result'),'isError');if(typeof error==='boolean')out.outcome=error?'failure':'success';break;}
    // The existing device adapter also uses finished for known-not-executed.
    // It is lifecycle evidence, not a confirmed successful effect receipt.
    case 'runtime/operation-finished':break;
    case 'runtime/operation-failed':out.outcome='failure';break;
    case 'runtime/outcome-unknown':out.outcome='unknown';break;
    case 'billing/unconfirmed':out.costUnknown=true;break;
    case 'billing/usage':for(const key of ['inputTokens','outputTokens','durationMs']){const value=get(data,key);if(number(value)&&(!key.endsWith('Tokens')||Number.isSafeInteger(value)))out[key]=value;}break;
    case 'runtime/anomaly': {out.outcome='failure';const phase=get(data,'phase');if(phases.has(phase))out.phase=phase;break;}
    case 'runtime/status': {const employees=get(data,'employees');if(Array.isArray(employees)&&employees.length===1){const item=Object.getOwnPropertyDescriptor(employees,'0');if(item&&Object.hasOwn(item,'value')){const phase=get(item.value,'phase');if(phases.has(phase))out.phase=phase;}}break;}
   }
  }else return null;
  return validateObservationSummary(out);
 }catch{return null;}
}
