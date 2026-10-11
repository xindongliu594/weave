import test from 'node:test';
import assert from 'node:assert/strict';
import { planSchema, runInputSchema, validatePlan, type Plan } from '../packages/contracts/index.ts';
import { attachRunInputs } from '../apps/api/src/knowledge-store.ts';
import { approvedSkills,companySkills } from '../services/agent-runtime/approved-skills.mjs';

const employee={id:'employee-1',employeeId:'qa',tools:['knowledge_search','knowledge_read']};
const manifest={format:'document-versions-v2' as const,documents:[],agentDocuments:{}};
const input={id:'method',title:'交付检查方法',content:'先读取文件。\r\n再测试。\n保留依据。',agentIds:['qa'],skillName:'delivery-check'};

test('company catalog bounds and immutable identities fail closed without exposing ungranted methods',()=>{
 const doc={documentId:'doc',title:'批准方法',version:1,sha256:'a'.repeat(64),source:{skillName:'method'}};
 const documents=Array.from({length:51},(_,i)=>({...doc,documentId:'doc-'+i}));
 const scoped={format:'document-versions-v2',documents,agentDocuments:{'employee-1':documents.map(d=>d.documentId)}};
 assert.throws(()=>companySkills(scoped,employee),/COMPANY_SKILL_LIMIT/);
 assert.equal(companySkills({...scoped,documents:documents.slice(0,50)},employee).length,50);
 for(const invalid of [{source:{skillName:'../bad'}},{sha256:'bad'},{version:0}])assert.throws(()=>companySkills({format:'document-versions-v2',documents:[{...doc,...invalid}],agentDocuments:{'employee-1':['doc']}},employee),/APPROVED_SKILL_INVALID/);
 assert.deepEqual(companySkills({...scoped,agentDocuments:{}},employee),[]);
});

test('approved method keeps one exact body and maps employee identity without importing shared knowledge',()=>{
  const result=attachRunInputs(manifest,[input],[employee],'run-1');
  assert.equal(result.documents.length,0);
  assert.equal(result.runInputs?.[0].chunks.length,1);
  assert.equal(result.runInputs?.[0].chunks[0].content,input.content);
  assert.deepEqual(result.runInputs?.[0].agentIds,['employee-1']);
  assert.equal(approvedSkills(result,employee)[0].content,input.content);
  assert.deepEqual(approvedSkills(result,{...employee,id:'employee-2'}),[]);
  assert.deepEqual(approvedSkills(result,{...employee,tools:['knowledge_search']}),[]);
  assert.deepEqual(approvedSkills(result,{...employee,tools:['knowledge_read']}),[]);
  const restored=JSON.parse(JSON.stringify(result));
  const updated=attachRunInputs(manifest,[{...input,content:'different current text'}],[employee],'run-new');
  assert.equal(approvedSkills(updated,employee)[0].content,'different current text');
  assert.equal(approvedSkills(restored,employee)[0].content,'先读取文件。\r\n再测试。\n保留依据。');
});

test('ordinary knowledge is never promoted into instructions; tampered approved content fails closed',()=>{
  const result=attachRunInputs(manifest,[{...input,skillName:undefined}],[employee],'run-2');
  assert.deepEqual(approvedSkills(result,employee),[]);
  const method=attachRunInputs(manifest,[input],[employee],'run-3');
  method.runInputs![0].chunks[0].content+=' changed';
  assert.throws(()=>approvedSkills(method,employee),/APPROVED_SKILL_INVALID/);
});

test('method schema rejects invalid names and oversized instructions',()=>{
  assert.equal(runInputSchema.safeParse({...input,skillName:'../secret'}).success,false);
  assert.equal(runInputSchema.safeParse({...input,content:'a'.repeat(16001)}).success,false);
  assert.equal(runInputSchema.safeParse({...input,content:'a'.repeat(16001),skillName:undefined}).success,true);
});

test('plan approval requires original knowledge access and rejects duplicate method identities',()=>{
  const plan:Plan={rationale:'核对资料',agents:[{id:'qa',name:'QA',role:'manager',title:'QA',instructions:'核对',modelId:'model',tools:['knowledge_search']}],
    tasks:[{id:'check',subject:'检查输入资料',objective:'核对固定工作方法',kind:'requirements',assigneeId:'qa',dependencies:[],acceptanceCriteria:['依据固定方法逐项核对'],estimatedInputTokens:100,estimatedOutputTokens:100}],runInputs:[input]};
  const policy={maxBudget:1,maxAgents:1,maxConcurrentAgents:1,deadlineSeconds:600};
  assert.equal(validatePlan(plan,policy,[],false).checks.find(check=>check.label==='工作方法授权')?.pass,false);
  plan.agents[0].tools.push('knowledge_read');
  assert.equal(validatePlan(plan,policy,[],false).checks.find(check=>check.label==='工作方法授权')?.pass,true);
  assert.equal(planSchema.safeParse({...plan,runInputs:[input,{...input,id:'other'}]}).success,false);
});
