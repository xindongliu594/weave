import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { RunEmployeeStatus, TerminalRunChecks } from '../apps/web/src/RunExtras.tsx';
import type { CostReadiness } from '../apps/web/src/CostCarryoverChoice.tsx';

// Minimal fields from actual v9 run f86bfd4f-265d-43f4-ad30-5c5c1140dd92.
// Original capture stays private: v9-terminal-ui-events.json, SHA256
// 36b4177d09c5df3c57b47c19d0ae2ee5d5b80559d401f1adea14e4a768712037.
// Task prose, source code and provider data are deliberately not copied here.
const actualEvents = [
 { seq: 2450, at: '2026-10-08T13:07:37.380Z', type: 'runtime/status', data: { employees: [{
  sessionId: '342863e3-0639-4fc2-8244-eb9a1c411830', runtimeTaskId: 't3', taskId: 'T3',
  attemptId: 'be2247a8-f9d4-46bd-a7cb-eda755fc6ba3', phase: 'waiting_model', lastProgressAt: 1791464855503, errors: 0, agentId: 'employee-1' }] } },
 { seq: 2576, at: '2026-10-08T13:08:16.732Z', type: 'run/finished', data: { status: 'completed', tasks: [
  { id: 't1', status: 'completed' }, { id: 't2', status: 'completed' }, { id: 't3', status: 'completed' }] } },
];
const runtime = actualEvents.findLast(event => event.type === 'runtime/status')!.data;
const employeeName = () => '协调经理', taskName = () => '只读复审';
const renderStatus = (status: string) => renderToStaticMarkup(createElement(RunEmployeeStatus, { status, runtime, employeeName, taskName }));
const settled: CostReadiness = { recordedCost: .1, reserved: 0, availableBudget: .3, pendingCount: 0, uncertainCount: 0, receipts: [] };

test('actual completed event overrides the earlier manager waiting-model display without rewriting source events', () => {
 const original = structuredClone(actualEvents), status = actualEvents.findLast(event => event.type === 'run/finished')!.data.status!;
 const html = renderStatus(status);
 assert.match(html, /员工状态 · 本次运行已完成/); assert.match(html, /本次运行已结束/);
 assert.doesNotMatch(html.split('<details>')[0], /协调经理 · 等待模型/);
 assert.match(html, /查看停止前原始员工状态（历史记录）/); assert.match(html, /协调经理 · 等待模型 · 只读复审/);
 assert.deepEqual(actualEvents, original); assert.deepEqual(actualEvents[1].data.tasks!.map(task => task.status), ['completed', 'completed', 'completed']);
});

test('failed, cancelled and interrupted runs keep old active phases as folded history while active runs still show live phases', () => {
 for (const status of ['failed', 'cancelled', 'interrupted']) {
  const html = renderStatus(status); assert.match(html, /本次运行已结束/); assert.match(html, /历史记录/);
  assert.doesNotMatch(html.split('<details>')[0], /协调经理 · 等待模型/);
 }
 for (const status of ['running', 'unfinished']) {
  const html = renderStatus(status); assert.match(html, /员工运行状态/); assert.match(html, /协调经理 · 等待模型 · 只读复审/);
  assert.doesNotMatch(html, /本次运行已结束|历史记录/);
 }
});

test('even completed runs expose pending fees, unknown external operations and leftover approvals for reconciliation', () => {
 const readiness: CostReadiness = { ...settled, pendingCount: 1, uncertainCount: 2, reserved: .09, receipts: [{ id: 'unknown-fee', amount: .09, status: 'uncertain' }] };
 const unknown = [{ callId: 'external-call', name: 'terminal_test', arguments: { command: 'synthetic only' } }];
 const original = structuredClone({ readiness, unknown });
 for (const status of ['completed', 'failed', 'cancelled', 'interrupted']) {
  let refreshes = 0;
  const html = renderToStaticMarkup(createElement(TerminalRunChecks, { status, readiness, unknown, pendingApprovals: 1, onRefresh: () => { refreshes++; } }));
  assert.match(html, /1 笔进行中的模型费用/); assert.match(html, /2 笔费用待核对/);
  assert.match(html, /1 项外部操作结果未知/); assert.match(html, /external-call/); assert.match(html, /不会自动重放/);
  assert.match(html, /1 项待处理审批/); assert.match(html, /终态不能继续批准旧操作/);
  assert.match(html, /href="#usage"/); assert.match(html, /刷新核对状态/); assert.equal(refreshes, 0);
 }
 assert.deepEqual({ readiness, unknown }, original);
});

test('missing fees stay unknown, settled terminal runs avoid a false pending notice, and active-run controls are unchanged', () => {
 const render = (status: string, readiness?: CostReadiness) => renderToStaticMarkup(createElement(TerminalRunChecks, { status, readiness, unknown: [], pendingApprovals: 0, onRefresh: () => {} }));
 assert.match(render('completed'), /当前费用状态尚未读取/); assert.match(render('completed'), /核对用量与费用/);
 assert.equal(render('completed', settled), ''); assert.equal(render('running'), '');
});
