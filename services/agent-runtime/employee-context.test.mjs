import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm';
import { createTeamHost } from './host.mjs';
import { createRunArchive, readRun } from './trace-store.mjs';
import { OpenAiCompatibleAdapter } from './openai-compatible.mjs';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { employeeContextPolicy, EvidencePruner } from './employee-context.mjs';

const prompt = text => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } });

// Local transport fixtures exercise the installed DSH summarizer's real
// truncation, durable replacement and shared admission seams, not model quality.
async function checkpointCapFixture({ legacy = false, taskCap = 2048, routeCap = 2048, defaultEntry = false, pressureAfterSummary = false,
  omitSummaryUsage = false, rejectSummaryFee = false, unknownSummaryHop = false,callLimit=10 } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'context-approved-summary-cap-'));
  const archive = createRunArchive(root, { title: 'approved checkpoint output cap' });
  const route = { id: 'summary-cap', name: 'local fixture', wireModel: 'local-fixture', baseUrl: 'https://fixture.invalid/v1',
    inputRate: 1, outputRate: 1, maxOutputTokens: routeCap, contextWindowTokens: 128000 };
  const checkpoint = ['## Primary Request and Intent\n- COMPLETE_CHECKPOINT: finish cli.mjs and README.md.',
    '## Key Technical Concepts\n- Node CLI; approved workspace only.',
    '## Files and Code\n- cli.mjs: original evidence retained; do not replay completed writes.',
    '## Errors and Fixes\n- (none)', '## Pending Jobs\n- Verify the CLI exit code independently.',
    '## Current Work\n- Independent verification remains pending.', '## Next Step\n- Run the approved test command.',
    '## Critical Context\n- ' + 'Keep exact file versions and the original task scope. '.repeat(105)].join('\n\n');
  const summaryTokens = Math.ceil(checkpoint.length / 4);
  assert.ok(summaryTokens > 1024 && summaryTokens < 2048, 'fixture requires the existing 2048 allowance');
  const wires = [], usages = [];
  const backup = { ...route, id: 'summary-backup', wireModel: 'local-fixture-backup' };
  let executions = 0;
  const fetchMock = mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(url, route.baseUrl + '/chat/completions');
    const body = JSON.parse(init.body), summary = body.messages.at(-1)?.content?.includes('acting as a compaction engine');
    wires.push({ body, summary });
    if (summary && unknownSummaryHop && body.model === route.wireModel)
      return Response.json({ error: { message: 'local configured-fallback fixture' } }, { status: 429 });
    const length = summary && body.max_tokens < summaryTokens;
    return Response.json({ choices: [{ message: { content: summary ? checkpoint.slice(0, body.max_tokens * 4) : 'execution continued' },
      finish_reason: length ? 'length' : 'stop' }], ...(summary && omitSummaryUsage ? {} : { usage: {
        prompt_tokens: summary ? 8000 : ++executions === 1 ? 7000 : pressureAfterSummary ? 19000 : executions === 2 ? 12000 : 2000,
        completion_tokens: summary ? Math.min(summaryTokens, body.max_tokens) : 5 } }) });
  });
  const task = { id: 'dev', assigneeId: 'developer', maxOutputTokens: taskCap, maxBudget: .4, maxModelCalls: callLimit };
  const adapter = new OpenAiCompatibleAdapter({ routes: unknownSummaryHop ? [route, backup] : [route], tasks: [task], contextBytes: 64000, maxBudget: .4,
    maxModelCalls: callLimit, beforeRequest: async () => {},
    onCallError: data => archive.append('billing/unconfirmed', data),
    onFallback: data => archive.append('model/fallback', data, { sessionId: data.sessionId }),
    onRequest: data => {
      archive.append('model/wire-request', data, { sessionId: data.sessionId });
    }, onUsage: usage => {
      if (rejectSummaryFee && usage.requestPurpose === 'compaction') throw Error('fixture summary fee persistence rejected');
      archive.append('billing/usage', usage, { sessionId: usage.sessionId });
      usages.push(usage);
    } });
  adapter.attribution = sessionId => ({ sessionId, taskId: task.id, employeeId: task.assigneeId });
  const context = defaultEntry ? { mode: 'summary' } : employeeContextPolicy({ contextBytes: 64000 }, [route], 'fixture');
  if (legacy) context.compaction.modelPolicies[0].maxTokens = 1024;
  const host = await createTeamHost({ adapter, provider: 'fixture', sessionRoot: join(root, 'sessions'), archive, context });
  const agentSetup = pressureAfterSummary ? ctx => {
    ctx.systemPrompt.section({ name: 'fixed-scaffold', order: 120,
      text: 'FIXED_SCAFFOLD: keep original approved scope and limits. '.repeat(150) });
  } : undefined;
  let handle = await host.ctx.agents.create({ sessionId: randomUUID(), agentOptions: { provider: 'fixture', model: route.id }, setup: agentSetup });
  if (unknownSummaryHop) adapter.sessionPolicies.set(handle.agent.id, { fallbackModelId: backup.id });
  return { root, adapter, archive, context, wires, usages, get agent() { return handle.agent; },
    async seed() {
      await turn(handle.agent, 'ORIGINAL_SOURCE_EVIDENCE ' + 'x'.repeat(28000));
      await turn(handle.agent, 'RECENT_PENDING_WORK ' + 'y'.repeat(12000));
      assert.equal(wires.length, 2, 'pressure arises after two execution requests');
    },
    async resume() {
      const sessionId = handle.agent.id;
      await handle.dispose();
      handle = await host.ctx.agents.resume({ resumeSessionId: sessionId, agentOptions: { provider: 'fixture', model: route.id }, setup: agentSetup });
      await handle.agent.whenIdle();
    },
    async close() { try { await host.close(); } finally { fetchMock.mock.restore(); await rm(root, { recursive: true, force: true }); } },
  };
}
const reply = text => [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'block-end', index: 0, block: { type: 'text', text } },
  { type: 'finish', reason: { kind: 'stop' } },
];
async function turn(agent, text) { agent.followup(prompt(text)); await agent.whenIdle(); }
async function seed(agent, marker) { await turn(agent, marker + 'x'.repeat(4500)); await turn(agent, 'recent work ' + 'y'.repeat(3000)); }

