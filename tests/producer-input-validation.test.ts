import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { artifactInputSchema, planSchema, validatePlan, type Plan, type Model } from '../packages/contracts/index.ts';
import { taskContractErrors } from '../packages/contracts/task-contracts.mjs';
import { HandoffGate, inspectArtifact } from '../services/agent-runtime/handoff.mjs';
import { resumeHandoff } from '../apps/api/src/handoff-checkpoints.ts';
import { toolEvidence } from './model-fixture.ts';

const model: Model = { id: 'model', name: 'Fixture', gatewayId: 'fixture', model: 'fixture', inputRate: 1, outputRate: 1, version: 1, status: 'available', capabilities: toolEvidence };
const policy = { maxBudget: 1, maxAgents: 1, maxConcurrentAgents: 1, deadlineSeconds: 600 };
const base: Plan = { rationale: 'Accepted producer inputs', agents: [{ id: 'manager', name: 'Manager', role: 'manager', title: 'Manager', instructions: 'Fixture only', modelId: model.id, tools: ['filesystem', 'artifact_write'] }], tasks: [
  { id: 'produce', subject: 'Produce new data', objective: 'Write current result', assigneeId: 'manager', dependencies: [], acceptanceCriteria: ['Current result'], estimatedInputTokens: 100, estimatedOutputTokens: 100, outputs: [{ path: 'data.json' }] },
  { id: 'consume', subject: 'Read accepted data', objective: 'Consume current accepted result', assigneeId: 'manager', dependencies: ['produce'], acceptanceCriteria: ['Accepted version'], estimatedInputTokens: 100, estimatedOutputTokens: 100, inputs: [{ path: 'data.json', producerTaskId: 'produce' }] },
] };

test('new plan validation and preview reject producer inputs pinned to a historical SHA without rewriting them', () => {
  const plan = structuredClone(base);
  plan.tasks[1].inputs![0].sha256 = 'a'.repeat(64);
  const original = structuredClone(plan);
  for (const requireToolSupport of [true, false]) {
    const validation = validatePlan(planSchema.parse(plan), policy, [model], requireToolSupport);
    assert.equal(validation.valid, false);
    assert.equal(validation.checks.find(check => check.label === '文件交接与质量合同')?.pass, false);
    assert.ok(validation.errors.some(message => message.includes('不能同时指定 producerTaskId 和固定 SHA256')));
  }
  assert.deepEqual(plan, original);
  assert.equal(taskContractErrors(plan.tasks).length, 1);
});

test('normal producer inputs and externally pinned material remain valid, with accurate planner schema descriptions', () => {
  assert.equal(validatePlan(planSchema.parse(base), policy, [model]).valid, true);
  const external = structuredClone(base);
  external.tasks[1].inputs!.push({ path: 'external-reference.json', sha256: 'b'.repeat(64) });
  assert.equal(validatePlan(planSchema.parse(external), policy, [model]).valid, true);
  const schema = z.toJSONSchema(artifactInputSchema) as any;
  assert.match(schema.properties.producerTaskId.description, /本次 accepted seal/);
  assert.match(schema.properties.sha256.description, /外部固定资料/);
  assert.match(schema.properties.sha256.description, /不填写 producerTaskId/);
});

test('historical pinned producer contracts still parse, restore exact accepted files and retain runtime mismatch checks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'producer-input-history-'));
  try {
    await writeFile(join(root, 'data.json'), '{"version":"current"}');
    const output = inspectArtifact(root, { path: 'data.json' });
    const plan = structuredClone(base);
    plan.tasks[1].inputs![0].sha256 = output.sha256;
    assert.equal(planSchema.safeParse(plan).success, true, 'historical schema deserialization keeps both signed fields');
    const seal = { taskId: 'produce', attemptId: 'accepted-produce', inputs: [], outputs: [output], commands: [] };
    const snapshot = { tasks: plan.tasks, agents: [], handoffCheckpoints: [seal] };
    const done = new Map([['produce', { attemptId: seal.attemptId }]]);
    assert.deepEqual(resumeHandoff(snapshot, [], done, root), [seal]);
    const events: any[] = [];
    const gate: any = new HandoffGate({ snapshot, sandbox: { root }, archive: { append: (type: string, data: any) => events.push({ type, data }) } });
    assert.equal(gate.beforeFile('consume', 'consumer-attempt', 'filesystem', { path: 'data.json' })[0].path, 'data.json');
    assert.equal(events[0].data.inputs[0].sha256, output.sha256);

    const stale = structuredClone(snapshot);
    stale.tasks[1].inputs![0].sha256 = 'a'.repeat(64);
    assert.throws(() => resumeHandoff(stale, [], done, root), /没有匹配的已验收版本/);
    const staleGate: any = new HandoffGate({ snapshot: stale, sandbox: { root }, archive: { append() {} } });
    assert.throws(() => staleGate.beforeFile('consume', 'stale-attempt', 'filesystem', { path: 'data.json' }), /VERSION_MISMATCH: data.json/);
    await writeFile(join(root, 'data.json'), '{"version":"tampered"}');
    assert.throws(() => resumeHandoff(snapshot, [], done, root), /已变化/);
    assert.throws(() => gate.beforeFile('consume', 'consumer-attempt', 'filesystem', { path: 'data.json' }), /VERSION_MISMATCH: data.json/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('producer-only input binds the current accepted SHA rather than any historical file version', async () => {
  const root = await mkdtemp(join(tmpdir(), 'producer-input-current-'));
  try {
    await writeFile(join(root, 'data.json'), '{"version":"new"}');
    const output = inspectArtifact(root, { path: 'data.json' });
    const snapshot = { tasks: structuredClone(base.tasks), agents: [], handoffCheckpoints: [{ taskId: 'produce', attemptId: 'new-producer', outputs: [output] }] };
    const events: any[] = [];
    const gate: any = new HandoffGate({ snapshot, sandbox: { root }, archive: { append: (type: string, data: any) => events.push({ type, data }) } });
    gate.beforeFile('consume', 'new-consumer', 'filesystem', { path: 'data.json' });
    assert.equal(events[0].data.inputs[0].sha256, output.sha256);
    assert.equal(snapshot.tasks[1].inputs![0].sha256, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
