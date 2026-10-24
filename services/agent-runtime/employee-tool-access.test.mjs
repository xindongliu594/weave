import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import { createTeamHost } from './host.mjs';
import { EmployeeHostFactory } from './employee-hosts.mjs';

const req = createRequire(import.meta.url);
const base = createRequire(req.resolve('@deepseek-ai/dsh-base/package.json'));
test('employee Hosts restrict arbitrary native tools, preserve grants on resume, and reject scoped shadows', async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-access-'));
  const host = await createTeamHost({ adapter: new class extends LlmAdapter { async *stream() { throw Error('NO_MODEL_CALL'); } }(), provider: 'fixture', sessionRoot: join(root, 'sessions') });
  let executed = 0;
  const tool = name => defineTool({ name, description: 'native tool', parameters: {}, output: { schema: { type: 'json' }, render: (_, value) => [{ type: 'text', text: JSON.stringify(value) }] }, execute: async () => { executed++; return 'ok'; } });
  const removeRead = host.ctx.tools.register(tool('plugin__office__read'));
  host.ctx.tools.register(tool('plugin__office__write'));
  const options = { coordinator: host.ctx, provider: 'fixture', sessionRoot: join(root, 'sessions'),
    identify: agent => ({ id: agent.options.model, tools: agent.options.model === 'reader' ? ['plugin__office__read'] : [] }),
    loadPlugin: name => import(pathToFileURL(base.resolve(name)).href) };
  let factory = new EmployeeHostFactory(options);
  try {
    let reader = await factory.createAgent(host.ctx, { sessionId: randomUUID(), agentOptions: { provider: 'fixture', model: 'reader' } });
    const other = await factory.createAgent(host.ctx, { sessionId: randomUUID(), agentOptions: { provider: 'fixture', model: 'other' } });
    const ctxFor = agent => factory.list().find(slot => slot.sessionId === agent.id).ctx;
    const call = (agent, name, who = agent) => ctxFor(agent).tools.execute({ name, arguments: {}, agent: who, callId: randomUUID(), signal: AbortSignal.timeout(2000) });
    const names = agent => ctxFor(agent).tools.schemas(agent).map(item => item.name);
    assert.equal(names(reader.agent).includes('plugin__office__write'), false, 'ungranted native tool must be absent');
    assert.equal(names(other.agent).includes('plugin__office__read'), false);
    assert.equal((await call(reader.agent, 'plugin__office__read')).isError, false);
    assert.equal((await call(reader.agent, 'plugin__office__write')).isError, true);
    assert.equal((await call(reader.agent, 'plugin__office__read', other.agent)).isError, true);
    assert.ok(names(reader.agent).includes('agent_teams_status'));
    assert.ok(names(reader.agent).includes('capability_search'));
    ctxFor(reader.agent).tools.register(tool('plugin__late__write'));
    assert.equal(names(reader.agent).includes('plugin__late__write'), false, 'new global registrations cannot enlarge approved snapshot');
    reader.agent.ctx.tools.register(tool('plugin__office__read'));
    assert.equal((await call(reader.agent, 'plugin__office__read')).isError, true, 'same-scope shadow cannot replace the admitted definition');
    reader.agent.ctx.tools.register(tool('plugin__late__write'));
    assert.equal((await call(reader.agent, 'plugin__late__write')).isError, true, 'scope-local registration must still pass a monotonic guard');
    assert.equal(executed, 1);
    const id = reader.agent.id;
    await factory.close(); factory = new EmployeeHostFactory(options);
    reader = await factory.resume(host.ctx, { resumeSessionId: id, agentOptions: { provider: 'fixture', model: 'reader' } });
    assert.equal(names(reader.agent).includes('plugin__office__write'), false);
    assert.equal((await call(reader.agent, 'plugin__office__read')).isError, false);
    assert.equal(executed, 2);
    removeRead(); host.ctx.tools.register(tool('plugin__office__read'));
    assert.equal((await call(reader.agent, 'plugin__office__read')).isError, true, 'coordinator replacement cannot change the admitted body');
    await reader.dispose();
    reader = await factory.resume(host.ctx, { resumeSessionId: id, agentOptions: { provider: 'fixture', model: 'reader' } });
    assert.equal((await call(reader.agent, 'plugin__office__read')).isError, true, 'resume under the original factory keeps its definition fence');
    assert.equal(executed, 2);
  } finally { await factory.close(); await host.close(); await rm(root, { recursive: true, force: true }); }
});

