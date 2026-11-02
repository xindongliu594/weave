import {parentPort,workerData} from 'node:worker_threads';
import {createRequire} from 'node:module';

// A separate isolate keeps SDK diagnostics/collector response text out of DSH's global handlers.
const require=createRequire(new URL('../../../services/agent-runtime/package.json',import.meta.url));
const scalarFields={schema:'schema',sourceEventId:'source_event_id',actorKind:'actor_kind',outcome:'outcome',reasonCode:'reason_code',phase:'phase',durationMs:'duration_ms',inputTokens:'input_tokens',outputTokens:'output_tokens',confirmedCost:'confirmed_cost',costUnknown:'cost_unknown',capabilityId:'capability_id',capabilityVersion:'capability_version',capabilitySha256:'capability_sha256'};
const correlationFields={correlationId:'correlation_id',requestId:'request_id',modelRequestId:'model_request_id',projectId:'project_id',runId:'run_id',taskId:'task_id',attemptId:'attempt_id',operationId:'operation_id',parentOperationId:'parent_operation_id',approvalId:'approval_id',mergeId:'merge_id'};
function attributes(summary){
 const selected={};
 for(const [source,target] of Object.entries(scalarFields))if(summary[source]!==undefined)selected['weiwu.'+target]=summary[source];
 for(const [source,target] of Object.entries(correlationFields))if(summary.correlation[source]!==undefined)selected['weiwu.'+target]=summary.correlation[source];
 return selected;
}
try{
 const {LoggerProvider,BatchLogRecordProcessor}=require('@opentelemetry/sdk-logs');
 const {OTLPLogExporter}=require('@opentelemetry/exporter-logs-otlp-http');
 const {resourceFromAttributes}=require('@opentelemetry/resources');
 const transport=new OTLPLogExporter({url:workerData.endpoint,headers:{},timeoutMillis:2000,concurrencyLimit:1,compression:'none',httpAgentOptions:{keepAlive:false,maxSockets:1},userAgent:'weiwu-summary'});
 const ids=new WeakMap();let currentId,closed=false;
 const exporter={
  export(records,callback){
   const batchIds=records.map(record=>ids.get(record));let completed=false;
   const timer=setTimeout(()=>parentPort.postMessage({kind:'timeout'}),2000);timer.unref();
   const finish=result=>{if(completed)return;completed=true;clearTimeout(timer);parentPort.postMessage({kind:'result',ids:batchIds,success:result.code===0});callback({code:result.code===0?0:1,...(result.code===0?{}:{error:new Error('OBSERVATION_EXPORT_FAILED')})});};
   try{transport.export(records,finish);}catch{finish({code:1});}
  },
  forceFlush:()=>transport.forceFlush(),shutdown:()=>transport.shutdown()
 };
 const mapping={onEmit(record){ids.set(record,currentId);},forceFlush:async()=>{},shutdown:async()=>{}};
 const batch=new BatchLogRecordProcessor({exporter,maxQueueSize:256,maxExportBatchSize:32,scheduledDelayMillis:1000,exportTimeoutMillis:2000});
 const version=createRequire(import.meta.url)('../../../package.json').version;
 if(typeof version!=='string'||!version||version.length>128)throw Error('OBSERVATION_EXPORT_VERSION_INVALID');
 const provider=new LoggerProvider({resource:resourceFromAttributes({'service.name':'weiwu','service.version':version}),processors:[mapping,batch],forceFlushTimeoutMillis:2000,logRecordLimits:{attributeCountLimit:32,attributeValueLengthLimit:128}});
 const logger=provider.getLogger('weiwu.observation','1');
 parentPort.on('message',async message=>{
  if(message.kind==='offer'&&!closed){try{currentId=message.id;logger.emit({timestamp:new Date(message.summary.at),eventName:message.summary.name,body:message.summary.name,attributes:attributes(message.summary)});}catch{parentPort.postMessage({kind:'result',ids:[message.id],success:false});}return;}
  if(message.kind==='close'&&!closed){closed=true;try{await provider.shutdown();}catch{parentPort.postMessage({kind:'failed'});}finally{parentPort.postMessage({kind:'closed'});parentPort.close();}}
 });
 parentPort.postMessage({kind:'ready'});
}catch{parentPort.postMessage({kind:'failed'});parentPort.close();}
