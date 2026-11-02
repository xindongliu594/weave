import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {Worker} from 'node:worker_threads';
import {createRequire} from 'node:module';
import {createObservability} from '../apps/api/src/observability.ts';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {createObservationExporter} from '../apps/api/src/observation-exporter.ts';
import {createRunArchive} from '../services/agent-runtime/trace-store.mjs';

const summary=(outcome:'success'|'failure'|'unknown'='success')=>({schema:1,sourceEventId:'audit:'+randomUUID(),at:new Date().toISOString(),name:'audit.tool.result',correlation:{},outcome});
const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check:()=>boolean){const end=Date.now()+8000;while(!check()){assert.ok(Date.now()<end,'condition reached before deadline');await delay(20);}}
async function receiver(run:(url:string,bodies:string[],mode:{value:string})=>Promise<void>){
 const bodies:string[]=[],mode={value:'ok'};
 const server=createServer((req,res)=>{const chunks:Buffer[]=[];req.on('data',c=>chunks.push(c));req.on('end',()=>{bodies.push(Buffer.concat(chunks).toString());if(mode.value==='stall')return;if(mode.value==='trickle'){res.writeHead(200);const timer=setInterval(()=>res.write(' '),50);res.on('close',()=>clearInterval(timer));return;}if(mode.value==='reset'){req.socket.destroy();return;}res.statusCode=['429','503'].includes(mode.value)?Number(mode.value):200;res.setHeader('content-type','application/json');res.end(mode.value==='partial'?JSON.stringify({partialSuccess:{rejectedLogRecords:1,errorMessage:'collector-private-secret'}}):mode.value==='malformed'?'collector-private-secret':'{}');});});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert.ok(address&&typeof address!=='string');
 try{await run(`http://127.0.0.1:${address.port}/v1/logs`,bodies,mode);}finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
}
const env=(url:string)=>({WEIWU_TELEMETRY_ENABLED:'1',WEIWU_TELEMETRY_ENDPOINT:url});
const scalarAttributes=(attributes:{key:string;value:Record<string,unknown>}[])=>Object.fromEntries(attributes.map(({key,value})=>[key,Object.values(value)[0]]));

test('review: an already exited worker closes promptly and preserves its true error',async t=>{
 const sink=createObservationExporter(env('http://127.0.0.1:1/v1/logs'));
 const original=Worker.prototype.postMessage;
 const intercept=t.mock.method(Worker.prototype,'postMessage',function(this:Worker,message:unknown,transferList?:Parameters<Worker['postMessage']>[1]){
  if((message as {kind?:string}).kind==='offer'){void this.terminate();return;}
  return original.call(this,message,transferList);
 });
 try{assert.equal(sink.offer(summary()),true);intercept.mock.restore();await until(()=>sink.snapshot().lastErrorCode==='OBSERVATION_EXPORT_WORKER_EXITED');
  const before=sink.snapshot(),started=Date.now();await Promise.all([sink.close(),sink.close()]);const closeMs=Date.now()-started;
  assert.ok(closeMs<300,`already exited close: ${closeMs} ms`);assert.equal(sink.snapshot().lastErrorCode,before.lastErrorCode);assert.equal(sink.snapshot().closedUnconfirmed,1);assert.equal(sink.offer(summary()),false);
  t.diagnostic(JSON.stringify({alreadyExitedCloseMs:closeMs,health:sink.snapshot()}));
 }finally{intercept.mock.restore();await sink.close();}
});

