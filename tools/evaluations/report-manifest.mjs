import { execFileSync } from 'node:child_process';
import { relative, resolve, basename, extname } from 'node:path';
import { realpathSync } from 'node:fs';
import { toolRoot, readBounded, readJson, hash, fixtureFile } from './files.mjs';
import { loadDataset } from './weiwu-provider.mjs';

const sourceInputs = readJson(resolve(toolRoot, 'source-inputs.json'));
export function selectSourceInputs(names) {
  return [...new Set(names.filter(name => {
    if (!name || name.includes('\\') || name.split('/').some(part => part === '..' || sourceInputs.excludedSegments.includes(part)) || sourceInputs.excludedPrefixes.some(prefix => name.startsWith(prefix))) return false;
    if (sourceInputs.rootFiles.includes(name)) return true;
    return sourceInputs.roots.some(root => name.startsWith(`${root}/`)) &&
      (sourceInputs.extensions.includes(extname(name)) || sourceInputs.basenames.includes(basename(name)));
  }))].sort();
}

export function sourceInputDigests(root, candidates) {
  let total = 0;
  const entries = selectSourceInputs(candidates).map(name => {
    let file;
    try { file = realpathSync(resolve(root, name)); } catch (error) {
      if (error.code === 'ENOENT') return [name, null];
      throw error;
    }
    const physicalName = relative(realpathSync(root), file).replaceAll('\\', '/');
    if (!selectSourceInputs([physicalName]).length) throw new Error('source-input-outside-allowlist');
    const bytes = readBounded(file, 32 * 1024 * 1024);
    total += bytes.length;
    if (total > 256 * 1024 * 1024) throw new Error('source-size-limit');
    return [name, hash(bytes)];
  });
  return { rootDigest: hash(JSON.stringify(entries)), runtimeDigest: hash(JSON.stringify(entries.filter(([name]) => name.startsWith('services/agent-runtime/')))) };
}

export function sourceIdentity() {
  const root = resolve(toolRoot, '../..');
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  const scopes = [...sourceInputs.roots, ...sourceInputs.rootFiles];
  const names = output => output.split('\0').filter(Boolean);
  const files = names(git(['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...scopes]));
  const changed = names(git(['diff', '--name-only', '-z', 'HEAD', '--', ...scopes]));
  const untracked = names(git(['ls-files', '-z', '--others', '--exclude-standard', '--', ...scopes]));
  return { commit: git(['rev-parse', 'HEAD']).trim(), dirty: selectSourceInputs([...changed, ...untracked]).length > 0,
    ...sourceInputDigests(root, files) };
}

export function evaluationBindings() {
  const dataset = loadDataset();
  const criteria = readJson(resolve(toolRoot, 'criteria-v1.json'));
  return {
    dataset: { id: dataset.id, version: dataset.version, digest: hash(readBounded(fixtureFile('synthetic-v1.json'))), caseIds: dataset.cases.map(c => c.id) },
    criteria: { id: criteria.id, version: criteria.version, digest: hash(Buffer.concat([readBounded(resolve(toolRoot, 'criteria-v1.json')), readBounded(resolve(toolRoot, 'evidence-assertion.mjs'))])) },
  };
}

export function normalizeResults(raw) {
  const results = raw?.results?.results;
  if (!Array.isArray(results)) throw new Error('missing-promptfoo-results');
  if (!results.length || results.length > 100) throw new Error('empty-or-oversize-results');
  return results.map(result => {
    let evidence = null;
    try { evidence = typeof result.response?.output === 'string' ? JSON.parse(result.response.output) : result.response?.output; } catch { /* Invalid outputs remain failed evidence. */ }
    const explicitStatus = result.skipped || result.response?.skipped ? 'skipped' : result.blocked || result.response?.blocked ? 'blocked' : result.status;
    const grade = result.gradingResult;
    const componentPassed = component => component?.pass === true && component.score === 1 && !component.error && !component.skipped && !component.blocked &&
      (!component.status || component.status === 'pass') && (component.failureReason === undefined || component.failureReason === 0) &&
      (component.componentResults === undefined || (Array.isArray(component.componentResults) && component.componentResults.length > 0 && component.componentResults.every(componentPassed)));
    const gradePassed = componentPassed(grade) && Array.isArray(grade.componentResults) && grade.componentResults.length > 0;
    const status = result.error || result.response?.error || result.failureReason === 2 ? 'error' : explicitStatus && explicitStatus !== 'pass' ? explicitStatus :
      result.success === true && result.failureReason === 0 && gradePassed ? 'pass' : 'fail';
    return { caseId: result.vars?.caseId, status, score: result.score, evaluatorCost: result.cost, providerCost: result.response?.cost,
      evidence: evidence ?? null };
  });
}

export function createManifest({ rawPath, evaluationId, evaluatorVersion, source = sourceIdentity(), lockDigest = hash(readBounded(resolve(toolRoot, 'package-lock.json'))) }) {
  return { schemaVersion: 1, evaluationId, evaluatedAt: new Date().toISOString(), source, evaluator: { name: 'promptfoo', version: evaluatorVersion, lockDigest },
    ...evaluationBindings(), executionKind: 'fixture', modelExecuted: false, fresh: false,
    rawResult: { file: basename(rawPath), digest: hash(readBounded(rawPath)) }, cases: normalizeResults(readJson(rawPath)) };
}

export function expectedBindings() {
  const packageJson = readJson(resolve(toolRoot, 'package.json'));
  return { source: sourceIdentity(), ...evaluationBindings(), evaluator: { name: 'promptfoo', version: packageJson.dependencies.promptfoo, lockDigest: hash(readBounded(resolve(toolRoot, 'package-lock.json'))) } };
}
