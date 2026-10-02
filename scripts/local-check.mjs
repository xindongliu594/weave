import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export async function verifyLocal(url, directory, saved) {
  const call = async (path, method = 'GET', body, expected) => {
    const response = await fetch(url + path, { method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000) });
    const value = await response.json(); if(expected===undefined)assert.ok(response.ok,path + ': ' + JSON.stringify(value));else assert.equal(response.status, expected, path + ': ' + JSON.stringify(value)); return value;
  };
  const health = await call('/health');
  assert.equal(health.demo, undefined); assert.equal(health.workspace.kind, 'local');
  const target = health.workspace.executionTarget;
  const device = (await call('/local-devices')).find(value => value.id === target.deviceId);
  if(saved?.disabled)assert.equal(device?.enabled,false,'restart must not undo an explicit revocation');else assert.ok(device?.enabled && device.online && device.allowCommands);
  assert.equal(device.grantId, target.grantId);
  if (saved) {
    assert.equal(target.deviceId, saved.deviceId); assert.equal(target.grantId, saved.grantId);
    const gateways = await call('/gateways'), models = await call('/models');
    assert.ok(gateways.some(value => value.id === saved.gatewayId && value.baseUrl === 'https://example.invalid/v1'));
    assert.ok(models.some(value => value.id === saved.modelId && value.capabilities?.tools?.status === 'supported'));
    assert.equal((await call('/runs/' + saved.runId)).status, 'completed');
    assert.equal((await call('/runs')).length, 1, 'restart must not replay the completed task');
    assert.equal(readFileSync(join(directory, 'device.credential'), 'utf8').includes('token'), false);
    writeFileSync(join(directory, 'verification.json'), JSON.stringify({ ...saved, persistedAfterRestart: true, disabledAfterRestart:!!saved.disabled, fixtureModel: true, paidModelCalled: false }, null, 2) + '\n');
    return saved;
  }
  const marker = randomUUID(), secret = 'local-check-no-real-secret', steps = new Map();
  const source = `import assert from 'node:assert/strict';\nimport {readFileSync,writeFileSync} from 'node:fs';\nconst input=JSON.parse(readFileSync('input.json','utf8'));\nassert.equal(input.marker,${JSON.stringify(marker)});\nwriteFileSync('result.json',JSON.stringify({passed:true,marker:input.marker})+'\\n');\nconsole.log('native-local-check:'+input.marker);\n`;
  const fixture = http.createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    try {
      assert.equal(req.headers.authorization, 'Bearer ' + secret);
      let raw = ''; for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw), messages = body.messages ?? [];
      let message = { content: '本机启动验证完成；固定协议服务，仅供无费用检查。' };
      const probe = body.tools?.find(value => value.function.name === 'capability_probe');
      const probeReply = messages.find(value => value.role === 'tool' && value.tool_call_id === 'local-probe');
      if (probeReply) message = { content: JSON.parse(probeReply.content).result };
      else if (probe) message = tool('capability_probe', { nonce: probe.function.parameters.properties.nonce.enum[0] }, 'local-probe');
      else {
        let pinned;
        for (const item of messages.filter(value => value.role === 'system')) for (const line of String(item.content ?? '').split('\n')) {
          try { const value = JSON.parse(line); if (value.runtimeTaskId && value.attemptId && value.task) pinned = value; } catch {}
        }
        if (!pinned) {
          const assignment = messages.findLast(value => value.role === 'user' && String(value.content).includes('AgentTeams automatic task assignment'))?.content ?? '';
          const task = /Task: (t\d+) — 本机启动检查/.exec(assignment), attempt = /Attempt id: ([a-f0-9-]+)/.exec(assignment);
          if (task && attempt) pinned = { runtimeTaskId: task[1], attemptId: attempt[1] };
        }
        if (pinned) {
          const key = pinned.attemptId, step = steps.get(key) ?? 0;
          const update = (status, extra = {}) => ['agent_teams_update_task', { task_id: pinned.runtimeTaskId, attempt_id: pinned.attemptId, status, ...extra }];
          const actions = [
            ['agent_teams_claim_task', { task_id: pinned.runtimeTaskId }], update('in_progress'),
            ['artifact_write', { path: 'check.mjs', content: source }], ['artifact_write', { path: 'input.json', content: JSON.stringify({ marker }) }],
            ['terminal_test', { command: 'node check.mjs' }],
            update('completed', { output: '本机命令实际生成 result.json。', changedPaths: ['check.mjs', 'input.json', 'result.json'], acceptanceResults: [{ criterion: '实际命令生成正确结果', status: 'passed', evidence: '实际 Node 退出码及 result.json' }], commandsRun: [{ command: 'node check.mjs', status: 'passed', exitCode: 0, evidence: '实际本机命令' }] }),
          ];
          if (step < actions.length) { message = tool(...actions[step], key + ':' + step); steps.set(key, step + 1); }
        }
      }
      res.end(JSON.stringify({ choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 } }));
    } catch (error) { res.statusCode = 422; res.end(JSON.stringify({ error: { message: error.message } })); }
  }).listen(0, '127.0.0.1');
  await once(fixture, 'listening');
  try {
    const external = await call('/gateways', 'POST', { name: '外部配置保存检查，不发请求', baseUrl: 'https://example.invalid/v1', apiKey: secret });
    const gateway = await call('/gateways', 'POST', { name: '本机启动检查（固定协议）', baseUrl: `http://127.0.0.1:${fixture.address().port}/v1`, apiKey: secret });
    assert.equal(JSON.stringify(await call('/gateways')).includes(secret), false);
    const model = await call('/models', 'POST', { name: '本机启动检查（无真实模型）', gatewayId: gateway.id, model: 'local-check', inputRate: 0, outputRate: 0 });
    await call('/models/' + model.id + '/test', 'POST', {}); await call('/models/' + model.id + '/test-tools', 'POST', {});
    const agents = [
      { id: 'manager', role: 'manager', name: '经理', title: '协调', instructions: '协调已批准的本机任务。', modelId: model.id, tools: [] },
      { id: 'worker', role: 'member', name: '执行员工', title: '代码执行', instructions: '生成文件并实际运行命令，依据结果交付。', modelId: model.id, tools: ['filesystem', 'artifact_write', 'terminal_test'] },
    ];
    const department = await call('/departments', 'POST', { name: '本机启动检查', description: '固定协议验证本机文件、命令审批与持久化，不调用付费模型。', agents });
    const project = await call('/projects', 'POST', { departmentId: department.id, requirement: '验证本机启动、任意授权文件写入和命令审批，不使用付费模型。', policy: { maxBudget: 1, maxAgents: 2, maxConcurrentAgents: 1, deadlineSeconds: 120, maxModelCalls: 30, maxTaskModelCalls: 20, contextBytes: 256000 } });
    const initial = (await call('/projects')).find(value => value.id === project.id);
    assert.deepEqual(initial.policy.executionTarget, target, 'local project must default to the actual registered device');
    const plan = { rationale: '本机执行验证', agents: initial.plan.agents, tasks: [{ id: 'local-probe', subject: '本机启动检查', objective: '写入实际文件并执行 Node 命令生成结果。', assigneeId: 'worker', dependencies: [], acceptanceCriteria: ['实际命令生成正确结果'], estimatedInputTokens: 10000, estimatedOutputTokens: 4000, kind: 'verification', inputs: [], outputs: [{ path: 'check.mjs', format: 'text' }, { path: 'input.json', format: 'json' }, { path: 'result.json', format: 'json', expectedValues: { passed: true, marker } }], inScope: ['check.mjs', 'input.json', 'result.json'], verify: ['node check.mjs'] }] };
    await call('/projects/' + project.id + '/plan', 'PUT', { version: initial.version, plan });
    const ready = (await call('/projects')).find(value => value.id === project.id);
    const run = await call('/projects/' + project.id + '/approve', 'POST', { version: ready.version }, 202);
    let detail, approved = 0, deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      detail = await call('/runs/' + run.id); if (['completed', 'failed', 'cancelled', 'interrupted'].includes(detail.status)) break;
      for (const approval of (await call('/approvals?runId=' + run.id)).filter(value => value.status === 'pending')) {
        assert.equal(approval.arguments.command, 'node check.mjs');
        assert.ok(!(await call('/runs/' + run.id + '/local-operations')).some(value => value.payload.name === 'terminal_test'), 'command must wait for approval');
        await call('/approvals/' + approval.id, 'POST', { decision: 'approved' }); approved++;
      }
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    assert.equal(detail.status, 'completed', JSON.stringify(detail.events.findLast(value => value.type === 'run/finished')?.data)); assert.equal(approved, 1);
    assert.equal(detail.snapshot.demo, undefined); assert.deepEqual(detail.snapshot.policy.executionTarget, target);
    const operations = await call('/runs/' + run.id + '/local-operations');
    assert.ok(operations.length >= 4 && operations.every(value => value.status === 'completed'));
    assert.ok(operations.some(value => value.payload.name === 'terminal_test' && value.result.exitCode === 0 && value.result.output.includes('native-local-check:' + marker)));
    const expected = { passed: true, marker };
    assert.deepEqual(JSON.parse(readFileSync(join(health.workspace.workspacesPath, run.id, 'result.json'), 'utf8')), expected);
    assert.deepEqual(JSON.parse(readFileSync(join(directory, 'runs', run.id, 'artifacts', 'result.json'), 'utf8')), expected);
    const artifact = await fetch(url + '/runs/' + run.id + '/artifact?path=result.json'); assert.equal(artifact.status, 200); assert.deepEqual(await artifact.json(), expected);
    return { gatewayId: external.id, modelId: model.id, runId: run.id, deviceId: target.deviceId, grantId: target.grantId, approvals: approved, nativeOperations: operations.length };
  } finally { await new Promise(resolve => fixture.close(resolve)); }
}
function tool(name, args, id) { return { content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }; }
