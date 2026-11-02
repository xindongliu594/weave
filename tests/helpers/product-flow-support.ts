import {createArchiveWriterManager} from '../../services/agent-runtime/archive-writer-scope.mjs';
import { before, after, test, mock } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash,randomUUID,randomBytes } from 'node:crypto';
import {createRequire} from 'node:module';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import pg from 'pg';
import { RunSandbox, listArtifacts, artifactFile } from '../../services/agent-runtime/sandbox.mjs';
import { HandoffGate } from '../../services/agent-runtime/handoff.mjs';
import { fixtureTaskContext, fixtureRuntimeContextPrefix } from '../model-fixture.ts';

export function productFlowSchema(admin: Pick<pg.Pool, 'query'>) {
  const name = 'flow_' + randomUUID().replaceAll('-', '');
  let owned = false;
  return {
    name,
    async create() { await admin.query('CREATE SCHEMA ' + name); owned = true; },
    async drop() { if (owned) { await admin.query('DROP SCHEMA ' + name + ' CASCADE'); owned = false; } },
  };
}

export function registerProductFlowTests(group: 'native' | 'core' | 'rework' | 'escalation' | 'recovery' | 'recovery-rework') {
// The API, queue, billing and DSH host are real. Only the model and Docker
// boundary are test doubles in legacy scenarios. D1 uses a real desktop helper,
// temporary directories and fixed native commands with the actual DSH pipeline.
const base = process.env.DATABASE_URL ?? 'postgres://agent_department:local-development-only@127.0.0.1:55432/agent_department';
const admin = new pg.Pool({ connectionString: base });
const schema = productFlowSchema(admin);
const expected = JSON.parse(readFileSync(new URL('../fixtures/offline-handoff/expected/report.json', import.meta.url), 'utf8'));
const fixtureContextWindowTokens = 16384;
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
let app: any, server: http.Server, gateway: http.Server, pool: pg.Pool, directory: string, url: string;
let modelId: string, mode = 'pass', commands = 0, summaryCalls = 0,readFaults=0,mutations=0;
let verificationCommand='check-fixed-result';
let resourcePaused = false, resourcePlanningReply: any, resourceKnowledge: any;
const {LocalDeviceClient}=createRequire(import.meta.url)('../../apps/desktop/local-client.cjs');
const contextRequests: any[] = [];
const steps = new Map<string, number>(), assignments: string[] = [], evidence: any[] = [];

before(async () => {
  await schema.create();
  const dbURL = new URL(base); dbURL.searchParams.set('options', '-c search_path=' + schema.name);
  process.env.DATABASE_URL = dbURL.toString();
  directory = await mkdtemp(join(tmpdir(), 'product-flow-'));
  writeFileSync(join(directory,'.fixture-owner'),String(process.pid));
  console.log('PRODUCT_FLOW_FIXTURE='+JSON.stringify({root:directory,pid:process.pid}));
  process.env.DATA_DIR = directory; process.env.TRACE_ROOT = join(directory, '.data', 'runs');
  process.env.OBSIDIAN_VAULT = join(directory, 'obsidian-vault');
  // Replace the readiness boundary directly on every OS. No shell shim or
  // PATH mutation; accidental real container operations must fail loudly.
  mock.method(RunSandbox, 'assertReady', async (signal?: AbortSignal) => { signal?.throwIfAborted(); });
  for (const name of ['start', 'file', 'sync'] as const) {
    mock.method(RunSandbox.prototype as any, name, async () => { throw Error('TEST_DOCKER_EXECUTION_FORBIDDEN'); });
  }
  mock.method(RunSandbox.prototype, 'close', async function () {});
  mock.method(RunSandbox.prototype, 'execute', async function (this: any, name: string, args: any, signal?: AbortSignal) {
    signal?.throwIfAborted(); mkdirSync(this.root, { recursive: true });
    if (args.expectedWorkspaceRevision) assert.equal(args.expectedWorkspaceRevision, this.revision());
    assert.ok(['result.json', 'review.json'].includes(args.path) || name === 'terminal_test');
    let result: any;
    if (name === 'artifact_write') {
      const file = join(this.root, args.path), current = existsSync(file) ? hash(readFileSync(file)) : undefined;
      if (current !== args.expectedSha256) throw Error('FILE_VERSION_CONFLICT');
      mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, args.content);
      mutations++;
      if(mode==='c3-unknown-write'){writeFileSync(file,'{"interrupted":true}');throw Object.assign(Error('write response lost'),{code:'ETIMEDOUT'});}
      result = { path: args.path, sha256: hash(args.content) };
    } else if (name === 'filesystem') {
      if(mode==='c3-read-retry'&&readFaults++<2)throw Object.assign(Error('temporary read busy'),{code:'EBUSY'});
      const content = readFileSync(artifactFile(this.root, args.path), 'utf8');
      result = { path: args.path, content, sha256: hash(content) };
    } else {
      assert.equal(name, 'terminal_test'); assert.equal(args.command, 'check-fixed-result'); commands++;
      const actual = JSON.parse(readFileSync(artifactFile(this.root, 'result.json'), 'utf8'));
      if(mode.startsWith('rework')){assert.equal(actual.orderCount,expected.orderCount);assert.equal(actual.totalCents,expected.totalCents);}
      else assert.deepEqual(actual, expected);
      result = { exitCode: 0, output: 'fixed JSON oracle passed' };
    }
    return { ...result, artifacts: listArtifacts(this.root), workspaceRevision: this.revision() };
  });
  const commit = HandoffGate.prototype.commit;
  mock.method(HandoffGate.prototype, 'commit', function (this: any, record: any) {
    commit.call(this, record);
    if (mode === 'stale' && record.taskId === 'produce') writeFileSync(join(this.sandbox.root, 'result.json'), '{}');
  });
  const db = await import('../../apps/api/src/db.ts'); pool = db.pool; await db.migrate();
  const { createApp } = await import('../../apps/api/src/app.ts'); app = createApp();
  server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  url = 'http://127.0.0.1:' + (server.address() as any).port + '/api';
  gateway = http.createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    const body = JSON.parse(text), messages = body.messages ?? [];
    assert.equal(req.headers.authorization, 'Bearer simulated-key');
    let message: any = { content: 'fixture done' };
    if (body.tools?.[0]?.function?.name === 'capability_probe') {
      message = tool('capability_probe', { nonce: body.tools[0].function.parameters.properties.nonce.enum[0] }, 'probe');
    } else if (messages.some((m: any) => m.role === 'tool' && m.tool_call_id === 'probe')) {
      message = { content: JSON.parse(messages.find((m: any) => m.tool_call_id === 'probe').content).result };
    } else if (mode === 'resource-recovery' && messages[0]?.content?.includes('只规划未完成任务的资源')) {
      assert.ok(resourcePlanningReply, 'only the explicitly requested localhost resource planner may reply');
      message = { content: JSON.stringify(resourcePlanningReply) };
    } else if (messages.at(-1)?.content?.includes('Output EXACTLY the Markdown structure below:')) {
      summaryCalls++;
      message = { content: 'Task unchanged. Continue from approved context and observed tool results.' };
    } else {
      const pinned = fixtureTaskContext(messages);
      if (mode === 'resource-recovery' && pinned?.task.id === 'review' && !pinned.recovery) {
        // A genuinely dispatched localhost request has no response. Cancellation
        // must retain its unknown reservation through the real billing path.
        contextRequests.push(body); resourcePaused = true; return;
      }
      // Rework contracts keep the original subject; native follow-up labels use
      // the approved reworkRound and must not select the original write branch.
      const subject = pinned?.task.kind === 'repair' ? `repair-round-${pinned.task.reworkRound + 1}` :
        pinned?.task.kind === 'review' && pinned.task.reworkRound ? `review-round-${pinned.task.reworkRound + 1}` : pinned?.task.subject;
      const hasCurrentSnapshot = messages.some((m: any) => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith(fixtureRuntimeContextPrefix));
      const assignment = pinned ? `Task: ${pinned.runtimeTaskId} ${subject} Attempt id: ${pinned.attemptId}` : hasCurrentSnapshot ? '' : messages.filter((m: any) => m.role === 'user' && typeof m.content === 'string').reverse().find((m: any) => m.content.includes('AgentTeams automatic task assignment'))?.content ?? '';
      const match = /Task: (t\d+).*?(?:\[flow:(\w+)\]|(repair|review)-round-(\d+))/.exec(assignment), attempt = /Attempt id: ([a-f0-9-]+)/.exec(assignment)?.[1];
      if (match) {
        const id=match[1],label=match[2]??match[3],key = id + ':' + attempt, step = steps.get(key) ?? 0;
        const rework=mode.startsWith('rework'),repair=label==='repair',round=Number(match[4]??1)-1;
        steps.set(key, step + 1); assignments.push(label);
        const update = (status: string, more: any = {}) => ['agent_teams_update_task', { task_id: id, attempt_id: attempt, status, ...more }];
        const actions: any[] = [['agent_teams_claim_task', { task_id: id }], update('in_progress')];
        if (label === 'produce'||repair) {
          const previous=messages.filter((m:any)=>m.role==='tool').map((m:any)=>{try{return JSON.parse(m.content);}catch{return undefined;}}).findLast((value:any)=>value?.path==='result.json'&&value.sha256);
          if(repair||mode==='c3-reconciled')actions.push(['filesystem',{path:'result.json'}]);
          if (mode !== 'missing') actions.push(['artifact_write', { path: 'result.json', content: JSON.stringify(rework?{...expected,reviewStage:repair?'final':'initial'}:expected),...(repair||mode==='c3-reconciled'?{expectedSha256:previous?.sha256}:{}) }]);
          if (!['missing', 'forged'].includes(mode)) actions.push(['terminal_test', { command: verificationCommand }]);
          actions.push(update('completed', { output: 'fixed report', changedPaths: ['result.json'], acceptanceResults: [{ criterion: repair?'Set result.json reviewStage to final':'result correct', status: 'passed', evidence: 'fixed fixture' }], commandsRun: [{ command: verificationCommand, status: 'passed', exitCode: 0, evidence: 'model claim' }] }));
          if(mode==='c3-repeat-action')actions.splice(3,actions.length-3,...Array.from({length:12},()=>['filesystem',{path:'result.json'}]));
          if(mode==='c3-repeat-error')actions.splice(2,actions.length-2,...Array.from({length:6},()=>['filesystem',{path:'review.json'}]));
        } else if (mode === 'resource-recovery' && label === 'review') {
          const search = messages.filter((m:any)=>m.role==='tool').map((m:any)=>{try{return JSON.parse(m.content);}catch{return undefined;}})
            .findLast((value:any)=>Array.isArray(value)&&value.some((hit:any)=>hit.documentId===resourceKnowledge.id));
          actions.push(['knowledge_search',{query:'frozen-boundary-reference'}],['knowledge_read',{chunkId:search?.[0]?.id??'await-search-result'}],
            ['filesystem',{path:'result.json'}],['terminal_test',{command:'check-fixed-result'}],
            update('completed',{output:'Scripted QA inspected the frozen reference and actual host verification.',verdict:'pass'}));
        } else if (mode === 'resource-recovery' && label === 'accept') {
          actions.push(update('completed',{output:'Scripted manager received committed QA evidence.'}));
        } else if(label==='consume') {
          actions.push(['filesystem',{path:'result.json'}],['terminal_test',{command:'check-fixed-result'}],['artifact_write',{path:'review.json',content:'{"accepted":true}'}],update('completed',{output:'delivered checkpoint result'}));
        } else {
          actions.push(['filesystem', { path: 'result.json' }]);
          if(rework){
            actions.push(round&&mode!=='rework-limit'?update('completed',{output:'independent repaired review',verdict:'pass'}):
              update('failed',{verdict:mode==='rework-reject'?'reject':'needs_revision',findings:[{id:'F1',severity:'high',file:mode==='rework-scope'?'private/secret.json':'result.json',problem:'Report needs final review stage',requiredFix:mode==='rework-prefix-scope'?'Update result.js':'Set result.json reviewStage to final'}]}));
          }else {
            if(mode==='resume-review'){
              if(pinned?.recovery){actions.push(['recovery_read',{taskId:'review'}],['recovery_read',{taskId:'produce'}],['filesystem',{path:'review.json'}]);}
              else actions.push(['artifact_write',{path:'review.json',content:'{"accepted":false,"note":"partial review"}'}]);
              actions.push(['terminal_test',{command:'check-fixed-result'}]);
            }
            const previous=messages.filter((m:any)=>m.role==='tool').map((m:any)=>{try{return JSON.parse(m.content);}catch{return undefined;}}).findLast((value:any)=>value?.path==='review.json'&&value.sha256);
            actions.push(['artifact_write', { path: 'review.json', content: '{"accepted":true}',...(mode==='resume-review'?{expectedSha256:previous?.sha256}:{}) }], update('completed', { output: 'independent review', verdict: 'pass' }));
          }
        }
        if (step < actions.length) {
          message = tool(actions[step][0], actions[step][1], key + ':' + step);
          if (mode === 'context' && step < 3) message.content = 'HISTORY_EVIDENCE_' + label + '_' + step + ':' + 'x'.repeat(8000);
          if(mode==='resume-review'&&label==='review'&&step===2)message.content='RECOVERY_NOTE: input read; verify the fixed report next. This is a work note, not acceptance.';
        }
      }
    }
    if (mode === 'context'||mode==='resume-review'||mode==='resource-recovery') contextRequests.push(body);
    const inputTokens = mode === 'context' ? Math.ceil(JSON.stringify({ messages, tools: body.tools }).length / 4) : 50;
    const outputTokens = mode === 'context' ? Math.ceil(JSON.stringify(message).length / 4) : 10;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: inputTokens, completion_tokens: outputTokens, total_tokens: inputTokens + outputTokens } }));
  }).listen(0, '127.0.0.1'); await once(gateway, 'listening');
  const gatewayId = (await call('/gateways', 'POST', { name: 'Simulated gateway', baseUrl: 'http://127.0.0.1:' + (gateway.address() as any).port + '/v1', apiKey: 'simulated-key' }, 201)).id;
  // The current native schemas and protected context must fit below the soft
  // compaction threshold. Large synthetic history still exercises summaries.
  modelId = (await call('/models', 'POST', { gatewayId, model: 'fixture', name: 'Fixture model', inputRate: 1, outputRate: 2, contextWindowTokens: fixtureContextWindowTokens }, 201)).id;
  await call('/models/' + modelId + '/test', 'POST', {});
  await call('/models/' + modelId + '/test-tools', 'POST', {});
});

