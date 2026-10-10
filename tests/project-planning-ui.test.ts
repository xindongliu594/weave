import test from 'node:test';
import assert from 'node:assert/strict';
import { Children, createElement, isValidElement, type ReactNode, type ChangeEvent, type InputHTMLAttributes, type SelectHTMLAttributes, type ButtonHTMLAttributes } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Model, Project } from '../packages/contracts/index.ts';
import { defaultPlanningParameters, planningParametersValid, planningQuoteMatches, planningQuoteKey, readPlanningQuote,
  generatePlanningCandidate, readPlanningGeneration, confirmPlanningCandidate, PlanningParametersView, PlanningQuoteView,
  readPlanningConfirmation, restoredPlanningDraft,
  GeneratedPlanView, ProjectPlanning, PlanningExecutionHistoryView, planningConfirmationMessage, type PlanningParameters, type PlanningQuote, type GeneratedPlan, type PlanningClient } from '../apps/web/src/ProjectPlanning.tsx';

const hash = 'a'.repeat(64);
const model = { id: 'astra', name: 'Astra', model: 'fixture-astra', gatewayId: 'fixture-gateway', inputRate: 2, outputRate: 50, status: 'available', version: 1 } as Model;
const project: Project = { id: 'original-project', departmentId: 'department', departmentVersion: 1, departmentName: '原团队', requirement: '开发 Todo API 并完成独立测试和经理验收',
  version: 6, status: 'FAILED', source: 'model', createdAt: '2026-10-05T00:00:00Z', planningCost: .02,
  policy: { maxBudget: .48, maxAgents: 1, maxConcurrentAgents: 1, deadlineSeconds: 3600, maxTaskModelCalls: 12, allowedModelIds: ['astra'] },
  plan: { rationale: '原方案仍保留', agents: [{ id: 'manager', name: '经理', role: 'manager', title: '研发经理', instructions: '只按真实证据验收，不改预算', modelId: 'astra', tools: ['filesystem', 'knowledge_search'] }],
    tasks: [{ id: 'acceptance', subject: '剩余验收', objective: '读取固定文件版本核对真实输出', assigneeId: 'manager', dependencies: [], acceptanceCriteria: ['测试退出码为零'], estimatedInputTokens: 8000, estimatedOutputTokens: 1600, maxBudget: .07, maxOutputTokens: 512,
      inputs: [{ path: 'server.mjs', sha256: hash }], outputs: [{ path: 'acceptance.json', format: 'json', requiredKeys: ['passed'], expectedValues: { passed: true } }], verify: ['node --test acceptance.test.mjs'] }],
    knowledgeDocumentIds: ['fixed-doc'], runInputs: [{ id: 'fixed_evidence', title: '开发测试结果', content: '开发测试 8/8；独立 QA 尚未执行', agentIds: ['manager'] }] },
  validation: { valid: true, checks: [{ label: '任务合同', pass: true }], errors: [], estimate: .06 } };
const parameters: PlanningParameters = { ...defaultPlanningParameters(project), modelId: 'astra', maxPlanningCost: .08, maxOutputTokens: 500 };
function quote(patch: Partial<PlanningQuote> = {}): PlanningQuote {
  return { ...parameters, checkedAt: '2026-10-05T08:00:00Z', reservation: .029048, inputBytes: 1000,
    rates: { inputRate: 2, outputRate: 50 }, nativeExecutionChecked: false,
    costReadiness: { recordedCost: .3664174, reserved: .0278694, availableBudget: .0857132, pendingCount: 0, uncertainCount: 2,
      receipts: [{ id: 'old-unknown', amount: .0278694, status: 'uncertain', runId: 'old-run' }] },
    allowed: true, reasons: [], ...patch };
}
function candidate(patch: Partial<GeneratedPlan> = {}): GeneratedPlan {
  return { previewId: 'preview-only', projectId: project.id, baseVersion: project.version,
    plan: structuredClone(project.plan), policy: structuredClone(project.policy), validation: structuredClone(project.validation), usageId: 'new-planning-fee', ...patch };
}
function history(patch: Partial<NonNullable<PlanningQuote['executionHistory']>> = {}): NonNullable<PlanningQuote['executionHistory']> {
  return { available: true, sourceRun: { id: 'historical-run', projectVersion: 6, status: 'failed', integrity: 'ok', currentVersion: true, currentPlanMatches: true },
    completedTaskIds: ['dev'], budget: { available: true, projectVersion: 6, calls: 21 },
    files: [{ path: 'server.mjs', sha256: hash, size: 1000, state: 'accepted', producerTaskId: 'dev', inputTaskIds: ['qa'] },
      { path: 'acceptance.test.mjs', sha256: 'b'.repeat(64), size: 1200, state: 'fixed_input', inputTaskIds: ['qa'] },
      { path: 'unreviewed.txt', sha256: 'c'.repeat(64), size: 400, state: 'unverified', inputTaskIds: [] }],
    unknownOperationIds: [], knowledge: { available: true, documents: [], citations: [], authorizations: [] }, issues: [], rules: [], ...patch };
}
type ElementProps = { children?: ReactNode; [key: string]: unknown };
function elements(node: ReactNode, type: string): ElementProps[] {
  const found: ElementProps[] = [];
  function visit(value: ReactNode) {
    Children.forEach(value, child => {
      if (!isValidElement(child)) return;
      const props = child.props as ElementProps;
      if (child.type === type) found.push(props);
      visit(props.children);
    });
  }
  visit(node); return found;
}