test('last-call handoff skips automatic summary pressure, keeps original evidence and still obeys the hard size limit',{timeout:15000},async()=>{
 for(const [oversized,late] of [[false,false],[false,true],[true,false],[true,true]]){
  const f=await checkpointCapFixture({callLimit:3});
  try{
   await f.seed();
   let checks=0;
   f.adapter.handoffClosure=id=>++checks===1&&late?undefined:f.adapter.budget.run.maxCalls-f.adapter.budget.run.calls===1?f.adapter.attribution(id):undefined;
   await turn(f.agent,oversized?'OVERSIZED_LAST_HANDOFF '+'q'.repeat(70000):'Submit the last handoff.');
   assert.equal(f.wires.filter(w=>w.summary).length,0,'no paid compaction consumes the handoff allowance');
   assert.ok(readRun(f.root,f.archive.id).events.some(e=>e.type==='context/summary-skipped-for-handoff'),JSON.stringify({oversized,late,checks,errors:f.agent.session.snapshotEvents().filter(e=>e.type==='turn/end'||e.type==='compaction/end').map(e=>e.data)}));
   assert.ok(JSON.stringify(f.agent.session.deriveMessages()).includes('ORIGINAL_SOURCE_EVIDENCE'));
   if(oversized){assert.equal(f.wires.length,2);assert.equal(f.adapter.budget.run.calls,2);}
   else{
    assert.equal(f.wires.length,3);assert.equal(f.usages.at(-1).requestPurpose,'handoff');
    assert.ok(JSON.stringify(f.wires.at(-1).body).includes('ORIGINAL_SOURCE_EVIDENCE'));
    assert.equal(f.adapter.budget.run.calls,3);
   }
  }finally{await f.close();}
 }
});

test('installed DSH discards a known-fee truncated checkpoint and continues with complete original history without a paid summary retry', { timeout: 15000 }, async () => {
  const f = await checkpointCapFixture({ legacy: true });
  try {
    await f.seed(); await turn(f.agent, 'continue the approved task');
    const summaries = f.wires.filter(wire => wire.summary), events = f.agent.session.snapshotEvents();
    assert.equal(summaries.length, 1); assert.equal(summaries[0].body.max_tokens, 1024);
    assert.equal(f.usages.filter(usage => usage.requestPurpose === 'compaction').length, 1);
    assert.equal(events.filter(event => event.type === 'compaction/summary').length, 0);
    assert.ok(events.some(event => event.type === 'compaction/end' && event.data.error?.includes('incomplete checkpoint')));
    assert.ok(JSON.stringify(f.agent.session.deriveMessages()).includes('ORIGINAL_SOURCE_EVIDENCE'));
    assert.equal(f.wires.length, 4, 'one complete original-history execution follows the discarded summary');
    assert.equal(f.wires.at(-1).summary, false);
    assert.ok(JSON.stringify(f.wires.at(-1).body.messages).includes('ORIGINAL_SOURCE_EVIDENCE'));
    assert.ok(JSON.stringify(f.wires.at(-1).body.messages).includes('RECENT_PENDING_WORK'));
    assert.equal(f.adapter.budget.run.calls, 4); assert.equal(f.adapter.budget.tasks.get('dev').calls, 4);
    assert.equal(f.adapter.reserved, 0, 'the charged summary has known usage');
    assert.equal(readRun(f.root, f.archive.id).integrity, 'ok');
  } finally { await f.close(); }
});

test('a discarded checkpoint suppresses repeated summary fees and restores its confirmed failure gate on a cold Host', { timeout: 15000 }, async () => {
  const f = await checkpointCapFixture({ legacy: true, pressureAfterSummary: true });
  try {
    await f.seed(); await turn(f.agent, 'continue with original source');
    for (let index = 0; index < 3; index++) await turn(f.agent, 'small pending-work followup ' + index);
    assert.equal(f.wires.filter(wire => wire.summary).length, 1);
    await f.resume(); await turn(f.agent, 'resume the same pending work');
    assert.equal(f.wires.filter(wire => wire.summary).length, 1);
    assert.equal(f.usages.filter(usage => usage.requestPurpose === 'compaction').length, 1);
    assert.equal(f.agent.session.snapshotEvents().filter(event => event.type === 'compaction/summary').length, 0);
    for (const wire of f.wires.slice(3)) {
      assert.equal(wire.summary, false);
      assert.ok(JSON.stringify(wire.body.messages).includes('ORIGINAL_SOURCE_EVIDENCE'));
      assert.ok(JSON.stringify(wire.body.messages).includes('RECENT_PENDING_WORK'));
    }
    const run = readRun(f.root, f.archive.id);
    assert.equal(run.integrity, 'ok');
    assert.equal(run.events.filter(event => event.type === 'context/summary-truncated-retained').length, 1);
    assert.equal(f.adapter.budget.run.limit, .4); assert.equal(f.adapter.reserved, 0);
  } finally { await f.close(); }
});

test('raw-history continuation after truncation rejects a 64000-byte overflow before another dispatch and keeps all source fields', { timeout: 15000 }, async () => {
  const f = await checkpointCapFixture({ legacy: true });
  try {
    await f.seed(); await turn(f.agent, 'continue with original source');
    const before = { calls: f.adapter.budget.run.calls, spent: f.adapter.spent, wires: f.wires.length };
    await turn(f.agent, 'RAW_REQUEST_TOO_LARGE ' + 'q'.repeat(70000));
    assert.equal(f.wires.length, before.wires); assert.equal(f.adapter.budget.run.calls, before.calls);
    assert.equal(f.adapter.spent, before.spent); assert.equal(f.adapter.contextBytes, 64000);
    assert.equal(f.wires.filter(wire => wire.summary).length, 1);
    const visible = JSON.stringify(f.agent.session.deriveMessages());
    assert.ok(visible.includes('ORIGINAL_SOURCE_EVIDENCE')); assert.ok(visible.includes('RECENT_PENDING_WORK'));
    assert.ok(visible.includes('RAW_REQUEST_TOO_LARGE'));
    assert.ok(JSON.stringify(f.agent.session.snapshotEvents()).includes('CONTEXT_LIMIT'));
  } finally { await f.close(); }
});