after(async () => {
  await app?.locals.shutdown();
  for (const instance of [server, gateway]) if (instance) await new Promise<void>(resolve => instance.close(() => resolve()));
  mock.restoreAll();
  await pool?.end(); await schema.drop(); await admin.end();
  // Each process owns its evidence file as well as its database and cleanup.
  if (process.env.E2E_EVIDENCE_PATH) writeFileSync(process.env.E2E_EVIDENCE_PATH + '.' + group + '.json', JSON.stringify({ group, executor: 'bounded test double', model: 'simulated HTTP gateway', scenarios: evidence }, null, 2) + '\n');
  if (directory) await rm(directory, { recursive: true, force: true });
});

function tool(name: string, args: any, id: string) { return { content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }; }
async function call(path: string, method = 'GET', body?: any, status = 200) {
  let response:Response|undefined;
  // Polling may race a closed keep-alive socket after a busy Windows fsync or
  // service restart. Retry reads only; never replay approvals or mutations.
  for(let attempt=0;!response;attempt++)try{response=await fetch(url + path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });}
  catch(error){if(method!=='GET'||attempt>=2||!['ECONNRESET','UND_ERR_SOCKET'].includes((error as any).cause?.code))throw error;await new Promise(resolve=>setTimeout(resolve,100));}
  const data = await response.json(); assert.equal(response.status, status, path + ': ' + JSON.stringify(data)); return data;
}
async function waitFor(read: () => Promise<any>, accept: (value: any) => boolean, label: string, timeoutMs=20000) {
  const deadline = Date.now() + timeoutMs; let value: any;
  while (Date.now() < deadline) { value = await read(); if (accept(value)) return value; await new Promise(resolve => setTimeout(resolve, 50)); }
  assert.fail(label + ': ' + JSON.stringify(value));
}
async function launch(nextMode: string,executionTarget?:any) {
  mode = nextMode; commands = 0; summaryCalls = 0;readFaults=0;mutations=0; contextRequests.length = 0; assignments.length = 0; steps.clear();
  resourcePaused=false; resourcePlanningReply=undefined; resourceKnowledge=undefined;
  if(mode==='resource-recovery'){
    const space=await call('/knowledge/spaces','POST',{name:'Recovery fixture reference',scope:'company'},201);
    const document=await call('/knowledge/documents','POST',{spaceId:space.id,title:'Frozen QA reference',content:'frozen-boundary-reference: compare the exact approved result before accepting.'},201);
    resourceKnowledge=(await call('/knowledge/documents')).find((row:any)=>row.id===document.id);
  }
  const localCode=nextMode==='local-long'?"require('fs').writeFileSync('command-started.txt','started');setTimeout(()=>console.log('long command complete'),25000)":"const result=require('./result.json');require('node:assert/strict').deepEqual(result,JSON.parse(Buffer.from('"+Buffer.from(JSON.stringify(expected)).toString('base64')+"','base64').toString()));console.log('local validation passed')";
  verificationCommand=nextMode.startsWith('local-')?'node -e "'+localCode+'"':'check-fixed-result';
  const agents = [
    { id: 'manager', role: 'manager', name: '经理', tools: [] },
    { id: 'producer', role: 'member', name: '产出者', tools: nextMode.startsWith('rework')||nextMode.startsWith('c3-')?['filesystem','artifact_write','terminal_test']:['artifact_write', 'terminal_test'] },
    { id: 'reviewer', role: 'member', name: '审查者', tools: nextMode==='resource-recovery'?['filesystem','terminal_test','knowledge_search','knowledge_read']:['rework-checkpoint','resume-review'].includes(nextMode)?['filesystem','artifact_write','terminal_test']:['filesystem', 'artifact_write'],
      ...(resourceKnowledge?{knowledgeSpaceIds:[resourceKnowledge.spaceId]}:{}) },
  ].map(a => ({ ...a, title: a.name, instructions: 'Execute only the approved fixture tasks', modelId }));
  const department = await call('/departments', 'POST', { name: 'Flow ' + mode, description: 'Integration fixture', agents }, 201);
  const project = await call('/projects', 'POST', { departmentId: department.id, requirement: '生成固定测试报告并由另一位员工独立审查，核对文件版本和审批。', policy: { maxBudget: 1, maxAgents: 3, maxConcurrentAgents: 2, deadlineSeconds: 60,...(executionTarget?{executionTarget}:{}) } }, 201);
  const original = (await call('/projects')).find((p: any) => p.id === project.id);
  const common = { estimatedInputTokens: 1000, estimatedOutputTokens: 512, maxModelCalls: 15, maxBudget: .2 };
  const plan:any = { rationale: 'An approved producer and an independent reviewer exchange a versioned file', agents: original.plan.agents, tasks: [
    { ...common, id: 'produce', subject: '[flow:produce]', objective: 'Write the fixed report', assigneeId: 'producer', dependencies: [], acceptanceCriteria: ['result correct'], kind: 'implementation', inScope: ['result.json'], verify: [verificationCommand], outputs: [{ path: 'result.json', format: 'json', requiredKeys: ['orderCount', 'totalCents'], expectedValues: expected }] },
    { ...common, id: 'review', subject: '[flow:review]', objective: 'Read and independently review the fixed report', assigneeId: 'reviewer', dependencies: ['produce'], acceptanceCriteria: ['independent approval'], kind: 'review', reviewedTaskId: 'produce', inputs: [{ path: 'result.json', producerTaskId: 'produce' }], outputs: [{ path: 'review.json', format: 'json', expectedValues: { accepted: true } }] },
  ] };
  if(mode.startsWith('rework')){
    Object.assign(plan.tasks[0],{inputs:[],maxModelCalls:mode==='rework-budget'?8:20});
    Object.assign(plan.tasks[1],{outputs:[],maxReworkRounds:1});
  }
  if(mode==='rework-checkpoint')plan.tasks.push({...common,id:'deliver',subject:'[flow:consume]',objective:'Deliver after independent review',assigneeId:'reviewer',dependencies:['review'],acceptanceCriteria:['delivery correct'],kind:'work',inputs:[{path:'result.json',producerTaskId:'produce'}],outputs:[{path:'review.json',format:'json',expectedValues:{accepted:true}}]});
  if(mode==='resume-review')plan.tasks[1].maxModelCalls=40;
  if(mode==='resource-recovery'){
    for(const task of plan.tasks)task.maxOutputTokens=2048;
    Object.assign(plan.tasks[1],{outputs:[],verify:['check-fixed-result'],maxModelCalls:8});
    plan.tasks.push({...common,id:'accept',subject:'[flow:accept]',objective:'Inspect committed independent QA evidence',assigneeId:'manager',dependencies:['review'],
      acceptanceCriteria:['QA has a current host seal'],kind:'work',inputs:[],outputs:[],maxModelCalls:7,maxOutputTokens:2048});
  }
  if(mode==='local-long'){plan.tasks[0].inScope.push('command-started.txt');plan.tasks[0].outputs.push({path:'command-started.txt',format:'text',nonEmpty:true});}
  await call('/projects/' + project.id + '/plan', 'PUT', { version: 1, plan });
  const saved = (await call('/projects')).find((p: any) => p.id === project.id); assert.equal(saved.validation.valid, true, JSON.stringify(saved.validation));
  return (await call('/projects/' + project.id + '/approve', 'POST', { version: 2 }, 202)).id;
}
const approvals = (id: string) => call('/approvals?runId=' + id);
async function localFixture(request=globalThis.fetch){
 const root=join(directory,'local-workspaces-'+randomUUID()),journalRoot=join(directory,'local-journal-'+randomUUID());mkdirSync(root,{recursive:true});
 const device={id:randomUUID(),token:randomBytes(32).toString('hex'),name:'真实本机测试设备',grant:{id:randomUUID(),root,allowCommands:true}};
 const input={connection:{server:url.replace(/api$/,''),username:'fixture',password:'fixture'},device,journalRoot,pollMs:50,fetch:request};
 const client=new LocalDeviceClient(input);await client.start();return {root,device,input,client,target:{kind:'local',deviceId:device.id,grantId:device.grant.id}};
}
const run = (id: string) => call('/runs/' + id);
async function pendingApproval(id: string) {
 try{return (await waitFor(() => approvals(id), list => list.some((a: any) => a.status === 'pending'), 'pending approval',40000)).find((a: any) => a.status === 'pending');}
 catch(error){const file=join(directory,'.data','runs',id,'events.jsonl');const events=existsSync(file)?readFileSync(file,'utf8').trim().split('\n').map(line=>JSON.parse(line)):[];throw Error((error as Error).message+'; runtime evidence: '+JSON.stringify(events.filter((event:any)=>['run/finished','model/error','handoff/blocked','runtime/anomaly','quality/escalated','team/checkpoint'].includes(event.type)).slice(-5)));}
}
async function stopped(id: string) {
  const result = await waitFor(() => run(id), r => ['completed', 'failed', 'cancelled'].includes(r.status), 'stopped run');
  assert.equal(result.integrity, 'ok', 'every stopped run must have a complete archive');
  const events = [...result.events]; let page = result;
  while (page.hasMore) { page = await call('/runs/' + id + '?after=' + page.nextCursor); events.push(...page.events); }
  return { ...result, events };
}

