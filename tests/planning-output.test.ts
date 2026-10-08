import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {planSchema} from '../packages/contracts/index.ts';
import {extractPlanningObject,PlanningOutputError,planningOutputDiagnostic,safeFinishReason,safePlanningSchemaIssues,planningSchemaMessage,PLANNING_SCHEMA_ISSUE_LIMIT,
 PLANNING_OUTPUT_MAX_BYTES,PLANNING_OUTPUT_MAX_DEPTH,PLANNING_OUTPUT_MAX_OUTSIDE_CHARS} from '../apps/api/src/planning-output.ts';

test('one exact object, one fence, or short surrounding prose preserves the whole candidate',()=>{
 const value={rationale:'Unchanged text',agents:[{id:'manager',tools:[]}],tasks:[{id:'dev',dependencies:[],details:{state:'draft'}}]},json=JSON.stringify(value);
 for(const raw of [json,' \n'+json+'\n ','```json\n'+json+'\n```','```\n'+json+'\n```','Here is the candidate:\n'+json,
  json+'\nPlease review it before saving.','Candidate follows:\n```JSON\n'+json+'\n```\nStill requires confirmation.'])assert.deepEqual(extractPlanningObject(raw),value);
});

const planFixture=()=>({rationale:'A valid fixture',agents:[{id:'manager',name:'Manager',title:'Manager',role:'manager',instructions:'Fixture only',modelId:'model',tools:[]}],
 tasks:[{id:'work',subject:'Review the fixture',objective:'Describe the scope',assigneeId:'manager',dependencies:[],acceptanceCriteria:['Scope is explicit'],estimatedInputTokens:100,estimatedOutputTokens:100,kind:'work'}]});
