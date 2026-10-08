import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { Children, createElement, isValidElement, type ReactNode, type ChangeEvent, type InputHTMLAttributes, type SelectHTMLAttributes } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer, type ViteDevServer } from 'vite';
import type { Model, Policy } from '../packages/contracts/index.ts';
import type { Draft } from '../apps/web/src/organization-draft.ts';

// Load the real CSS-importing component without a browser, HTTP listener, or backend.
let server: ViteDevServer, directory: string;
let ui: typeof import('../apps/web/src/OrganizationChat.tsx');
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'organization-models-ui-'));
  server = await createServer({ configFile: false, root: process.cwd(), cacheDir: directory, appType: 'custom', logLevel: 'silent',
    server: { middlewareMode: true, hmr: false, watch: null } });
  ui = await server.ssrLoadModule('/apps/web/src/OrganizationChat.tsx') as typeof ui;
});
after(async () => {
  await server?.close();
  if (directory) {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep + 'organization-models-ui-'));
    await rm(directory, { recursive: true, force: true });
  }
});

const policy: Policy = { maxBudget: 5, maxAgents: 4, maxConcurrentAgents: 2, deadlineSeconds: 3600,
  maxModelCalls: 100, maxTaskModelCalls: 40, contextBytes: 64000, allowedTools: ['filesystem', 'artifact_write', 'terminal_test'],
  allowedKnowledgeSpaceIds: ['authorized-space'], executionTarget: { kind: 'local', deviceId: '00000000-0000-4000-8000-000000000001', grantId: '00000000-0000-4000-8000-000000000002' } };
const models = ['Astra', 'Luna', 'Sol'].map(name => ({ id: name.toLowerCase(), name, model: 'fixture-' + name, gatewayId: 'fixture', inputRate: 1, outputRate: 2, status: 'available', version: 1 } as Model));
type Props = { children?: ReactNode; [key: string]: unknown };
function elements(node: ReactNode, type: string): Props[] {
  const found: Props[] = [];
  const visit = (value: ReactNode) => Children.forEach(value, child => {
    if (!isValidElement(child)) return;
    const props = child.props as Props;
    if (child.type === type) found.push(props);
    visit(props.children);
  });
  visit(node); return found;
}
function controls(value: Policy, onChange: (value: Policy) => void, planningModelId = 'astra', disabled = false) {
  return elements(ui.OrganizationAllowedModels({ policy: value, planningModelId, models, onChange, disabled }), 'input') as InputHTMLAttributes<HTMLInputElement>[];
}
function change(input: InputHTMLAttributes<HTMLInputElement>, checked: boolean) {
  input.onChange!({ target: { checked } } as ChangeEvent<HTMLInputElement>);
}
function homeMarkup(draft: Draft | null) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: { getItem: () => draft && JSON.stringify(draft) } });
  try {
    return renderToStaticMarkup(createElement(ui.OrganizationChat, { models, onSaved: async () => {}, onDepartments: () => {}, onProject: () => {}, onModels: () => {} }));
  } finally {
    if (previous) Object.defineProperty(globalThis, 'sessionStorage', previous);
    else Reflect.deleteProperty(globalThis, 'sessionStorage');
  }
}
const draft = (value: Policy = policy): Draft => ({ messages: [], modelId: 'astra', policy: value, maxPlanningCost: .5, input: '开发 Todo API' });

test('missing legacy allowlist grants only the current planner and does not mutate policy', () => {
  const before = JSON.stringify(policy);
  assert.deepEqual(ui.organizationAllowedModelIds(policy, 'astra'), ['astra']);
  assert.deepEqual(ui.organizationAllowedModelIds(policy, ''), []);
  assert.equal(JSON.stringify(policy), before);
  const inputs = controls(policy, () => {});
  assert.deepEqual(inputs.filter(input => input.checked).map(input => input.value), ['astra']);
  assert.equal(inputs[0].disabled, true);
  assert.equal(inputs[1].disabled, false);
  assert.equal(inputs[2].disabled, false);
});

test('switching from an implicit initial planner grants only the explicitly selected planner', () => {
  const changed = ui.selectOrganizationPlanningModel({ modelId: 'luna', policy }, 'astra');
  assert.equal(changed.modelId, 'astra');
  assert.deepEqual(changed.policy.allowedModelIds, ['astra']);
  assert.deepEqual(changed.policy, { ...policy, allowedModelIds: ['astra'] });
  assert.equal(policy.allowedModelIds, undefined);
});

test('changing the planner preserves explicit employee choices and every other authorization and budget', () => {
  const original: Policy = { ...policy, allowedModelIds: ['luna', 'sol', 'legacy-offline', 'sol'] };
  const changed = ui.selectOrganizationPlanningModel({ modelId: 'luna', policy: original }, 'astra');
  assert.deepEqual(changed.policy.allowedModelIds, ['luna', 'sol', 'legacy-offline', 'astra']);
  const { allowedModelIds: _, ...unchanged } = changed.policy;
  assert.deepEqual(unchanged, policy);
  assert.deepEqual(original.allowedModelIds, ['luna', 'sol', 'legacy-offline', 'sol']);
  assert.deepEqual(ui.selectOrganizationPlanningModel(changed, 'astra').policy.allowedModelIds, changed.policy.allowedModelIds);
});

