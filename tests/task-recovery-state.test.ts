import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {redact} from '../services/agent-runtime/trace-store.mjs';
import {decodeTaskRecoverySource,taskRecoveryApprovalDigest,decodeTaskRecoveryInitialization,taskRecoveryInitializationDigest,decodeTaskRecoveryEvidence} from '../apps/api/src/task-recovery-state.ts';

const {manifest,revision,canonicalManifest}=createRequire(import.meta.url)('../apps/desktop/local-executor.cjs');
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
const sorted=(v:any):any=>Array.isArray(v)?v.map(sorted):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,sorted(v[k])])):v;
const digest=(v:any)=>sha(JSON.stringify(sorted(v)));
const file=(path:string,text:string)=>({path,content:Buffer.from(text).toString('base64')});
const invalid={status:409,code:'TASK_RECOVERY_STATE_INVALID'};
function fixture():any{
 const sourceRunId=randomUUID(),childRunId=randomUUID(),mergeId=randomUUID();
 const files=[file('a.txt','A'),file('input.txt','input')],initial=[file('a.txt','new A'),file('input.txt','input'),file('z.txt','Z')];
 const key={runId:sourceRunId,taskId:'a',attemptId:'attempt-a',generation:1};
 const source={version:1,mode:'live-sql-v1',sourceRunId,
  sourceHead:{version:1,revision:revision(files),manifest:manifest(files),mergeId,receipt:{mergeId,operationId:mergeId,key,scopeHash:sha('scope'),beforeRevision:sha('before'),afterRevision:revision(files),workRevision:sha('work'),status:'committed'}},
  sourceCheckpoint:{key,id:randomUUID(),sha256:sha('checkpoint'),seq:3},sourceHistoryDigest:sha('history'),
  sourceArchiveCursor:{seq:4,eventSha256:sha('event'),prefixSha256:sha('prefix'),snapshotSha256:sha('snapshot')},
  authority:{projectId:randomUUID(),planVersion:1,taskId:'a',contractHash:sha('contract'),permissionHash:sha('permission'),capabilityHash:sha('capability'),resourceRevision:1,
   backend:{kind:'openshell',version:'0.1.2',gateway:'local gateway',image:'node@sha256:'+sha('image'),policySha256:sha('policy'),fingerprint:sha('backend')}}};
 const record:any={version:1,childRunId,approvalDigest:digest({kind:'task-recovery-source',version:1,record:source}),source,
  readPaths:['input.txt'],writePaths:['a.txt','z.txt'],checkpointWorkRevision:sha('work'),plannerScopeHash:sha('planner'),
  delta:[{path:'a.txt',beforeSha256:sha('A'),afterSha256:sha('new A'),size:5},{path:'z.txt',beforeSha256:null,afterSha256:sha('Z'),size:1}],
  initialHead:{version:1,revision:revision(initial),manifest:manifest(initial),mergeId:null,receipt:null}};
 record.digest=digest({kind:'task-recovery-initialization',version:1,record});return record;
}
function resign(record:any){
 record.approvalDigest=digest({kind:'task-recovery-source',version:1,record:record.source});
 const {digest:_,...unsigned}=record;record.digest=digest({kind:'task-recovery-initialization',version:1,record:unsigned});return record;
}
function resealHead(value:any){
 value.revision=sha(JSON.stringify(canonicalManifest(value.manifest)));
 if(value.receipt)value.receipt.afterRevision=value.revision;
}
function rejects(mutate:(record:any)=>void,resigned=true){
 const value=fixture();mutate(value);if(resigned)resign(value);
 const before=structuredClone(value);assert.throws(()=>decodeTaskRecoveryInitialization(value),invalid);assert.deepEqual(value,before);
}

