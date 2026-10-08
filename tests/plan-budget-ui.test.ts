import test from 'node:test';
import assert from 'node:assert/strict';
import { Children, createElement, isValidElement, type InputHTMLAttributes, type ReactNode, type ChangeEvent } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { taskSchema, type Plan } from '../packages/contracts/index.ts';
import { PlanTaskBudgetFields, PlanTaskBudgetSummary } from '../apps/web/src/PlanTaskBudget.tsx';

type Task = Plan['tasks'][number];
const legacy: Task = { id: 'qa', subject: '独立测试', objective: '运行完整测试并报告真实结果', assigneeId: 'qa',
  dependencies: [], acceptanceCriteria: ['记录测试退出码'], estimatedInputTokens: 12000, estimatedOutputTokens: 1400 };
function fields(task: Task, update: (patch: Partial<Task>) => void) {
  const inputs = new Map<string, InputHTMLAttributes<HTMLInputElement>>();
  function visit(node: ReactNode) {
    Children.forEach(node, child => {
      if (!isValidElement(child)) return;
      const props = child.props as InputHTMLAttributes<HTMLInputElement> & { children?: ReactNode };
      if (child.type === 'input' && props.name) inputs.set(props.name, props);
      visit(props.children);
    });
  }
  visit(PlanTaskBudgetFields({ task, maxTaskModelCalls: 14, update }));
  return inputs;
}
function change(input: InputHTMLAttributes<HTMLInputElement>, value: string) {
  input.onChange!({ target: { value, valueAsNumber: value === '' ? NaN : Number(value) } } as ChangeEvent<HTMLInputElement>);
}

test('legacy plans keep an empty optional per-request cap and an unchanged serialized contract', () => {
  const before = JSON.stringify(legacy);
  const inputs = fields(legacy, () => assert.fail('rendering must not edit the plan'));
  const cap = inputs.get('maxOutputTokens')!;
  assert.equal(cap.value, '');
  assert.ok(!cap.required);
  const text = renderToStaticMarkup(createElement(PlanTaskBudgetSummary, { task: legacy, defaultMaxCalls: 14 }));
  assert.match(text, /整项任务累计预计 Token：输入 12,000 · 输出 1,400/);
  assert.match(text, /单次最大输出 Token：沿用已批准模型路线/);
  assert.match(text, /任务费用上限：共用项目预算/);
  assert.match(text, /调用上限：14 次（策略默认）/);
  assert.equal(JSON.stringify(legacy), before);
  assert.ok(!Object.hasOwn(taskSchema.parse(legacy), 'maxOutputTokens'));
});

test('explicit per-request output, total estimated output, and task money remain visibly different', () => {
  const task = taskSchema.parse({ ...legacy, estimatedOutputTokens: 5000, maxOutputTokens: 800, maxBudget: .05, maxModelCalls: 8 });
  const text = renderToStaticMarkup(createElement(PlanTaskBudgetSummary, { task, defaultMaxCalls: 14 }));
  assert.match(text, /任务费用上限：\$0.05 · 调用上限：8 次/);
  assert.match(text, /整项任务累计预计 Token：输入 12,000 · 输出 5,000/);
  assert.match(text, /单次最大输出 Token：800（任务显式上限，模型路线或本次请求可能更小）/);
  assert.ok(!text.includes('已消费'));
});

test('editing cumulative output does not silently set a per-request cap, and editing the cap does not change the estimate', () => {
  const patches: Partial<Task>[] = [];
  const inputs = fields({ ...legacy, estimatedOutputTokens: 5000, maxOutputTokens: 800 }, patch => patches.push(patch));
  change(inputs.get('estimatedOutputTokens')!, '7000');
  change(inputs.get('maxOutputTokens')!, '512');
  assert.deepEqual(patches, [{ estimatedOutputTokens: 7000 }, { maxOutputTokens: 512 }]);
  const saved = taskSchema.parse({ ...legacy, ...patches[0], ...patches[1] });
  assert.equal(saved.estimatedOutputTokens, 7000);
  assert.equal(saved.maxOutputTokens, 512);
});

test('clearing the optional cap omits it from a submitted legacy plan instead of inserting a default', () => {
  let patch: Partial<Task> | undefined;
  change(fields(legacy, value => { patch = value; }).get('maxOutputTokens')!, '');
  assert.deepEqual(patch, { maxOutputTokens: undefined });
  const wire = JSON.stringify({ ...legacy, ...patch });
  assert.equal(wire, JSON.stringify(legacy));
  assert.ok(!Object.hasOwn(taskSchema.parse(JSON.parse(wire)), 'maxOutputTokens'));
});

test('the editor explains whole-task accumulation and constrains the optional single-request integer', () => {
  const inputs = fields(legacy, () => {}), cap = inputs.get('maxOutputTokens')!;
  assert.equal(cap.min, 1);
  assert.equal(cap.max, 32768);
  assert.equal(cap.step, 1);
  const text = renderToStaticMarkup(createElement(PlanTaskBudgetFields, { task: legacy, maxTaskModelCalls: 14, update: () => {} }));
  assert.match(text, /累计预计输入 Token/);
  assert.match(text, /整项任务累计，包含多轮请求反复传入的岗位、合同、上下文与工具/);
  assert.match(text, /整项任务所有模型请求的累计输出，用于静态估算，不是单次输出上限/);
  assert.match(text, /留空沿用已批准模型路线/);
  assert.match(text, /不为后续阶段锁定额度/);
  assert.match(text, /不会保证余下任务可付/);
});