test('review: collector receives fixed bodies, allowlisted scalar correlation attributes and service metadata',async()=>receiver(async(url,bodies)=>{
 const sink=createObservationExporter(env(url));const correlation={correlationId:randomUUID(),runId:randomUUID(),requestId:randomUUID()};
 const inputs=(['success','failure','unknown'] as const).map(outcome=>({...summary(outcome),correlation,durationMs:12,inputTokens:7,costUnknown:outcome==='unknown',capabilityVersion:'1.2.3'}));
 try{for(const input of inputs)assert.equal(sink.offer(input),true);await until(()=>sink.snapshot().transportAcknowledged===3);
  const resources=bodies.flatMap(body=>JSON.parse(body).resourceLogs);assert.ok(resources.length>0);
  for(const resource of resources){const metadata=scalarAttributes(resource.resource.attributes);assert.deepEqual(metadata,{'service.name':'weiwu','service.version':createRequire(import.meta.url)('../package.json').version});}
  const records=resources.flatMap(resource=>resource.scopeLogs.flatMap((scope:{logRecords:unknown[]})=>scope.logRecords));assert.equal(records.length,3);
  for(let i=0;i<records.length;i++){const record=records[i],attributes=scalarAttributes(record.attributes);assert.equal(record.body.stringValue,'audit.tool.result');assert.equal(record.eventName,'audit.tool.result');
   assert.equal(attributes['weiwu.source_event_id'],inputs[i].sourceEventId);assert.equal(attributes['weiwu.correlation_id'],correlation.correlationId);assert.equal(attributes['weiwu.run_id'],correlation.runId);assert.equal(attributes['weiwu.request_id'],correlation.requestId);assert.equal(attributes['weiwu.outcome'],inputs[i].outcome);assert.equal(Number(attributes['weiwu.duration_ms']),12);assert.equal(Number(attributes['weiwu.input_tokens']),7);assert.equal(attributes['weiwu.cost_unknown'],inputs[i].costUnknown);assert.equal(attributes['weiwu.capability_version'],'1.2.3');
   assert.ok(Object.keys(attributes).length<=32);assert.ok(Object.values(attributes).every(value=>['string','number','boolean'].includes(typeof value)));assert.equal(record.traceId,undefined);assert.equal(record.spanId,undefined);
  }
 }finally{await sink.close();}
}));

test('disabled and invalid configurations construct no transport and expose only fixed codes',async()=>receiver(async(url,bodies)=>{
 for(const config of [{},{OTEL_EXPORTER_OTLP_ENDPOINT:url},{WEIWU_TELEMETRY_ENABLED:'yes'},env(url+'?token=private'),env(url+'#private'),env(url.replace('http://','http://private:private@')),env('https://example.com/v1/logs'),{...env(url),OTEL_RESOURCE_ATTRIBUTES:'secret=private'},{...env(url),OTEL_EXPORTER_OTLP_HEADERS:'authorization=private'},env(url.replace('/v1/logs','/other')),env(url.replace('127.0.0.1','localhost'))]){
  const sink=createObservationExporter(config);assert.equal(sink.offer(summary()),false);assert.equal(sink.snapshot().configured,false);assert.equal(sink.snapshot().pendingRecords,0);assert.ok(!JSON.stringify(sink.snapshot()).includes('private'));await sink.close();
 }assert.equal(bodies.length,0);
}));

test('strict allowlist exports fresh terminal outcomes; transport acknowledgement is final-delivery unknown',async()=>receiver(async(url,bodies)=>{
 const sink=createObservationExporter(env(url));try{
  let touched=false;const malicious={...summary(),get prompt(){touched=true;return 'prompt-private-secret';}};
  assert.equal(sink.offer(malicious),false);assert.equal(touched,false);
  assert.equal(sink.offer({...summary(),correlation:{userId:'identity-private-secret'}}),false);
  for(const outcome of ['success','failure','unknown'] as const)assert.equal(sink.offer(summary(outcome)),true);
  await until(()=>sink.snapshot().transportAcknowledged===3);
  const health=sink.snapshot();assert.equal(health.exportedSuccess,0);assert.equal(health.exportedUnknown,3);assert.equal(health.pendingRecords,0);assert.equal(health.sanitizeRejected,2);
  const wire=bodies.join('');for(const secret of ['prompt-private-secret','identity-private-secret','process.pid','host.name'])assert.equal(wire.includes(secret),false);
  const outcomes=bodies.flatMap(body=>JSON.parse(body).resourceLogs.flatMap((resource:{scopeLogs:{logRecords:{attributes:{key:string;value:Record<string,unknown>}[]}[]}[]})=>resource.scopeLogs.flatMap(scope=>scope.logRecords.map(record=>scalarAttributes(record.attributes)['weiwu.outcome']))));
  assert.deepEqual(outcomes,['success','failure','unknown']);
 }finally{await sink.close();await sink.close();}assert.equal(sink.snapshot().state,'closed');assert.equal(sink.offer(summary()),false);
}));

