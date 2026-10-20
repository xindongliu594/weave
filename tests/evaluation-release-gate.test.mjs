import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createManifest, normalizeResults } from '../tools/evaluations/report-manifest.mjs';
import { readJson, hash, readBounded } from '../tools/evaluations/files.mjs';
import { checkReleaseGate } from '../tools/evaluations/release-gate.mjs';
import { loadDataset, WeiwuProvider } from '../tools/evaluations/weiwu-provider.mjs';
import * as manifestApi from '../tools/evaluations/report-manifest.mjs';

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'weiwu-eval-'));
  const dataset = loadDataset();
  const provider = new WeiwuProvider();
  const results = [];
  for (const item of dataset.cases) {
    results.push({ testIdx: results.length, vars: { caseId: item.id, datasetVersion: dataset.version }, success: true, cost: 0, failureReason: 0,
      score: 1, gradingResult: { pass: true, score: 1, componentResults: [{ pass: true, score: 1 }] }, response: await provider.callApi(item.id, { vars: { caseId: item.id, datasetVersion: dataset.version } }) });
  }
  const rawPath = join(directory, 'raw.json');
  writeFileSync(rawPath, JSON.stringify({ results: { results } }));
  const manifest = createManifest({ rawPath, evaluationId: 'synthetic-test', evaluatorVersion: 'test-only', source: { commit: 'a'.repeat(40), dirty: true, rootDigest: 'b'.repeat(64), runtimeDigest: 'c'.repeat(64) }, lockDigest: 'd'.repeat(64) });
  const expected = structuredClone({ source: manifest.source, dataset: manifest.dataset, criteria: manifest.criteria, evaluator: manifest.evaluator });
  return { manifest, expected, rawPath, directory };
}

test('fixture gate passes only offline engineering invariants; live is unavailable', async () => {
  const f = await fixture();
  try {
    assert.equal(checkReleaseGate(f.manifest, f).pass, true);
    assert.ok(checkReleaseGate(f.manifest, { ...f, requireLive: true }).reasons.includes('live-evidence-required'));
  } finally { rmSync(f.directory, { recursive: true }); }
});

test('gate rejects mutations, empty/omitted/duplicate cases, false live, bad scores and missing evidence', async () => {
  const f = await fixture();
  try {
    for (const mutate of [
      m => { m.dataset.digest = '0'.repeat(64); }, m => { m.criteria.digest = '0'.repeat(64); },
      m => { m.source.rootDigest = '0'.repeat(64); }, m => { m.rawResult.digest = '0'.repeat(64); },
      m => { m.cases = []; }, m => { m.cases.pop(); }, m => { m.cases[1] = m.cases[0]; },
      m => { m.executionKind = 'live'; m.modelExecuted = true; }, m => { m.fresh = true; },
      ...[NaN, Infinity, null, -1, 2].map(score => m => { m.cases[0].score = score; }),
      ...['error', 'blocked', 'skipped'].map(status => m => { m.cases[0].status = status; }),
      m => { m.cases[0].evidence.receipt = null; }, m => { m.cases[0].evidence.cost = { status: 'unknown' }; },
    ]) {
      const altered = structuredClone(f.manifest); mutate(altered);
      assert.equal(checkReleaseGate(altered, f).pass, false, String(mutate));
    }
    writeFileSync(f.rawPath, '{}');
    assert.equal(checkReleaseGate(f.manifest, f).pass, false);
  } finally { rmSync(f.directory, { recursive: true }); }
});

test('normalization preserves errors and cannot turn missing data into pass', () => {
  assert.throws(() => normalizeResults({}), /results/);
  assert.throws(() => normalizeResults({ results: { results: [] } }), /empty/);
  const [result] = normalizeResults({ results: { results: [{ vars: { caseId: 'x' }, success: true, score: 1, error: 'blocked' }] } });
  assert.equal(result.status, 'error');
});