test('actual plan schema issues retain field, expected type, length, enum and numeric constraint without received values',()=>{
 const candidate:any=planFixture();candidate.agents[0].role='sk-private-role';candidate.agents[0].instructions=null;candidate.tasks[0].maxOutputTokens=32769;candidate.tasks[0].objective='sk-private-objective'.repeat(300);
 const parsed=planSchema.safeParse(candidate);assert.equal(parsed.success,false);if(parsed.success)return;
 const raw=JSON.stringify(candidate),diagnostic=planningOutputDiagnostic(raw,'stop',new PlanningOutputError('PLAN_SCHEMA_INVALID',null,parsed.error.issues));
 const at=(path:string)=>diagnostic.schemaIssues!.find(issue=>JSON.stringify(issue.path)===path)!;
 assert.deepEqual(at('["tasks",0,"maxOutputTokens"]').expected,{type:'number',maximum:32768,inclusive:true});assert.equal(at('["agents",0,"instructions"]').expected.type,'string');
 assert.deepEqual(at('["agents",0,"role"]').expected.values,['manager','member']);assert.equal(at('["tasks",0,"objective"]').expected.maximum,5000);
 assert.equal(diagnostic.originalOutputSHA,createHash('sha256').update(raw).digest('hex'));assert.equal(diagnostic.position,null);assert.ok(!JSON.stringify(diagnostic).includes('sk-private'));assert.ok(!JSON.stringify(diagnostic).includes('received'));
 assert.match(planningSchemaMessage(diagnostic as any),/agents\[0\].role/);assert.match(planningSchemaMessage(diagnostic as any),/允许 manager\/member/);
});
test('record keys, unknown fields and nested union input never enter a safe schema diagnostic',()=>{
 const candidate:any=planFixture();candidate.tasks[0].outputs=[{path:'output.json',format:'json',expectedValues:{'sk-private-record-key':'x'.repeat(2001),instructions:{secret:'sk-private-union'}}}];
 const failed=planSchema.safeParse(candidate);assert.equal(failed.success,false);if(failed.success)return;const summary=safePlanningSchemaIssues(failed.error.issues),serialized=JSON.stringify(summary);
 assert.ok(!serialized.includes('sk-private'));assert.ok(!serialized.includes('secret'));assert.ok(summary.schemaIssues.every(issue=>issue.path.at(-1)==='<field>'));assert.ok(summary.schemaIssues.some(issue=>issue.code==='invalid_union'));
 const strict=z.object({tasks:z.array(z.object({kind:z.enum(['work'])}).strict())}).strict().safeParse({tasks:[{kind:'work','sk-private-unknown':true}]});assert.equal(strict.success,false);if(strict.success)return;
 const unknown=safePlanningSchemaIssues(strict.error.issues);assert.deepEqual(unknown.schemaIssues[0],{path:['tasks',0],code:'unrecognized_keys',expected:{rule:'unknown-fields-not-allowed'}});assert.ok(!JSON.stringify(unknown).includes('sk-private'));
});
test('multiple issue summaries are capped and only schema fields, bounded array indexes and safe constraints survive',()=>{
 const issues=Array.from({length:50},()=>({path:['sk-private-path',2,'tasks',10000,'expectedValues','instructions'],code:'invalid_value',values:['sk-private-enum','work'],expected:'sk-private-type',maximum:Infinity,message:'sk-private-message',input:'sk-private-input',keys:['sk-private-key'],pattern:'sk-private-pattern',errors:[{input:'sk-private-union'}]}));
 const summary=safePlanningSchemaIssues(issues);assert.equal(summary.schemaIssues.length,PLANNING_SCHEMA_ISSUE_LIMIT);assert.equal(summary.schemaIssueCount,50);assert.equal(summary.schemaIssuesTruncated,true);assert.deepEqual(summary.schemaIssues[0].path,['<field>','<field>','tasks','<field>','expectedValues','<field>']);assert.deepEqual(summary.schemaIssues[0].expected,{values:['work']});
 assert.ok(!JSON.stringify(summary).includes('sk-private'));assert.ok(Buffer.byteLength(JSON.stringify(summary))<12000);assert.ok(planningSchemaMessage(summary).length<1500);
 const unknown=safePlanningSchemaIssues([{path:['tasks',0],code:'sk-private-code',expected:{secret:'sk-private'}}]);assert.equal(unknown.schemaIssues[0].code,'schema_constraint');assert.ok(!JSON.stringify(unknown).includes('sk-private'));
});
test('normal candidate parsing and accepted unknown-field stripping retain original schema behavior',()=>{
 const original=planFixture();assert.deepEqual(planSchema.parse(extractPlanningObject(JSON.stringify(original))),original);
 assert.deepEqual(planSchema.parse({...original,'sk-private-unknown':'not a schema field'}),original);
 const refinement=safePlanningSchemaIssues([{code:'custom',path:['tasks',0,'inputs',0],message:'输入必须绑定来源任务或固定 SHA256'}]);assert.equal(refinement.schemaIssues[0].expected.rule,'input-source-required');
 const positive=safePlanningSchemaIssues([{code:'too_small',path:['tasks',0,'maxBudget'],origin:'number',minimum:0,inclusive:false}]);assert.match(planningSchemaMessage(positive),/大于 0/);
});

test('quoted braces, escaped quotes/backslashes/newlines and nested containers never split the object',()=>{
 const value={text:'quoted " } { ] [; slash \\; newline\n; ```json; 中文',nested:[{value:['{','}',[],{depth:3}]}]};
 assert.deepEqual(extractPlanningObject('One object:\n'+JSON.stringify(value,null,2)+'\nReview it.'),value);
});

test('multiple candidates, alternative scalar values and malformed fence boundaries are rejected',()=>{
 for(const raw of ['{"a":1}{"b":2}','Example: {"a":1}\nActual: {"b":2}','```json\n{"a":1}\n```\n```json\n{"b":2}\n```',
  '```js\n{"a":1}\n```','```json\n{"a":1}','{"a":1}\n```','null {"a":1}','{"a":1} true','"a" {"b":2}',
  '[{"a":1}]','[1,2]','null','true','4','"text"'])assert.throws(()=>extractPlanningObject(raw),PlanningOutputError,raw);
});