if (group === 'native') test('D1 API and actual DSH execute native device files and an approved command, preserving verified handoff and accounting', {timeout:40000},async()=>{
 const local=await localFixture();try{
  const listed=await call('/local-devices');assert.equal(listed.find((d:any)=>d.id===local.device.id).online,true);assert.equal(JSON.stringify(listed).includes(local.device.token),false);
  await call('/local-devices/'+local.device.id+'/poll','POST',{},403);
  const id=await launch('local-pass',local.target),approval=await pendingApproval(id);
  assert.deepEqual(JSON.parse(readFileSync(join(local.root,id,'result.json'),'utf8')),expected);
  const waiting=await call('/runs/'+id+'/local-operations');assert.equal(waiting.some((job:any)=>job.payload.name==='terminal_test'),false,'no native command is dispatched before approval');
  await call('/approvals/'+approval.id,'POST',{decision:'approved'});const result=await stopped(id);assert.equal(result.status,'completed',JSON.stringify(result.events.at(-1)));
  assert.equal(commands,0,'the Docker test double was never used');assert.equal(mutations,0);
  assert.equal(result.snapshot.executionTarget.deviceId,local.device.id);assert.equal(result.snapshot.executionTarget.grantId,local.device.grant.id);
  assert.ok(result.events.some((event:any)=>event.type==='local/device-bound'));assert.ok(result.events.some((event:any)=>event.type==='handoff/command-observed'&&event.data.exitCode===0));
  assert.deepEqual(JSON.parse(readFileSync(join(local.root,id,'review.json'),'utf8')),{accepted:true});assert.deepEqual(JSON.parse(readFileSync(join(directory,'.data','runs',id,'artifacts','result.json'),'utf8')),expected);
  const operations=await call('/runs/'+id+'/local-operations');assert.ok(operations.every((job:any)=>job.status==='completed'));assert.equal(operations.filter((job:any)=>job.payload.name==='terminal_test').length,1);
  assert.ok(operations.find((job:any)=>job.payload.name==='terminal_test').result.output.includes('local validation passed'));assert.equal(result.recovery.unknownOperations.length,0);
  const stored=(await pool.query("SELECT * FROM local_operations WHERE run_id=$1 AND approval_id IS NOT NULL",[id])).rows[0];
  const protocol=async(endpoint:string,body:any,status:number)=>{const response=await fetch(url+'/local-devices/'+local.device.id+'/operations/'+stored.id+endpoint,{method:'POST',headers:{'Content-Type':'application/json','X-Local-Device-Key':local.device.token},body:JSON.stringify(body)});assert.equal(response.status,status,JSON.stringify(await response.json()));};
  await protocol('/start',{claimToken:stored.claim_token},409);
  await protocol('/result',stored.result,200);await protocol('/result',stored.result,200);
  await protocol('/result',{...stored.result,claimToken:randomUUID()},403);
  await protocol('/result',{...stored.result,result:{...stored.result.result,exitCode:null}},422);
  await protocol('/result',{...stored.result,result:{...stored.result.result,output:'forged changed receipt'}},409);
  assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM local_operations WHERE approval_id=$1',[stored.approval_id])).rows[0].count,1);
  const {LocalOperationService}=await import('../../apps/api/src/local-execution.ts');
  await assert.rejects(new LocalOperationService(join(directory,'.data','runs'),stored.lease_owner,createArchiveWriterManager({traceRoot:join(directory,'.data','runs')})).wait(stored.id),{code:'LOCAL_OPERATION_CANCELLED',notExecuted:false},'a stopped worker cannot adopt an old completed receipt');
  const usage=(await call('/usage')).filter((item:any)=>item.runId===id);assert.ok(usage.length>0);assert.ok(usage.every((item:any)=>item.agentId&&item.cost>0));
  assert.ok(usage.some((item:any)=>item.employeeId==='producer'&&item.taskId==='produce'));assert.ok(usage.some((item:any)=>item.employeeId==='reviewer'&&item.taskId==='review'));
  assert.equal(usage.length,result.events.filter((event:any)=>event.type==='billing/usage').length);
 }finally{await local.client.disable();}
});
if (group === 'native') test('D1 lost poll response recovers an unstarted claim and executes it exactly once',{timeout:40000},async()=>{
 let lostId:string|undefined,claims=0,starts=0;
 const local=await localFixture(async(input,options)=>{
  const response=await fetch(input,options),endpoint=new URL(String(input)).pathname;
  if(endpoint.endsWith('/poll')){
   const body=await response.clone().json() as any;
   if(body.job&&(!lostId||body.job.id===lostId)){
    claims++;if(!lostId){lostId=body.job.id;throw Error('fixture: claim committed, poll response lost');}
   }
  }
  if(endpoint.endsWith('/operations/'+lostId+'/start')&&response.ok)starts++;
  return response;
 });
 try{
  const id=await launch('local-pass',local.target),approval=await pendingApproval(id);
  await call('/approvals/'+approval.id,'POST',{decision:'approved'});
  const result=await stopped(id);assert.equal(result.status,'completed',JSON.stringify(result.events.at(-1)));
  assert.equal(claims,2);assert.equal(starts,1);assert.deepEqual(result.recovery.unknownOperations,[]);
  const operations=await call('/runs/'+id+'/local-operations');
  assert.equal(operations.filter((job:any)=>job.id===lostId).length,1);
  assert.ok(operations.every((job:any)=>job.status==='completed'));
 }finally{await local.client.disable();}
});