test('original defaults remain 10% capped at $1 and 5000 output, without changing any project data', () => {
  const before = JSON.stringify(project);
  assert.deepEqual(defaultPlanningParameters(project), { projectId: project.id, version: 6, modelId: '', maxPlanningCost: .048, maxOutputTokens: 5000, retainUncertainCosts: false });
  assert.equal(defaultPlanningParameters({ ...project, policy: { ...project.policy, maxBudget: 40 } }).maxPlanningCost, 1);
  assert.equal(planningParametersValid(defaultPlanningParameters(project)), false);
  for (const value of [0, NaN, Infinity, 101]) assert.equal(planningParametersValid({ ...parameters, maxPlanningCost: value }), false);
  for (const value of [0, 1.1, NaN, 32769]) assert.equal(planningParametersValid({ ...parameters, maxOutputTokens: value }), false);
  for (const value of ['false', 'true', 0, null]) assert.equal(planningParametersValid({ ...parameters, retainUncertainCosts: value as never }), false);
  assert.equal(planningParametersValid({ ...parameters, maxPlanningCost: 100, maxOutputTokens: 32768 }), true);
  assert.equal(JSON.stringify(project), before);
});

test('a changed conversation requires fresh review even when rates and reservation are unchanged',async()=>{
  const visible=quote({conversation:{sha256:'a'.repeat(64),messageIds:['message'],count:1,omitted:0,pendingCount:0}});
  const changed={...visible,conversation:{...visible.conversation!,sha256:'b'.repeat(64)}};
  assert.notEqual(planningQuoteKey(visible),planningQuoteKey(changed));
  const client:PlanningClient=async<T>(path:string)=>{assert.ok(path.endsWith('/planning-quote'));return changed as T;};
  const result=await generatePlanningCandidate(parameters,visible,'must-not-generate',client);assert.equal(result.kind,'recheck');
});

test('the exact user adjustment invalidates an old quote and stays in the locked generation body', async () => {
  const revisionRequest = '改用 DeepSeek 和 GLM。\n  保留原权限、费用与历史。';
  const revised = { ...parameters, revisionRequest }, visible = quote({ revisionRequest });
  assert.equal(planningParametersValid(revised), true);
  assert.equal(planningParametersValid({ ...parameters, revisionRequest: 'x'.repeat(4001) }), false);
  assert.equal(planningQuoteMatches(quote(), revised), false);
  assert.equal(planningQuoteMatches(visible, { ...revised, revisionRequest: revisionRequest + ' ' }), false);
  assert.notEqual(planningQuoteKey(visible), planningQuoteKey(quote()));
  const calls: { path: string; method?: string; body?: any; key?: string }[] = [];
  const client: PlanningClient = async <T,>(path: string, method?: string, body?: unknown, key?: string) => {
    calls.push({ path, method, body, key });
    if (path.endsWith('/planning-quote')) {
      assert.equal(method,'POST');assert.equal((body as any).revisionRequest,revisionRequest);assert.equal(key,undefined);
      return visible as T;
    }
    assert.equal(method, 'POST'); assert.equal((body as any).revisionRequest, revisionRequest);
    assert.equal(key, 'original-adjustment-key');
    return candidate({ revisionRequest }) as T;
  };
  const result = await generatePlanningCandidate(revised, visible, 'original-adjustment-key', client);
  assert.equal(result.kind, 'candidate'); assert.equal(calls.length, 2);
  const pending = { key: 'original-adjustment-key', parameters: revised };
  await readPlanningGeneration(pending, client);
  assert.deepEqual(calls[2].body, calls[1].body); assert.equal(calls[2].key, calls[1].key);
  const wrong: PlanningClient = async <T,>() => candidate() as T;
  await assert.rejects(readPlanningGeneration(pending, wrong), /候选/);
});

