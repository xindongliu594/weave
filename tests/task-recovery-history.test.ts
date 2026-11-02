import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';

const module = await import('../apps/api/src/task-recovery-history.ts').catch(()=>({summarizeTaskRecoveryHistory:undefined}));
const summarize = (value:any):any => {
 assert.equal(typeof module.summarizeTaskRecoveryHistory,'function','history projection is not implemented');
 return module.summarizeTaskRecoveryHistory!(value);
};
const stamp='2026-10-30T01:02:03.123456Z';
function fixture():any {
 const runId=randomUUID();
 const run={id:runId,project_id:randomUUID(),project_version:1,status:'interrupted',error:null,
  created_at:stamp,started_at:stamp,finished_at:stamp,attempt:1,parent_run_id:null,cancel_requested:true,
  department_ids:['department'],lease_owner:null,lease_until:null,snapshot:{private:'snapshot-secret'},canonical_workspace:null,
  requested_by_user_id:null,authorized_by_user_id:null,authorized_epoch:null,authority_kind:'local-owner',authority_department_ids:null,source_bounds:null};
 const scope={run_id:runId,task_id:'a',attempt_id:'a1',generation:1,principal:'employee',session_id:'session',runtime_task_id:'a',
  contract_hash:'a'.repeat(64),permission_hash:'b'.repeat(64),capability_hash:'c'.repeat(64),contract:{version:1},input_origins:[],
  committed_outputs:[],sandbox_identity:null,scope:null,work_revision:null,phase:'active',accepted_stop:null};
 const operation={id:randomUUID(),run_id:runId,device_id:'device',grant_id:'grant',approval_id:null,status:'cancelled',started:false,
  deadline:stamp,created_at:stamp,finished_at:stamp,merge_state:null,payload:{private:'payload-secret'},result:null,late_result:null,
  merge_record:null,merge_rejection:null,claim_token:'claim-secret',lease_owner:'owner-secret',executor_kind:'local',
  effect_intent:null,effect_state:null,effect_version:0,parent_operation_id:null,evidence_records:[]};
 return {run,scopes:[scope],operations:[operation]};
}
const invalid={code:'TASK_RECOVERY_HISTORY_INVALID'};

test('history includes all rows, is deterministic by byte order and does not mutate source',()=>{
 const value=fixture(),before=structuredClone(value);
 value.scopes.push({...value.scopes[0],task_id:'B'});
 value.operations.push({...value.operations[0],id:randomUUID(),status:'failed',created_at:'2026-10-30T01:02:03.123455Z'});
 const first=summarize(value),reordered=summarize({...value,scopes:[...value.scopes].reverse(),operations:[...value.operations].reverse()});
 assert.equal(first.digest,reordered.digest);assert.equal(first.history.scopes[0].task_id,'B');
 assert.equal(first.history.operations[0].status,'failed');assert.equal(first.history.run.created_at,stamp);
 assert.deepEqual(value.run,before.run);assert.deepEqual(value.scopes[0],before.scopes[0]);
 assert.match(first.digest,/^[a-f0-9]{64}$/);assert.equal(first.history.kind,'task-live-source-history');
});

test('snapshot, owner, claim and operation result material enter the projection only as digests',()=>{
 const value=fixture(),result=summarize(value),encoded=JSON.stringify(result);
 for(const secret of ['snapshot-secret','payload-secret','claim-secret','owner-secret'])assert.equal(encoded.includes(secret),false);
 for(const field of ['snapshot_digest','lease_owner_digest'])assert.match(result.history.run[field],/^[a-f0-9]{64}$/);
 for(const field of ['payload_digest','result_digest','late_result_digest','merge_record_digest','claim_token_digest','effect_intent_digest','evidence_records_digest'])
  assert.match(result.history.operations[0][field],/^[a-f0-9]{64}$/);
});

test('NULL, empty JSON and every failed, late, stopped and runtime effect fact remain distinct',()=>{
 const original=fixture(),baseline=summarize(original).digest;
 const mutations=[
  (x:any)=>x.operations[0].result={},(x:any)=>x.operations[0].late_result={ok:true},
  (x:any)=>x.operations[0].merge_state='unknown',(x:any)=>x.operations[0].status='failed',
  (x:any)=>x.operations[0].claim_token=null,(x:any)=>x.scopes[0].accepted_stop={state:'stopped'},
  (x:any)=>x.scopes[0].phase='unknown',(x:any)=>x.operations[0].effect_intent={action:'send'},
  (x:any)=>x.operations[0].effect_state='unknown',(x:any)=>x.operations[0].effect_version=1,
  (x:any)=>x.operations[0].parent_operation_id=randomUUID(),(x:any)=>x.operations[0].evidence_records=[{outcome:'unknown'}],
  (x:any)=>x.run.source_bounds={restored:true},(x:any)=>x.run.authorized_epoch='1',
  (x:any)=>x.run.authorized_by_user_id='human',(x:any)=>x.run.authority_department_ids=[],
  (x:any)=>x.run.requested_by_user_id='requester',(x:any)=>x.run.authority_kind='human',
  (x:any)=>x.run.created_at='2026-10-30T01:02:03.123457Z',
 ];
 for(const mutate of mutations){const value=structuredClone(original);mutate(value);assert.notEqual(summarize(value).digest,baseline);}
 const runtime=structuredClone(original);Object.assign(runtime.operations[0],{executor_kind:'runtime',device_id:null,grant_id:null,status:'unknown',effect_state:'unknown'});
 assert.equal(summarize(runtime).history.operations[0].device_id,null);
 // This unit records unresolved facts. It does not authorize them for recovery.
});