if (group === 'native') test('D1 revoked device grants reject dispatch after approval and do not become unknown mutations',{timeout:35000},async()=>{
 const local=await localFixture();try{
  const id=await launch('local-pass',local.target),approval=await pendingApproval(id);
  await call('/local-devices/'+local.device.id,'DELETE',{});await call('/approvals/'+approval.id,'POST',{decision:'approved'});
  const result=await stopped(id);assert.equal(result.status,'failed');const operations=await call('/runs/'+id+'/local-operations');assert.equal(operations.some((job:any)=>job.payload.name==='terminal_test'),false);assert.deepEqual(result.recovery.unknownOperations,[]);
  const duplicate=await fetch(url+'/local-devices/register',{method:'POST',headers:{'Content-Type':'application/json','X-Local-Device-Key':local.device.token},body:JSON.stringify({id:local.device.id,token:local.device.token,name:local.device.name,platform:process.platform,grant:{id:local.device.grant.id,label:local.root.split(/[\\/]/).at(-1),allowCommands:true}})});assert.equal(duplicate.status,403,'an old client cannot silently undo device revocation');
 }finally{await local.client.close();}
});
if (group === 'native') test('D1 cancels an in-flight native command and reconnects by reporting its receipt without replay',{timeout:45000},async()=>{
 const local=await localFixture();let reconnected:any;
 try{
  const id=await launch('local-long',local.target),approval=await pendingApproval(id);await call('/approvals/'+approval.id,'POST',{decision:'approved'});
  const marker=join(local.root,id,'command-started.txt');await waitFor(async()=>existsSync(marker),Boolean,'native command started');
  await call('/runs/'+id+'/cancel','POST',{},202);await local.client.close();const result=await stopped(id);assert.equal(result.status,'cancelled');assert.ok(result.recovery.unknownOperations.some((operation:any)=>operation.name==='terminal_test'));
  await call('/runs/'+id+'/retry','POST',{resume:false},409);
  reconnected=new LocalDeviceClient(local.input);await reconnected.start();const operations=await waitFor(()=>call('/runs/'+id+'/local-operations'),jobs=>jobs.some((job:any)=>job.payload.name==='terminal_test'&&job.lateResult),'late native receipt');
  assert.equal(operations.filter((job:any)=>job.payload.name==='terminal_test').length,1);assert.equal(readFileSync(marker,'utf8'),'started');assert.equal(operations.find((job:any)=>job.payload.name==='terminal_test').lateResult.ok,false);
 }finally{await reconnected?.disable();await local.client.close();}
});
if (group === 'core') test('approved API flow waits for command approval, hands off verified files and settles usage', { timeout: 30000 }, async () => {
  const id = await launch('pass'), approval = await pendingApproval(id);
  assert.equal(commands, 0); assert.ok(!assignments.includes('review')); assert.equal(approval.tool, 'terminal_test');
  await call('/approvals/' + approval.id, 'POST', { decision: 'approved' });
  const result = await stopped(id); assert.equal(result.status, 'completed', JSON.stringify(result.events.filter((e: any) => e.type === 'session/turn/end' || e.type === 'session/compaction/end' || e.type === 'model/error' || e.type === 'handoff/blocked'))); assert.equal(commands, 1);
  assert.equal(result.integrity, 'ok', 'approval and runtime writers must preserve one complete event journal');
  const seals = result.events.filter((e: any) => e.type === 'handoff/accepted'); assert.equal(seals.length, 2);
  assert.equal(seals[1].data.inputs[0].sha256, seals[0].data.outputs[0].sha256);
  const artifact = await fetch(url + '/runs/' + id + '/artifact?path=result.json'); assert.equal(artifact.status, 200); assert.deepEqual(await artifact.json(), expected);
  assert.match(artifact.headers.get('content-disposition')??'',/attachment/);
  assert.equal(artifact.headers.get('x-content-type-options'),'nosniff');
  await call('/runs/'+id+'/artifact?path=..%2F..%2Fsnapshot.json','GET',undefined,404);
  assert.deepEqual((await call('/runs/' + id + '/artifacts')).map((f: any) => f.path).sort(), ['result.json', 'review.json']);
  const exported = await call('/runs/' + id + '/export'); assert.equal(exported.integrity, 'ok'); assert.ok(!JSON.stringify(exported).includes('simulated-key'));
  const usage = (await call('/usage')).filter((u: any) => u.runId === id);
  const producer = usage.find((u: any) => u.employeeId === 'producer'), reviewer = usage.find((u: any) => u.employeeId === 'reviewer');
  assert.ok(producer?.sessionId && reviewer?.sessionId); assert.notEqual(producer.sessionId, reviewer.sessionId);
  assert.equal(result.snapshot.runtimeArchitecture, 'employee-host-v1');
  const hosts = result.events.filter((e: any) => e.type === 'runtime/created');
  for (const receipt of [producer, reviewer]) {
    assert.ok(hosts.some((e: any) => e.sessionId === receipt.sessionId && e.data.agentId === receipt.agentId && e.data.employeeId === receipt.employeeId), 'Host identity must match the billed session and employee');
  }
  assert.equal(new Set(hosts.map((e: any) => e.data.hostId)).size, hosts.length, 'every residency has its own Host');
  const disposed = result.events.filter((e: any) => e.type === 'runtime/disposed');
  assert.deepEqual(disposed.map((e: any) => e.data.hostId).sort(), hosts.map((e: any) => e.data.hostId).sort(), 'completed runs release every employee Host');
  for (const host of hosts) {
    assert.ok(disposed.some((e: any) => e.data.hostId === host.data.hostId && e.sessionId === host.sessionId && e.data.agentId === host.data.agentId && e.data.employeeId === host.data.employeeId));
  }
  const receipts = (await pool.query('SELECT id,status FROM model_reservations WHERE run_id=$1', [id])).rows;
  assert.ok(usage.length > 0); assert.ok(usage.every((u: any) => receipts.some(r => r.id === u.id && r.status === 'settled')));
  assert.ok(receipts.every(r => r.status !== 'pending'));
  evidence.push({ scenario: 'approval-handoff-billing', status: result.status, seals: seals.length, commands, usageRows: usage.length, separateWorkerSessions: true, report: expected });
});

