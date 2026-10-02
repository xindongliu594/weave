import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ProductDshRuntime } from './product-runtime.mjs';
import { readRun } from './trace-store.mjs';

test('approved deadline is retained as the stop reason when a tool wraps the abort', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-deadline-'));
  const id = randomUUID();
  let closed = false;
  const runtime = new ProductDshRuntime({ traceRoot: root, createExecutor: archive => {
    const artifacts = join(archive.dir, 'artifacts'); mkdirSync(artifacts, { recursive: true });
    return { root: artifacts, close: async () => { closed = true; }, prepare: signal => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(Error('tool call aborted')), { once: true });
    }) };
  } });
  try {
    const run = await runtime.start({ runId: id, routes: [], approvedSnapshot: {
      projectId: 'deadline-fixture', planVersion: 1, agents: [], tasks: [],
      policy: { maxConcurrentAgents: 1, deadlineSeconds: 1 },
    } });
    const result = await run.completion;
    assert.equal(result.status, 'failed');
    assert.match(result.message, /已批准的 1 秒时限/);
    assert.match(result.message, /先核对待结算调用/);
    const archived = readRun(root, id);
    assert.equal(archived.integrity, 'ok');
    assert.equal(archived.events.findLast(e => e.type === 'run/finished').data.code, 'RUN_DEADLINE_EXCEEDED');
    assert.equal(archived.events.filter(e => e.type === 'run/deadline-exceeded').length, 1);
    assert.equal(archived.events.filter(e => e.type === 'model/wire-request').length, 0);
    assert.equal(closed, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