test('raw-history continuation cannot shorten source to spend an existing retained budget hold', { timeout: 15000 }, async () => {
  const f = await checkpointCapFixture({ legacy: true }); let hold;
  try {
    await f.seed(); await turn(f.agent, 'continue with original source');
    const attribution = { taskId: 'dev', employeeId: 'developer' };
    hold = f.adapter.budget.reserve(f.adapter.budget.peekAvailable(attribution) - .001, attribution);
    const before = { calls: f.adapter.budget.run.calls, reserved: f.adapter.budget.run.reserved, wires: f.wires.length };
    await turn(f.agent, 'continue only with complete source');
    assert.equal(f.wires.length, before.wires); assert.equal(f.adapter.budget.run.calls, before.calls);
    assert.equal(f.adapter.budget.run.reserved, before.reserved);
    assert.equal(f.wires.filter(wire => wire.summary).length, 1);
    assert.ok(JSON.stringify(f.agent.session.deriveMessages()).includes('ORIGINAL_SOURCE_EVIDENCE'));
    assert.equal(f.adapter.budget.run.limit, .4);
  } finally { hold?.release(); await f.close(); }
});

test('missing summary usage, failed fee persistence and an unknown fallback hop never enable truncated-checkpoint degradation', { timeout: 15000 }, async () => {
  for (const patch of [{ omitSummaryUsage: true }, { rejectSummaryFee: true }, { unknownSummaryHop: true }]) {
    const f = await checkpointCapFixture({ legacy: true, ...patch });
    try {
      await f.seed(); await turn(f.agent, 'continue with original source');
      assert.equal(f.wires.length, patch.unknownSummaryHop ? 4 : 3, 'there is no subsequent execution after an unconfirmed summary');
      if (patch.unknownSummaryHop) {
        const run = readRun(f.root, f.archive.id);
        assert.ok(run.events.some(event => event.type === 'model/fallback'));
        assert.ok(run.events.some(event => event.type === 'billing/unconfirmed'));
      }
      assert.equal(f.agent.session.snapshotEvents().filter(event => event.type === 'compaction/summary').length, 0);
      assert.equal(readRun(f.root, f.archive.id).events.filter(event => event.type === 'context/summary-truncated-retained').length, 0);
      assert.ok(JSON.stringify(f.agent.session.deriveMessages()).includes('ORIGINAL_SOURCE_EVIDENCE'));
    } finally { await f.close(); }
  }
});

test('known-fee truncation still requires the official original-request flush before execution dispatch', { timeout: 15000 }, async () => {
  const f = await checkpointCapFixture({ legacy: true }); let unhook;
  try {
    await f.seed();
    unhook = f.agent.ctx.on('session/flush', session => {
      if (session.snapshotEvents().some(event => event.type === 'compaction/end' && event.data.error?.includes('incomplete checkpoint')))
        throw Error('fixture original-prefix durability barrier rejected');
    });
    await turn(f.agent, 'continue with original source');
    assert.equal(f.wires.length, 3, 'the discarded summary settles, but the original request cannot dispatch without flush');
    assert.equal(f.usages.filter(usage => usage.requestPurpose === 'compaction').length, 1);
    assert.ok(JSON.stringify(f.agent.session.deriveMessages()).includes('ORIGINAL_SOURCE_EVIDENCE'));
  } finally { unhook?.(); await f.close(); }
});

test('a complete checkpoint above the soft pressure target continues execution and waits for new history before paying again', { timeout: 15000 }, async () => {
  const f = await checkpointCapFixture({ pressureAfterSummary: true });
  try {
    await f.seed(); await turn(f.agent, 'continue the approved task');
    const initial = readRun(f.root, f.archive.id);
    assert.equal(f.wires.filter(wire => wire.summary).length, 1);
    assert.ok(initial.events.some(event => event.type === 'context/summary-pressure-retained' && event.data.estimatedTokens >= event.data.softThresholdTokens));
    assert.equal(f.wires.at(-1).summary, false, 'a fully committed summary is followed by normal execution');
    assert.ok(!f.agent.session.snapshotEvents().some(event => event.type === 'compaction/end' && event.data.error));
    for (let index = 0; index < 3; index++) await turn(f.agent, 'small unchanged-scope followup ' + index);
    assert.equal(f.wires.filter(wire => wire.summary).length, 1, 'unchanged high pressure does not buy repeated summaries');
    await turn(f.agent, 'MATERIAL_NEW_EVIDENCE ' + 'z'.repeat(12000));
    await turn(f.agent, 'continue after the new evidence');
    assert.equal(f.wires.filter(wire => wire.summary).length, 2, 'meaningful new source history can authorize another ordinary summary');
    assert.equal(f.usages.filter(usage => usage.requestPurpose === 'compaction').length, 2);
    assert.ok(JSON.stringify(f.agent.session.snapshotEvents()).includes('MATERIAL_NEW_EVIDENCE'));
    assert.equal(f.adapter.budget.run.limit, .4); assert.equal(f.adapter.budget.tasks.get('dev').limit, .4);
    assert.ok(f.adapter.spent < .4); assert.equal(f.adapter.reserved, 0);
  } finally { await f.close(); }
});

test('a cold resumed employee reconstructs its successful checkpoint gate and retains the original source', { timeout: 15000 }, async () => {
  const f = await checkpointCapFixture({ pressureAfterSummary: true });
  try {
    await f.seed(); await turn(f.agent, 'continue the approved task');
    const checkpoint = f.agent.session.snapshotEvents().find(event => event.type === 'compaction/summary');
    assert.ok(checkpoint); await f.resume(); await turn(f.agent, 'resume with the same pending work');
    assert.equal(f.wires.filter(wire => wire.summary).length, 1, 'restoring a Host does not pay again for the same pressure');
    assert.equal(f.agent.session.snapshotEvents().filter(event => event.type === 'compaction/summary').length, 1);
    assert.ok(JSON.stringify(f.agent.session.snapshotEvents()).includes('ORIGINAL_SOURCE_EVIDENCE'));
    assert.ok(JSON.stringify(f.agent.session.deriveMessages()).includes('COMPLETE_CHECKPOINT'));
    assert.equal(readRun(f.root, f.archive.id).integrity, 'ok');
  } finally { await f.close(); }
});