test('valid records round trip without mutation and domain digests preserve array order',()=>{
 const value=fixture(),before=structuredClone(value),{digest:_,...unsigned}=value;
 assert.deepEqual(decodeTaskRecoverySource(value.source),value.source);
 assert.deepEqual(decodeTaskRecoveryInitialization(value),value);
 assert.deepEqual(decodeTaskRecoveryEvidence({version:1,recoveryInitialization:value,sourceHistory:null}),{version:1,recoveryInitialization:value,sourceHistory:null});
 assert.equal(taskRecoveryApprovalDigest(value.source),value.approvalDigest);
 assert.equal(taskRecoveryInitializationDigest(unsigned),value.digest);
 const reorder=(v:any):any=>Array.isArray(v)?v.map(reorder):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).reverse().map(k=>[k,reorder(v[k])])):v;
 assert.equal(taskRecoveryApprovalDigest(reorder(value.source)),value.approvalDigest);
 assert.equal(taskRecoveryInitializationDigest(reorder(unsigned)),value.digest);
 assert.deepEqual(value,before);assert.deepEqual(redact(value.source.authority),value.source.authority);
 assert.notEqual(value.initialHead.revision,digest(value.initialHead.manifest),'manifest revision retains original fixed field order');
});

test('SQL NULL is distinct from explicit empty V1 evidence and cannot create source authority',()=>{
 assert.deepEqual(decodeTaskRecoveryEvidence({version:1,recoveryInitialization:null,sourceHistory:null}),{version:1,recoveryInitialization:null,sourceHistory:null});
 for(const value of [null,undefined,{}, {version:2,recoveryInitialization:null,sourceHistory:null}, {version:1,recoveryInitialization:null,sourceHistory:{}}, {version:1,recoveryInitialization:null,sourceHistory:null,verified:true}])assert.throws(()=>decodeTaskRecoveryEvidence(value),invalid);
});

test('source identity, generation, sequence, head and committed receipt are strictly bound',()=>{
 for(const mutate of [
  (v:any)=>v.childRunId=v.source.sourceRunId,(v:any)=>v.source.sourceRunId=randomUUID(),
  (v:any)=>v.source.sourceCheckpoint.key.runId=randomUUID(),(v:any)=>v.source.authority.taskId='b',
  (v:any)=>v.source.sourceCheckpoint.key.generation=0,(v:any)=>v.source.sourceCheckpoint.key.generation=Number.MAX_SAFE_INTEGER+1,
  (v:any)=>v.source.sourceCheckpoint.seq=5,(v:any)=>v.source.sourceArchiveCursor.seq=0,(v:any)=>v.source.sourceCheckpoint.seq=1.5,
  (v:any)=>v.source.sourceHead.mergeId=null,(v:any)=>v.source.sourceHead.receipt=null,
  (v:any)=>v.source.sourceHead.receipt.operationId=randomUUID(),(v:any)=>v.source.sourceHead.receipt.mergeId=randomUUID(),
  (v:any)=>v.source.sourceHead.receipt.afterRevision=sha('wrong'),(v:any)=>v.source.sourceHead.receipt.key.runId=randomUUID(),
  (v:any)=>v.source.sourceHead.receipt.status='rejected', (v:any)=>v.initialHead.mergeId=v.source.sourceHead.mergeId,
  (v:any)=>v.initialHead.receipt=v.source.sourceHead.receipt,
 ])rejects(mutate);
});

test('all nested keys, versions and identity text stay exact without dropping or repairing fields',()=>{
 const paths=[[],['source'],['source','sourceHead'],['source','sourceHead','receipt'],['source','sourceHead','receipt','key'],['source','sourceHead','manifest',0],['source','sourceCheckpoint'],['source','sourceCheckpoint','key'],['source','sourceArchiveCursor'],['source','authority'],['source','authority','backend'],['initialHead'],['delta',0]];
 for(const path of paths)for(const field of ['extra','verified','authorization'])rejects(v=>{let at=v;for(const part of path)at=at[part];at[field]=true;});
 for(const mutate of [
  (v:any)=>v.source.version=2,(v:any)=>v.version=2,(v:any)=>v.initialHead.version=2,(v:any)=>v.source.mode='archive-v1',
  (v:any)=>v.source.authority.backend.version='0.1.3',(v:any)=>v.source.sourceRunId=v.source.sourceRunId.toUpperCase(),
  (v:any)=>v.source.sourceCheckpoint.key.taskId=' a',(v:any)=>v.source.sourceCheckpoint.key.attemptId='a\n',
  (v:any)=>v.source.authority.backend.gateway='x'.repeat(1025),(v:any)=>v.source.authority.backend.image=' node',
  (v:any)=>v.source.authority.projectId='project',(v:any)=>v.plannerScopeHash='A'.repeat(64),
  (v:any)=>v.source.authority.planVersion=0,(v:any)=>v.source.authority.resourceRevision=-1,
 ])rejects(mutate);
 const value=fixture();delete value.source.authority.capabilityHash;assert.throws(()=>decodeTaskRecoverySource(value.source),invalid);
});