test('actual parameter controls require explicit choices and keep planning output separate from task estimates', () => {
  const patches: Partial<PlanningParameters>[] = [];
  const view = PlanningParametersView({ parameters, models: [model, { ...model, id: 'other', name: '未获授权' }, { ...model, id: 'offline', status: 'error' }], allowedModelIds: ['astra'], onChange: patch => patches.push(patch) });
  const inputs = elements(view, 'input') as InputHTMLAttributes<HTMLInputElement>[];
  const cost = inputs.find(input => input.name === 'maxPlanningCost')!, output = inputs.find(input => input.name === 'planningMaxOutputTokens')!;
  assert.equal(cost.max, 100); assert.equal(output.min, 1); assert.equal(output.max, 32768); assert.equal(output.step, 1);
  cost.onChange!({ target: { valueAsNumber: .05 } } as ChangeEvent<HTMLInputElement>);
  output.onChange!({ target: { valueAsNumber: 800 } } as ChangeEvent<HTMLInputElement>);
  (elements(view, 'select')[0] as SelectHTMLAttributes<HTMLSelectElement>).onChange!({ target: { value: 'astra' } } as ChangeEvent<HTMLSelectElement>);
  assert.deepEqual(patches, [{ maxPlanningCost: .05 }, { maxOutputTokens: 800 }, { modelId: 'astra' }]);
  assert.equal(elements(view, 'option').find(option => option.value === 'other')!.disabled, true);
  assert.equal(elements(view, 'option').some(option => option.value === 'offline'), false);
  const markup = renderToStaticMarkup(createElement(PlanningParametersView, { parameters, models: [model], allowedModelIds: ['astra'], onChange: () => {} }));
  assert.match(markup, /不能突破项目净可用预算/); assert.match(markup, /默认 5000，不会自动降低/); assert.match(markup, /区别于任务累计估算/);
  assert.equal(project.plan.tasks[0].maxOutputTokens, 512);
});

test('read-only quote performs one POST body with exact explicit parameters and rejects mismatched versions', async () => {
  const calls: { path: string; method?: string; body?: unknown }[] = [];
  const client: PlanningClient = async <T>(path: string, method?: string, body?: unknown) => { calls.push({ path, method, body }); return quote() as T; };
  await readPlanningQuote(parameters, client);
  assert.equal(calls.length, 1); assert.equal(calls[0].method, 'POST');
  const url = new URL(calls[0].path, 'http://fixture');
  assert.equal(url.pathname, '/projects/original-project/planning-quote');
  assert.equal(url.search,'');assert.deepEqual(calls[0].body, { modelId: 'astra', version: 6, maxPlanningCost: .08, maxOutputTokens: 500, retainUncertainCosts: false });
  await assert.rejects(readPlanningQuote(parameters, async <T>() => quote({ version: 7 }) as T), /不一致/);
});

test('model, output, limit and version changes invalidate old quote; receipt changes cannot reuse old consent', () => {
  const old = quote();
  for (const patch of [{ version: 7 }, { modelId: 'other' }, { maxPlanningCost: .05 }, { maxOutputTokens: 600 }, { retainUncertainCosts: true }]) assert.equal(planningQuoteMatches(old, { ...parameters, ...patch }), false);
  assert.equal(planningQuoteKey(old), planningQuoteKey(quote({ checkedAt: '2026-10-05T08:01:00Z' })));
  for (const costs of [
    { ...old.costReadiness, recordedCost: .38 },
    { ...old.costReadiness, reserved: .03, availableBudget: .083 },
    { ...old.costReadiness, receipts: [{ ...old.costReadiness.receipts[0], id: 'another-unknown' }] },
  ]) assert.notEqual(planningQuoteKey(old), planningQuoteKey(quote({ costReadiness: costs })));
});

test('changed or newly blocked quote returns current evidence without a paid generation or reservation callback', async () => {
  for (const fresh of [quote({ costReadiness: { ...quote().costReadiness, availableBudget: .02, recordedCost: .4321306 } }), quote({ allowed: false, reasons: [{ code: 'COST_PENDING', message: '未知费用仍须核对' }] })]) {
    const methods: string[] = []; let submitted = false;
    const client: PlanningClient = async <T>(_path: string, method = 'GET') => { methods.push(method); return fresh as T; };
    const result = await generatePlanningCandidate(parameters, quote(), 'original-request-key', client, () => { submitted = true; });
    assert.equal(result.kind, 'recheck'); assert.equal(submitted, false); assert.deepEqual(methods, ['POST']);
  }
  let calls = 0;
  await assert.rejects(generatePlanningCandidate(parameters, quote({ allowed: false }), 'no-call-key', async <T>() => { calls++; return quote() as T; }), /先完成/);
  assert.equal(calls, 0);
});