test('SQL bigint epoch is normalized losslessly and microseconds cannot be replaced with Date/millisecond values',()=>{
 const value=fixture();value.run.authorized_epoch='9007199254740991';
 const normalized=structuredClone(value);normalized.run.authorized_epoch=9007199254740991;
 assert.equal(summarize(value).digest,summarize(normalized).digest);
 for(const epoch of ['9007199254740992','01',-1,NaN]){const bad=fixture();bad.run.authorized_epoch=epoch;assert.throws(()=>summarize(bad),invalid);}
 for(const time of [new Date(stamp),'2026-10-30T01:02:03.123Z','2026-02-30T01:02:03.123456Z']){
  const bad=fixture();bad.run.created_at=time;assert.throws(()=>summarize(bad),invalid);
 }
});

test('missing, additional and cross-run fields or duplicate rows fail closed without filling defaults',()=>{
 for(const mutate of [
  (x:any)=>delete x.run.source_bounds,(x:any)=>x.run.task_evidence=null,(x:any)=>delete x.operations[0].executor_kind,
  (x:any)=>x.scopes[0].run_id=randomUUID(),(x:any)=>x.operations[0].run_id=randomUUID(),
  (x:any)=>x.scopes.push({...x.scopes[0]}),(x:any)=>x.operations.push({...x.operations[0]}),
  (x:any)=>x.scopes[0].generation=0,(x:any)=>x.operations[0].effect_version=-1,
  (x:any)=>{x.scopes=[];x.operations=[];x.run.id=[x.run.id];},(x:any)=>x.run.project_id=[x.run.project_id],
 ]){const value=fixture();mutate(value);assert.throws(()=>summarize(value),invalid);}
});

test('non-JSON input is rejected before getters/toJSON can execute',()=>{
 let invoked=0;
 for(const build of [
  ()=>({bad:undefined}),()=>({bad:Infinity}),()=>({bad:-0}),()=>[,,],()=>new Proxy({},{}),
  ()=>Object.defineProperty({},'x',{enumerable:true,get(){invoked++;return 1;}}),
  ()=>({toJSON(){invoked++;return {};}}),()=>{const a:any={};a.self=a;return a;},
 ]){const value=fixture();value.run.snapshot=build();assert.throws(()=>summarize(value),invalid);}
 assert.equal(invoked,0);
});

test('history projection is detached and cannot silently discard unknown future columns or huge depth',()=>{
 const value=fixture(),result=summarize(value);result.history.scopes[0].contract.version=2;
 assert.equal(value.scopes[0].contract.version,1);
 let nested:any={};for(let i=0;i<70;i++)nested={nested};value.run.snapshot=nested;
 assert.throws(()=>summarize(value),invalid);
});

test('oversized wide JSON is refused before it can exhaust a bounded child heap',()=>{
 const url=pathToFileURL(resolve('apps/api/src/task-recovery-history.ts')).href;
 const script=`import {summarizeTaskRecoveryHistory} from ${JSON.stringify(url)};
  try { summarizeTaskRecoveryHistory({run:{snapshot:Array(4096).fill('x'.repeat(1024*1024))},scopes:[],operations:[]});process.exitCode=2; }
  catch(error){if(error?.code!=='TASK_RECOVERY_HISTORY_INVALID')throw error;console.log('BOUNDED_HISTORY_REFUSAL');}`;
 const child=spawnSync(process.execPath,['--max-old-space-size=256','--import','tsx','--input-type=module','--eval',script],
  {encoding:'utf8',windowsHide:true,timeout:30000,maxBuffer:64*1024});
 assert.ifError(child.error);
 assert.equal(child.status,0,child.stderr.slice(-1600));
 assert.match(child.stdout,/BOUNDED_HISTORY_REFUSAL/);
});

test('unpaired surrogate identities cannot collide under UTF-8 byte sorting',()=>{
 for(const taskId of ['\ud800','\ud801']){const value=fixture();value.scopes[0].task_id=taskId;assert.throws(()=>summarize(value),invalid);}
 const value=fixture();value.scopes[0].task_id='员工😀';assert.equal(summarize(value).history.scopes[0].task_id,'员工😀');
});

test('wide arrays are refused before allocating an own-key list for millions of elements',()=>{
 const url=pathToFileURL(resolve('apps/api/src/task-recovery-history.ts')).href;
 const script=`import {summarizeTaskRecoveryHistory} from ${JSON.stringify(url)};
  try { summarizeTaskRecoveryHistory({run:{snapshot:Array(8000000).fill(0)},scopes:[],operations:[]});process.exitCode=2; }
  catch(error){if(error?.code!=='TASK_RECOVERY_HISTORY_INVALID')throw error;console.log('BOUNDED_ARRAY_REFUSAL');}`;
 const child=spawnSync(process.execPath,['--max-old-space-size=256','--import','tsx','--input-type=module','--eval',script],
  {encoding:'utf8',windowsHide:true,timeout:30000,maxBuffer:64*1024});
 assert.ifError(child.error);assert.equal(child.status,0,child.stderr.slice(-1600));assert.match(child.stdout,/BOUNDED_ARRAY_REFUSAL/);
});