test('soft-pressure continuation leaves the original 64000-byte request boundary in force without extra summary fees', { timeout: 15000 }, async () => {
  const f = await checkpointCapFixture({ pressureAfterSummary: true });
  try {
    await f.seed(); await turn(f.agent, 'continue the approved task');
    const before = { calls: f.adapter.budget.run.calls, spent: f.adapter.spent, wires: f.wires.length };
    await turn(f.agent, 'OVERSIZED_CURRENT_REQUEST ' + 'q'.repeat(70000));
    assert.equal(f.adapter.contextBytes, 64000); assert.equal(f.wires.length, before.wires);
    assert.equal(f.adapter.budget.run.calls, before.calls); assert.equal(f.adapter.spent, before.spent);
    assert.equal(f.wires.filter(wire => wire.summary).length, 1);
    const events = f.agent.session.snapshotEvents();
    assert.ok(JSON.stringify(events).includes('CONTEXT_LIMIT'));
    assert.ok(JSON.stringify(events).includes('OVERSIZED_CURRENT_REQUEST'));
    assert.equal(f.adapter.budget.run.limit, .4); assert.equal(f.adapter.reserved, 0);
  } finally { await f.close(); }
});

test('installed DSH completes a checkpoint using the existing approved 2048 cap and retains durable original evidence', { timeout: 15000 }, async () => {
  const f = await checkpointCapFixture();
  try {
    await f.seed(); await turn(f.agent, 'continue the approved task');
    const summaries = f.wires.filter(wire => wire.summary), events = f.agent.session.snapshotEvents();
    assert.equal(f.context.compaction.modelPolicies[0].maxTokens, 2048);
    assert.equal(summaries.length, 1); assert.equal(summaries[0].body.max_tokens, 2048);
    assert.equal(events.filter(event => event.type === 'compaction/summary').length, 1);
    assert.ok(JSON.stringify(events).includes('ORIGINAL_SOURCE_EVIDENCE'), 'full source remains in the durable transcript');
    const visible = JSON.stringify(f.agent.session.deriveMessages());
    assert.ok(visible.includes('COMPLETE_CHECKPOINT')); assert.ok(visible.includes('RECENT_PENDING_WORK'));
    assert.ok(!visible.includes('ORIGINAL_SOURCE_EVIDENCE'), 'only the successful summary replaces the old visible span');
    assert.equal(f.wires.length, 4); assert.equal(f.wires.at(-1).summary, false);
    assert.equal(f.adapter.budget.run.calls, 4); assert.equal(f.adapter.budget.tasks.get('dev').calls, 4);
    assert.equal(f.adapter.budget.run.limit, .4); assert.equal(f.adapter.budget.tasks.get('dev').limit, .4);
    assert.equal(f.usages.filter(usage => usage.requestPurpose === 'compaction').length, 1);
    assert.ok(f.adapter.spent > 0 && f.adapter.spent < .4); assert.equal(f.adapter.reserved, 0);
  } finally { await f.close(); }
});

test('default context initialization uses the official summary allowance while the adapter clamps it to the approved task cap', { timeout: 15000 }, async () => {
  const f = await checkpointCapFixture({ defaultEntry: true, routeCap: 4096 });
  try {
    await f.seed();
    const result = await f.agent.ctx.get('compaction').compactNow(f.agent, AbortSignal.timeout(5000));
    const summaries = f.wires.filter(wire => wire.summary), events = f.agent.session.snapshotEvents();
    assert.ok(result, 'the installed DSH default entry commits a complete checkpoint');
    assert.equal(summaries.length, 1); assert.equal(summaries[0].body.max_tokens, 2048, 'task cap is stricter than the approved route');
    const summary = events.find(event => event.type === 'compaction/summary');
    assert.equal(summary.data.maxTokens, 8192, 'default initialization retains the pinned DSH generation configuration');
    assert.ok(JSON.stringify(summary.data.summary).includes('COMPLETE_CHECKPOINT'));
    assert.ok(JSON.stringify(events).includes('ORIGINAL_SOURCE_EVIDENCE'));
    assert.equal(f.adapter.budget.run.calls, 3); assert.equal(f.adapter.budget.tasks.get('dev').calls, 3);
    assert.equal(f.usages.filter(usage => usage.requestPurpose === 'compaction').length, 1);
    assert.equal(f.adapter.budget.run.limit, .4); assert.equal(f.adapter.budget.tasks.get('dev').limit, .4);
    assert.equal(f.adapter.reserved, 0); assert.equal(readRun(f.root, f.archive.id).integrity, 'ok');
  } finally { await f.close(); }
});

test('a lower approved task cap still rejects the truncated checkpoint while safe original-history execution keeps that cap', { timeout: 15000 }, async () => {
  const f = await checkpointCapFixture({ taskCap: 1024 });
  try {
    await f.seed(); await turn(f.agent, 'continue the approved task');
    const summaries = f.wires.filter(wire => wire.summary), events = f.agent.session.snapshotEvents();
    assert.equal(f.context.compaction.modelPolicies[0].maxTokens, 2048);
    assert.equal(summaries.length, 1); assert.equal(summaries[0].body.max_tokens, 1024, 'shared adapter preserves the approved task cap');
    assert.equal(events.filter(event => event.type === 'compaction/summary').length, 0);
    assert.ok(JSON.stringify(f.agent.session.deriveMessages()).includes('ORIGINAL_SOURCE_EVIDENCE'));
    assert.equal(f.wires.length, 4); assert.equal(f.usages.length, 4);
    assert.equal(f.wires.at(-1).summary, false); assert.equal(f.wires.at(-1).body.max_tokens, 1024);
    assert.ok(JSON.stringify(f.wires.at(-1).body.messages).includes('ORIGINAL_SOURCE_EVIDENCE'));
    assert.equal(f.adapter.budget.run.limit, .4); assert.equal(f.adapter.budget.tasks.get('dev').limit, .4);
  } finally { await f.close(); }
});

