import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, appendFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { runTraceVerification, verificationSnapshot } from './verification.mjs';
import { readRun, openRunArchive, createRunArchive } from './trace-store.mjs';

test('actual team execution archives prompts, task attempts, messages and results across a new process', { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'trace-integration-'));
  try {
    const snapshot = verificationSnapshot();
    const originalRole = snapshot.agents[1].rolePrompt;
    const result = await runTraceVerification(root, { snapshot });
    assert.equal(result.status, 'completed');
    assert.equal(result.integrity, 'ok');
    const requests = result.events.filter(e => e.type === 'model/request');
    const writer = requests.find(e => e.data.model === 'fixture-writer');
    const reviewer = requests.find(e => e.data.model === 'fixture-reviewer');
    assert.ok(writer.sessionId && writer.taskId && writer.attemptId);
    assert.ok(JSON.stringify(writer.data.messages).includes(originalRole));
    assert.ok(JSON.stringify(writer.data.messages).includes(snapshot.tasks[0].taskPrompt));
    assert.ok(JSON.stringify(reviewer.data.messages).includes('需求说明：支持创建'));
    const reports = result.events.filter(e => e.type === 'team/operation' && e.data.name === 'agent_teams_send_message');
    assert.equal(reports.length, 2);
    assert.ok(result.events.some(e => e.type === 'session/assistant/message'));
    assert.ok(result.events.some(e => e.type === 'session/tool/result'));
    assert.ok(result.events.some(e => e.type === 'team/snapshot' && e.data.deliverable));
    snapshot.agents[1].rolePrompt = '之后修改的岗位';
    snapshot.tasks[0].taskPrompt = '之后修改的任务';
    const child = spawnSync(process.execPath, ['--input-type=module', '-e',
      'import { readRun } from "./services/agent-runtime/trace-store.mjs"; console.log(JSON.stringify(readRun(process.argv[1], process.argv[2])));', root, result.id], { cwd: new URL('../..', import.meta.url), encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
    const restored = JSON.parse(child.stdout);
    assert.equal(restored.snapshot.agents[1].rolePrompt, originalRole);
    assert.deepEqual(restored.events, result.events);
    // Replayed canonical session records cannot duplicate an existing source identity.
    const event = result.events.find(e => e.sourceKey);
    openRunArchive(root, result.id).append(event.type, event.data, { sourceKey: event.sourceKey });
    assert.equal(readRun(root, result.id).eventCount, result.eventCount);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('partial journal is reported as incomplete, snapshots redact known credential fields', async () => {
  const root = await mkdtemp(join(tmpdir(), 'trace-integrity-'));
  try {
    const archive = createRunArchive(root, { title: 'fixture', mode: 'fixture', apiKey: 'private-value', note: 'Bearer test-secret-value' });
    const raw = await readFile(join(archive.dir, 'snapshot.json'), 'utf8');
    assert.ok(!raw.includes('private-value') && !raw.includes('test-secret-value'));
    archive.append('run/finished', { status: 'completed' });
    await appendFile(join(archive.dir, 'events.jsonl'), '{"seq":');
    assert.equal(readRun(root, archive.id).status, 'incomplete');
    assert.throws(() => openRunArchive(root, archive.id), /incomplete/);
    assert.throws(() => readRun(root, '../../outside'), /Invalid run id/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
