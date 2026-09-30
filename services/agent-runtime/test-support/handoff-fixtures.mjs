// Test-only fixture bridge and independent output oracle. Never a production sandbox.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { artifactFile, validArtifactPath, listArtifacts } from '../sandbox.mjs';

export const fixtureRoot = fileURLToPath(new URL('../../../tests/fixtures/offline-handoff/', import.meta.url));
export const fixtureText = path => readFileSync(join(fixtureRoot, path), 'utf8');
export const fixtureJson = path => JSON.parse(fixtureText(path));
export const sha256 = value => createHash('sha256').update(value).digest('hex');

export function inspectInput(root, input) {
  try {
    const bytes = readFileSync(artifactFile(root, input.path));
    const actualSha256 = sha256(bytes);
    return { path: input.path, ready: !input.sha256 || input.sha256 === actualSha256,
      reason: input.sha256 && input.sha256 !== actualSha256 ? 'VERSION_MISMATCH' : 'READY', actualSha256 };
  } catch (error) {
    return { path: input.path, ready: false, reason: error.code === 'ENOENT' ? 'MISSING_FILE' : 'INVALID_FILE' };
  }
}

// Validate fixture declarations only. The product does not consume inputs/outputs yet.
export function validateFixtureGraph(plan) {
  const errors = [], tasks = new Map(plan.tasks.map(task => [task.id, task]));
  if (tasks.size !== plan.tasks.length) errors.push('DUPLICATE_TASK');
  const visiting = new Set(), visited = new Set();
  function visit(id) {
    if (!tasks.has(id)) { errors.push('UNKNOWN_TASK:' + id); return; }
    if (visiting.has(id)) { errors.push('CYCLE:' + id); return; }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dep of tasks.get(id).dependencies) visit(dep);
    visiting.delete(id); visited.add(id);
  }
  for (const task of tasks.values()) visit(task.id);
  if (errors.length) return errors;
  function ancestors(id, found = new Set()) {
    for (const dep of tasks.get(id).dependencies) if (!found.has(dep)) { found.add(dep); ancestors(dep, found); }
    return found;
  }
  for (const task of tasks.values()) {
    const upstream = ancestors(task.id);
    for (const input of task.inputs ?? []) {
      if (input.producer === 'user') continue;
      if (!upstream.has(input.producer)) errors.push('MISSING_DEPENDENCY:' + task.id + ':' + input.producer);
      if (!tasks.get(input.producer)?.outputs?.includes(input.path)) errors.push('UNKNOWN_OUTPUT:' + input.path);
    }
  }
  for (const task of tasks.values()) for (const other of tasks.values()) {
    if (task.id >= other.id || ancestors(task.id).has(other.id) || ancestors(other.id).has(task.id)) continue;
    for (const path of task.outputs ?? []) if (other.outputs?.includes(path)) errors.push('UNORDERED_WRITERS:' + path);
  }
  return errors;
}

export function makeFixtureFiles(root) {
  mkdirSync(join(root, 'inputs'), { recursive: true });
  writeFileSync(join(root, 'inputs/orders.json'), fixtureText('inputs/orders.json'));
  const allowed = new Set(['lib/money.mjs', 'report.mjs', 'report.json', 'inputs/orders.json', 'checks/inspect.json', 'checks/verify.json']);
  const events = [];
  function target(path) {
    validArtifactPath(path);
    if (!allowed.has(path)) throw Error('FIXTURE_PATH_DENIED');
    return join(root, path);
  }
  function read(path) {
    target(path);
    const content = readFileSync(artifactFile(root, path), 'utf8');
    return { path, content, sha256: sha256(content) };
  }
  function write(path, content, expectedSha256) {
    const file = target(path);
    const current = existsSync(file) ? read(path).sha256 : undefined;
    if (current !== expectedSha256) throw Error('FIXTURE_VERSION_CONFLICT');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
    return read(path);
  }
  function check(label) {
    // Only execute byte-for-byte known fixture code, never arbitrary model/user code.
    const money = read('lib/money.mjs').content;
    assert.ok(['candidates/money-broken.mjs', 'candidates/money-fixed.mjs'].some(path => money === fixtureText(path)));
    assert.equal(read('report.mjs').content, fixtureText('candidates/report.mjs'));
    assert.equal(read('inputs/orders.json').content, fixtureText('inputs/orders.json'));
    const stdout = execFileSync(process.execPath, ['report.mjs'], {
      cwd: root, timeout: 5000, maxBuffer: 65536, encoding: 'utf8',
      env: { NODE_NO_WARNINGS: '1', ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) },
    });
    const actual = JSON.parse(stdout), expected = fixtureJson('expected/report.json');
    assert.deepEqual(JSON.parse(read('report.json').content), actual);
    const result = { label, accepted: actual.orderCount === expected.orderCount && actual.totalCents === expected.totalCents,
      expected, actual, inputs: ['lib/money.mjs', 'report.mjs', 'inputs/orders.json'].map(path => ({ path, sha256: read(path).sha256 })) };
    const path = `checks/${label}.json`;
    write(path, JSON.stringify(result, null, 2) + '\n', existsSync(target(path)) ? read(path).sha256 : undefined);
    events.push(result);
    return result;
  }
  return { read, write, check, events, manifest: () => listArtifacts(root),
    // Dependency injection is test-only; this does NOT exercise RunSandbox/Docker.
    sandbox: {
      revision: () => sha256(JSON.stringify(listArtifacts(root))),
      execute: async (name, args, signal) => {
        signal?.throwIfAborted();
        const result = name === 'filesystem' ? read(args.path) : name === 'artifact_write'
          ? write(args.path, args.content, args.expectedSha256) : (() => { throw Error('FIXTURE_TOOL_DENIED'); })();
        return { ...result, artifacts: listArtifacts(root) };
      },
    },
  };
}