for (const [label, mutate] of [
  ['coordinator execute', (source, local, replaced) => { source.execute = replaced; }],
  ['coordinator parameter schema', source => { source.parameters.properties.newField = { type: 'string' }; }],
  ['coordinator output schema', source => { source.output.schema = { type: 'string' }; }],
  ['employee execute', (source, local, replaced) => { local.execute = replaced; }],
  ['employee description', (source, local) => { local.description = 'changed declaration'; }],
]) test(`employee rejects same-object ${label} mutation before body entry`, { timeout: 15000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-definition-'));
  const host = await createTeamHost({ adapter: new class extends LlmAdapter { async *stream() { throw Error('NO_MODEL_CALL'); } }(), provider: 'fixture', sessionRoot: join(root, 'sessions') });
  let executed = 0;
  const source = defineTool({ name: 'office_read', description: 'office read', parameters: {}, output: { schema: { type: 'json' }, render: (_, value) => [{ type: 'text', text: JSON.stringify(value) }] }, execute: async () => { executed++; return 'ok'; } });
  host.ctx.tools.register(source);
  const factory = new EmployeeHostFactory({ coordinator: host.ctx, provider: 'fixture', sessionRoot: join(root, 'sessions'), identify: () => ({ id: 'reader', tools: ['office_read'] }), loadPlugin: name => import(pathToFileURL(base.resolve(name)).href) });
  try {
    const reader = await factory.createAgent(host.ctx, { sessionId: randomUUID(), agentOptions: { provider: 'fixture', model: 'reader' } });
    const ctx = factory.list()[0].ctx;
    const call = () => ctx.tools.execute({ name: 'office_read', arguments: {}, agent: reader.agent, callId: randomUUID(), signal: AbortSignal.timeout(2000) });
    assert.equal((await call()).isError, false); assert.equal(executed, 1);
    mutate(source, ctx.tools.get('office_read', reader.agent), async () => { executed++; return 'replacement'; });
    const result = await call();
    assert.equal(result.isError, true, 'changed definition must be rejected');
    assert.equal(executed, 1, 'no changed or formerly approved body may run after drift');
  } finally { await factory.close(); await host.close(); await rm(root, { recursive: true, force: true }); }
});

test('employee integrity capture accepts final B2 registered definitions', { timeout: 15000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-definition-b2-'));
  const host = await createTeamHost({ adapter: new class extends LlmAdapter { async *stream() { throw Error('NO_MODEL_CALL'); } }(), provider: 'fixture', sessionRoot: join(root, 'sessions') });
  let executed = 0;
  host.ctx.tools.register(defineTool({ name: 'office_read', description: 'office read', parameters: {}, output: { schema: { type: 'json' }, render: (_, value) => [{ type: 'text', text: JSON.stringify(value) }] }, execute: async () => { executed++; return 'ok'; } }));
  const factory = new EmployeeHostFactory({ coordinator: host.ctx, taskToolBoundary: true, provider: 'fixture', sessionRoot: join(root, 'sessions'), identify: () => ({ id: 'reader', tools: ['office_read'] }), loadPlugin: name => import(pathToFileURL(base.resolve(name)).href) });
  try {
    const reader = await factory.createAgent(host.ctx, { sessionId: randomUUID(), agentOptions: { provider: 'fixture', model: 'reader' } });
    const ctx = factory.list()[0].ctx, definition = ctx.tools.get('office_read', reader.agent);
    assert.equal(Object.isFrozen(definition), true);
    assert.equal((await ctx.tools.execute({ name: 'office_read', arguments: {}, agent: reader.agent, callId: randomUUID(), signal: AbortSignal.timeout(2000) })).isError, false);
    assert.equal(executed, 1);
  } finally { await factory.close(); await host.close(); await rm(root, { recursive: true, force: true }); }
});