test('256 reservations include in-flight records and flood remains synchronous and bounded',async t=>receiver(async(url,bodies,mode)=>{
 mode.value='stall';const sink=createObservationExporter(env(url));try{
  const rssBefore=process.memoryUsage().rss,started=Date.now();let accepted=0;for(let i=0;i<10000;i++)if(sink.offer(summary()))accepted++;
  const offerMs=Date.now()-started;assert.equal(accepted,256);assert.ok(offerMs<3000);const health=sink.snapshot();assert.equal(health.pendingRecords,256);assert.ok(health.pendingBytes<=1048576);assert.equal(health.queueFull,9744);
  await until(()=>bodies.length>0);const rssAfter=process.memoryUsage().rss,closing=Date.now();await sink.close();const closeMs=Date.now()-closing;assert.ok(closeMs<3600);assert.equal(sink.snapshot().pendingRecords,0);assert.ok(sink.snapshot().exportedUnknown+sink.snapshot().exportedFailure>0);
  t.diagnostic(JSON.stringify({offered:10000,accepted,queueFull:health.queueFull,pendingBytes:health.pendingBytes,offerMs,closeMs,rssBefore,rssAfter,closeHealth:sink.snapshot()}));
 }finally{await sink.close();}
}));

test('callback stalled by a trickling response keeps reservations until bounded close, then releases singleton',async t=>receiver(async(url,bodies,mode)=>{
 mode.value='trickle';const sink=createObservationExporter(env(url));try{
  for(let i=0;i<32;i++)assert.equal(sink.offer(summary()),true);
  const duplicate=createObservationExporter(env(url));assert.equal(duplicate.snapshot().configured,false);assert.equal(duplicate.snapshot().lastErrorCode,'OBSERVATION_EXPORT_ALREADY_ACTIVE');await duplicate.close();
  await until(()=>sink.snapshot().timedOut>0);assert.ok(bodies.length>0);assert.equal(sink.snapshot().pendingRecords,32);assert.equal(sink.snapshot().transportAcknowledged,0);
  const started=Date.now();await Promise.all([sink.close(),sink.close()]);const closeMs=Date.now()-started;assert.ok(closeMs<3000,`close budget includes worker termination: ${closeMs} ms`);assert.equal(sink.snapshot().closedUnconfirmed,32);assert.equal(sink.snapshot().pendingBytes,0);
  t.diagnostic(JSON.stringify({closeMs,health:sink.snapshot()}));
  mode.value='ok';const next=createObservationExporter(env(url));try{assert.equal(next.offer(summary()),true);await until(()=>next.snapshot().transportAcknowledged===1);}finally{await next.close();}
 }finally{await sink.close();}
}));

for(const modeName of ['429','503','reset','partial','malformed'])test(`collector ${modeName} has truthful bounded health without raw error text`,async t=>receiver(async(url,bodies,mode)=>{
 mode.value=modeName;const sink=createObservationExporter(env(url));try{assert.equal(sink.offer(summary()),true);await until(()=>sink.snapshot().pendingRecords===0);const health=sink.snapshot();assert.ok(bodies.length>=1&&bodies.length<=6);assert.equal(health.exportedSuccess,0);assert.equal(JSON.stringify(health).includes('collector-private-secret'),false);if(['429','503','reset'].includes(modeName))assert.equal(health.exportedFailure,1);else assert.equal(health.exportedUnknown,1);t.diagnostic(JSON.stringify({collector:modeName,requests:bodies.length,health}));}finally{await sink.close();}
}));

test('createObservability forwards only fresh offers and keeps existing counters',async()=>receiver(async(url,bodies)=>{
 const root=await mkdtemp(join(process.cwd(),'.private/p0-observation-export-20261029-'));
 createRunArchive(root,{});
 const sink=createObservability({traceRoot:root,telemetryEnv:env(url)});try{await until(()=>sink.snapshot().state==='enabled');assert.equal(sink.snapshot().accepted,0);assert.equal(bodies.length,0);assert.equal(sink.offer(summary()),true);await until(()=>sink.snapshot().transportAcknowledged===1);assert.equal(sink.snapshot().accepted,1);assert.equal(bodies.length,1);}finally{await sink.close();await rm(root,{recursive:true,force:true});}
}));
