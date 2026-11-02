import {Worker} from 'node:worker_threads';
import {validateObservationSummary} from '../../../services/agent-runtime/observation-summary.mjs';

let active=false;
type ExportState='disabled'|'invalid-configuration'|'starting'|'enabled'|'degraded'|'closed';
const plus=(a:number,b=1)=>Math.min(Number.MAX_SAFE_INTEGER,a+b);
function configuration(env:Record<string,string|undefined>){
 if(env.WEIWU_TELEMETRY_ENABLED===undefined||env.WEIWU_TELEMETRY_ENABLED==='0')return {state:'disabled' as const};
 try{
  if(env.WEIWU_TELEMETRY_ENABLED!=='1'||Object.keys(env).some(key=>key.toUpperCase().startsWith('OTEL_')&&env[key]!==undefined))throw Error();
  const value=env.WEIWU_TELEMETRY_ENDPOINT;if(!value||value.length>2048)throw Error();const url=new URL(value);
  if(!['http:','https:'].includes(url.protocol)||!['127.0.0.1','[::1]'].includes(url.hostname)||url.pathname!=='/v1/logs'||url.username||url.password||url.search||url.hash||value!==url.href)throw Error();
  return {state:'starting' as const,endpoint:url.href};
 }catch{return {state:'invalid-configuration' as const};}
}

/** Process-local best-effort copy; never an execution, billing or audit authority. */
export function createObservationExporter(env:Record<string,string|undefined>=process.env){
 const config=configuration(env);let state:ExportState=config.state,configured=false,closed=false,worker:Worker|undefined,closing:Promise<void>|undefined;
 let exportAccepted=0,exportedFailure=0,exportedUnknown=0,transportAcknowledged=0,sanitizeRejected=0,queueFull=0,unavailable=0,disabled=0,closedUnconfirmed=0,timedOut=0,pendingBytes=0,sequence=0;
 let lastErrorCode:string|null=config.state==='invalid-configuration'?'OBSERVATION_EXPORT_CONFIG_INVALID':null,lastSuccessAt:string|null=null,lastFailureAt:string|null=null;
 const pending=new Map<number,number>();let finishClose:(()=>void)|undefined;
 const fail=(code:string)=>{lastErrorCode=code;lastFailureAt=new Date().toISOString();if(!closed)state='degraded';};
 const unconfirm=()=>{closedUnconfirmed=plus(closedUnconfirmed,pending.size);exportedUnknown=plus(exportedUnknown,pending.size);pending.clear();pendingBytes=0;};
 if(config.endpoint){
  if(active)fail('OBSERVATION_EXPORT_ALREADY_ACTIVE');
  else try{
   worker=new Worker(new URL('./observation-exporter-worker.mjs',import.meta.url),{workerData:{endpoint:config.endpoint},env:{},execArgv:[],stdout:true,stderr:true,resourceLimits:{maxOldGenerationSizeMb:64}});
   active=true;configured=true;worker.stdout?.resume();worker.stderr?.resume();
   worker.on('message',(message:{kind:string;ids?:number[];success?:boolean})=>{
    if(message.kind==='ready'){if(!closed)state='enabled';return;}
    if(message.kind==='closed'){finishClose?.();return;}
    if(message.kind==='timeout'){timedOut=plus(timedOut);fail('OBSERVATION_EXPORT_TIMEOUT');return;}
    if(message.kind==='failed'){fail('OBSERVATION_EXPORT_WORKER_FAILED');return;}
    if(message.kind!=='result'||!Array.isArray(message.ids))return;
    let count=0;for(const id of message.ids){const bytes=pending.get(id);if(bytes===undefined)continue;pending.delete(id);pendingBytes-=bytes;count++;}
    if(!count)return;
    if(message.success){transportAcknowledged=plus(transportAcknowledged,count);exportedUnknown=plus(exportedUnknown,count);lastSuccessAt=new Date().toISOString();if(!closed){state='enabled';lastErrorCode=null;}}
    else{exportedFailure=plus(exportedFailure,count);fail('OBSERVATION_EXPORT_FAILED');}
   });
   worker.on('error',()=>{fail('OBSERVATION_EXPORT_WORKER_FAILED');});
   worker.on('exit',()=>{worker=undefined;active=false;unconfirm();if(!closed)fail('OBSERVATION_EXPORT_WORKER_EXITED');finishClose?.();});
   worker.unref();
  }catch{fail('OBSERVATION_EXPORT_WORKER_FAILED');}
 }
 return {
  offer(input:unknown):boolean{
   if(closed)return false;const summary=validateObservationSummary(input);if(!summary){sanitizeRejected=plus(sanitizeRejected);return false;}
   if(!configured){if(state==='disabled')disabled=plus(disabled);else unavailable=plus(unavailable);return false;}
   if(!worker||state==='degraded'&&lastErrorCode?.startsWith('OBSERVATION_EXPORT_WORKER')){unavailable=plus(unavailable);return false;}
   const bytes=Buffer.byteLength(JSON.stringify(summary));if(pending.size>=256||pendingBytes+bytes>1048576){queueFull=plus(queueFull);return false;}
   const id=++sequence;pending.set(id,bytes);pendingBytes+=bytes;
   try{worker.postMessage({kind:'offer',id,summary});exportAccepted=plus(exportAccepted);return true;}
   catch{pending.delete(id);pendingBytes-=bytes;unavailable=plus(unavailable);fail('OBSERVATION_EXPORT_WORKER_FAILED');return false;}
  },
  snapshot(){return {state,configured,exportAccepted,exportedSuccess:0,exportedFailure,exportedUnknown,transportAcknowledged,sanitizeRejected,queueFull,unavailable,disabled,closedUnconfirmed,timedOut,dropped:plus(sanitizeRejected,plus(queueFull,unavailable)),pendingRecords:pending.size,pendingBytes,lastSuccessAt,lastFailureAt,lastErrorCode};},
  close():Promise<void>{
   if(closing)return closing;closed=true;state='closed';
   closing=(async()=>{if(!worker)return;const owned=worker;let timer:ReturnType<typeof setTimeout>|undefined;
    // Reserve 100 ms of the 3-second close budget for isolate termination.
    const done=new Promise<void>(resolve=>{finishClose=resolve;timer=setTimeout(()=>{fail('OBSERVATION_EXPORT_CLOSE_TIMEOUT');resolve();},2900);});
    try{owned.postMessage({kind:'close'});await done;}catch{fail('OBSERVATION_EXPORT_WORKER_FAILED');}
    finally{if(timer)clearTimeout(timer);await owned.terminate().catch(()=>{});unconfirm();worker=undefined;}
   })();return closing;
  }
 };
}