test('unchanged affordable quote generates one candidate after the read-only POST, with no save/approve request or data changes', async () => {
  const before = JSON.stringify(project), actions: { path: string; method: string; body: unknown; key?: string }[] = [];
  const client: PlanningClient = async <T>(path: string, method = 'GET', body?: unknown, key?: string) => { actions.push({ path, method, body, key }); return (path.endsWith('/planning-quote') ? quote() : candidate()) as T; };
  const result = await generatePlanningCandidate(parameters, quote(), 'original-request-key', client);
  assert.equal(result.kind, 'candidate'); assert.deepEqual(actions.map(action => action.method), ['POST', 'POST']);assert.equal(actions[0].key,undefined);
  assert.equal(actions[1].path, '/projects/original-project/generate'); assert.equal(actions[1].key, 'original-request-key');
  assert.deepEqual(actions[1].body, { modelId: 'astra', version: 6, maxPlanningCost: .08, maxOutputTokens: 500, retainUncertainCosts: false });
  assert.equal(actions.some(action => /confirm|approve|\/plan$/.test(action.path)), false);
  assert.equal(JSON.stringify(project), before);
});

test('interrupted generation is never automatically retried and explicit continuation retains its original key/body', async () => {
  let posts = 0;
  const failed: PlanningClient = async <T>(path: string) => { if (path.endsWith('/planning-quote')) return quote() as T; posts++; throw Error('连接已中断'); };
  await assert.rejects(generatePlanningCandidate(parameters, quote(), 'same-request-key', failed), /连接已中断/);
  assert.equal(posts, 1);
  const requests: { body: unknown; key?: string }[] = [];
  const cached: PlanningClient = async <T>(_path: string, _method?: string, body?: unknown, key?: string) => { requests.push({ body, key }); return candidate() as T; };
  await readPlanningGeneration({ parameters, key: 'same-request-key' }, cached);
  assert.equal(requests.length, 1); assert.equal(requests[0].key, 'same-request-key');
  assert.deepEqual(requests[0].body, { modelId: 'astra', version: 6, maxPlanningCost: .08, maxOutputTokens: 500, retainUncertainCosts: false });
});

test('candidate visibly preserves full role/task/hash/outputs, static budget and explicit save/discard controls', () => {
  const data = candidate(), before = JSON.stringify(data); let confirmed = 0, discarded = 0;
  const view = GeneratedPlanView({ candidate: data, currentVersion: 6, models: [model], onConfirm: () => { confirmed++; }, onDiscard: () => { discarded++; } });
  const markup = renderToStaticMarkup(createElement(GeneratedPlanView, { candidate: data, currentVersion: 6, models: [model], onConfirm: () => {}, onDiscard: () => {} }));
  for (const text of ['尚未保存', '不清零已登记费用或未知预留', '新版本需重新批准', '不会自动继承原运行检查点', '只按真实证据验收', 'server.mjs', hash, 'acceptance.json', 'requiredKeys', 'passed', 'node --test acceptance.test.mjs', 'fixed-doc', '开发测试 8/8', '任务费用上限：$0.07', '静态执行估算 $0.06', '20% 余量']) assert.ok(markup.includes(text), text);
  const buttons = elements(view, 'button') as ButtonHTMLAttributes<HTMLButtonElement>[];
  assert.equal(buttons[0].disabled, false); buttons[0].onClick!({} as never); buttons[1].onClick!({} as never);
  assert.equal(confirmed, 1); assert.equal(discarded, 1); assert.equal(JSON.stringify(data), before);
  assert.match(markup, /丢弃只移除待确认候选，不退回本次模型费用/);
});

test('stale candidates cannot confirm; saving an invalid candidate is explicitly a draft and never approves it', async () => {
  const requests: { path: string; method?: string; body: unknown; key?: string }[] = [];
  const client: PlanningClient = async <T>(path: string, method?: string, body?: unknown, key?: string) => { requests.push({ path, method, body, key }); return { ok: true, version: 7 } as T; };
  for (const data of [candidate({ baseVersion: 5 }), candidate({ projectId: 'another-project' })]) {
    await assert.rejects(confirmPlanningCandidate(data, project.id, 6, 'save-only-key', client), /不能保存/);
    const view = GeneratedPlanView({ candidate: data, currentVersion: 6, models: [model], onConfirm: () => {}, onDiscard: () => {} });
    if (data.projectId === project.id) assert.equal(elements(view, 'button')[0].disabled, true);
  }
  assert.equal(requests.length, 0);
  assert.deepEqual(await confirmPlanningCandidate(candidate(), project.id, 6, 'save-only-key', client), { ok: true, version: 7 });
  assert.deepEqual(requests, [{ path: '/projects/original-project/generated-plan/confirm', method: 'POST', body: { previewId: 'preview-only', version: 6 }, key: 'save-only-key' }]);
  const invalid = candidate({ validation: { ...project.validation, valid: false, errors: ['净额不足'] } });
  const view = GeneratedPlanView({ candidate: invalid, currentVersion: 6, models: [model], onConfirm: () => {}, onDiscard: () => {} });
  assert.equal(elements(view, 'button')[0].disabled, false);
  const markup = renderToStaticMarkup(createElement(GeneratedPlanView, { candidate: invalid, currentVersion: 6, models: [model], onConfirm: () => {}, onDiscard: () => {} }));
  assert.match(markup, /此候选尚不能运行/); assert.match(markup, /确认保存候选为草稿/); assert.match(markup, /批准执行时仍须通过全部校验/);
  await confirmPlanningCandidate(invalid, project.id, 6, 'draft-save-key', client);
  assert.equal(requests.length, 2); assert.ok(requests.every(request => request.path.endsWith('/generated-plan/confirm')));
});

