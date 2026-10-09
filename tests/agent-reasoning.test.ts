import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type ViteDevServer } from 'vite';
import { agentSchema, policySchema, validatePlan, type Model } from '../packages/contracts/index.ts';
import { assertRunModels, routeFingerprint } from '../apps/api/src/model-capabilities.ts';

const agent = agentSchema.parse({ id: 'manager', name: '经理', role: 'manager', title: '经理', instructions: '仅按批准方案工作。', modelId: 'primary', tools: [] });
const policy = policySchema.parse({ maxBudget: 1, maxAgents: 1, maxConcurrentAgents: 1, deadlineSeconds: 300, allowedModelIds: ['primary', 'fallback'], allowedTools: [] });
const task = { id: 'research', subject: '整理温度转换说明', objective: '解释温度转换公式及限制。', assigneeId: agent.id, dependencies: [], acceptanceCriteria: ['解释公式与实际限制'], estimatedInputTokens: 100, estimatedOutputTokens: 100 };
const models = ['primary', 'fallback'].map(id => ({ id, name: id, model: 'synthetic', gatewayId: 'fixture', status: 'available', inputRate: .1, outputRate: .2, capabilities: { tools: { status: 'supported' } } } as Model));

test('all explicit efforts are rejected before tool checks, regardless of route name, protocol or thinking flag', () => {
  for (const effort of ['low', 'medium', 'high'] as const) for (const route of [{ model: 'deepseek', thinkingMode: 'disabled' as const }, { model: 'gpt-fixture' }, { protocol: 'responses' as const }]) {
    const plan = { rationale: '隔离验证配置门禁', agents: [{ ...agent, reasoningEffort: effort, fallbackModelId: 'fallback' }], tasks: [task] };
    const before = structuredClone(plan);
    for (const requireTools of [false, true]) {
      const result = validatePlan(plan, policy, models.map(model => ({ ...model, ...route })), requireTools);
      assert.equal(result.valid, false); assert.equal(result.checks.find(check => check.label === '员工推理强度兼容性')?.pass, false);
      assert.match(result.errors.join('；'), /经理.*primary.*fallback.*使用模型默认/);
    }
    assert.deepEqual(plan, before, 'validation cannot clear stored effort or switch routes');
  }
});

test('model default passes while existing tool permission and budget gates still apply', () => {
  const plan = { rationale: '隔离验证模型默认', agents: [{ ...agent, fallbackModelId: 'fallback' }], tasks: [task] };
  assert.equal(validatePlan(plan, policy, models).valid, true);
  assert.equal(validatePlan(plan, policy, models.map(model => ({ ...model, capabilities: {} }))).valid, false);
  assert.equal(validatePlan(plan, { ...policy, maxBudget: .000001 }, models).valid, false);
  const stored = agentSchema.parse({ ...agent, reasoningEffort: 'medium' });
  assert.equal(stored.reasoningEffort, 'medium', 'schema retains historical settings rather than migrating them');
});

test('archived explicit effort is rejected before any database access or dispatch', async () => {
  const snapshot = { agents: [{ ...agent, reasoningEffort: 'medium' }], modelRoutes: [] }, original = structuredClone(snapshot);
  await assert.rejects(assertRunModels(snapshot, { query: async () => { throw new Error('must not access database'); } } as any), (error: any) => error.code === 'UNSUPPORTED_REASONING_EFFORT' && /使用模型默认/.test(error.message));
  assert.deepEqual(snapshot, original);
});

test('default archived routes still require current tools and exact approved fingerprints', async () => {
  const rows = models.map(model => ({ id: model.id, data: model, status: model.status, capabilities: model.capabilities, gateway_version: 1 }));
  const snapshot = { agents: [{ ...agent, fallbackModelId: 'fallback' }], modelRoutes: rows.map(row => ({ id: row.id, configurationHash: routeFingerprint(row.data, 1) })) };
  await assertRunModels(snapshot, { query: async () => ({ rows }) } as any);
  await assert.rejects(assertRunModels({ ...snapshot, modelRoutes: [] }, { query: async () => ({ rows }) } as any), (error: any) => error.code === 'MODEL_REAPPROVAL_REQUIRED');
  await assert.rejects(assertRunModels(snapshot, { query: async () => ({ rows: rows.map(row => ({ ...row, capabilities: {} })) }) } as any), (error: any) => error.code === 'MODEL_CAPABILITY_REQUIRED');
});

let server: ViteDevServer, directory: string, ui: typeof import('../apps/web/src/AgentAdvanced.tsx');
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'agent-reasoning-ui-'));
  server = await createServer({ configFile: false, root: process.cwd(), cacheDir: directory, appType: 'custom', logLevel: 'silent', server: { middlewareMode: true, hmr: false, watch: null } });
  ui = await server.ssrLoadModule('/apps/web/src/AgentAdvanced.tsx') as typeof ui;
});
after(async () => { await server?.close(); if (directory) await rm(directory, { recursive: true, force: true }); });
test('unset effort renders model default and saved medium remains visible until user changes it', () => {
  const render = (reasoningEffort?: 'medium') => renderToStaticMarkup(createElement(ui.AgentAdvanced, { agent: { ...agent, reasoningEffort }, models, update: () => { throw new Error('render must not mutate settings'); } }));
  const unset = render(); assert.match(unset, /<option value="" selected="">使用模型默认（不指定）<\/option>/); assert.doesNotMatch(unset, /value="medium" selected/);
  const saved = render('medium'); assert.match(saved, /<option value="medium" disabled="" selected="">中<\/option>/); assert.match(saved, /已有设置不会自动更改/);
  for (const effort of ['low', 'medium', 'high']) assert.match(unset, new RegExp(`<option value="${effort}" disabled="">`));
});
