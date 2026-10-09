import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { TraceEvent } from '../services/agent-runtime/trace-store.mjs';
import { RunTraceEvent, RunTraceEventBody, eventSummary } from '../apps/web/src/RunCenter.tsx';
import { visibleRunTraceEvents } from '../apps/web/src/run-events.ts';

const event = (seq: number, type: string, data: any = {}): TraceEvent => ({ seq, type, data, at: '2026-10-08T00:00:00Z', sessionId: 'worker', attemptId: 'original-attempt' } as TraceEvent);
test('hundreds of collapsed events neither serialize giant raw requests nor place their bodies in the DOM', () => {
 const payload = 'BEGIN_FULL_RAW_' + 'x'.repeat(300000) + '_END_FULL_RAW'; let serialized = 0;
 const data = { provider: 'local-fixture', model: 'synthetic', payload };
 Object.defineProperty(data, 'toJSON', { value: () => { serialized++; throw Error('closed raw body must not be serialized'); } });
 const cards = Array.from({ length: 500 }, (_, index) => createElement(RunTraceEvent, { key: index, event: event(index + 1, 'model/request', data), employeeName: 'QA fixture' }));
 const html = renderToStaticMarkup(createElement('div', null, cards));
 assert.equal(serialized, 0); assert.doesNotMatch(html, /<pre|BEGIN_FULL_RAW|END_FULL_RAW|执行尝试/);
 assert.equal((html.match(/class="trace-event"/g) ?? []).length, 500);
 assert.match(html, /local-fixture \/ synthetic/);
});

test('closed body guards serialization; an explicitly opened body renders complete original JSON and attempt identity', () => {
 const payload = 'BEGIN_ORIGINAL_' + '真实本地测试'.repeat(10000) + '_END_ORIGINAL'; let serialized = 0;
 const data = { nested: { payload, toolArguments: { command: 'synthetic command only' } } };
 Object.defineProperty(data, 'toJSON', { value: () => { serialized++; return { nested: data.nested }; } });
 const trace = event(10, 'model/wire-request', data);
 assert.equal(renderToStaticMarkup(createElement(RunTraceEventBody, { event: trace, open: false })), ''); assert.equal(serialized, 0);
 const expected = renderToStaticMarkup(createElement('pre', null, JSON.stringify(data, null, 2))); serialized = 0;
 const html = renderToStaticMarkup(createElement(RunTraceEventBody, { event: trace, open: true }));
 assert.equal(serialized, 1); assert.ok(html.endsWith(expected)); assert.match(html, /original-attempt/);
 assert.ok(html.includes(payload));
});

test('main view omits routine status polling but preserves failures, unknown outcomes and accepted state changes', () => {
 const events = [event(1, 'team/snapshot', { phase: 'running' }), event(2, 'tool/start', { name: 'agent_teams_status' }),
  event(3, 'tool/result', { name: 'agent_teams_status', result: { isError: false, value: {} } }),
  event(4, 'tool/result', { name: 'agent_teams_status', result: { isError: true, error: { message: 'original failure' } } }),
  event(5, 'tool/result', { name: 'agent_teams_status', result: { value: 'result not confirmed' } }),
  event(6, 'runtime/outcome-unknown', { message: 'do not replay' }), event(7, 'runtime/anomaly', { code: 'EMPLOYEE_IDLE' }),
  event(8, 'handoff/accepted', { taskId: 'T1' }), event(9, 'runtime/status', { employees: [] })];
 const named = new Set(events.map(item => item.type)), before = JSON.stringify(events);
 assert.deepEqual(visibleRunTraceEvents(events, 'all', '', named).map(item => item.seq), [4, 5, 6, 7, 8, 9]);
 assert.equal(JSON.stringify(events), before);
 assert.deepEqual(visibleRunTraceEvents(events, 'raw', '', named), events);
 assert.deepEqual(visibleRunTraceEvents(events, 'team/', '', named).map(item => item.seq), [1]);
 assert.deepEqual(visibleRunTraceEvents(events, 'tool/', '', named).map(item => item.seq), [2, 3, 4, 5]);
 assert.deepEqual(visibleRunTraceEvents(events, 'raw', 'other-worker', named), []);
});

test('closed previews take only a bounded text prefix instead of joining the complete original message', () => {
 const untouched = { get type() { throw Error('later giant blocks need not be inspected for a preview'); } };
 const trace = event(20, 'session/assistant/message', { message: { content: [{ type: 'text', text: 'A'.repeat(100000) }, untouched] } });
 assert.equal(eventSummary(trace), 'A'.repeat(180));
});