test('blocked quote and initial screen clearly distinguish fees, unknown holds, checks and actual execution', () => {
  const blocked = quote({ maxOutputTokens: 5000, maxPlanningCost: .048, reservation: .254048, allowed: false, reasons: [
    { code: 'CALL_BUDGET_EXCEEDED', message: '本次预留超过单次规划限额' }, { code: 'COST_PENDING', message: '还有费用未知，预留未释放' },
  ] });
  const markup = renderToStaticMarkup(createElement(PlanningQuoteView, { quote: blocked, stale: false, checking: false, onCheck: () => {} }));
  for (const text of ['$0.254048', '$0.048', '$0.366417', '$0.027869', '$0.085713', '费用未知 2 笔', 'CALL_BUDGET_EXCEEDED', 'COST_PENDING', '不按零费用处理', '1024 字节安全余量', '并非实际 Token 或账单', '尚未检查具体执行模型请求', '不能保证 QA']) assert.ok(markup.includes(text), text);
  const initial = renderToStaticMarkup(createElement(ProjectPlanning, { project, models: [model], allowedModelIds: ['astra'], onChanged: async () => assert.fail('SSR cannot refresh or mutate'), onCosts: () => {} }));
  assert.match(initial, /尚未检查/); assert.match(initial, /检查费用、生成候选、确认保存分别操作/);
  assert.match(initial, /value="0.048"/); assert.match(initial, /value="5000"/);
  assert.match(initial, /disabled=""[^>]*>生成 AI 候选/);
  assert.ok(!initial.includes('AI 方案已保存'));
});

test('confirmation feedback uses fresh server validation rather than the earlier candidate estimate', () => {
  assert.match(planningConfirmationMessage({ ok: true, version: 7, validation: { ...project.validation, valid: false, errors: ['保存时净预算不足'] } }), /最新执行校验未通过，尚不能运行/);
  assert.match(planningConfirmationMessage({ ok: true, version: 7, validation: project.validation }), /尚未启动执行/);
  assert.match(planningConfirmationMessage({ ok: true, version: 7, existing: true }), /方案 v7/);
});

test('quote shows the included saved plan, verified source/version/contracts/nodes and complete file hashes separately from inheritance', () => {
  const markup = renderToStaticMarkup(createElement(PlanningQuoteView, { quote: quote({ executionHistory: history(), savedPlanIncluded: true }), stale: false, checking: false, onCheck: () => {} }));
  for (const text of ['费用预留已计入完整已保存方案及历史元数据', 'historical-run', '来源方案 v6', '与当前方案版本一致', '需求与任务合同：与当前方案一致', '档案完整性：完整（ok）', '当前方案完成节点：dev', '方案 v6 的执行调用：21 次', 'server.mjs', hash, 'acceptance.test.mjs', 'b'.repeat(64), 'unreviewed.txt', 'c'.repeat(64), '已核验的交付版本（accepted）', '与原批准固定输入匹配（fixed_input）', '存在但未核验为已验收交付（unverified）', '保存候选不会自动继承执行检查点']) assert.ok(markup.includes(text), text);
  assert.ok(markup.includes('href="#run/historical-run"'));
});

test('unavailable calls never become zero or a stale count; old contracts, integrity failures and issues stay explicit', () => {
  const data = history({ available: false, sourceRun: { id: 'old-run', projectVersion: 5, status: 'failed', integrity: 'missing', currentVersion: false, currentPlanMatches: false },
    completedTaskIds: [], budget: { available: false, projectVersion: 6, calls: 999 }, files: [], unknownOperationIds: ['unconfirmed-write'],
    issues: [{ code: 'BUDGET_HISTORY_UNAVAILABLE', message: '调用历史无法完整核对' }, { code: 'PLANNING_FILE_UNAVAILABLE', message: '实际文件版本无法核对' }] });
  const markup = renderToStaticMarkup(createElement(PlanningExecutionHistoryView, { history: data, savedPlanIncluded: true }));
  for (const text of ['来源为旧方案版本', '需求与任务合同：与当前方案不一致', '档案完整性：档案缺失（missing）', '未核验出完成节点', '执行调用：未知（历史未完整核对）', 'BUDGET_HISTORY_UNAVAILABLE', '调用历史无法完整核对', 'PLANNING_FILE_UNAVAILABLE', '实际文件版本无法核对', '候选不授权重放', '不代表原交付为空']) assert.ok(markup.includes(text), text);
  assert.ok(!markup.includes('999 次')); assert.ok(!markup.includes('执行调用：0 次'));
  const incomplete = renderToStaticMarkup(createElement(PlanningExecutionHistoryView, { history: history({ budget: { available: true, projectVersion: 6 } }), savedPlanIncluded: true }));
  assert.ok(incomplete.includes('执行调用：未知（历史未完整核对）'));
});