test('the larger checkpoint allowance cannot spend a retained task/project reservation or dispatch a budget-blocked summary', { timeout: 15000 }, async () => {
  const f = await checkpointCapFixture(); let hold;
  try {
    await f.seed();
    const attribution = { taskId: 'dev', employeeId: 'developer' };
    hold = f.adapter.budget.reserve(f.adapter.budget.peekAvailable(attribution) - .001, attribution);
    const beforeCalls = f.adapter.budget.run.calls, retained = f.adapter.budget.run.reserved;
    await turn(f.agent, 'continue the approved task');
    const events = f.agent.session.snapshotEvents();
    assert.equal(f.wires.length, 2); assert.equal(f.usages.length, 2, 'no summary is dispatched or billed');
    assert.equal(f.adapter.budget.run.calls, beforeCalls); assert.equal(f.adapter.budget.run.reserved, retained);
    assert.equal(events.filter(event => event.type === 'compaction/summary').length, 0);
    assert.ok(events.some(event => event.type === 'compaction/end' && event.data.error?.includes('BUDGET_CONTEXT_LIMIT')));
    assert.ok(JSON.stringify(f.agent.session.deriveMessages()).includes('ORIGINAL_SOURCE_EVIDENCE'));
    assert.equal(f.adapter.budget.run.limit, .4); assert.equal(f.adapter.budget.tasks.get('dev').limit, .4);
  } finally { hold?.release(); await f.close(); }
});
function setup(role) { return ctx => {
  ctx.tools.restrict({ allow: [] });
  ctx.systemPrompt.section({ name: 'role', order: 120, text: role });
}; }

test('default byte policy admits a detailed task with a large fixed prompt and tool schema', { timeout: 10000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'context-fixed-prompt-')); const requests = [];
  const adapter = new class extends LlmAdapter {
    async resolveModel(provider, id) { return { provider, id, name: id, context: { contextWindow: 272000 } }; }
    async *stream(options) { requests.push(options); yield* reply(options.purpose === 'compaction' ? 'prior work retained' : 'work continued'); }
  }();
  const context = employeeContextPolicy({ contextBytes: 64000 }, [{ id: 'a', contextWindowTokens: 272000, maxOutputTokens: 6000 }], 'fixture');
  const host = await createTeamHost({ adapter, provider: 'fixture', sessionRoot: join(root, 'sessions'), context });
  try {
    host.ctx.tools.register(defineTool({ name: 'large_contract', description: 'Tool protocol '.repeat(1400), parameters: {}, output: { schema: { type: 'json' }, render: () => [] }, async execute() { return {}; } }));
    const a = await host.ctx.agents.create({ sessionId: randomUUID(), agentOptions: { provider: 'fixture', model: 'a' }, setup: ctx => {
      ctx.systemPrompt.section({ name: 'approved-task', order: 120, text: 'Fixed approved requirements. '.repeat(550) });
    } });
    await seed(a.agent, 'task details '); await turn(a.agent, 'write the implementation');
    const events = a.agent.session.snapshotEvents();
    assert.equal(requests.filter(r => r.purpose !== 'compaction').length, 3, JSON.stringify(events.filter(e => e.type === 'turn/end').map(e => e.data)));
    assert.equal(requests.filter(r => r.purpose === 'compaction').length, 0, 'fixed prompt must not cause a futile paid summary');
    assert.ok(events.some(e => e.type === 'assistant/message' && JSON.stringify(e).includes('work continued')));
  } finally { await host.close(); await rm(root, { recursive: true, force: true }); }
});

test('automatic employee summaries retain source records, isolate history and survive resume', { timeout: 15000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'context-summary-'));
  const archive = createRunArchive(root, { title: 'context isolation' }), requests = [];
  const adapter = new class extends LlmAdapter {
    async resolveModel(provider, id) { return { provider, id, name: id, context: { contextWindow: 4096 } }; }
    async *stream(options) {
      requests.push(options);
      yield* reply(options.purpose === 'compaction' ? 'Progress: evidence saved at doc-A#L1; pending: verify result. Constraint: approved files only.' : 'work saved');
    }
  }();
  const host = await createTeamHost({ adapter, provider: 'fixture', sessionRoot: join(root, 'sessions'), archive, context: { mode: 'summary', compaction: { modelPolicies: [{ provider: 'fixture', model: 'a', retainTokens: 512 }] } } });
  try {
    let a = await host.ctx.agents.create({ sessionId: randomUUID(), agentOptions: { provider: 'fixture', model: 'a' }, setup: setup('ROLE_A') });
    const b = await host.ctx.agents.create({ sessionId: randomUUID(), agentOptions: { provider: 'fixture', model: 'b' }, setup: setup('ROLE_B') });
    const worlds = host.employeeHosts();
    assert.notEqual(worlds[0].ctx.get('tokenMeter'), worlds[1].ctx.get('tokenMeter'));
    assert.notEqual(worlds[0].ctx.get('compaction'), worlds[1].ctx.get('compaction'));
    await turn(b.agent, 'SECRET_B');
    await turn(a.agent, 'SECRET_A' + 'x'.repeat(9000));
    await turn(a.agent, 'recent work ' + 'y'.repeat(3000));
    await turn(a.agent, 'continue work');
    const summaries = a.agent.session.snapshotEvents().filter(e => e.type === 'compaction/summary');
    assert.equal(summaries.length, 1, JSON.stringify({ meter: worlds[0].ctx.get('tokenMeter').measure(a.agent.session), requests: requests.map(r => ({ model: r.model, purpose: r.purpose })), ends: a.agent.session.snapshotEvents().filter(e => e.type === 'turn/end' || e.type === 'compaction/end').map(e => e.data) }));
    assert.ok(summaries[0].data.shadowedSeqs.length >= 2);
    assert.ok(a.agent.session.snapshotEvents().some(e => JSON.stringify(e).includes('SECRET_A')));
    const request = requests.filter(r => r.model === 'a' && r.purpose !== 'compaction').at(-1);
    assert.ok(JSON.stringify(request.messages).includes('doc-A#L1'), JSON.stringify({ requests: requests.map(r => ({ model: r.model, purpose: r.purpose })), ends: a.agent.session.snapshotEvents().filter(e => e.type === 'turn/end' || e.type === 'compaction/end').map(e => e.data) }));
    assert.ok(!JSON.stringify(request.messages).includes('SECRET_A'));
    assert.ok(!JSON.stringify(request.messages).includes('SECRET_B'));
    assert.ok(JSON.stringify(request.messages).includes('ROLE_A'));
    assert.equal(b.agent.session.snapshotEvents().filter(e => e.type === 'compaction/summary').length, 0);
    const id = a.agent.id; await a.dispose();
    a = await host.ctx.agents.resume({ resumeSessionId: id, agentOptions: { provider: 'fixture', model: 'a' }, setup: setup('ROLE_A') });
    await turn(a.agent, 'resume after restart');
    assert.ok(JSON.stringify(requests.at(-1).messages).includes('doc-A#L1'));
    assert.ok(a.agent.session.snapshotEvents().some(e => JSON.stringify(e).includes('SECRET_A')));
    const run = readRun(root, archive.id);
    assert.equal(run.integrity, 'ok');
    assert.equal(run.events.filter(e => e.type === 'session/compaction/summary').length, 1, 'resume must not duplicate durable summary provenance');
    assert.ok(run.events.some(e => e.type === 'model/request' && e.data.purpose === 'compaction' && e.sessionId === id));
  } finally { await host.close(); await rm(root, { recursive: true, force: true }); }
});