if (group === 'core') test('employee summaries are billed to the active task and preserve approved contracts through handoff', { timeout: 30000 }, async () => {
  const id = await launch('context'), approval = await pendingApproval(id);
  await call('/approvals/' + approval.id, 'POST', { decision: 'approved' });
  const result = await stopped(id);
  assert.equal(result.status, 'completed', JSON.stringify(result.events.slice(-10)));
  assert.ok(summaryCalls > 0, 'long histories must trigger an actual gateway summary request');
  assert.equal(result.events.filter((e: any) => e.type === 'handoff/accepted').length, 2);
  assert.equal(commands, 1);
  assert.equal(result.snapshot.modelRoutes[0].contextWindowTokens, fixtureContextWindowTokens);
  const usage = (await call('/usage')).filter((u: any) => u.runId === id && u.purpose === '上下文摘要');
  assert.equal(usage.length, summaryCalls);
  assert.ok(usage.every((u: any) => u.taskId && u.attemptId && u.sessionId && ['producer', 'reviewer'].includes(u.employeeId)));
  const records = result.events.filter((e: any) => e.type === 'session/compaction/summary');
  assert.ok(records.length > 0 && records.length <= summaryCalls);
  const rejected = result.events.filter((e: any) => e.type === 'session/compaction/end' && e.data.error);
  // Shutdown can cancel an opened compaction before it dispatches a model call.
  assert.ok(records.length + rejected.length >= summaryCalls);
  const sent = result.events.filter((e: any) => e.type === 'model/wire-request' && e.data.requestPurpose === 'compaction');
  assert.ok(usage.every((u: any) => sent.some((e: any) => e.data.usageId === u.id && e.sessionId === u.sessionId && e.taskId === u.taskId && e.attemptId === u.attemptId)));
  const receipts = (await pool.query('SELECT id,status FROM model_reservations WHERE run_id=$1', [id])).rows;
  assert.ok(usage.every((u: any) => receipts.some(r => r.id === u.id && r.status === 'settled')));
  assert.ok(receipts.every(r => r.status !== 'pending'));
  assert.ok(records.every((e: any) => e.data.shadowedSeqs.length > 0));
  assert.ok(result.events.some((e: any) => e.type === 'session/assistant/message' && JSON.stringify(e.data).includes('HISTORY_EVIDENCE_produce_0')));
  const resumedRequests = contextRequests.filter(body => body.messages.some((m: any) => typeof m.content === 'string' && m.content.includes('<compacted-summary>')) && !body.messages.at(-1)?.content?.includes('Output EXACTLY the Markdown structure below:'));
  assert.ok(resumedRequests.length > 0);
  assert.ok(resumedRequests.every(body => {
    const context = fixtureTaskContext(body.messages);
    return context?.attemptId && Array.isArray(context.task.acceptanceCriteria) && JSON.stringify(context).includes('摘要不能扩大权限');
  }));
  assert.ok(result.events.some((e: any) => e.type === 'model/wire-request' && e.data.requestPurpose === 'compaction'));
  evidence.push({ scenario: 'context-summary-handoff-billing', status: result.status, summaryCalls, summaryUsageRows: usage.length, commands, originalEvidenceRetained: true });
});

async function finishRework(id:string) {
  // This exercises real fsync/native journal locks as well as the local model.
  const deadline=Date.now()+45000;
  while(Date.now()<deadline){
    const current=await run(id);
    if(['completed','failed','cancelled'].includes(current.status))return stopped(id);
    for(const approval of (await approvals(id)).filter((a:any)=>a.status==='pending'))await call('/approvals/'+approval.id,'POST',{decision:'approved'});
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  const last=await run(id);
  assert.fail('bounded rework did not finish: '+JSON.stringify({id,status:last.status,eventCount:last.eventCount,events:last.summaryEvents?.slice(-4)}));
}

if (group === 'rework') test('approved API rework repairs, independently re-reviews and bills the original task buckets', {timeout:60000},async()=>{
  const id=await launch('rework-pass'), result=await finishRework(id);
  assert.equal(result.status,'completed',JSON.stringify(result.events.filter((e:any)=>['handoff/blocked','quality/escalated','model/error'].includes(e.type))));
  assert.equal(result.snapshot.tasks[1].maxReworkRounds,1);assert.equal(commands,2);
  const generated=result.events.filter((e:any)=>e.type==='quality/rework-created');assert.equal(generated.length,1);
  assert.ok(result.summaryEvents.some((e:any)=>e.type==='quality/rework-created'));assert.ok(result.summaryEvents.some((e:any)=>e.type==='quality/reviewed'));
  const mappings=generated[0].data.bindings;assert.equal(mappings.length,2);
  const wire=result.events.filter((e:any)=>e.type==='model/wire-request');
  const receipts=(await call('/usage')).filter((u:any)=>u.runId===id);
  for(const binding of mappings){
    const requests=result.events.filter((e:any)=>e.type==='model/request'&&e.taskId===binding.task_id);
    assert.ok(requests.length>0);
    const unmapped=requests.filter((e:any)=>!wire.some((w:any)=>w.requestId===e.requestId&&w.data.taskId===binding.seed_id&&w.data.attemptId===e.attemptId));
    assert.equal(unmapped.length,0,JSON.stringify({binding,unmapped:unmapped.map((e:any)=>({seq:e.seq,requestId:e.requestId,sessionId:e.sessionId,taskId:e.taskId,attemptId:e.attemptId,purpose:e.data.purpose,wire:wire.filter((w:any)=>w.requestId===e.requestId).map((w:any)=>({seq:w.seq,usageId:w.data.usageId,taskId:w.data.taskId,runtimeTaskId:w.data.runtimeTaskId,attemptId:w.data.attemptId})),terminal:result.events.filter((t:any)=>t.requestId===e.requestId&&['model/error','model/finish'].includes(t.type)).map((t:any)=>({seq:t.seq,type:t.type,data:t.data}))}))}));
    assert.ok(receipts.some((u:any)=>u.taskId===binding.seed_id&&requests.some((e:any)=>e.attemptId===u.attemptId&&e.sessionId===u.sessionId)));
  }
  const artifact=await fetch(url+'/runs/'+id+'/artifact?path=result.json');assert.equal((await artifact.json()).reviewStage,'final');
  const seals=result.events.filter((e:any)=>e.type==='handoff/accepted'&&e.data.taskId==='produce');assert.equal(seals.length,2);assert.notEqual(seals[0].data.outputs[0].sha256,seals[1].data.outputs[0].sha256);
  assert.ok(!receipts.some((u:any)=>mappings.some((m:any)=>m.task_id===u.taskId)),'runtime IDs must not create new budget buckets');
});

if (group === 'rework') test('API rework stops at its call allowance and full retry cannot reset the task counter', {timeout:35000},async()=>{
  const id=await launch('rework-budget'),result=await finishRework(id);assert.equal(result.status,'failed');
  assert.equal(result.events.filter((e:any)=>e.type==='quality/rework-created').length,1);
  // The final authorized request is reserved for handoff. This fixture asks
  // for another file read, so the handoff gate rejects it before turn exhaustion.
  const closure=result.events.find((e:any)=>e.type==='handoff/closure-started'&&e.data.taskId==='produce');
  assert.ok(closure);assert.equal(closure.data.reason,'last-authorized-call');
  assert.ok(result.events.some((e:any)=>e.type==='session/turn/end'&&e.sessionId===closure.sessionId&&e.seq>closure.seq&&e.data.reason?.error?.code==='HANDOFF_ONLY'));
  assert.ok(!result.events.some((e:any)=>e.type==='runtime/operation-start'&&e.seq>closure.seq),'no ordinary operation may execute after the last-call handoff gate');
  assert.ok(!result.events.some((e:any)=>e.type==='handoff/accepted'&&e.data.attemptId===closure.data.attemptId),'the rejected repair cannot publish a new delivery');
  const producer=(await call('/usage')).filter((u:any)=>u.runId===id&&u.taskId==='produce');assert.equal(producer.length,8);
  const resumed=await call('/runs/'+id+'/retry','POST',{resume:true},409);assert.match(resumed.message??resumed.error,/完整重试/);
  const response=await fetch(url+'/runs/'+id+'/retry',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({resume:false})}),retried=await response.json();
  // Cancelling a sibling's in-flight request may leave an uncertain receipt.
  // That accounting gate correctly runs before the exhausted task-call gate.
  assert.ok(['COST_PENDING','TASK_BUDGET_EXHAUSTED'].includes(retried.code),JSON.stringify(retried));
  assert.equal(response.status,retried.code==='COST_PENDING'?409:422);
  const row=(await pool.query('SELECT project_id,project_version FROM project_runs WHERE id=$1',[id])).rows[0];
  const {budgetHistory}=await import('../../apps/api/src/budget-history.ts');
  const history=await budgetHistory(pool,join(directory,'.data','runs'),row.project_id,row.project_version);
  assert.equal(history.tasks.produce.calls,8,'all original and repair calls must survive retry accounting');
  assert.equal((await pool.query('SELECT id FROM project_runs WHERE parent_run_id=$1',[id])).rowCount,0,'neither rejection may create a fresh task allowance');
});