test('absent history or saved-plan proof is shown as unknown instead of claiming no previous execution', () => {
  const markup = renderToStaticMarkup(createElement(PlanningExecutionHistoryView, {}));
  assert.match(markup, /尚未确认本次预检是否包含完整已保存方案/);
  assert.match(markup, /尚未返回执行历史，不能推断没有历史调用或完成节点/);
  assert.match(markup, /原运行、实际费用与未知预留仍保留/);
});

test('same-cost and same-size SHA, completed-node or call-history changes recheck without paid generation', async () => {
  const originalHistory = history(), visible = quote({ savedPlanIncluded: true, executionHistory: originalHistory });
  const changed = [
    history({ files: originalHistory.files.map((file, index) => index === 0 ? { ...file, sha256: 'd'.repeat(64) } : file) }),
    history({ completedTaskIds: ['dev', 'qa'] }),
    history({ budget: { ...originalHistory.budget, calls: 22 } }),
  ];
  for (const executionHistory of changed) {
    const fresh = quote({ savedPlanIncluded: true, executionHistory });
    assert.equal(fresh.inputBytes, visible.inputBytes); assert.equal(fresh.reservation, visible.reservation);
    assert.notEqual(planningQuoteKey(fresh), planningQuoteKey(visible));
    const methods: string[] = []; let submitted = false;
    const client: PlanningClient = async <T>(_path: string, method = 'GET') => { methods.push(method); return fresh as T; };
    const result = await generatePlanningCandidate(parameters, visible, 'history-request-key', client, () => { submitted = true; });
    assert.equal(result.kind, 'recheck'); assert.equal(submitted, false); assert.deepEqual(methods, ['POST']);
  }
  assert.notEqual(planningQuoteKey(quote({ executionHistory: originalHistory })), planningQuoteKey(visible));
  assert.equal(planningQuoteKey(quote({ savedPlanIncluded: true, executionHistory: originalHistory, checkedAt: '2026-10-05T09:59:00Z' })), planningQuoteKey(visible));
});

test('retaining unknown fees starts unchecked; its actual checkbox invalidates prior consent and respects locking', () => {
  let changed = parameters;
  const view = PlanningParametersView({ parameters, models: [model], allowedModelIds: ['astra'], onChange: patch => { changed = { ...parameters, ...patch }; } });
  const checkbox = elements(view, 'input').find(input => input.name === 'planningRetainUncertainCosts') as InputHTMLAttributes<HTMLInputElement>;
  assert.equal(checkbox.checked, false);
  checkbox.onChange!({ target: { checked: true } } as ChangeEvent<HTMLInputElement>);
  assert.equal(changed.retainUncertainCosts, true); assert.equal(planningQuoteMatches(quote(), changed), false);
  const disabled = PlanningParametersView({ parameters: changed, models: [model], allowedModelIds: ['astra'], disabled: true, onChange: () => assert.fail('No programmatic change') });
  assert.equal(elements(disabled, 'input').find(input => input.name === 'planningRetainUncertainCosts')!.disabled, true);
  const markup = renderToStaticMarkup(view);
  for (const text of ['默认不选', '全部未知预留仍占用原预算', '不清零、不提高额度', '进行中的调用仍须等待', '选择改变后需要重新检查']) assert.ok(markup.includes(text), text);
});

