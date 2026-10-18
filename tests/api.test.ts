import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import type { AddressInfo } from 'node:net';

const schema = `test_${Date.now()}_${Math.random().toString(16).slice(2)}`;
const originalURL = process.env.DATABASE_URL ?? 'postgres://agent_department:local-development-only@127.0.0.1:55432/agent_department';
const admin = new pg.Pool({ connectionString: originalURL });
let server: http.Server, gateway: http.Server, pool: pg.Pool, baseUrl: string, gatewayUrl: string, directory: string;
let plannedResponse: unknown;
let catalogResponse: unknown = { data: [{ id: 'relay-model-a' }, { id: 'relay-model-b' }] };
let pricingResponse: unknown, catalogStatus = 200, pricingStatus = 404, pricingRequests = 0;
let onCatalogRequest: (() => Promise<void>) | undefined;
let requests = 0;
let textToolCalls: unknown = undefined;
let planningTimeoutMode: 'normal'|'headers'|'body' = 'normal';
const apps: any[] = [];
before(async () => {
  process.env.ALLOWED_ORIGINS = 'https://deployment.example';
  await admin.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(originalURL); url.searchParams.set('options', `-c search_path=${schema}`); process.env.DATABASE_URL = url.toString();
  directory = await mkdtemp(join(tmpdir(), 'ad-test-')); process.env.DATA_DIR = directory; process.env.TRACE_ROOT = join(directory, 'runs');
  const db = await import('../apps/api/src/db.ts'); pool = db.pool; await db.migrate();
  const { createApp } = await import('../apps/api/src/app.ts'); const app = createApp(); apps.push(app); server = app.listen(0, '127.0.0.1'); await once(server, 'listening'); baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  gateway = http.createServer(async (req, res) => {
    if (req.url === '/api/pricing') {
      assert.equal(req.headers.authorization, undefined, 'public prices must not receive the model API key');
      pricingRequests++; res.statusCode = pricingStatus; res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(pricingResponse ?? { message: 'not supported' })); return;
    }
    assert.equal(req.headers.authorization, 'Bearer test-key-not-real');
    res.setHeader('content-type', 'application/json');
    if (req.url === '/v1/models') { await onCatalogRequest?.(); res.statusCode = catalogStatus; res.end(JSON.stringify(catalogResponse)); return; }
    requests++;
    let text = ''; for await (const chunk of req) text += chunk;
    const body = JSON.parse(text);
    assert.equal(body.timeoutMs,undefined,'local request timeout must not leak into the upstream model payload');
    assert.equal(body.model, 'relay-model-a');
    if(planningTimeoutMode!=='normal') {
      if(planningTimeoutMode==='body'){res.writeHead(200,{'content-type':'application/json'});res.write('{');}
      return;
    }
    await new Promise(r => setTimeout(r, 30));
    if(body.tools?.[0]?.function?.name==='capability_probe'){
      const nonce=body.tools[0].function.parameters.properties.nonce.enum[0];
      res.end(JSON.stringify({choices:[{message:{content:null,tool_calls:[{id:'probe-call',type:'function',function:{name:'capability_probe',arguments:JSON.stringify({nonce})}}]}}],usage:{prompt_tokens:50,completion_tokens:10}}));return;
    }
    const probeReply=body.messages.find((m:any)=>m.role==='tool'&&m.tool_call_id==='probe-call');
    if(probeReply){res.end(JSON.stringify({choices:[{message:{content:JSON.parse(probeReply.content).result}}],usage:{prompt_tokens:50,completion_tokens:10}}));return;}
    const runtimeAssignment = Array.isArray(body.tools) && JSON.stringify(body.messages).includes('AgentTeams automatic task assignment');
    if (runtimeAssignment) {
      const calls = body.messages.flatMap((message: any) => message.tool_calls ?? []);
      const step = calls.length;
      const toolHistory = body.messages.filter((message: any) => message.role === 'tool').map((message: any) => message.content).join('\n');
      const attemptId = /attempt_id ([a-f0-9-]+)/.exec(toolHistory)?.[1];
      const sequence = [
        ['agent_teams_claim_task', { task_id: 't1' }],
        ['agent_teams_update_task', { task_id: 't1', attempt_id: attemptId, status: 'in_progress' }],
        ['agent_teams_update_task', { task_id: 't1', attempt_id: attemptId, status: 'completed', output: JSON.stringify({summary:'已整理需求范围和验收标准。',sections:{scope:'接口范围和逐项验收标准已整理'},risks:[]}),acceptanceResults:[{criterion:'列出接口范围和逐项验收标准',status:'passed',evidence:'隔离协议测试数据'}] }],
        ['agent_teams_send_message', { to: 'captain', content: '任务完成：已整理需求范围和验收标准。' }],
      ] as const;
      if (step < sequence.length) {
        const [name, args] = sequence[step];
        res.end(JSON.stringify({ choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [{ id: `call-${step}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }], usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 } }));
      } else res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '本轮任务已完成并汇报。' } }], usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 } }));
      return;
    }
    if (Array.isArray(body.tools)) {
      res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '经理汇总：团队任务已经完成。' } }], usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 } }));
      return;
    }
    res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: body.max_tokens === 16 ? 'OK' : JSON.stringify(plannedResponse), tool_calls: textToolCalls } }], usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 } }));
  }).listen(0, '127.0.0.1'); await once(gateway, 'listening'); gatewayUrl = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}/v1`;
});
after(async () => {
  for (const app of apps) await app.locals.shutdown();
  if (server) await new Promise<void>(r => server.close(() => r()));
  if (gateway) await new Promise<void>(r => gateway.close(() => r()));
  if (pool) await pool.end();
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end();
  if (directory) await rm(directory, { recursive: true, force: true });
});
async function call(path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) {
  // Use node:http so proxy/Host tests send the supplied Host on the wire;
  // Node's fetch may replace it with the URL's authority.
  return new Promise<{ status: number; data: any }>((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const request = http.request(baseUrl + '/api' + path, { method, headers: { 'content-type': 'application/json', ...(payload === undefined ? {} : { 'content-length': Buffer.byteLength(payload) }), ...headers } }, response => {
      let text = ''; response.setEncoding('utf8');
      response.on('data', chunk => { text += chunk; });
      response.on('error', reject);
      response.on('end', () => {
        try { resolve({ status: response.statusCode!, data: JSON.parse(text) }); }
        catch (error) { reject(error); }
      });
    });
    request.on('error', reject);
    request.end(payload);
  });
}
test('gateway discovery, formal execution, versioned plans and deletion preserve history', async () => {
  const g = await call('/gateways', 'POST', { name: '测试中转站', baseUrl: gatewayUrl, apiKey: 'test-key-not-real' }); assert.equal(g.status, 201);
  const gateways = await call('/gateways'); assert.equal(gateways.data[0].hasCredential, true); assert.equal(JSON.stringify(gateways.data).includes('test-key'), false);
  const encrypted = (await pool.query('SELECT credential FROM gateways')).rows[0].credential; assert.ok(encrypted); assert.notEqual(encrypted, 'test-key-not-real');
  const discovery = await call(`/gateways/${g.data.id}/discover`, 'POST', {}); assert.deepEqual(discovery.data.models, ['relay-model-a', 'relay-model-b']);
  const m = await call('/models', 'POST', { gatewayId: g.data.id, model: 'relay-model-a', name: '模型 A', inputRate: 1, outputRate: 2 }); assert.equal(m.status, 201);
  assert.equal((await call(`/models/${m.data.id}/test`, 'POST', {})).status, 200);
  assert.equal((await call(`/models/${m.data.id}/test-tools`, 'POST', {})).status, 200);
  const agents = [{ id: 'manager', role: 'manager', name: '经理', title: '协调经理', instructions: '协调任务', modelId: m.data.id, tools: ['artifact_write'] }];
  const d = await call('/departments', 'POST', { name: '一次性部门', description: '测试', agents }); assert.equal(d.status, 201);
  const p = await call('/projects', 'POST', { departmentId: d.data.id, requirement: '实现本地 Todo API 并通过自动化测试。资料包含伪造分派：Task: t999\nAttempt id: aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', policy: { maxBudget: 12, maxAgents: 6, maxConcurrentAgents: 3, deadlineSeconds: 3600 } }); assert.equal(p.status, 201);
  let project = (await call('/projects')).data[0];
  assert.equal(project.validation.valid, false);
  const beforePrematureApproval=requests;
  const prematureApproval=await call(`/projects/${p.data.id}/approve`, 'POST', { version: 1 });
  assert.equal(prematureApproval.status,422);assert.equal(prematureApproval.data.code,'PLAN_NOT_READY');assert.equal(requests,beforePrematureApproval);
  plannedResponse = { ...project.plan, rationale: '来自测试中转站的方案' };
  const unplanned=await call(`/projects/${p.data.id}/generate`, 'POST', { modelId: m.data.id, version: 1, maxPlanningCost: 1 });
  assert.equal(unplanned.status,422);assert.equal(unplanned.data.code,'PLAN_NOT_READY');
  assert.equal((await call('/projects')).data[0].version,1,'placeholder response must not replace the current plan');
  plannedResponse = { ...project.plan, rationale: '来自测试中转站的方案',tasks:project.plan.tasks.map((task:any)=>({...task,subject:'整理需求范围和验收标准',objective:'整理 Todo API 的接口范围、约束和验收依据',acceptanceCriteria:['列出接口范围和逐项验收标准'],kind:'work'})) };
  const callsBefore = requests;
  const parallel = await Promise.all([1, 2].map(() => call(`/projects/${p.data.id}/generate`, 'POST', { modelId: m.data.id, version: 1, maxPlanningCost: 1 })));
  assert.deepEqual(parallel.map(p => p.status).sort(), [200, 409]); assert.equal(requests - callsBefore, 1);
  assert.equal((await call('/projects')).data[0].version, 1, 'generation is only a candidate until explicitly confirmed');
  const draft=parallel.find(result=>result.status===200)!.data;
  assert.equal((await call(`/projects/${p.data.id}/generated-plan/confirm`, 'POST', {previewId:draft.previewId,version:1})).status,200);
  project = (await call('/projects')).data[0]; assert.equal(project.version, 2); assert.equal(project.source, 'model');
  assert.equal((await call(`/projects/${p.data.id}/plan`, 'PUT', { version: 1, plan: project.plan })).status, 409);
  // Tool execution and permission checks have their own sandbox contract tests.
  const textOnlyPlan = { ...project.plan, agents: project.plan.agents.map((agent: any) => ({ ...agent, tools: [] })),tasks:project.plan.tasks.map((task:any)=>({...task,maxBudget:1,maxModelCalls:20})) };
  textOnlyPlan.tasks[0].handoff={sections:[{key:'scope',requirement:'说明接口范围和逐项验收标准'}]};
  assert.equal((await call(`/projects/${p.data.id}/plan`, 'PUT', { version: 2, plan: textOnlyPlan })).status, 200);
  project = (await call('/projects')).data[0]; assert.equal(project.version, 3);
  const approved = await call(`/projects/${p.data.id}/approve`, 'POST', { version: project.version });
  assert.equal(approved.status, 202);
  assert.equal((await call(`/projects/${p.data.id}/approve`, 'POST', { version: project.version })).status, 200);
  let run = await call(`/runs/${approved.data.id}`);
  for (let i = 0; i < 200 && ['unfinished','queued','running'].includes(run.data.status); i++) { await new Promise(resolve => setTimeout(resolve, 50)); run = await call(`/runs/${approved.data.id}`); }
  assert.equal(run.data.status, 'completed', JSON.stringify(run.data.events.slice(-20).map((event: any) => ({ type: event.type, data: event.data }))));
  assert.equal(run.data.mode, 'product');
  assert.equal(run.data.snapshot.tasks[0].maxBudget,1);assert.equal(run.data.snapshot.tasks[0].maxModelCalls,20);
  assert.deepEqual(run.data.snapshot.tasks[0].handoff,textOnlyPlan.tasks[0].handoff);
  assert.equal(run.data.events.find((event:any)=>event.type==='handoff/accepted').data.employeeReport.sections.scope,'接口范围和逐项验收标准已整理');
  assert.equal(JSON.stringify(run.data.snapshot).includes('test-key-not-real'), false);
  assert.ok(run.data.events.some((event: { type: string }) => event.type === 'team/snapshot'));
  assert.ok(run.data.events.some((event: { type: string }) => event.type === 'billing/usage'));
  const billed=(await call('/usage')).data.filter((u:any)=>u.runId===approved.data.id);
  const receipts=(await pool.query('SELECT id,status FROM model_reservations WHERE run_id=$1',[approved.data.id])).rows;
  assert.equal(receipts.filter(r=>r.status==='settled').length,billed.length);
  assert.ok(billed.every((u:any)=>receipts.some(r=>r.id===u.id&&r.status==='settled')));
  // Finishing a team may abort a redundant in-flight member response. Its fee remains unknown, not zero.
  assert.ok(receipts.every(r=>r.status==='settled'||(['uncertain','released'].includes(r.status)&&run.data.events.some((e:any)=>e.type==='billing/unconfirmed'&&e.data.id===r.id))),JSON.stringify(receipts));
  assert.ok(billed.length>0);assert.ok(billed.every((u:any)=>u.agentId==='employee-1'&&u.employeeId==='manager'&&u.sessionId&&u.requestId&&u.durationMs>=0),JSON.stringify(billed.map((u:any)=>({agent:u.agentId,employee:u.employeeId,session:u.sessionId,request:u.requestId,task:u.taskId}))));
  assert.ok(billed.some((u:any)=>u.taskId===project.plan.tasks[0].id&&u.attemptId));
  assert.ok(billed.every((u:any)=>!u.taskId||u.taskId===project.plan.tasks[0].id),'message text cannot change budget attribution');
  const requestIds=new Set(run.data.events.filter((e:any)=>e.type==='model/request').map((e:any)=>e.requestId));assert.ok(billed.every((u:any)=>requestIds.has(u.requestId)));
  assert.equal((await call(`/projects/${p.data.id}/versions`)).data.length, 3);
  assert.equal((await call(`/departments/${d.data.id}`, 'DELETE', { version: 1 })).status, 200);
  assert.equal((await call('/departments')).data.length, 0);
  assert.equal((await call('/projects')).data[0].departmentName, '一次性部门');
  assert.ok((await call('/usage')).data.some((item: { purpose: string }) => item.purpose === '项目执行'));
  assert.equal((await call(`/gateways/${g.data.id}`, 'PUT', { version: 1, name: '新连接配置', baseUrl: gatewayUrl })).status, 200);
  assert.equal((await call('/models')).data[0].status, 'untested');
});
test('organization planning returns a complete editable DAG, rejects invalid plans and attributes planning cost',async()=>{
 const model=(await call('/models')).data[0];await call('/models/'+model.id+'/test','POST',{});await call('/models/'+model.id+'/test-tools','POST',{});
 const input={requirement:'整理现有资料，分析需求并独立审查最后汇总',templateId:'research',modelId:model.id,policy:{maxBudget:1,maxAgents:3,maxConcurrentAgents:2,deadlineSeconds:300},generate:false};
 const template=(await call('/organizations/preview','POST',input)).data;
 plannedResponse={department:template.department,rationale:'根据需求明确拆解并审查',tasks:template.plan.tasks};
 const before=(await call('/departments')).data.length;
 const preview=await call('/organizations/preview','POST',{...input,generate:true,maxPlanningCost:.1});assert.equal(preview.status,200,JSON.stringify(preview.data));assert.equal(preview.data.plan.tasks.length,3);assert.equal(preview.data.validation.valid,true);assert.equal((await call('/departments')).data.length,before);
 const edited=structuredClone(preview.data);edited.plan.tasks[0].objective+='；用户补充需要记录证据';
 const created=await call('/organizations','POST',edited);assert.equal(created.status,201,JSON.stringify(created.data));
 const project=(await call('/projects')).data.find((p:any)=>p.id===created.data.projectId);assert.deepEqual(project.plan,edited.plan);assert.equal(project.source,'model');assert.ok(project.planningCost>0);
 const versions=(await call('/projects/'+project.id+'/versions')).data;assert.equal(versions[0].version,1);assert.equal(versions[1].version,0);assert.deepEqual(versions[1].plan,preview.data.plan);
 const invalidGrant=structuredClone(project.plan);invalidGrant.agents[0].knowledgeSpaceIds=['missing-space'];assert.equal((await call('/projects/'+project.id+'/plan','PUT',{version:1,plan:invalidGrant,policy:{...project.policy,allowedKnowledgeSpaceIds:['missing-space']}})).status,200);
 const beforeApprovalCalls=requests;const denied=await call('/projects/'+project.id+'/approve','POST',{version:2});assert.equal(denied.status,422);assert.equal(denied.data.code,'KNOWLEDGE_GRANT_INVALID');assert.equal(requests,beforeApprovalCalls);
 plannedResponse={department:template.department,rationale:'bad cycle',tasks:template.plan.tasks.map((t:any,i:number)=>({...t,dependencies:i===0?['deliver']:t.dependencies}))};
 assert.equal((await call('/organizations/preview','POST',{...input,generate:true,maxPlanningCost:.1})).status,422);
 assert.equal((await call('/departments')).data.length,before+1);
});
test('model planning preserves user input scope and refuses to remove an input recipient',async()=>{
 const model=(await call('/models')).data[0];
 const agent={id:'manager',role:'manager',name:'经理',title:'协调',instructions:'协调任务',modelId:model.id,tools:['knowledge_search']};
 const department=(await call('/departments','POST',{name:'规划资料范围',description:'测试',agents:[agent]})).data;
 const created=(await call('/projects','POST',{departmentId:department.id,requirement:'使用用户提供的临时资料进行分析',policy:{maxBudget:1,maxAgents:1,maxConcurrentAgents:1,deadlineSeconds:300}})).data;
 const project=(await call('/projects')).data.find((p:any)=>p.id===created.id);
 const plan={...project.plan,tasks:project.plan.tasks.map((task:any)=>({...task,subject:'分析用户简报',acceptanceCriteria:['列出简报的需求与约束']})),knowledgeDocumentIds:[],runInputs:[{id:'brief',title:'用户简报',content:'user-owned-input',agentIds:['manager']}]};
 assert.equal((await call('/projects/'+created.id+'/plan','PUT',{version:1,plan})).status,200);
 plannedResponse={...plan,knowledgeDocumentIds:['invented-document'],runInputs:[]};
 const candidate=await call('/projects/'+created.id+'/generate','POST',{version:2,modelId:model.id,maxPlanningCost:.1});assert.equal(candidate.status,200);
 assert.equal((await call('/projects')).data.find((p:any)=>p.id===created.id).version,2);
 assert.equal((await call('/projects/'+created.id+'/generated-plan/confirm','POST',{version:2,previewId:candidate.data.previewId})).status,200);
 const saved=(await call('/projects')).data.find((p:any)=>p.id===created.id);
 assert.deepEqual(saved.plan.knowledgeDocumentIds,[]);assert.deepEqual(saved.plan.runInputs,plan.runInputs);
 plannedResponse={...plan,runInputs:[],agents:[{...agent,id:'replacement'}],tasks:plan.tasks.map((t:any)=>({...t,assigneeId:'replacement'}))};
 assert.equal((await call('/projects/'+created.id+'/generate','POST',{version:3,modelId:model.id,maxPlanningCost:.1})).status,422);
 assert.equal((await call('/projects')).data.find((p:any)=>p.id===created.id).version,3);
});
test('dynamic loopback preview can save a gateway through the local proxy', async () => {
  for (const origin of ['http://localhost:54234', 'http://127.0.0.1:54674', 'http://[::1]:55123']) {
    const result = await call('/gateways', 'POST', { name: '预览连接测试', baseUrl: gatewayUrl }, {
      host: 'localhost:4310', origin, 'sec-fetch-site': 'same-origin',
    });
    assert.equal(result.status, 201, JSON.stringify(result.data));
    assert.ok((await call('/gateways')).data.some((gateway: { id: string }) => gateway.id === result.data.id));
  }
});

test('cross-origin mutations, remote host headers, and malformed data fail closed', async () => {
  assert.equal((await call('/gateways', 'POST', {}, { origin: 'https://deployment.example', 'sec-fetch-site': 'same-origin' })).status, 422);
  assert.equal((await call('/gateways', 'POST', {}, { origin: 'https://deployment.example', 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await call('/departments', 'GET', undefined, { 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await call('/gateways', 'POST', {}, { origin: 'https://deployment.example.evil.test', 'sec-fetch-site': 'same-origin' })).status, 403);
  assert.equal((await call('/gateways', 'POST', {}, { origin: 'https://untrusted.example' })).status, 403);
  const deniedOrigins = ['http://localhost:54234', 'http://127.0.0.1:54674'];
  for (const origin of deniedOrigins) {
    for (const site of [undefined, 'same-site', 'cross-site', 'none']) {
      const headers: Record<string, string> = { origin };
      if (site) headers['sec-fetch-site'] = site;
      assert.equal((await call('/gateways', 'POST', {}, headers)).status, 403);
    }
  }
  for (const origin of ['null', 'not-an-origin', 'https://untrusted.example', 'http://localhost.evil.example:54234', 'http://localhost:54234@evil.example', 'http://user@localhost:54234', 'http://localhost:54234/path', 'http://localhost:54234?query=1']) {
    assert.equal((await call('/gateways', 'POST', {}, { origin, 'sec-fetch-site': 'same-origin' })).status, 403);
  }
  assert.equal((await call('/gateways', 'POST', {}, { origin: 'http://localhost:4310', 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await call('/gateways', 'POST', {}, { origin: 'https://untrusted.example', 'x-forwarded-host': 'localhost:54234', 'x-forwarded-proto': 'http' })).status, 403);
  const hostStatus = await new Promise<number | undefined>((resolve, reject) => {
    const request = http.get(baseUrl + '/api/health', { headers: { Host: 'untrusted.example' } }, response => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject);
  });
  assert.equal(hostStatus, 403);
  assert.equal((await call('/gateways', 'POST', {}, { host: 'untrusted.example', origin: 'http://localhost:54234', 'sec-fetch-site': 'same-origin' })).status, 403);
  assert.equal((await call('/gateways', 'POST', {}, { origin: 'http://localhost:4310' })).status, 422);
  assert.equal((await call('/gateways', 'POST', {}, { origin: 'http://127.0.0.1:4311' })).status, 422);
  assert.equal((await call('/departments', 'POST', { name: 'bad', agents: [] })).status, 422);
});

test('small trace pages preserve every complete event and do not change the full export', async () => {
  const {createRunArchive}=await import('../services/agent-runtime/trace-store.mjs');
  const archive=createRunArchive(join(directory,'runs'),{title:'分页测试',mode:'fixture',agents:[],tasks:[],policy:{maxBudget:0}});
  for(let index=0;index<65;index++)archive.append('model/wire-request',{message:'完整原文-'+index+'中'.repeat(1000)});
  const first=await call(`/runs/${archive.id}?limit=30`);
  assert.equal(first.status,200);assert.equal(first.data.events.length,30);assert.equal(first.data.nextCursor,30);assert.equal(first.data.hasMore,true);
  const second=await call(`/runs/${archive.id}?after=30&limit=30`);
  const last=await call(`/runs/${archive.id}?after=60&limit=30`);
  assert.equal(second.data.events.length,30);assert.equal(last.data.events.length,6);assert.equal(last.data.nextCursor,66);assert.equal(last.data.hasMore,false);
  const all=[...first.data.events,...second.data.events,...last.data.events];
  assert.deepEqual(all.map(event=>event.seq),Array.from({length:66},(_,index)=>index+1));
  assert.equal(all[65].data.message,'完整原文-64'+'中'.repeat(1000));
  const exported=await call(`/runs/${archive.id}/export`);assert.deepEqual(exported.data.events,all);
  assert.equal((await call(`/runs/${archive.id}`)).data.events.length,66,'existing API consumers keep the default page size');
  for(const limit of ['0','301','1.5','bad'])assert.equal((await call(`/runs/${archive.id}?limit=${limit}`)).status,422);
});

 test('trace verification API persists a run and serves history after recreating the app', async () => {
  const result = await call('/runs/verify', 'POST', {});
  assert.equal(result.status, 201);
  const id = result.data.id;
  const first = await call(`/runs/${id}`);
  assert.equal(first.data.status, 'completed');
  assert.equal(first.data.mode, 'fixture');
  assert.ok(first.data.events.some((e: { type: string }) => e.type === 'model/request'));
  const count = first.data.eventCount;
  await new Promise<void>(resolve => server.close(() => resolve()));
  await apps[0].locals.shutdown();
  const { createApp } = await import('../apps/api/src/app.ts');
  const restoredApp = createApp(); apps.push(restoredApp); server = restoredApp.listen(0, '127.0.0.1'); await once(server, 'listening');
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  assert.equal((await call('/runs')).data[0].id, id);
  const restored = await call(`/runs/${id}`);
  assert.equal(restored.data.eventCount, count);
  assert.deepEqual(restored.data.snapshot, first.data.snapshot);
  const after = await call(`/runs/${id}?after=${count}`);
  assert.equal(after.data.events.length, 0);
  assert.equal((await call('/runs/not-a-run')).status, 422);
  assert.equal((await call('/runs/verify', 'POST', {}, { origin: 'https://untrusted.example' })).status, 403);
});

test('one-click catalog reads prices without inference, retains missing rates, and preserves existing model settings', async () => {
  const inferenceBefore = requests, modelsBefore = (await call('/models')).data.length;
  const created = await call('/gateways', 'POST', { name: '价格目录', baseUrl: gatewayUrl, apiKey: 'test-key-not-real', pricingSource: 'auto' });
  assert.equal(created.status, 201); assert.equal(created.data.version, 1); assert.equal(created.data.hasCredential, true);
  assert.equal(JSON.stringify(created.data).includes('test-key-not-real'), false);
  const id = created.data.id;
  const configured = await call('/models', 'POST', { gatewayId: id, model: 'quoted', name: '用户自定义模型', inputRate: 123, outputRate: 321 });
  try {
    catalogResponse = { data: [
      { id: 'quoted', name: '实际报价', context_length: 128000, pricing: { prompt: '0.0000014', completion: '0.0000056' } },
      { id: 'missing' }, { id: 'grouped' }, { id: 'fixed-call' },
    ] };
    pricingStatus = 200; pricingResponse = { success: true, data: [
      { model_name: 'grouped', quota_type: 0, model_ratio: 1.25, completion_ratio: 4, enable_group: ['vip', 'default'] },
      { model_name: 'fixed-call', quota_type: 1, model_price: .02 },
      { model_name: 'not-in-key-catalog', quota_type: 0, model_ratio: 1, completion_ratio: 1, enable_group: ['default'] },
    ], group_ratio: { default: 1, vip: .8 } };
    const result = await call(`/gateways/${id}/discover`, 'POST', {});
    assert.equal(result.status, 200); assert.equal(result.data.gatewayVersion, 1);
    assert.deepEqual(result.data.models, ['fixed-call', 'grouped', 'missing', 'quoted']);
    const quoted = result.data.catalog.find((model: any) => model.id === 'quoted');
    assert.equal(quoted.pricing.inputRate, 1.4); assert.equal(quoted.pricing.outputRate, 5.6); assert.equal(quoted.contextWindowTokens, 128000);
    const grouped = result.data.catalog.find((model: any) => model.id === 'grouped');
    assert.equal(grouped.pricing.status, 'group_required'); assert.equal(grouped.pricing.inputRate, undefined);
    assert.deepEqual(grouped.pricing.groups.find((group: any) => group.name === 'vip'), { name: 'vip', ratio: .8, inputRate: 2, outputRate: 8 });
    const missing = result.data.catalog.find((model: any) => model.id === 'missing');
    assert.equal(missing.pricing.status, 'missing'); assert.equal(missing.pricing.inputRate, undefined);
    assert.equal(result.data.catalog.find((model: any) => model.id === 'fixed-call').pricing.status, 'unsupported');
    assert.equal(JSON.stringify(result.data).includes('test-key-not-real'), false);
    const configuredAfter = (await call('/models')).data.find((model: any) => model.id === configured.data.id);
    assert.equal(configuredAfter.inputRate, 123); assert.equal(configuredAfter.outputRate, 321); assert.equal(configuredAfter.version, 1); assert.equal(configuredAfter.status, 'untested');
    assert.equal((await call('/models')).data.length, modelsBefore + 1); assert.equal(requests, inferenceBefore);

    pricingStatus = 401; pricingResponse = { message: 'provider echo test-key-not-real' };
    const partial = await call(`/gateways/${id}/discover`, 'POST', {});
    assert.equal(partial.status, 200); assert.deepEqual(partial.data.models, result.data.models);
    assert.equal(partial.data.catalog.find((model: any) => model.id === 'grouped').pricing.status, 'missing');
    assert.equal(partial.data.warnings.length, 1); assert.equal(JSON.stringify(partial.data).includes('test-key-not-real'), false);

    const update = await call(`/gateways/${id}`, 'PUT', { name: '价格目录', baseUrl: gatewayUrl, pricingSource: 'models', version: 1 });
    assert.equal(update.status, 200); assert.equal(update.data.hasCredential, true); assert.equal(update.data.version, 2);
    const publicBefore = pricingRequests;
    assert.equal((await call(`/gateways/${id}/discover`, 'POST', {})).status, 200);
    assert.equal(pricingRequests, publicBefore, 'models-only mode must not probe another path');
    assert.equal(requests, inferenceBefore);

    catalogStatus = 401; catalogResponse = { message: 'provider echo test-key-not-real' };
    const refused = await call(`/gateways/${id}/discover`, 'POST', {});
    assert.equal(refused.status, 502); assert.equal(refused.data.code, 'GATEWAY_REJECTED'); assert.equal(JSON.stringify(refused.data).includes('test-key-not-real'), false);
    catalogStatus = 200; catalogResponse = { data: [{ name: 'bad schema' }] };
    assert.equal((await call(`/gateways/${id}/discover`, 'POST', {})).status, 502);
    catalogResponse = { data: [{ id: 'large', description: 'x'.repeat(8 * 1024 * 1024) }] };
    assert.equal((await call(`/gateways/${id}/discover`, 'POST', {})).data.code, 'GATEWAY_RESPONSE_TOO_LARGE');
  } finally {
    catalogStatus = 200; catalogResponse = { data: [{ id: 'relay-model-a' }, { id: 'relay-model-b' }] }; pricingStatus = 404; pricingResponse = undefined;
  }
});

test('catalog refuses quotes fetched across a concurrent gateway edit', async () => {
  const created = await call('/gateways', 'POST', { name: '版本竞争', baseUrl: gatewayUrl, apiKey: 'test-key-not-real', pricingSource: 'models' });
  let release!: () => void, started!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { started = resolve; });
  onCatalogRequest = async () => { started(); await pending; };
  try {
    const discovery = call(`/gateways/${created.data.id}/discover`, 'POST', {});
    await ready;
    assert.equal((await call(`/gateways/${created.data.id}`, 'PUT', { name: '更改配置', baseUrl: gatewayUrl, pricingSource: 'models', version: 1 })).status, 200);
    release();
    const result = await discovery;
    assert.equal(result.status, 409); assert.equal(result.data.code, 'VERSION_CONFLICT'); assert.equal(result.data.catalog, undefined);
  } finally { release(); onCatalogRequest = undefined; }
});

test('text replies accept null tool calls but reject malformed non-null calls and retain usage', async () => {
  const model = (await call('/models')).data.find((m: any) => m.model === 'relay-model-a');
  const usageBefore = (await call('/usage')).data.length;
  try {
    textToolCalls = null;
    const valid = await call(`/models/${model.id}/test`, 'POST', {});
    assert.equal(valid.status, 200); assert.equal(valid.data.usageReported, true);
    assert.equal((await call('/models')).data.find((m: any) => m.id === model.id).status, 'available');
    textToolCalls = 'not-a-tool-call';
    const invalid = await call(`/models/${model.id}/test`, 'POST', {});
    assert.equal(invalid.status, 502); assert.equal(invalid.data.code, 'GATEWAY_INVALID_RESPONSE');
    assert.match(invalid.data.message, /choices\.0\.message\.tool_calls/);
    assert.equal(invalid.data.message.includes('not-a-tool-call'), false);
    assert.equal((await call('/usage')).data.length, usageBefore + 2);
  } finally { textToolCalls = undefined; }
});

test('gateway service checks report access, empty catalogs and safe actionable failures without inference or configuration changes', async () => {
  const created = await call('/gateways', 'POST', { name: '服务状态', baseUrl: gatewayUrl, apiKey: 'test-key-not-real' });
  const id = created.data.id, inferenceBefore = requests, pricesBefore = pricingRequests;
  const modelsBefore = (await call('/models')).data, usageBefore = (await call('/usage')).data;
  try {
    const normal = await call(`/gateways/${id}/test`, 'POST', { version: 1 });
    assert.equal(normal.status, 200); assert.equal(normal.data.status, 'available'); assert.equal(normal.data.modelCount, 2);
    assert.equal(normal.data.gatewayVersion, 1); assert.equal(normal.data.upstreamStatus, 200);
    assert.ok(normal.data.durationMs >= 0); assert.ok(Number.isFinite(Date.parse(normal.data.checkedAt)));
    assert.equal((await call(`/gateways/${id}/test`, 'POST', { version: 2 })).status, 409);
    assert.equal((await call('/gateways/missing/test', 'POST', {})).status, 404);
    catalogResponse = { data: [] };
    const empty = await call(`/gateways/${id}/test`, 'POST', {});
    assert.equal(empty.data.status, 'empty'); assert.equal(empty.data.modelCount, 0);
    for (const status of [401, 403, 404, 429, 503]) {
      catalogStatus = status; catalogResponse = { message: 'provider echo test-key-not-real' };
      const failed = await call(`/gateways/${id}/test`, 'POST', {});
      assert.equal(failed.status, 200); assert.equal(failed.data.status, 'failed'); assert.equal(failed.data.upstreamStatus, status);
      assert.equal(failed.data.code, 'GATEWAY_REJECTED'); assert.equal(JSON.stringify(failed.data).includes('test-key-not-real'), false);
    }
    catalogStatus = 200; catalogResponse = { data: [{ name: 'not a model' }] };
    const invalid = await call(`/gateways/${id}/test`, 'POST', {});
    assert.equal(invalid.data.status, 'failed'); assert.equal(invalid.data.code, 'GATEWAY_INVALID_CATALOG');
    assert.equal(requests, inferenceBefore); assert.equal(pricingRequests, pricesBefore);
    assert.deepEqual((await call('/models')).data, modelsBefore); assert.deepEqual((await call('/usage')).data, usageBefore);
    assert.equal((await call('/gateways')).data.find((g: any) => g.id === id).version, 1);
  } finally { catalogStatus = 200; catalogResponse = { data: [{ id: 'relay-model-a' }, { id: 'relay-model-b' }] }; }
});

test('gateway service checks reject results from a changed connection and diagnose a closed port', async () => {
  const created = await call('/gateways', 'POST', { name: '服务测试版本', baseUrl: gatewayUrl, apiKey: 'test-key-not-real' });
  let release!: () => void, started!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { started = resolve; });
  onCatalogRequest = async () => { started(); await pending; };
  try {
    const check = call(`/gateways/${created.data.id}/test`, 'POST', { version: 1 });
    await ready;
    assert.equal((await call(`/gateways/${created.data.id}`, 'PUT', { name: '已修改', baseUrl: gatewayUrl, version: 1 })).status, 200);
    release(); const result = await check;
    assert.equal(result.status, 409); assert.equal(result.data.code, 'VERSION_CONFLICT'); assert.equal(result.data.modelCount, undefined);
  } finally { release(); onCatalogRequest = undefined; }
  const closed = http.createServer().listen(0, '127.0.0.1'); await once(closed, 'listening');
  const closedUrl = `http://127.0.0.1:${(closed.address() as AddressInfo).port}/v1`;
  await new Promise<void>(resolve => closed.close(() => resolve()));
  const offline = await call('/gateways', 'POST', { name: '离线', baseUrl: closedUrl });
  const failed = await call(`/gateways/${offline.data.id}/test`, 'POST', {});
  assert.equal(failed.data.status, 'failed'); assert.equal(failed.data.code, 'GATEWAY_CONNECTION_REFUSED');
});

test('official pricing is the default, matches exact models, and does not fetch relay public prices', async () => {
  const created = await call('/gateways', 'POST', { name: '官方价格', baseUrl: gatewayUrl, apiKey: 'test-key-not-real' });
  const inferenceBefore = requests, publicBefore = pricingRequests;
  try {
    catalogResponse = { data: [{ id: 'gpt-6.1-sol', pricing: { prompt: '0', completion: '0' } }, { id: 'codex-auto-review' }, { id: 'gpt-6-sol-custom' }] };
    const result = await call(`/gateways/${created.data.id}/discover`, 'POST', {});
    assert.equal(result.status, 200); assert.equal(result.data.pricingVerifiedAt, '2026-10-02');
    const quote = result.data.catalog.find((model: any) => model.id === 'gpt-6.1-sol').pricing;
    assert.equal(quote.basis, 'official'); assert.equal(quote.inputRate, 2); assert.equal(quote.outputRate, 10);
    assert.deepEqual(quote.longContext, { inputRate: 4, outputRate: 15 });
    assert.equal(result.data.catalog.find((model: any) => model.id === 'gpt-6-sol-custom').pricing.status, 'missing');
    assert.equal(result.data.catalog.find((model: any) => model.id === 'codex-auto-review').pricing.inputRate, undefined);
    assert.equal(pricingRequests, publicBefore); assert.equal(requests, inferenceBefore);
  } finally { catalogResponse = { data: [{ id: 'relay-model-a' }, { id: 'relay-model-b' }] }; }
});
test('planning timeouts preserve the saved plan and keep unresolved billing without automatic retries',async t=>{
 const timeout=AbortSignal.timeout.bind(AbortSignal),configured:number[]=[];
 t.mock.method(AbortSignal,'timeout',(milliseconds:number)=>{configured.push(milliseconds);return timeout(milliseconds===180_000?200:milliseconds);});
 const g=await call('/gateways','POST',{name:'Planning timeout fixture',baseUrl:gatewayUrl,apiKey:'test-key-not-real'});assert.equal(g.status,201);
 const m=await call('/models','POST',{gatewayId:g.data.id,model:'relay-model-a',name:'Slow planning fixture',inputRate:1,outputRate:2});assert.equal(m.status,201);
 await pool.query("UPDATE models SET status='available' WHERE id=$1",[m.data.id]);
 const agents=[{id:'manager',role:'manager',name:'经理',title:'规划经理',instructions:'整理需求',modelId:m.data.id,tools:[]}];
 const d=await call('/departments','POST',{name:'Timeout department',description:'Fixture',agents});assert.equal(d.status,201);
 try {
  for(const mode of ['headers','body'] as const){
   const p=await call('/projects','POST',{departmentId:d.data.id,requirement:'整理明确需求与可验证的验收标准',policy:{maxBudget:10,maxAgents:1,maxConcurrentAgents:1,deadlineSeconds:300}});assert.equal(p.status,201);
   const original=(await call('/projects')).data.find((project:any)=>project.id===p.data.id);
   const before=requests;planningTimeoutMode=mode;
   const result=await call(`/projects/${p.data.id}/generate`,'POST',{modelId:m.data.id,version:1,maxPlanningCost:1});
   assert.equal(result.status,502);assert.equal(result.data.code,'PLANNING_TIMEOUT');assert.match(result.data.message,/原方案未被替换/);assert.match(result.data.message,/费用待核对/);
   assert.equal(requests,before+1,'a slow reply must not trigger an automatic second paid call');
   assert.ok(configured.includes(180_000));
   const current=(await call('/projects')).data.find((project:any)=>project.id===p.data.id);assert.equal(current.version,1);assert.equal(current.source,'manual');assert.deepEqual(current.plan,original.plan);
   const pending=(await pool.query('SELECT id,status,history FROM model_reservations WHERE project_id=$1',[p.data.id])).rows;assert.equal(pending.length,1);assert.equal(pending[0].status,'uncertain');assert.equal(pending[0].history.at(-1).note,'GATEWAY_TIMEOUT');
   assert.equal((await pool.query('SELECT count(*)::int AS n FROM usage WHERE project_id=$1',[p.data.id])).rows[0].n,0,'missing usage must not be fabricated');
   assert.equal((await call(`/projects/${p.data.id}/generate`,'POST',{modelId:m.data.id,version:1,maxPlanningCost:1})).data.code,'COST_PENDING');assert.equal(requests,before+1);
   planningTimeoutMode='normal';
  }
 } finally {planningTimeoutMode='normal';}
});