if (group === 'escalation') test('API rework escalates exhausted rounds, forbidden files and explicit rejection', {timeout:180000},async()=>{
  for(const fault of ['rework-limit','rework-scope','rework-prefix-scope','rework-reject']){
    const id=await launch(fault),result=await finishRework(id);assert.equal(result.status,'failed');
    const escalation=result.events.find((e:any)=>e.type==='quality/escalated');assert.ok(escalation);
    assert.match(escalation.data.message,fault==='rework-limit'?/REWORK_LIMIT/:fault.includes('scope')?/REWORK_SCOPE_REQUIRED/:/REPLAN_REQUIRED/);
    assert.equal(result.events.filter((e:any)=>e.type==='quality/rework-created').length,fault==='rework-limit'?1:0);
    assert.ok(result.events.some((e:any)=>e.type==='quality/review-submitted'&&e.data.findings[0].id==='F1'));
  }
});

if (group === 'core') test('missing output and forged verification cannot dispatch the dependent reviewer', { timeout: 30000 }, async () => {
  for (const fault of ['missing', 'forged']) {
    const id = await launch(fault);
    const result = await waitFor(() => run(id), r => r.events?.some((e: any) => e.type === 'handoff/blocked'), fault + ' blocked');
    assert.ok(result.events.some((e: any) => e.type === 'handoff/blocked' && e.data.message.includes(fault === 'missing' ? 'MISSING_FILE' : 'UNVERIFIED_COMMAND')));
    assert.ok(!assignments.includes('review')); assert.equal(commands, 0); assert.equal((await approvals(id)).length, 0);
    assert.equal(result.events.filter((e: any) => e.type === 'handoff/accepted').length, 0);
    await call('/runs/' + id + '/cancel', 'POST', {}, 202); await stopped(id);
    evidence.push({ scenario: fault, downstreamModelCalls: 0, commands, blocked: true });
  }
});

if (group === 'core') test('a modified accepted input is rejected before the reviewer makes a model request', { timeout: 30000 }, async () => {
  const id = await launch('stale'), approval = await pendingApproval(id);
  await call('/approvals/' + approval.id, 'POST', { decision: 'approved' });
  const result = await stopped(id); assert.equal(result.status, 'failed'); assert.ok(!assignments.includes('review'));
  assert.ok(result.events.some((e: any) => e.type === 'handoff/blocked' && e.data.message.includes('VERSION_MISMATCH')));
  evidence.push({ scenario: 'stale-input', status: result.status, downstreamModelCalls: 0, blocked: true });
});

if (group === 'core') test('cancellation while approval is pending cancels the receipt and never runs the command', { timeout: 30000 }, async () => {
  const id = await launch('cancel'), approval = await pendingApproval(id);
  await call('/runs/' + id + '/cancel', 'POST', {}, 202);
  assert.equal((await stopped(id)).status, 'cancelled'); assert.equal(commands, 0); assert.ok(!assignments.includes('review'));
  assert.equal((await approvals(id)).find((a: any) => a.id === approval.id).status, 'cancelled');
  await call('/approvals/' + approval.id, 'POST', { decision: 'approved' }, 409);
  evidence.push({ scenario: 'cancel-pending-approval', status: 'cancelled', commands, obsoleteApprovalStatus: 409 });
});

if (group === 'core') test('C3 monitors actual employee waits and stops repeated actions/errors before more paid calls', {timeout:45000},async()=>{
 for(const [fault,code,limit] of [['c3-repeat-action','REPEATED_ACTION',8],['c3-repeat-error','REPEATED_ERROR',3]] as const){
  const id=await launch(fault),result=await stopped(id);
  assert.equal(result.status,'failed');assert.ok(result.events.some((event:any)=>event.type==='runtime/anomaly'&&event.data.code===code));
  assert.equal(commands,0);assert.ok(!assignments.includes('review'));
  const actions=result.events.filter((event:any)=>event.type==='tool/result'&&event.data.name==='filesystem');assert.equal(actions.length,limit);
  const anomaly=result.events.find((event:any)=>event.type==='runtime/anomaly');
  assert.ok(!result.events.some((event:any)=>event.type==='model/wire-request'&&event.seq>anomaly.seq),'anomaly fences the next model dispatch');
  assert.ok(result.summaryEvents.some((event:any)=>event.type==='runtime/anomaly'));
 }
});

if (group === 'core') test('C3 retries a transient read within the same tool call, without extra model charges', {timeout:30000},async()=>{
 const id=await launch('c3-read-retry'),approval=await pendingApproval(id);
 const waiting=await waitFor(()=>run(id),value=>value.summaryEvents?.some((event:any)=>event.type==='runtime/status'&&event.data.employees.some((employee:any)=>employee.phase==='waiting_approval')),'approval classified');
 assert.deepEqual(waiting.recovery.unknownOperations,[],'unapproved command has not started');
 await call('/approvals/'+approval.id,'POST',{decision:'approved'});
 const result=await stopped(id);assert.equal(result.status,'completed');
 const retries=result.events.filter((event:any)=>event.type==='runtime/read-retry');assert.deepEqual(retries.map((event:any)=>event.data.retry),[1,2]);
 assert.equal(result.events.filter((event:any)=>event.type==='tool/start'&&event.data.name==='filesystem').length,1);
 assert.ok(!result.events.some((event:any)=>event.type==='runtime/outcome-unknown'));
});

async function reconcileFixtureUsage(id:string){
 // The fixed HTTP fixture reports precisely 50/10 for each non-summary call.
 // Use the product reconciliation endpoint, preserving the real cost gate.
 for(const receipt of (await call('/costs')).calls.filter((item:any)=>item.runId===id))await call('/costs/'+receipt.id+'/reconcile','POST',{inputTokens:50,outputTokens:10,note:'Confirmed fixed gateway fixture usage',confirmation:'RECONCILE'});
}

if (group === 'rework') test('C3 never replays an uncertain write; explicit reconciliation is recorded before a bounded retry', {timeout:35000},async()=>{
 const id=await launch('c3-unknown-write'),result=await stopped(id);assert.equal(result.status,'failed');assert.equal(mutations,1);
 assert.equal(result.recovery.unknownOperations.length,1);assert.ok(result.events.some((event:any)=>event.type==='runtime/anomaly'&&event.data.code==='OUTCOME_UNKNOWN'));
 const rejected=await call('/runs/'+id+'/retry','POST',{resume:false},409);assert.equal(rejected.code,'OPERATION_RECONCILIATION_REQUIRED');
 await reconcileFixtureUsage(id);mode='c3-reconciled';
 const retry=await call('/runs/'+id+'/retry','POST',{resume:false,acknowledgeUnknownOperations:true},202);
 const approval=await pendingApproval(retry.id);await call('/approvals/'+approval.id,'POST',{decision:'approved'});
 const restored=await stopped(retry.id);assert.equal(restored.status,'completed');assert.equal(restored.snapshot.approval.reconciledOperations.length,1);
 assert.equal(restored.snapshot.budgetHistory.tasks.produce.calls,result.events.filter((event:any)=>event.type==='model/wire-request'&&event.data.taskId==='produce').length);
});