test('explicit retention binds quote and generation POST bodies and candidate response, with no implicit true', async () => {
  const parametersWithRetention = { ...parameters, retainUncertainCosts: true };
  const costs = quote().costReadiness;
  const evidence = { retained: true, recordedCost: costs.recordedCost, reserved: costs.reserved, availableBudget: costs.availableBudget, receipts: costs.receipts };
  const visible = quote({ retainUncertainCosts: true, retainedCostEvidence: evidence });
  const actions: { path: string; method: string; body?: unknown; key?: string }[] = [];
  const client: PlanningClient = async <T>(path: string, method = 'GET', body?: unknown, key?: string) => {
    actions.push({ path, method, body, key }); return (path.endsWith('/planning-quote') ? visible : candidate({ retainUncertainCosts: true })) as T;
  };
  assert.equal((await generatePlanningCandidate(parametersWithRetention, visible, 'retained-fee-key', client)).kind, 'candidate');
  assert.equal(new URL(actions[0].path, 'http://fixture').search,'');assert.equal((actions[0].body as any).retainUncertainCosts,true);
  assert.deepEqual(actions[1].body, { modelId: 'astra', version: 6, maxPlanningCost: .08, maxOutputTokens: 500, retainUncertainCosts: true });
  assert.equal(actions[1].key, 'retained-fee-key');
  assert.equal(planningQuoteMatches(quote({ retainUncertainCosts: true }), parametersWithRetention), false);
  assert.equal(planningQuoteMatches(quote({ retainUncertainCosts: 'false' as never }), parameters), false);
  await assert.rejects(readPlanningGeneration({ key: 'same-key', parameters: parametersWithRetention }, async <T>() => candidate() as T), /保留费用选择不一致/);
  const markup = renderToStaticMarkup(createElement(PlanningQuoteView, { quote: visible, stale: false, checking: false, onCheck: () => {} }));
  for (const text of ['本次选择保留未结算费用', '全部预留已从净可用预算扣除', '不授权重放结果未知的操作', 'old-unknown', '#run/old-run']) assert.ok(markup.includes(text), text);
});

test('a new retained receipt or changed reconciliation evidence requires another visible quote before any POST', async () => {
  const parametersWithRetention = { ...parameters, retainUncertainCosts: true }, costs = quote().costReadiness;
  const retainedCostEvidence = { retained: true, recordedCost: costs.recordedCost, reserved: costs.reserved, availableBudget: costs.availableBudget, receipts: costs.receipts };
  const visible = quote({ retainUncertainCosts: true, retainedCostEvidence });
  const fresh = quote({ retainUncertainCosts: true, retainedCostEvidence: { ...retainedCostEvidence, receipts: [{ ...costs.receipts[0], id: 'new-receipt' }] } });
  assert.notEqual(planningQuoteKey(visible), planningQuoteKey(fresh));
  const methods: string[] = [];
  const result = await generatePlanningCandidate(parametersWithRetention, visible, 'old-consent', async <T>(_path: string, method = 'GET') => { methods.push(method); return fresh as T; });
  assert.equal(result.kind, 'recheck'); assert.deepEqual(methods, ['POST']);
});

test('legacy browser storage preserves omitted choice and original request keys when generation or confirmation is reread', async () => {
  const { retainUncertainCosts: _omitted, ...legacy } = parameters;
  const generation = { key: 'legacy-generation-key', parameters: legacy }, confirmation = { key: 'legacy-confirmation-key', previewId: 'legacy-preview', version: 6 };
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: { getItem: () => JSON.stringify({ parameters: legacy, generation, confirmation }) } });
  try {
    const restored = restoredPlanningDraft(project);
    assert.deepEqual(restored.parameters, legacy); assert.deepEqual(restored.generation, generation); assert.deepEqual(restored.confirmation, confirmation);
    const calls: { path: string; body?: unknown; key?: string }[] = [];
    const client: PlanningClient = async <T>(path: string, _method?: string, body?: unknown, key?: string) => { calls.push({ path, body, key }); return (path.endsWith('/generate') ? candidate() : path.includes('planning-quote') ? quote({ retainUncertainCosts: undefined }) : { ok: true, version: 7 }) as T; };
    await readPlanningQuote(restored.parameters, client);
    assert.equal(new URL(calls[0].path, 'http://fixture').search,'');assert.equal(Object.hasOwn(calls[0].body as object,'retainUncertainCosts'),false);
    await readPlanningGeneration(restored.generation!, client); await readPlanningConfirmation(restored.confirmation!, project.id, client);
    assert.deepEqual(calls[1].body, { modelId: 'astra', version: 6, maxPlanningCost: .08, maxOutputTokens: 500 }); assert.equal(calls[1].key, generation.key);
    assert.deepEqual(calls[2].body, { previewId: confirmation.previewId, version: 6 }); assert.equal(calls[2].key, confirmation.key);
  } finally { if (previous) Object.defineProperty(globalThis, 'sessionStorage', previous); else Reflect.deleteProperty(globalThis, 'sessionStorage'); }
});