test('consistent manifest/raw rewrites cannot hide failure, unknown cost or altered evidence', async () => {
  const f = await fixture();
  const original = readJson(f.rawPath);
  try {
    for (const mutate of [
      row => { row.error = 'blocked'; }, row => { row.success = false; },
      row => { row.status = 'skipped'; }, row => { row.status = 'blocked'; },
      row => { row.gradingResult.score = null; }, row => { row.score = null; },
      row => { row.cost = null; }, row => { row.cost = 1; },
      row => { const e = JSON.parse(row.response.output); e.receipt = null; row.response.output = JSON.stringify(e); },
      row => { const e = JSON.parse(row.response.output); e.cost.status = 'unknown'; row.response.output = JSON.stringify(e); },
      row => { const e = JSON.parse(row.response.output); e.fresh = true; row.response.output = JSON.stringify(e); },
    ]) {
      const raw = structuredClone(original); mutate(raw.results.results[0]);
      writeFileSync(f.rawPath, JSON.stringify(raw));
      const altered = structuredClone(f.manifest);
      altered.rawResult.digest = hash(readBounded(f.rawPath));
      altered.cases = normalizeResults(raw);
      assert.equal(checkReleaseGate(altered, f).pass, false, String(mutate));
    }
  } finally { rmSync(f.directory, { recursive: true }); }
});

test('native Promptfoo contradictory failure signals remain failures after consistent rehashing', async () => {
  const f = await fixture();
  const original = readJson(f.rawPath);
  original.results.results.forEach(row => {
    row.failureReason = 0;
    row.gradingResult.componentResults = [{ pass: true, score: 1 }];
  });
  const verdicts = [];
  try {
    for (const [name, mutate] of [
      ['native-error', row => { row.failureReason = 2; }],
      ['native-assertion-failure', row => { row.failureReason = 1; }],
      ['pass-plus-skipped', row => { row.status = 'pass'; row.skipped = true; }],
      ['pass-plus-blocked', row => { row.status = 'pass'; row.blocked = true; }],
      ['failed-component', row => { row.gradingResult.componentResults[0] = { pass: false, score: 0 }; }],
      ['unknown-component-score', row => { row.gradingResult.componentResults[0].score = null; }],
      ['unknown-provider-cost', row => { row.response.cost = null; }],
      ['paid-provider-cost', row => { row.response.cost = 1; }],
    ]) {
      const raw = structuredClone(original); mutate(raw.results.results[0]);
      writeFileSync(f.rawPath, JSON.stringify(raw));
      const altered = structuredClone(f.manifest);
      altered.rawResult.digest = hash(readBounded(f.rawPath)); altered.cases = normalizeResults(raw);
      verdicts.push([name, checkReleaseGate(altered, f).pass]);
    }
    assert.deepEqual(verdicts, verdicts.map(([name]) => [name, false]));
  } finally { rmSync(f.directory, { recursive: true }); }
});

test('source binding includes uncommitted implementation but excludes private and acceptance history before reading', () => {
  assert.equal(typeof manifestApi.sourceInputDigests, 'function');
  const directory = mkdtempSync(join(tmpdir(), 'weiwu-source-scope-'));
  const files = ['package.json', 'apps/web/src/probe.ts', 'tools/evaluations/uncommitted.mjs'];
  try {
    for (const name of ['apps/web/src', 'tools/evaluations', 'docs/validation']) mkdirSync(join(directory, name), { recursive: true });
    for (const name of files) writeFileSync(join(directory, name), name === 'package.json' ? '{}' : 'export const value = 1;');
    const before = manifestApi.sourceInputDigests(directory, files);
    writeFileSync(join(directory, 'tools/evaluations/uncommitted.mjs'), 'export const value = 2;');
    const changed = manifestApi.sourceInputDigests(directory, files);
    assert.notEqual(changed.rootDigest, before.rootDigest);
    writeFileSync(join(directory, 'docs/validation/acceptance.md'), 'Synthetic acceptance report only.');
    const irrelevant = ['docs/validation/acceptance.md', '.private/must-not-open.mjs', 'apps/../.private/must-not-open.mjs', 'tools/evaluations/output/must-not-open.json', 'scripts/validation/must-not-open.json'];
    assert.deepEqual(manifestApi.sourceInputDigests(directory, [...files, ...irrelevant]), changed);
    assert.deepEqual(manifestApi.selectSourceInputs([...files, ...irrelevant]), [...files].sort());
  } finally { rmSync(directory, { recursive: true }); }
});