if (group === 'recovery') test('checkpoint resume returns the active child without duplicate rows or model dispatch and keeps the new-parent activity guard', {timeout:45000},async()=>{
 const parent=await launch('resume-review'),first=await pendingApproval(parent);
 await call('/approvals/'+first.id,'POST',{decision:'approved'});
 await pendingApproval(parent);await call('/runs/'+parent+'/cancel','POST',{},202);
 const original=await stopped(parent);await reconcileFixtureUsage(parent);
 let child:string|undefined;
 try{
  const created=await call('/runs/'+parent+'/retry','POST',{resume:true},202);child=String(created.id);
  await pendingApproval(child);
  assert.equal((await run(child)).status,'running');
  const projectId=original.snapshot.projectId;
  const rowCount=async()=>Number((await pool.query('SELECT count(*)::int AS count FROM project_runs WHERE project_id=$1',[projectId])).rows[0].count);
  const wireCount=()=>readFileSync(join(directory,'.data','runs',child!,'events.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line)).filter(event=>event.type==='model/wire-request').length;
  const rowsBefore=await rowCount(),callsBefore=wireCount();
  const repeated=await call('/runs/'+parent+'/retry','POST',{resume:true});
  assert.deepEqual(repeated,{id:child,existing:true});
  assert.equal(await rowCount(),rowsBefore,'repeating a recovery cannot create another successor');
  assert.equal(wireCount(),callsBefore,'returning an existing successor cannot dispatch another model request');
  assert.equal((await run(child)).status,'running');
  // A stopped alternate attempt without a successor exists only in this fresh
  // fixture DB. It must still hit the active-project guard before any creation.
  const alternate=randomUUID();
  await pool.query(`INSERT INTO project_runs(id,project_id,project_version,status,snapshot,attempt,department_ids)
    SELECT $1,project_id,project_version,'cancelled',snapshot,
      (SELECT max(attempt)+1 FROM project_runs WHERE project_id=$3),department_ids
    FROM project_runs WHERE id=$2`,[alternate,parent,projectId]);
  const guardedRows=await rowCount();
  const denied=await call('/runs/'+alternate+'/retry','POST',{resume:true},409);
  assert.match(denied.message??denied.error,/此项目已有运行/);
  assert.equal(await rowCount(),guardedRows,'a new parent cannot create a second active project run');
  assert.equal(wireCount(),callsBefore);
  evidence.push({scenario:'checkpoint-recovery-idempotency',parentRunId:parent,childRunId:child,existing:true,rowsBefore,rowsAfter:rowsBefore,modelCallsBefore:callsBefore,modelCallsAfter:callsBefore,newParentBlocked:true});
 }finally{
  if(child){await call('/runs/'+child+'/cancel','POST',{},202);await stopped(child);}
 }
});

if (group === 'recovery') test('resource-approved recovery carries frozen knowledge and real QA seals to the manager without developer replay', {timeout:90000},async()=>{
  const parent=await launch('resource-recovery'),approval=await pendingApproval(parent);
  await call('/approvals/'+approval.id,'POST',{decision:'approved'});
  await waitFor(async()=>resourcePaused,value=>value,'parent QA request dispatched to the localhost fixture');
  await call('/runs/'+parent+'/cancel','POST',{},202);
  const original=await stopped(parent),projectId=original.snapshot.projectId;
  assert.equal(original.status,'cancelled');assert.equal(original.integrity,'ok');
  const devSeal=original.events.find((event:any)=>event.type==='handoff/accepted'&&event.data.taskId==='produce').data;
  assert.deepEqual(original.events.filter((event:any)=>event.type==='handoff/accepted').map((event:any)=>event.data.taskId),['produce']);
  const unknown=(await pool.query("SELECT id,amount,status,context FROM model_reservations WHERE run_id=$1 AND status='uncertain' ORDER BY id",[parent])).rows;
  const qaUnknown=unknown.filter(row=>row.context.taskId==='review');
  assert.equal(qaUnknown.length,1,'the cancelled dispatched QA request must retain its real unknown fee');
  const retained=unknown.reduce((sum,row)=>sum+Number(row.amount),0);assert.ok(retained>0);
  const frozen=structuredClone(original.snapshot),originalCalls=original.events.filter((event:any)=>event.type==='model/wire-request');
  const parentArtifact=await fetch(url+'/runs/'+parent+'/artifact?path=result.json');assert.equal(parentArtifact.status,200);
  assert.equal(hash(Buffer.from(await parentArtifact.arrayBuffer())),devSeal.outputs[0].sha256);
  await call('/knowledge/documents/'+resourceKnowledge.id,'PUT',{spaceId:resourceKnowledge.spaceId,title:resourceKnowledge.title,version:1,content:'VERSION_TWO_MUST_NOT_REPLACE_APPROVED_REFERENCE'});

  await app.locals.shutdown();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));
  const {createApp}=await import('../../apps/api/src/app.ts');app=createApp();server=app.listen(0,'127.0.0.1');await once(server,'listening');url='http://127.0.0.1:'+(server.address() as any).port+'/api';
  resourcePlanningReply={maxBudget:2,maxModelCalls:100,taskCallLimits:{review:12,accept:7},taskBudgetLimits:{review:1.2,accept:1.2},
    taskOutputLimits:{review:8192,accept:8192},rationale:'Local scripted recovery regression; no real model acceptance.'};
  const countRuns=async()=>Number((await pool.query('SELECT count(*)::int AS n FROM project_runs WHERE project_id=$1',[projectId])).rows[0].n);
  const beforePlanning=contextRequests.length,rowsBefore=await countRuns();
  // Seven scripted task actions plus one actual compaction consume eight
  // calls. The last call must submit the formal handoff with complete evidence.
  const candidate=await call('/runs/'+parent+'/resource-proposal','POST',{modelId,maxBudget:2,maxPlanningCost:.1,maxModelCalls:100,maxTaskModelCalls:40,maxTaskOutputTokens:8192,retainUncertainCosts:true,taskContinuationLimits:{review:8,accept:7},coordinatorContinuationLimit:6});
  assert.equal(candidate.kind,'run-resource-proposal');assert.deepEqual(candidate.completedTaskIds,['produce']);
  assert.equal(contextRequests.length,beforePlanning+1);assert.equal(await countRuns(),rowsBefore,'planning cannot start employees');
  assert.deepEqual((await run(parent)).snapshot,frozen,'a candidate cannot mutate the original approval');
  const planningUsage=(await pool.query('SELECT planning_preview_id,purpose,cost FROM usage WHERE id=$1',[candidate.usageId])).rows[0];
  assert.equal(planningUsage.planning_preview_id,candidate.previewId);assert.equal(planningUsage.purpose,'预算补充规划');assert.ok(Number(planningUsage.cost)>0);
  const beforeChild=contextRequests.length;
  const child=(await call('/runs/'+parent+'/retry','POST',{resume:true,retainUncertainCosts:true,budgetPreviewId:candidate.previewId,confirmation:'APPROVE_RESOURCES_AND_RESUME'},202)).id;
  const qaApproval=await pendingApproval(child),running=await run(child);
  assert.deepEqual(running.snapshot.completedCheckpoints,['produce']);
  assert.equal(running.snapshot.resourceApproval.previewId,candidate.previewId);
  assert.equal(candidate.callRequirementVersion,'handoff-coordination-v2');
  assert.equal(candidate.coordinatorContinuationLimit,6);
  assert.equal(running.snapshot.resourceApproval.coordinatorCallCeiling,running.snapshot.budgetHistory.coordinatorCalls+6);
  assert.deepEqual(candidate.taskContinuationLimits,{review:8,accept:7});
  assert.deepEqual(running.snapshot.resourceApproval.taskCallCeilings,{review:9,accept:7});
  assert.equal(running.snapshot.budgetHistory.calls,originalCalls.length);
  assert.equal(running.snapshot.budgetHistory.tasks.review.calls,1);
  assert.ok(Math.abs(running.snapshot.costCarryover.reserved-retained)<1e-8);
  assert.equal(running.snapshot.budgetHistory.tasks.review.reserved,Number(qaUnknown[0].amount));
  assert.deepEqual(running.snapshot.knowledge,frozen.knowledge);
  assert.deepEqual(running.snapshot.tasks.find((task:any)=>task.id==='produce'),frozen.tasks.find((task:any)=>task.id==='produce'));
  for(const id of ['review','accept'])assert.equal(running.snapshot.tasks.find((task:any)=>task.id===id).maxOutputTokens,8192);
  assert.ok(!running.events.some((event:any)=>event.type==='model/wire-request'&&event.data.taskId==='accept'),'manager waits for formal QA acceptance');
  await call('/approvals/'+qaApproval.id,'POST',{decision:'approved'});
  const result=await stopped(child);assert.equal(result.status,'completed',JSON.stringify({
    stops:result.events.filter((event:any)=>['run/finished','model/error','handoff/blocked','handoff/closure-started','budget/stopped'].includes(event.type))
      .map((event:any)=>({seq:event.seq,type:event.type,taskId:event.data.taskId,code:event.data.code,reason:event.data.reason,message:event.data.message})),
    wires:result.events.filter((event:any)=>event.type==='model/wire-request').map((event:any)=>({seq:event.seq,taskId:event.data.taskId,purpose:event.data.requestPurpose}))}));
  assert.equal(result.integrity,'ok');assert.equal(commands,2);assert.equal(mutations,1);
  const childRequests=contextRequests.slice(beforeChild).filter(body=>fixtureTaskContext(body.messages)?.task&&
    !body.messages.at(-1)?.content?.includes('Output EXACTLY the Markdown structure below:'));
  assert.ok(childRequests.length>0);assert.ok(childRequests.every(body=>body.max_tokens===8192),JSON.stringify(childRequests.map(body=>({taskId:fixtureTaskContext(body.messages).task.id,maxTokens:body.max_tokens}))));
  assert.ok(childRequests.every(body=>['review','accept'].includes(fixtureTaskContext(body.messages).task.id)));
  assert.ok(result.events.filter((event:any)=>event.type==='model/wire-request').every((event:any)=>event.data.taskId!=='produce'));
  const seals=result.events.filter((event:any)=>event.type==='handoff/accepted');assert.deepEqual(seals.map((event:any)=>event.data.taskId),['review','accept']);
  const qaSeal=seals[0],managerWire=result.events.find((event:any)=>event.type==='model/wire-request'&&event.data.taskId==='accept');
  assert.ok(managerWire.seq>qaSeal.seq,'manager first dispatch follows durable QA acceptance');
  const managerContext=fixtureTaskContext(childRequests.find(body=>fixtureTaskContext(body.messages).task.id==='accept').messages);
  const qaEvidence=managerContext.runEvidence.completedAncestors.find((item:any)=>item.taskId==='review');
  assert.equal(qaEvidence.attemptId,qaSeal.data.attemptId);assert.equal(qaEvidence.commands[0].exitCode,0);
  assert.equal(qaEvidence.commands[0].approval.approvalId,qaApproval.id);assert.equal(qaEvidence.commands[0].validAtAccepted,true);
  assert.equal(qaEvidence.commands[0].output.sha256,hash('fixed JSON oracle passed'));
  assert.ok(!JSON.stringify(managerContext).includes(resourceKnowledge.content));
  assert.ok(childRequests.some(body=>fixtureTaskContext(body.messages).task.id==='review'&&JSON.stringify(body.messages).includes(resourceKnowledge.content)));
  assert.ok(childRequests.every(body=>!JSON.stringify(body.messages).includes('VERSION_TWO_MUST_NOT_REPLACE_APPROVED_REFERENCE')));
  assert.ok(childRequests.filter(body=>fixtureTaskContext(body.messages).task.id==='accept').every(body=>!JSON.stringify(body.messages).includes(resourceKnowledge.content)));
  const citation=result.events.find((event:any)=>event.type==='knowledge/citation'&&event.data.operation==='read');
  assert.ok(citation);const source=citation.data.sources.find((item:any)=>item.documentId===resourceKnowledge.id);
  assert.equal(source.version,1);assert.equal(source.sha256,resourceKnowledge.sha256);
  const read=await call('/runs/'+child+'/citations/'+source.chunkId);assert.equal(read.content,resourceKnowledge.content+'\n');
  const childArtifact=await fetch(url+'/runs/'+child+'/artifact?path=result.json');assert.equal(childArtifact.status,200);
  assert.equal(hash(Buffer.from(await childArtifact.arrayBuffer())),devSeal.outputs[0].sha256);
  assert.deepEqual((await run(parent)).snapshot,frozen);
  assert.deepEqual((await pool.query('SELECT id,amount,status,context FROM model_reservations WHERE id=ANY($1) ORDER BY id',[unknown.map(row=>row.id)])).rows,unknown);
  const childUsage=(await pool.query('SELECT id FROM usage WHERE run_id=$1',[child])).rows;
  const wireRequests=result.events.filter((event:any)=>event.type==='model/wire-request');
  assert.equal(childUsage.length,wireRequests.length);
  const purposes=(events:any[])=>Object.fromEntries(['review','accept','unattributed'].map(taskId=>[taskId,
    Object.fromEntries(['execution','compaction','handoff'].map(purpose=>[purpose,events.filter(event=>(event.data.taskId??'unattributed')===taskId&&
      (event.data.requestPurpose??'execution')===purpose).length]))]));
  const requestPurposeCounts=purposes(wireRequests);
  assert.deepEqual(requestPurposeCounts.review,{execution:6,compaction:1,handoff:1},'all eight QA requests consume the frozen allowance, including compaction');
  assert.deepEqual(purposes(result.events.filter((event:any)=>event.type==='billing/usage')),requestPurposeCounts,'every request purpose has a real recorded receipt');
  assert.deepEqual(result.snapshot.resourceApproval.taskCallCeilings,{review:9,accept:7});
  const closure=result.events.find((event:any)=>event.type==='handoff/closure-started'&&event.data.taskId==='review');
  assert.equal(closure?.data.reason,'last-authorized-call');
  const normalized=result.events.find((event:any)=>event.type==='context/compacted'&&event.data.requestPurpose==='handoff');
  assert.ok(normalized?.data.supersededRuntimeSnapshots>0);assert.equal(normalized?.data.removedGroups,0,'final handoff keeps all original non-snapshot history');
  evidence.push({scenario:'resource-approved-recovery-qa-manager',model:'localhost scripted responses only',parent,child,previewId:candidate.previewId,
    developerSha256:devSeal.outputs[0].sha256,retainedUnknownReceiptIds:unknown.map(row=>row.id),retainedUnknownAmount:retained,outputLimit:8192,knowledgeVersion:1,
    qaSealSequence:qaSeal.seq,managerFirstRequestSequence:managerWire.seq,status:result.status,taskContinuationLimits:candidate.taskContinuationLimits,
    taskCallCeilings:result.snapshot.resourceApproval.taskCallCeilings,inheritedCalls:result.snapshot.budgetHistory.calls,requestPurposeCounts});
});