test('large structured non-file tool output is reduced without losing hashes or full original evidence', { timeout: 10000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'context-tool-'));
  const archive = createRunArchive(root, { title: 'tool evidence' }); let step = 0;
  const output = { path: 'result.txt', sha256: 'a'.repeat(64), exitCode: 0, output: 'BEGIN ' + 'evidence '.repeat(3000) + ' END', source: { documentId: 'doc', version: 4, lineStart: 8 } };
  const adapter = new class extends LlmAdapter {
    async *stream(options) {
      if (step++ === 0) {
        yield { type: 'block-start', index: 0, blockType: 'tool-call' };
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'read-call', name: 'read_fixture', arguments: '{}' } };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
      } else {
        const result = options.messages.flatMap(m => m.content).find(b => b.type === 'tool-result');
        const visible = JSON.parse(result.content[0].text);
        assert.equal(visible.sha256, output.sha256); assert.equal(visible.path, output.path);
        assert.deepEqual(visible.source, output.source); assert.equal(visible.exitCode, 0);
        assert.ok(visible.output.startsWith('BEGIN ')); assert.ok(visible.output.endsWith(' END'));
        assert.match(visible.output, /text omitted; this text is incomplete/);
        assert.ok(visible.output.length < 3000); yield* reply('verified metadata');
      }
    }
  }();
  const host = await createTeamHost({ adapter, provider: 'fixture', sessionRoot: join(root, 'sessions'), archive, context: { mode: 'prune' } });
  try {
    host.ctx.tools.register(defineTool({ name: 'read_fixture', description: 'fixture', parameters: {}, output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] }, async execute() { return output; } }));
    const a = await host.ctx.agents.create({ sessionId: randomUUID(), agentOptions: { provider: 'fixture', model: 'a' } });
    await turn(a.agent, 'read and inspect');
    assert.equal(step, 2);
    const results = a.agent.session.snapshotEvents().filter(e => e.type === 'tool/result');
    assert.equal(results.length, 2);
    assert.equal(JSON.parse(results[0].data.message.content[0].content[0].text).output, output.output);
    assert.ok(results[1].sourceEventSeqs.includes(results[0].seq));
    assert.ok(readRun(root, archive.id).events.some(e => e.type === 'context/pruned'));
  } finally { await host.close(); await rm(root, { recursive: true, force: true }); }
});

const purePruner = () => Object.assign(Object.create(EvidencePruner.prototype), {
  config: { thresholdChars: 6000, headChars: 1800, tailChars: 600 },
});
const jsonBlock = value => ({ type: 'text', text: JSON.stringify(value) });

test('approved Skill instructions stay complete under pruning pressure', () => {
  const block={type:'text',text:'<skill_content name="approved-method">\n'+('Required verification step.\n'.repeat(400))+'</skill_content>'};
  assert.ok(block.text.length>6000);
  assert.equal(purePruner().pruneContent([block]),null);
});

test('structured text below 6000 characters is safely shortened when serialized JSON exceeds the threshold', () => {
  const output = 'BEGIN "quoted"\\\n'.repeat(400).slice(0, 5453) + ' END';
  assert.ok(output.length < 6000);
  const value = { path: 'test.log', sha256: 'a'.repeat(64), output, exitCode: 0 };
  const block = jsonBlock(value);
  assert.ok(block.text.length > 6000);
  const pruner = purePruner(), pruned = pruner.pruneContent([block]);
  assert.ok(pruned);
  const visible = JSON.parse(pruned[0].text);
  assert.equal(visible.path, value.path); assert.equal(visible.sha256, value.sha256);
  assert.equal(visible.exitCode, 0);
  assert.ok(visible.output.startsWith('BEGIN ')); assert.ok(visible.output.endsWith(' END'));
  assert.match(visible.output, /text omitted; this text is incomplete/);
  assert.ok(pruner.measureContent(pruned) <= 6000);
  assert.equal(JSON.parse(block.text).output, output, 'the source block is never modified');
});

test('escaped structured text uses serialized size and retains full metadata without a raw JSON fallback', () => {
  const value = { path: 'escaped.log', sha256: 'b'.repeat(64), output: '\u0001'.repeat(2000), source: { documentId: 'doc', version: 2 } };
  assert.ok(value.output.length < 2400);
  const pruner = purePruner(), pruned = pruner.pruneContent([jsonBlock(value)]);
  assert.ok(pruned);
  const visible = JSON.parse(pruned[0].text);
  assert.deepEqual(visible.source, value.source);
  assert.equal(visible.sha256, value.sha256); assert.equal(visible.path, value.path);
  assert.match(visible.output, /text omitted; this text is incomplete/);
  assert.ok(pruner.measureContent(pruned) <= 6000);
});