test('real checkboxes explicitly add Luna and Sol while planner removal cannot revoke the mandatory model', () => {
  let value = policy;
  const changed = (next: Policy) => { value = next; };
  change(controls(value, changed)[1], true);
  assert.deepEqual(value.allowedModelIds, ['astra', 'luna']);
  change(controls(value, changed)[2], true);
  assert.deepEqual(value.allowedModelIds, ['astra', 'luna', 'sol']);
  change(controls(value, changed)[1], false);
  assert.deepEqual(value.allowedModelIds, ['astra', 'sol']);
  change(controls(value, changed)[0], false);
  assert.deepEqual(value.allowedModelIds, ['astra', 'sol']);
  assert.deepEqual(value, { ...policy, allowedModelIds: ['astra', 'sol'] });
});

test('the real planner select callback keeps its accessible label and does not offer unavailable models', () => {
  let value = { modelId: 'luna', policy: { ...policy, allowedModelIds: ['luna', 'sol'] } };
  const view = ui.OrganizationPlanningModelSelect({ ...value, models: [...models, { ...models[0], id: 'unavailable', status: 'error' }],
    onChange: modelId => { value = ui.selectOrganizationPlanningModel(value, modelId) as typeof value; } });
  const select = elements(view, 'select')[0] as SelectHTMLAttributes<HTMLSelectElement>;
  assert.equal(select['aria-label'], '负责组建的模型');
  select.onChange!({ target: { value: 'astra' } } as ChangeEvent<HTMLSelectElement>);
  assert.deepEqual(value.policy.allowedModelIds, ['luna', 'sol', 'astra']);
  assert.equal(elements(view, 'option').some(option => option.value === 'unavailable'), false);
  const originalMissing = ui.OrganizationPlanningModelSelect({ modelId: 'unavailable', models, onChange: () => {} });
  assert.equal(elements(originalMissing, 'option').find(option => option.value === 'unavailable')?.disabled, true);
});

test('unavailable authorized models are preserved but cannot be newly selected in the catalog', () => {
  const original = { ...policy, allowedModelIds: ['astra', 'legacy-offline'] };
  let changed: Policy | undefined;
  const view = ui.OrganizationAllowedModels({ policy: original, planningModelId: 'astra',
    models: [...models, { ...models[0], id: 'legacy-offline', status: 'error' }], onChange: value => { changed = value; } });
  const inputs = elements(view, 'input') as InputHTMLAttributes<HTMLInputElement>[];
  assert.equal(inputs.some(input => input.value === 'legacy-offline'), false);
  change(inputs[1], true);
  assert.deepEqual(changed?.allowedModelIds, ['astra', 'legacy-offline', 'luna']);
});

test('explicit legacy list missing the planner blocks sending until the user authorizes it', () => {
  const original = { ...policy, allowedModelIds: ['sol'] };
  let changed = original as Policy;
  const inputs = controls(original, value => { changed = value; });
  assert.equal(inputs[0].checked, false);
  assert.equal(inputs[0].disabled, false, 'the user can repair the required planning selection');
  const before = homeMarkup(draft(original));
  assert.match(before, /负责组建的模型尚未加入允许范围/);
  assert.match(before, /<button[^>]*aria-label="发送需求"[^>]*disabled=""/);
  change(inputs[0], true);
  assert.deepEqual(changed.allowedModelIds, ['sol', 'astra']);
  const after = homeMarkup(draft(changed));
  assert.doesNotMatch(after, /<button[^>]*aria-label="发送需求"[^>]*disabled=""/);
});

test('actual home renders the new scope explanation and disables model settings for unresolved requests', () => {
  const before = homeMarkup(null);
  assert.match(before, /员工与后续规划可用模型/);
  assert.match(before, /其它模型由你明确勾选/);
  assert.match(before, /创建后还需批准项目才会执行/);
  assert.doesNotMatch(before, /name="organizationAllowedModelIds"[^>]*checked=""/);
  const value = draft();
  value.pendingRequest = { key: 'isolated-unknown-result', settings: 'original-settings', body: { messages: [{ role: 'user', content: value.input }], modelId: value.modelId, policy: value.policy, templateId: 'software', maxPlanningCost: value.maxPlanningCost } };
  const pending = homeMarkup(value);
  assert.match(pending, /继续获取原请求的结果/);
  assert.match(pending, /<select[^>]*aria-label="负责组建的模型"[^>]*disabled=""/);
  const checkboxes = [...pending.matchAll(/<input[^>]*name="organizationAllowedModelIds"[^>]*>/g)].map(match => match[0]);
  assert.equal(checkboxes.length, 3);
  assert.ok(checkboxes.every(input => input.includes('disabled=""')));
});
