import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readJson, readBounded, hash, fixtureFile } from './files.mjs';
import { expectedBindings, normalizeResults } from './report-manifest.mjs';
import { loadDataset } from './weiwu-provider.mjs';
import { evaluateEvidence } from './evidence-assertion.mjs';

const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function checkReleaseGate(manifest, { rawPath, expected, requireLive = false } = {}) {
  const reasons = [];
  if (requireLive) reasons.push('live-evidence-required');
  try {
    if (!manifest || manifest.schemaVersion !== 1 || typeof manifest.evaluationId !== 'string' || !manifest.evaluationId || !Number.isFinite(Date.parse(manifest.evaluatedAt))) throw new Error('invalid-manifest-schema');
    if (manifest.executionKind !== 'fixture' || manifest.modelExecuted !== false || manifest.fresh !== false) reasons.push('invalid-fixture-provenance');
    if (!/^[a-f0-9]{40,64}$/.test(manifest.source?.commit) || typeof manifest.source?.dirty !== 'boolean' || !digest(manifest.source?.rootDigest) || !digest(manifest.source?.runtimeDigest) || !digest(manifest.evaluator?.lockDigest)) reasons.push('invalid-source-schema');
    if (!expected) throw new Error('trusted-expected-bindings-required');
    for (const key of ['source', 'dataset', 'criteria', 'evaluator']) if (!same(manifest[key], expected[key])) reasons.push(`${key}-binding-mismatch`);
    if (!digest(manifest.rawResult?.digest) || hash(readBounded(rawPath)) !== manifest.rawResult.digest) reasons.push('raw-result-digest-mismatch');
    const normalized = normalizeResults(readJson(rawPath));
    if (!same(manifest.cases, normalized)) reasons.push('normalized-result-mismatch');
    const dataset = loadDataset();
    if (!Array.isArray(manifest.cases) || manifest.cases.length !== dataset.cases.length) throw new Error('missing-required-cases');
    const ids = manifest.cases.map(c => c.caseId);
    if (new Set(ids).size !== ids.length || !same([...ids].sort(), dataset.cases.map(c => c.id).sort())) reasons.push('required-case-set-mismatch');
    for (const item of manifest.cases) {
      if (item.status !== 'pass' || typeof item.score !== 'number' || !Number.isFinite(item.score) || item.score !== 1 || item.evaluatorCost !== 0 || item.providerCost !== 0) reasons.push('case-not-passed');
      const e = item.evidence;
      if (!e || e.executionKind !== 'fixture' || e.modelExecuted !== false || e.fresh !== false || e.caseId !== item.caseId || e.datasetVersion !== dataset.version || !e.runId?.startsWith('synthetic:') || !e.receipt?.id?.startsWith('synthetic-receipt:') || e.receipt?.kind !== 'fixture' || e.cost?.status !== 'known' || e.cost?.amount !== 0 || e.cost?.currency !== 'USD' || !digest(e.artifact?.digest) || !Array.isArray(e.operations)) {
        reasons.push('incomplete-fixture-evidence'); continue;
      }
      const expectedCase = dataset.cases.find(c => c.id === item.caseId);
      if (!expectedCase) continue;
      const bytes = readBounded(fixtureFile(expectedCase.fixture));
      if (hash(bytes) !== expectedCase.digest || !same(e, JSON.parse(bytes.toString('utf8'))) || !evaluateEvidence(e, expectedCase.expected).pass) reasons.push('fixture-evidence-mismatch');
    }
  } catch (error) { reasons.push(error.message); }
  return { pass: reasons.length === 0, executionKind: 'fixture', modelExecuted: false,
    meaning: 'Offline synthetic engineering invariants only; no live/model quality acceptance.', reasons: [...new Set(reasons)] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    const requireLive = args.includes('--require-live');
    const paths = args.filter(a => a !== '--require-live');
    if (paths.length !== 2) throw new Error('usage: node release-gate.mjs MANIFEST RAW_JSON [--require-live]');
    const result = checkReleaseGate(readJson(paths[0]), { rawPath: paths[1], expected: expectedBindings(), requireLive });
    console.log(JSON.stringify(result, null, 2)); process.exitCode = result.pass ? 0 : 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