test('oversized metadata remains valid and complete and already shortened results do not create repeated replacements', () => {
  const value = { artifacts: Array.from({ length: 70 }, (_, index) => ({ path: `long-reference-name-${index}.txt`, sha256: 'c'.repeat(64) })), output: 'x'.repeat(10000) };
  const pruner = purePruner(), pruned = pruner.pruneContent([jsonBlock(value)]);
  assert.ok(pruned);
  const visible = JSON.parse(pruned[0].text);
  assert.deepEqual(visible.artifacts, value.artifacts);
  assert.match(visible.output, /text omitted; this text is incomplete/);
  assert.ok(pruner.measureContent(pruned) > 6000, 'complete metadata can exceed the soft per-tool threshold');
  assert.equal(pruner.pruneContent(pruned), null, 'metadata does not cause repeated prune events');
  const metadataOnly = jsonBlock({ artifacts: value.artifacts });
  assert.equal(pruner.pruneContent([metadataOnly]), null);
  assert.deepEqual(JSON.parse(metadataOnly.text).artifacts, value.artifacts);
});

test('mixed structured and plain text preserves JSON, rich block order and explicit omission markers', () => {
  const file = { path: 'source.mjs', sha256: 'd'.repeat(64), content: 'full-source '.repeat(1000) };
  const structured = { path: 'results.log', sha256: 'e'.repeat(64), output: 'x'.repeat(12000) };
  const image = { type: 'image', source: { kind: 'url', url: 'https://fixture.invalid/image.png' } };
  const blocks = [jsonBlock(file), image, { type: 'text', text: 'plain '.repeat(2000) }, jsonBlock(structured)];
  const pruned = purePruner().pruneContent(blocks);
  assert.ok(pruned); assert.equal(pruned.length, blocks.length);
  assert.equal(pruned[0], blocks[0], 'a complete file read is retained byte for byte');
  assert.equal(pruned[1], image);
  assert.match(pruned[2].text, /tool result middle pruned/);
  assert.equal(JSON.parse(pruned[3].text).sha256, structured.sha256);
  assert.match(JSON.parse(pruned[3].text).output, /this text is incomplete/);
});

test('complete filesystem reads survive the actual employee pruning pipeline and retain original trace evidence', { timeout: 10000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'context-file-complete-'));
  const archive = createRunArchive(root, { title: 'complete authorized file read' }); let step = 0;
  const content = 'const text = "complete";\\\n'.repeat(250).slice(0, 5453);
  const output = { path: 'todo.test.mjs', sha256: 'f'.repeat(64), content, artifacts: [{ path: 'todo.test.mjs', size: content.length, sha256: 'f'.repeat(64) }] };
  assert.ok(content.length < 6000); assert.ok(JSON.stringify(output).length > 6000);
  const adapter = new class extends LlmAdapter {
    async *stream(options) {
      if (step++ === 0) {
        yield { type: 'block-start', index: 0, blockType: 'tool-call' };
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'file-read', name: 'filesystem', arguments: JSON.stringify({ path: output.path }) } };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
      } else {
        const result = options.messages.flatMap(message => message.content).find(block => block.type === 'tool-result');
        const visible = JSON.parse(result.content[0].text);
        assert.deepEqual(visible, output);
        yield* reply('complete file available');
      }
    }
  }();
  const host = await createTeamHost({ adapter, provider: 'fixture', sessionRoot: join(root, 'sessions'), archive,
    context: { ...employeeContextPolicy({ contextBytes: 192000 }, [], 'fixture'), mode: 'prune' } });
  try {
    host.ctx.tools.register(defineTool({ name: 'filesystem', description: 'complete fixture read', parameters: { path: { type: 'string', required: true } },
      output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] }, async execute() { return output; } }));
    const employee = await host.ctx.agents.create({ sessionId: randomUUID(), agentOptions: { provider: 'fixture', model: 'a' } });
    await turn(employee.agent, 'read the approved file');
    assert.equal(step, 2);
    const history = employee.agent.session.snapshotEvents();
    const results = history.filter(event => event.type === 'tool/result');
    assert.equal(results.length, 1, 'complete file reads do not acquire a clipped replacement');
    assert.deepEqual(JSON.parse(results[0].data.message.content[0].content[0].text), output);
    assert.equal(history.filter(event => event.type === 'compaction/prune').length, 0);
    const run = readRun(root, archive.id);
    assert.equal(run.integrity, 'ok'); assert.equal(run.events.filter(event => event.type === 'context/pruned').length, 0);
  } finally { await host.close(); await rm(root, { recursive: true, force: true }); }
});

test('a complete file larger than 192000 context bytes fails before model dispatch and budget reservation', async () => {
  const file = { path: 'large.txt', sha256: 'a'.repeat(64), content: '中'.repeat(70000) }, blocks = [jsonBlock(file)];
  assert.equal(purePruner().pruneContent(blocks), null, 'an unpageable file is not silently truncated');
  assert.ok(Buffer.byteLength(blocks[0].text) > 192000);
  let fetched = 0, reserved = 0;
  const fetchMock = mock.method(globalThis, 'fetch', async () => { fetched++; throw Error('must not dispatch oversized input'); });
  const adapter = new OpenAiCompatibleAdapter({ routes: [{ id: 'a', name: 'fixture', wireModel: 'fixture', baseUrl: 'http://127.0.0.1', inputRate: 0.4, outputRate: 1.6, maxOutputTokens: 32 }],
    contextBytes: 192000, maxBudget: 0.48, maxModelCalls: 45, beforeRequest: () => { reserved++; } });
  const messages = [prompt('read the approved large file'), { role: 'assistant', content: [{ type: 'tool-call', id: 'read-large', name: 'filesystem', arguments: '{"path":"large.txt"}' }] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'read-large', content: blocks }] }];
  try {
    await assert.rejects(async () => { for await (const _ of adapter.stream({ model: 'a', messages })) {} }, error => error.code === 'CONTEXT_LIMIT' && error.message.startsWith('CONTEXT_LIMIT:'));
    assert.equal(adapter.contextBytes, 192000); assert.equal(fetched, 0); assert.equal(reserved, 0);
    assert.equal(adapter.calls, 0); assert.equal(adapter.spent, 0);
  } finally { fetchMock.mock.restore(); }
});