test('manifest paths reject Windows aliases, links syntax, conflicts and noncanonical order',()=>{
 for(const path of ['../x','/x','a\\b','a:b','a//b','con.txt','COM¹.txt','.agent/x','a.','a /b','a\u0000'])rejects(v=>{v.source.sourceHead.manifest[0].path=path;resealHead(v.source.sourceHead);});
 for(const entries of [
  [{path:'a',size:0,sha256:sha('')},{path:'A',size:0,sha256:sha('')}],
  [{path:'a',size:0,sha256:sha('')},{path:'a/b',size:0,sha256:sha('')}],
  [{path:'a/b',size:0,sha256:sha('')},{path:'A',size:0,sha256:sha('')}],
 ])rejects(v=>{v.source.sourceHead.manifest=entries;resealHead(v.source.sourceHead);});
 rejects(v=>v.source.sourceHead.manifest.reverse());rejects(v=>v.source.sourceHead.revision=sha('wrong'));
 rejects(v=>v.source.sourceHead.revision=digest(v.source.sourceHead.manifest));
 for(const size of [-1,0.5,Number.MAX_SAFE_INTEGER+1,5*1024*1024+1])rejects(v=>{v.source.sourceHead.manifest[0].size=size;resealHead(v.source.sourceHead);});
 rejects(v=>{v.source.sourceHead.manifest=Array.from({length:5},(_,i)=>({path:i+'.txt',size:5*1024*1024,sha256:sha('x')}));resealHead(v.source.sourceHead);});
 rejects(v=>{v.source.sourceHead.manifest=Array.from({length:129},(_,i)=>({path:String(i).padStart(3,'0'),size:0,sha256:sha('')}));resealHead(v.source.sourceHead);});
});

test('scope and delta cannot mutate outside writes, delete files, fake changes or mismatch either manifest',()=>{
 for(const mutate of [
  (v:any)=>v.readPaths=['input.txt','input.txt'],(v:any)=>v.writePaths.reverse(),(v:any)=>v.readPaths=['z','a'],
  (v:any)=>v.writePaths=['A.txt','a.txt'],(v:any)=>v.writePaths=['a','a/b'],(v:any)=>v.writePaths=['../a'],
  (v:any)=>v.readPaths=Array.from({length:129},(_,i)=>String(i).padStart(3,'0')),
  (v:any)=>v.writePaths=['a.txt'],(v:any)=>v.delta.reverse(),(v:any)=>v.delta.push(v.delta[0]),
  (v:any)=>v.delta[0].beforeSha256=null,(v:any)=>v.delta[0].afterSha256=sha('wrong'),(v:any)=>v.delta[0].size++,
  (v:any)=>v.delta[1].beforeSha256=sha('wrong'),(v:any)=>v.initialHead.manifest.pop(),
  (v:any)=>v.initialHead.manifest.splice(1,1),(v:any)=>v.initialHead.manifest[1].sha256=sha('foreign change'),
  (v:any)=>v.delta=[],(v:any)=>{v.delta[0].afterSha256=v.delta[0].beforeSha256;v.initialHead.manifest[0]={...v.source.sourceHead.manifest[0]};},
 ])rejects(v=>{mutate(v);v.initialHead.revision=sha(JSON.stringify(v.initialHead.manifest));});
});

