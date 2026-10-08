import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';

// Read-only HTTP evidence; no model dispatch, approval, or employee-file writes.
const [runId, projectId, versionText, directory, expectedStatus = 'completed'] = process.argv.slice(2);
assert.match(runId ?? '', /^[a-f0-9-]{36}$/);
assert.match(projectId ?? '', /^[a-f0-9-]{36}$/);
assert.match(versionText ?? '', /^\d+$/);
assert.match(directory ?? '', /^docs\/test-evidence\/[a-z0-9-]+$/);
assert.ok(['completed', 'cancelled', 'failed', 'interrupted', 'running'].includes(expectedStatus));
await mkdir(directory); // Exclusive directory: never overwrite prior evidence.
const sources = [], raw = {};
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function get(file, endpoint, binary = false) {
  const response = await fetch('http://127.0.0.1:4310/api' + endpoint, {
    method: 'GET', redirect: 'error', signal: AbortSignal.timeout(30000),
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  await writeFile(directory + '/' + file, bytes, { flag: 'wx' });
  sources.push({ file, endpoint, method: 'GET', status: response.status,
    bytes: bytes.length, sha256: sha(bytes), observedAt: new Date().toISOString() });
  await writeFile(directory + '/sources-progress.json', JSON.stringify(sources, null, 2));
  assert.equal(response.status, 200, endpoint);
  raw[file] = binary ? bytes : JSON.parse(bytes);
  return raw[file];
}
for (const [file, endpoint] of [
  ['state.json', '/runs/' + runId], ['archive.json', '/runs/' + runId + '/export'],
  ['operations.json', '/runs/' + runId + '/local-operations'],
  ['artifacts.json', '/runs/' + runId + '/artifacts'],
  ['approvals.json', '/approvals?runId=' + runId],
  ['readiness.json', '/projects/' + projectId + '/cost-readiness'],
  ['usage.json', '/usage'], ['projects.json', '/projects'], ['costs.json', '/costs'],
]) await get(file, endpoint);
const archive = raw['archive.json'], state = raw['state.json'];
assert.equal(state.id, runId); assert.equal(state.status, expectedStatus);
assert.equal(archive.snapshot.projectId, projectId);
assert.equal(archive.snapshot.planVersion, Number(versionText));
assert.equal(archive.integrity, 'ok');
assert.equal(archive.status, expectedStatus === 'running' ? 'unfinished' : expectedStatus);
assert.equal(archive.events.length, archive.eventCount);
assert.ok(archive.events.every((event, index) => event.seq === index + 1));
const allowed = ['server.mjs', 'todo.test.mjs', 'README.md', 'acceptance.test.mjs', 'acceptance-report.md'];
for (const artifact of raw['artifacts.json']) {
  assert.ok(allowed.includes(artifact.path));
  const bytes = await get(artifact.path, '/runs/' + runId + '/artifact?path=' + encodeURIComponent(artifact.path), true);
  assert.equal(bytes.length, artifact.size); assert.equal(sha(bytes), artifact.sha256);
}
await get('archive-after.json', '/runs/' + runId + '/export');
const stableArchive = sources.find(row => row.file === 'archive.json').sha256 ===
  sources.find(row => row.file === 'archive-after.json').sha256;
if (expectedStatus !== 'running') assert.equal(stableArchive, true);
await writeFile(directory + '/sources.json', JSON.stringify(sources, null, 2), { flag: 'wx' });
const summary = { kind: 'actual-readonly-web-run-capture', checkedAt: new Date().toISOString(),
  runId, projectId, version: Number(versionText), status: state.status, directory,
  eventCount: archive.eventCount, artifacts: raw['artifacts.json'], stableArchive,
  captureNote: expectedStatus === 'running' ? 'Sequential live observations; not an atomic snapshot. Use archived sequence prefixes and immutable receipt identities when comparing the subsequent stopped state.' : 'Terminal archive bytes unchanged across the capture.',
  wires: archive.events.filter(event => event.type === 'model/wire-request').length,
  accepted: archive.events.filter(event => event.type === 'handoff/accepted').map(event => ({
    seq: event.seq, taskId: event.data.taskId, commands: event.data.commands.map(command => ({
      command: command.command, exitCode: command.exitCode, nodeTests: command.evidence?.nodeTests,
      approval: command.evidence?.approval, operation: command.evidence?.operation,
    })),
  })),
  readiness: raw['readiness.json'], error: state.error ?? null,
  scope: { paidRequests: 0, employeeArtifactsAuthored: false, originalDatabaseOpened: false, credentialsRead: false },
};
await writeFile(directory + '/summary.json', JSON.stringify(summary, null, 2), { flag: 'wx' });
console.log(JSON.stringify(summary));
