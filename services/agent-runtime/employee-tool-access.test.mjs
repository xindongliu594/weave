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
