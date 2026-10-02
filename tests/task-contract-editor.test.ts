import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TaskContracts } from '../apps/web/src/TaskContracts.tsx';
import type { Plan } from '../packages/contracts/index.ts';

type Task = Plan['tasks'][number];
const task = (patch: Partial<Task> = {}): Task => ({ id: 'verify', subject: '独立测试', objective: '实际运行接口测试', assigneeId: 'tester', dependencies: [], acceptanceCriteria: ['真实测试通过'], estimatedInputTokens: 100, estimatedOutputTokens: 100, ...patch });
function markup(value: Task) {
  let updates = 0;
  const text = renderToStaticMarkup(createElement(TaskContracts, { task: value, tasks: [value], update: () => { updates++; } }));
  assert.equal(updates, 0, 'opening an editor must not widen or rewrite the approved scope');
  return text;
}

test('verification tasks expose existing scope for correction without making it mandatory', () => {
  const text = markup(task({ kind: 'verification', inScope: ['仅编写测试并记录结果'], outOfScope: ['server.mjs'], outputs: [{ path: 'acceptance.json' }] }));
  assert.match(text, /允许修改的文件或目录（每行一项，可选）/);
  assert.match(text, /仅编写测试并记录结果/);
  assert.match(text, /禁止修改的文件或目录（可选）/);
  assert.match(text, /只填写工作区相对路径/);
  assert.ok(!text.includes('<textarea required=""'), 'verification scope and commands remain optional');
});

test('tasks with declared outputs can edit scope even when the task kind is work', () => {
  const text = markup(task({ kind: 'work', outputs: [{ path: 'report.md' }] }));
  assert.match(text, /允许修改的文件或目录（每行一项，可选）/);
  assert.match(text, /report.md/);
});

test('implementation scope remains required and an unrestricted text task adds no scope fields', () => {
  const implementation = markup(task({ kind: 'implementation', inScope: ['server.mjs'], verify: ['node --check server.mjs'] }));
  assert.match(implementation, /允许修改的文件或目录（每行一项，必填）/);
  assert.match(implementation, /<textarea required=""/);
  const text = markup(task({ kind: 'verification' }));
  assert.ok(!text.includes('允许修改的文件或目录'));
});