if (group === 'recovery') test('checkpoint recovery preserves the DAG, unfinished files and history across two interruptions', {timeout:90000},async()=>{
 const id=await launch('resume-review'),first=await pendingApproval(id);
 await call('/approvals/'+first.id,'POST',{decision:'approved'});
 await pendingApproval(id);await call('/runs/'+id+'/cancel','POST',{},202);
 const original=await stopped(id);assert.equal(original.recovery.checkpointBlocked,undefined);
 const seal=original.events.find((event:any)=>event.type==='handoff/accepted'&&event.data.taskId==='produce').data;
 await reconcileFixtureUsage(id);
 // Recreate the API/coordinator/runtime so recovery cannot use a live Host or
 // in-memory employee context from the original run.
 await app.locals.shutdown();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));
 const {createApp}=await import('../../apps/api/src/app.ts');app=createApp();server=app.listen(0,'127.0.0.1');await once(server,'listening');url='http://127.0.0.1:'+(server.address() as any).port+'/api';
 let parent=id;
 for(let attempt=0;attempt<2;attempt++){
  const retry=await call('/runs/'+parent+'/retry','POST',{resume:true},202);
  assert.deepEqual(retry.completedCheckpoints,['produce']);
  const approval=await pendingApproval(retry.id),running=await run(retry.id);
  assert.deepEqual(running.snapshot.tasks.map((task:any)=>task.id),['produce','review']);
  assert.deepEqual(running.snapshot.tasks[1].dependencies,['produce']);assert.equal(running.snapshot.tasks[1].reviewedTaskId,'produce');
  assert.equal(running.snapshot.recovery.files.find((file:any)=>file.path==='result.json').state,'accepted');
  assert.equal(running.snapshot.recovery.files.find((file:any)=>file.path==='review.json').state,'unverified');
  assert.match(running.snapshot.recovery.nodes.review.lastMessage,/RECOVERY_NOTE/);
  if(attempt===0){await call('/runs/'+retry.id+'/cancel','POST',{},202);}
  else await call('/approvals/'+approval.id,'POST',{decision:'approved'});
  const result=await stopped(retry.id);assert.equal(result.status,attempt===0?'cancelled':'completed',JSON.stringify(result.events.at(-1)));
  assert.ok(result.events.filter((event:any)=>event.type==='model/wire-request'&&event.data.taskId).every((event:any)=>event.data.taskId==='review'));
  assert.ok(result.events.some((event:any)=>event.type==='recovery/read'));
  assert.equal(result.snapshot.handoffCheckpoints.find((record:any)=>record.taskId==='produce').outputs[0].sha256,seal.outputs[0].sha256);
  if(attempt===0)await reconcileFixtureUsage(retry.id);
  parent=retry.id;
 }
 assert.equal(commands,2,'only original developer verification and final reviewer verification execute');
 assert.equal(mutations,3,'developer output, interrupted review draft and final review only');
 assert.ok(contextRequests.some(body=>{
  const context=fixtureTaskContext(body.messages),text=JSON.stringify(context);
  return context&&text.includes('RECOVERY_NOTE')&&text.includes('sourceRunId');
 }));
});

if (group === 'recovery-rework') test('C3 restores an independently passed rework pair and runs only its remaining consumer', {timeout:90000},async()=>{
 const id=await launch('rework-checkpoint');
 for(let count=0;count<2;count++){const approval=await pendingApproval(id);await call('/approvals/'+approval.id,'POST',{decision:'approved'});}
 const downstream=await pendingApproval(id);assert.equal(commands,2);assert.equal(downstream.agentId,(await run(id)).snapshot.agents.find((agent:any)=>agent.employeeId==='reviewer').id);
 await call('/runs/'+id+'/cancel','POST',{},202);const before=await stopped(id);assert.equal(before.status,'cancelled');
 assert.ok(before.events.some((event:any)=>event.type==='quality/reviewed'&&event.data.reworkRound===1));
 assert.equal(before.recovery.checkpointBlocked,undefined);assert.deepEqual(before.recovery.unknownOperations,[]);
 await reconcileFixtureUsage(id);
 const retry=await call('/runs/'+id+'/retry','POST',{resume:true},202);assert.deepEqual(retry.completedCheckpoints.sort(),['produce','review']);
 const approval=await pendingApproval(retry.id);await call('/approvals/'+approval.id,'POST',{decision:'approved'});
 const restored=await stopped(retry.id);assert.equal(restored.status,'completed',JSON.stringify(restored.events.filter((event:any)=>['handoff/blocked','model/error'].includes(event.type))));
 assert.deepEqual(restored.snapshot.tasks.map((task:any)=>task.id),['produce','review','deliver']);assert.equal(restored.snapshot.approvedTasks.length,3);assert.equal(commands,3);
 assert.ok(restored.events.filter((event:any)=>event.type==='model/wire-request'&&event.data.taskId).every((event:any)=>event.data.taskId==='deliver'));
 assert.equal(restored.events.find((event:any)=>event.type==='handoff/accepted').data.inputs[0].sha256,before.events.findLast((event:any)=>event.type==='handoff/accepted'&&event.data.taskId==='produce').data.outputs[0].sha256);
});

}