test('summary admission shares the execution call allowance and rejection preserves source history', { timeout: 10000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'context-budget-'));
  let calls = 0; const usage = [];
  const fetchMock = mock.method(globalThis, 'fetch', async () => {
    calls++;
    return new Response(JSON.stringify({ choices: [{ message: { content: 'work saved' }, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 5 } }), { headers: { 'content-type': 'application/json' } });
  });
  const adapter = new OpenAiCompatibleAdapter({ routes: [{ id: 'a', name: 'a', wireModel: 'a', baseUrl: 'http://127.0.0.1', inputRate: 1, outputRate: 1, maxOutputTokens: 512, contextWindowTokens: 2048 }], maxBudget: 1, maxModelCalls: 2, onUsage: u => usage.push(u) });
  const host = await createTeamHost({ adapter, provider: 'fixture', sessionRoot: join(root, 'sessions'), context: { mode: 'summary' } });
  try {
    const a = await host.ctx.agents.create({ sessionId: randomUUID(), agentOptions: { provider: 'fixture', model: 'a' } });
    await seed(a.agent, 'SOURCE_NOT_SUMMARIZED'); await turn(a.agent, 'continue');
    assert.equal(calls, 2); assert.equal(usage.length, 2);
    assert.ok(usage.every(u => u.sessionId === a.agent.id && u.requestPurpose === 'execution'));
    const events = a.agent.session.snapshotEvents();
    assert.ok(events.some(e => e.type === 'compaction/end' && e.data.error?.includes('次数')));
    assert.equal(events.filter(e => e.type === 'compaction/summary').length, 0);
    assert.ok(JSON.stringify(a.agent.session.deriveMessages()).includes('SOURCE_NOT_SUMMARIZED'));
  } finally { await host.close(); fetchMock.mock.restore(); await rm(root, { recursive: true, force: true }); }
});

test('cancellation during one employee summary leaves sibling state and original history intact', { timeout: 10000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'context-cancel-'));
  const started = Promise.withResolvers(); let cancelled = false;
  const adapter = new class extends LlmAdapter {
    async resolveModel(provider, id) { return { provider, id, name: id, context: { contextWindow: 2048 } }; }
    async *stream(options) {
      if (options.purpose === 'compaction') {
        started.resolve();
        await new Promise(resolve => options.signal.addEventListener('abort', () => { cancelled = true; resolve(); }, { once: true }));
        options.signal.throwIfAborted();
      }
      yield* reply('work saved');
    }
  }();
  const host = await createTeamHost({ adapter, provider: 'fixture', sessionRoot: join(root, 'sessions'), context: { mode: 'summary' } });
  try {
    const a = await host.ctx.agents.create({ sessionId: randomUUID(), agentOptions: { provider: 'fixture', model: 'a' }, setup: setup('worker') });
    const b = await host.ctx.agents.create({ sessionId: randomUUID(), agentOptions: { provider: 'fixture', model: 'b' }, setup: setup('worker') });
    await turn(b.agent, 'SIBLING_STATE'); await seed(a.agent, 'KEEP_ORIGINAL');
    a.agent.followup(prompt('continue')); await started.promise; await a.dispose();
    assert.equal(cancelled, true); assert.equal(host.ctx.agents.get(b.agent.id), b.agent);
    assert.equal(a.agent.session.snapshotEvents().filter(e => e.type === 'compaction/summary').length, 0);
    assert.ok(JSON.stringify(a.agent.session.deriveMessages()).includes('KEEP_ORIGINAL'));
    await turn(b.agent, 'continue sibling'); assert.ok(JSON.stringify(b.agent.session.deriveMessages()).includes('SIBLING_STATE'));
  } finally { await host.close(); await rm(root, { recursive: true, force: true }); }
});

test('a nonshrinking summary is rejected without replacing the source history', { timeout: 10000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'context-nonshrinking-')); let summaries = 0;
  const adapter = new class extends LlmAdapter {
    async resolveModel(provider, id) { return { provider, id, name: id, context: { contextWindow: 4096 } }; }
    async *stream(options) {
      if (options.purpose === 'compaction') { summaries++; yield* reply('invalid oversized summary '.repeat(1500)); }
      else yield* reply('work saved');
    }
  }();
  const host = await createTeamHost({ adapter, provider: 'fixture', sessionRoot: join(root, 'sessions'), context: { mode: 'summary', compaction: { modelPolicies: [{ provider: 'fixture', model: 'a', retainTokens: 512 }] } } });
  try {
    const a = await host.ctx.agents.create({ sessionId: randomUUID(), agentOptions: { provider: 'fixture', model: 'a' }, setup: setup('worker') });
    await turn(a.agent, 'SOURCE_EVIDENCE ' + 'x'.repeat(9000));
    await turn(a.agent, 'recent work ' + 'y'.repeat(3000)); await turn(a.agent, 'continue');
    assert.equal(summaries, 1);
    const events = a.agent.session.snapshotEvents();
    assert.equal(events.filter(e => e.type === 'compaction/summary').length, 0);
    assert.ok(events.some(e => e.type === 'compaction/end' && e.data.error));
    assert.ok(JSON.stringify(a.agent.session.deriveMessages()).includes('SOURCE_EVIDENCE'));
  } finally { await host.close(); await rm(root, { recursive: true, force: true }); }
});

test('unknown model capacity uses pruning without inventing a token window or a summary charge', { timeout: 10000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'context-unknown-')), archive = createRunArchive(root, { title: 'unknown capacity' }); let summaries = 0;
  const adapter = new class extends LlmAdapter {
    async *stream(options) { if (options.purpose === 'compaction') summaries++; yield* reply('work saved'); }
  }();
  const host = await createTeamHost({ adapter, provider: 'fixture', sessionRoot: join(root, 'sessions'), archive, context: { mode: 'summary' } });
  try {
    const a = await host.ctx.agents.create({ sessionId: randomUUID(), agentOptions: { provider: 'fixture', model: 'unknown' }, setup: setup('worker') });
    await seed(a.agent, 'KEEP_SOURCE'); await turn(a.agent, 'continue');
    assert.equal(summaries, 0);
    assert.ok(JSON.stringify(a.agent.session.deriveMessages()).includes('KEEP_SOURCE'));
    assert.equal(readRun(root, archive.id).events.filter(e => e.type === 'context/capacity-unknown').length, 1);
  } finally { await host.close(); await rm(root, { recursive: true, force: true }); }
});
