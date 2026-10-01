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

const prompt = text => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } });
const reply = text => [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'block-end', index: 0, block: { type: 'text', text } },
  { type: 'finish', reason: { kind: 'stop' } },
];
async function turn(agent, text) { agent.followup(prompt(text)); await agent.whenIdle(); }
async function seed(agent, marker) { await turn(agent, marker + 'x'.repeat(4500)); await turn(agent, 'recent work ' + 'y'.repeat(3000)); }
function setup(role) { return ctx => {
  ctx.tools.restrict({ allow: [] });
  ctx.systemPrompt.section({ name: 'role', order: 120, text: role });
}; }

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

test('large structured tool output is reduced without losing hashes or full original evidence', { timeout: 10000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'context-tool-'));
  const archive = createRunArchive(root, { title: 'tool evidence' }); let step = 0;
  const output = { path: 'result.txt', sha256: 'a'.repeat(64), exitCode: 0, content: 'BEGIN ' + 'evidence '.repeat(3000) + ' END', source: { documentId: 'doc', version: 4, lineStart: 8 } };
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
        assert.ok(visible.content.startsWith('BEGIN ')); assert.ok(visible.content.endsWith(' END'));
        assert.ok(visible.content.length < 3000); yield* reply('verified metadata');
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
    assert.equal(JSON.parse(results[0].data.message.content[0].content[0].text).content, output.content);
    assert.ok(results[1].sourceEventSeqs.includes(results[0].seq));
    assert.ok(readRun(root, archive.id).events.some(e => e.type === 'context/pruned'));
  } finally { await host.close(); await rm(root, { recursive: true, force: true }); }
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