test('truncated strings/containers, invalid escape/control characters and syntax are never repaired',()=>{
 for(const raw of ['{"a":','{"a":"unfinished','{"a":{"b":1}','{"a":[1,2}','{"a":1,}','{"a":"bad\\x"}',
  '{"a":"raw\nnewline"}','{"a": undefined}','{"a":[1}}','{"a":1/*comment*/}',"{'a':1}",'Please plan it.',''])assert.throws(()=>extractPlanningObject(raw),PlanningOutputError);
});

test('output byte, nesting depth and outside text ceilings are exact and do not clip data',()=>{
 const overhead=Buffer.byteLength('{"x":""}');assert.equal(Buffer.byteLength(JSON.stringify({x:'x'.repeat(PLANNING_OUTPUT_MAX_BYTES-overhead)})),PLANNING_OUTPUT_MAX_BYTES);
 assert.equal((extractPlanningObject(JSON.stringify({x:'x'.repeat(PLANNING_OUTPUT_MAX_BYTES-overhead)})).x as string).length,PLANNING_OUTPUT_MAX_BYTES-overhead);
 assert.throws(()=>extractPlanningObject(JSON.stringify({x:'x'.repeat(PLANNING_OUTPUT_MAX_BYTES-overhead+1)})),{reason:'OUTPUT_TOO_LARGE'});
 assert.throws(()=>extractPlanningObject(JSON.stringify({x:'中'.repeat(Math.ceil(PLANNING_OUTPUT_MAX_BYTES/3))})),{reason:'OUTPUT_TOO_LARGE'});
 assert.ok(extractPlanningObject('{"x":'+'['.repeat(PLANNING_OUTPUT_MAX_DEPTH-1)+'0'+']'.repeat(PLANNING_OUTPUT_MAX_DEPTH-1)+'}'));
 assert.throws(()=>extractPlanningObject('{"x":'+'['.repeat(PLANNING_OUTPUT_MAX_DEPTH)+'0'+']'.repeat(PLANNING_OUTPUT_MAX_DEPTH)+'}'),{reason:'NESTING_TOO_DEEP'});
 assert.deepEqual(extractPlanningObject('p'.repeat(PLANNING_OUTPUT_MAX_OUTSIDE_CHARS)+'{"ok":true}'),{ok:true});
 assert.throws(()=>extractPlanningObject('p'.repeat(PLANNING_OUTPUT_MAX_OUTSIDE_CHARS+1)+'{"ok":true}'),{reason:'OUTSIDE_TEXT_TOO_LONG'});
});

test('failure diagnostics contain safe scalars and original SHA without echoing provider text or keys',()=>{
 const raw='{"secret":"sk-synthetic-private-value","task":}',finish='sk-secret-finish';let failure:PlanningOutputError|undefined;
 try{extractPlanningObject(raw);}catch(error){failure=error as PlanningOutputError;}
 assert.ok(failure);const diagnostic=planningOutputDiagnostic(raw,finish,failure);
 assert.equal(diagnostic.reason,'INVALID_JSON');assert.ok(diagnostic.position!==null&&diagnostic.position>=0&&diagnostic.position<raw.length);
 assert.equal(diagnostic.finishReason,'unknown');assert.equal(diagnostic.originalOutputSHA,createHash('sha256').update(raw).digest('hex'));assert.equal(diagnostic.outputBytes,Buffer.byteLength(raw));
 assert.ok(!JSON.stringify(diagnostic).includes('sk-'));assert.deepEqual(Object.keys(diagnostic).sort(),['finishReason','originalOutputSHA','outputBytes','position','reason']);
 assert.equal(safeFinishReason('length'),'length');assert.equal(safeFinishReason(null),undefined);assert.equal(safeFinishReason({text:'credential'}),'unknown');
});