test('retained confirmation pins its original choice for explicit reread; corrupted stored choices cannot grant consent', async () => {
  const calls: { body?: unknown; key?: string }[] = [];
  const client: PlanningClient = async <T>(_path: string, _method?: string, body?: unknown, key?: string) => { calls.push({ body, key }); return { ok: true, version: 7 } as T; };
  await confirmPlanningCandidate(candidate({ retainUncertainCosts: true }), project.id, 6, 'retained-save', client);
  await readPlanningConfirmation({ key: 'retained-save', previewId: 'preview-only', version: 6, retainUncertainCosts: true }, project.id, client);
  assert.deepEqual(calls, Array.from({ length: 2 }, () => ({ body: { previewId: 'preview-only', version: 6, retainUncertainCosts: true }, key: 'retained-save' })));
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: { getItem: () => JSON.stringify({ parameters: { ...parameters, retainUncertainCosts: 'true' }, generation: { key: 'bad-generation', parameters: { ...parameters, retainUncertainCosts: 'true' } }, confirmation: { key: 'bad-confirmation', previewId: 'preview-only', version: 6, retainUncertainCosts: 'true' } }) } });
  try {
    const restored = restoredPlanningDraft(project);
    assert.equal(restored.parameters.retainUncertainCosts, false); assert.equal(restored.generation, undefined); assert.equal(restored.confirmation, undefined);
  } finally { if (previous) Object.defineProperty(globalThis, 'sessionStorage', previous); else Reflect.deleteProperty(globalThis, 'sessionStorage'); }
});

test('retention does not bypass pending or Responses context reasons and the visible output choice stays unchanged', async () => {
  const chosen = { ...parameters, retainUncertainCosts: true, maxOutputTokens: 5000 }, costs = quote().costReadiness;
  const blocked = quote({ ...chosen, allowed: false,
    costReadiness: { ...costs, pendingCount: 1, receipts: [...costs.receipts, { id: 'live-request', amount: .01, status: 'pending' }] },
    retainedCostEvidence: { retained: true, recordedCost: costs.recordedCost, reserved: costs.reserved, availableBudget: costs.availableBudget, receipts: costs.receipts },
    reasons: [{ code: 'COST_PENDING', message: '进行中的调用仍须等待。' }, { code: 'CONTEXT_LIMIT', message: '完整 Responses 请求超过已配置上下文容量。' }] });
  const methods: string[] = [];
  await assert.rejects(generatePlanningCandidate(chosen, blocked, 'blocked-planning-key', async <T>(_path: string, method = 'GET') => { methods.push(method); return candidate() as T; }), /费用预检/);
  assert.deepEqual(methods, []);
  const parametersView = PlanningParametersView({ parameters: chosen, models: [model], allowedModelIds: ['astra'], onChange: () => assert.fail('No automatic output change') });
  assert.equal(elements(parametersView, 'input').find(input => input.name === 'planningMaxOutputTokens')!.value, 5000);
  assert.equal(elements(parametersView, 'input').find(input => input.name === 'planningRetainUncertainCosts')!.checked, true);
  const markup = renderToStaticMarkup(createElement(PlanningQuoteView, { quote: blocked, stale: false, checking: false, onCheck: () => {} }));
  for (const text of ['COST_PENDING', 'CONTEXT_LIMIT', '完整 Responses 请求', '检查时不能发起规划', '5,000', '费用未知 2 笔']) assert.ok(markup.includes(text), text);
});

test('restoring a locked request uses its original true choice even when the current editable draft stores false', async () => {
  const generation = { key: 'original-retained-generation', parameters: { ...parameters, retainUncertainCosts: true } };
  const confirmation = { key: 'original-retained-confirmation', previewId: 'preview-only', version: 6, retainUncertainCosts: true };
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: { getItem: () => JSON.stringify({ parameters, generation, confirmation }) } });
  try {
    const restored = restoredPlanningDraft(project), calls: { body?: unknown; key?: string }[] = [];
    assert.equal(restored.parameters.retainUncertainCosts, false);
    assert.deepEqual(restored.generation, generation); assert.deepEqual(restored.confirmation, confirmation);
    const client: PlanningClient = async <T>(path: string, _method?: string, body?: unknown, key?: string) => { calls.push({ body, key }); return (path.endsWith('/generate') ? candidate({ retainUncertainCosts: true }) : { ok: true, version: 7 }) as T; };
    await readPlanningGeneration(restored.generation!, client); await readPlanningConfirmation(restored.confirmation!, project.id, client);
    assert.deepEqual(calls[0], { body: { modelId: 'astra', version: 6, maxPlanningCost: .08, maxOutputTokens: 500, retainUncertainCosts: true }, key: generation.key });
    assert.deepEqual(calls[1], { body: { previewId: 'preview-only', version: 6, retainUncertainCosts: true }, key: confirmation.key });
    const markup = renderToStaticMarkup(createElement(ProjectPlanning, { project, models: [model], allowedModelIds: ['astra'], onChanged: async () => {}, onCosts: () => {} }));
    const lockedCheckbox = markup.match(/<input\b[^>]*name="planningRetainUncertainCosts"[^>]*>/)?.[0];
    assert.ok(lockedCheckbox?.includes('disabled=""'));
    assert.ok(markup.includes('读取本次保存结果'));
  } finally { if (previous) Object.defineProperty(globalThis, 'sessionStorage', previous); else Reflect.deleteProperty(globalThis, 'sessionStorage'); }
});
