import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ProductDshRuntime } from './product-runtime.mjs';
import { readRun } from './trace-store.mjs';

test('real ProductDshRuntime routes employee browser and MCP calls through the external callback', { timeout: 20000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'external-runtime-'));
  const calls = [], modelRequests = [];
  const server = http.createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    const body = JSON.parse(text); modelRequests.push(body);
    const assignment = body.messages.filter(message => message.role === 'user').map(message => message.content ?? '').reverse().find(content => content.includes('AgentTeams automatic task assignment'));
    let message = { content: 'Fixture work complete.' }, finish = 'stop';
    if (assignment) {
      const taskId = /Task: (t\d+)/.exec(assignment)?.[1] ?? 't1';
      const history = body.messages.filter(message => message.role === 'tool').map(message => message.content).join('\n');
      const attempt = /Attempt id: ([a-f0-9-]+)/.exec(assignment)?.[1] ?? /attempt_id ([a-f0-9-]+)/.exec(history)?.[1];
      const sequence = [
        ['agent_teams_claim_task', { task_id: taskId }],
        ['agent_teams_update_task', { task_id: taskId, attempt_id: attempt, status: 'in_progress' }],
        ['browser_read', { url: 'https://approved.example/reference' }],
        ['mcp_call_readonly', { connectionId: 'fixture-connection', tool: 'reference_lookup', arguments: { subject: 'fixture' } }],
        ['agent_teams_update_task', { task_id: taskId, attempt_id: attempt, status: 'completed', output: 'References read through approved tools.' }],
      ];
      const step = body.messages.flatMap(message => message.tool_calls ?? []).length;
      if (step < sequence.length) { const [name, args] = sequence[step]; message = { content: null, tool_calls: [{ id: randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } }] }; finish = 'tool_calls'; }
    }
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ choices: [{ message, finish_reason: finish }], usage: { prompt_tokens: 50, completion_tokens: 10 } }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const runId = randomUUID(), snapshot = {
    projectId: 'external-tools-fixture', planVersion: 1, requirement: 'Read approved reference sources.', executionBudget: 1,
    approval: { kind: 'project', projectVersion: 1 },
    policy: { maxBudget: 1, maxConcurrentAgents: 2, deadlineSeconds: 15, contextManagement: 'prune', maxModelCalls: 15, maxTaskModelCalls: 12, allowedTools: ['browser_read', 'mcp_call_readonly'] },
    agents: [
      { id: 'employee-1', employeeId: 'manager', role: 'manager', modelId: 'fixture', rolePrompt: 'Coordinate fixture work.', tools: [] },
      { id: 'employee-2', employeeId: 'researcher', sourceDepartmentId: 'department-a', sourceAgentId: 'researcher', role: 'member', modelId: 'fixture', rolePrompt: 'Read only approved references.', tools: ['browser_read', 'mcp_call_readonly'], browserOrigins: ['https://approved.example'], mcpConnections: [{ connectionId: 'fixture-connection', version: 1, tools: ['reference_lookup'] }] },
    ],
    tasks: [{ id: 'read-references', kind: 'work', subject: 'Read references', assignee: 'employee-2', assigneeId: 'researcher', dependencies: [] }],
  };
  const runtime = new ProductDshRuntime({ traceRoot: root,
    createExecutor: archive => { const artifacts = join(archive.dir, 'artifacts'); mkdirSync(artifacts, { recursive: true }); return { root: artifacts, close: async () => {}, prepare: async () => {} }; },
    externalTool: async input => { calls.push(input); return { trust: 'untrusted_fixture', text: 'Fixture reference result.' }; },
  });
  try {
    const started = await runtime.start({ runId, approvedSnapshot: snapshot, routes: [{ id: 'fixture', name: 'fixture', wireModel: 'fixture', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, inputRate: 0, outputRate: 0, maxOutputTokens: 512, contextWindowTokens: 100000 }] });
    const result = await started.completion;
    assert.equal(result.status, 'completed', result.message);
    assert.deepEqual(calls.map(call => call.name), ['browser_read', 'mcp_call_readonly']);
    assert.ok(calls.every(call => call.runId === runId && call.agentId === 'employee-2' && call.signal instanceof AbortSignal));
    assert.deepEqual(calls[1].args.arguments, { subject: 'fixture' });
    const events = readRun(root, runId).events;
    assert.equal(events.filter(event => event.type === 'external/tool-start').length, 2);
    assert.equal(events.filter(event => event.type === 'external/tool-finished').length, 2);
    assert.ok(modelRequests.some(request => JSON.stringify(request.messages).includes('Fixture reference result.')), 'external result must reach the employee model');
  } finally {
    await runtime.cancel(runId); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true });
  }
});