test('both digest domains are checked after structure and cross-field validation',()=>{
 rejects(v=>v.approvalDigest=sha('wrong'),false);rejects(v=>v.digest=sha('wrong'),false);
 rejects(v=>v.approvalDigest=digest({kind:'other',version:1,record:v.source}),false);
 const v=fixture();v.source.sourceCheckpoint.seq=999;assert.throws(()=>taskRecoveryApprovalDigest(v.source),invalid);
 const {digest:_,...unsigned}=fixture();unsigned.delta[0].size++;assert.throws(()=>taskRecoveryInitializationDigest(unsigned),invalid);
});

test('non JSON, hidden values, custom objects, sparse arrays and overlarge records fail without mutation',()=>{
 for(const value of [undefined,NaN,Infinity,1n,()=>{},Symbol('x'),new Date(),new Map()]){
  const v=fixture();v.source.authority.backend.gateway=value;assert.throws(()=>decodeTaskRecoveryInitialization(v),invalid);
 }
 const cyclic=fixture();cyclic.source.authority.loop=cyclic;assert.throws(()=>decodeTaskRecoveryInitialization(cyclic),invalid);
 const sparse=fixture();sparse.readPaths=new Array(1);assert.throws(()=>decodeTaskRecoveryInitialization(sparse),invalid);assert.equal(0 in sparse.readPaths,false);
 for(const make of [(v:any)=>v.extra=undefined,(v:any)=>Object.defineProperty(v,'hidden',{value:1}), (v:any)=>v[Symbol('hidden')]=1,(v:any)=>Object.defineProperty(v,'extra',{get(){throw Error('must not invoke');},enumerable:true}),(v:any)=>v.readPaths.extra=true]){
  const v=fixture();make(v);assert.throws(()=>decodeTaskRecoveryInitialization(v),invalid);
 }
 const large=fixture();large.padding='x'.repeat(512*1024);assert.throws(()=>decodeTaskRecoveryInitialization(large),invalid);
});

test('archive redaction cannot silently rewrite identity or nested authority',()=>{
 for(const mutate of [(v:any)=>v.source.authority.backend.gateway='Bearer abcdefghijklmnop',(v:any)=>v.source.authority.backend.image='sk-abcdefghijklmnop',(v:any)=>v.source.sourceCheckpoint.key.attemptId='Bearer abcdefghijklmnop'])rejects(mutate);
 const v=fixture();v.source.authority.backend.gateway='Bearer abcdefghijklmnop';assert.throws(()=>taskRecoveryApprovalDigest(v.source),invalid);
});

test('identity text rejects Unicode control characters',()=>{
 const control=fixture();control.source.authority.backend.gateway='gateway\u0085identity';resign(control);
 assert.throws(()=>decodeTaskRecoveryInitialization(control),invalid);
});
test('proxy objects cannot masquerade as plain JSON identity data',()=>{
 const proxied=fixture();proxied.source=new Proxy(proxied.source,{});
 assert.throws(()=>decodeTaskRecoveryInitialization(proxied),invalid);
});

test('exact file limits and unchanged child head remain valid without a fabricated delta',()=>{
 const value=fixture();
 value.source.sourceHead.manifest=Array.from({length:4},(_,i)=>({path:i+'.txt',size:5*1024*1024,sha256:sha(String(i))}));
 resealHead(value.source.sourceHead);
 value.initialHead={...value.source.sourceHead,mergeId:null,receipt:null};value.delta=[];value.readPaths=[];value.writePaths=[];resign(value);
 assert.deepEqual(decodeTaskRecoveryInitialization(value),value);
 value.source.sourceHead.manifest=Array.from({length:128},(_,i)=>({path:String(i).padStart(3,'0'),size:0,sha256:sha('')}));
 resealHead(value.source.sourceHead);value.initialHead={...value.source.sourceHead,mergeId:null,receipt:null};resign(value);
 assert.deepEqual(decodeTaskRecoveryInitialization(value),value);
});
