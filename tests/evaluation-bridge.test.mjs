import test from 'node:test';
import assert from 'node:assert/strict';
import { WeiwuProvider, loadDataset } from '../tools/evaluations/weiwu-provider.mjs';
import { buildConfig, validateConfig, runEvaluation, assertRuntime } from '../tools/evaluations/run.mjs';
import { evaluateEvidence } from '../tools/evaluations/evidence-assertion.mjs';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createManifest, expectedBindings } from '../tools/evaluations/report-manifest.mjs';
import { checkReleaseGate } from '../tools/evaluations/release-gate.mjs';

test('controlled file references avoid Windows drive-colon assertion parsing', () => {
  assert.match(buildConfig().tests[0].assert[0].value, /evidence-assertion\.mjs$/);
  assert.equal(buildConfig().tests[0].assert[0].value.slice(7).includes(':'), false);
});

test('isolated evaluator explicitly rejects project CI Node 22.19', () => {
  assert.throws(() => assertRuntime('22.19.0'), /evaluation-node-runtime-requires/);
  assert.doesNotThrow(() => assertRuntime('22.22.0'));
  assert.doesNotThrow(() => assertRuntime('24.15.0'));
});

test('installed real Promptfoo CLI produces private reports and an offline gate', { skip: !existsSync(new URL('../tools/evaluations/node_modules/promptfoo/package.json', import.meta.url)) }, async () => {
  const outputDir = fileURLToPath(new URL(`../tools/evaluations/output/test-${Date.now()}-${process.pid}`, import.meta.url));
  const result = await runEvaluation({ outputDir });
  assert.equal(result.gate.pass, true);
  const manifest = JSON.parse(readFileSync(resolve(outputDir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.cases.length, 5);
  assert.equal(manifest.executionKind, 'fixture');
  for (const name of ['promptfoo.json', 'promptfoo.junit.xml', 'promptfoo.html']) assert.ok(readFileSync(resolve(outputDir, name)).length > 0);

  const negativeDir = resolve(outputDir, 'negative-assertion'); mkdirSync(negativeDir);
  const config = buildConfig({ configDir: negativeDir });
  config.tests[0].vars.expected.accepted = false;
  writeFileSync(resolve(negativeDir, 'negative-config.json'), JSON.stringify(config));
  const toolRoot = fileURLToPath(new URL('../tools/evaluations/', import.meta.url));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => ['path', 'systemroot', 'windir', 'temp', 'tmp', 'comspec', 'pathext'].includes(key.toLowerCase())));
  Object.assign(env, { HOME: negativeDir, USERPROFILE: negativeDir, CI: 'true', PROMPTFOO_CONFIG_DIR: resolve(negativeDir, 'private-config'), PROMPTFOO_DISABLE_TELEMETRY: 'true', PROMPTFOO_DISABLE_UPDATE: 'true', PROMPTFOO_DISABLE_REMOTE_GENERATION: 'true' });
  const negative = spawnSync(process.execPath, ['--require', resolve(toolRoot, 'offline-guard.cjs'), resolve(toolRoot, 'node_modules/promptfoo/dist/src/entrypoint.js'),
    'eval', '--config', resolve(negativeDir, 'negative-config.json'), '--output', resolve(negativeDir, 'promptfoo.json'), '--no-cache', '--no-write', '--no-progress-bar'],
    { cwd: negativeDir, env, encoding: 'utf8', timeout: 120000, windowsHide: true });
  writeFileSync(resolve(negativeDir, 'runner.log'), `${negative.stdout ?? ''}\n${negative.stderr ?? ''}`);
  assert.equal(negative.error, undefined);
  assert.notEqual(negative.status, 0, 'real failed assertion must return nonzero');
  const negativeManifest = createManifest({ rawPath: resolve(negativeDir, 'promptfoo.json'), evaluationId: 'negative-synthetic-invariant', evaluatorVersion: manifest.evaluator.version });
  const negativeGate = checkReleaseGate(negativeManifest, { rawPath: resolve(negativeDir, 'promptfoo.json'), expected: expectedBindings() });
  writeFileSync(resolve(negativeDir, 'gate.json'), JSON.stringify(negativeGate, null, 2));
  assert.equal(negativeGate.pass, false);
});

test('execute fails before any request, even with bypass environment and transport', async () => {
  let requests = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => { requests++; throw new Error('network'); };
  try {
    process.env.WEIWU_EVAL_ALLOW_EXECUTE = 'true';
    await assert.rejects(new WeiwuProvider({ config: { mode: 'execute' } }).callApi('x'), /LIVE_AUTHORIZATION_REQUIRED/);
    assert.equal(requests, 0);
  } finally { globalThis.fetch = original; delete process.env.WEIWU_EVAL_ALLOW_EXECUTE; }
});

test('replay validates exact synthetic case version and digest', async () => {
  const dataset = loadDataset();
  assert.equal(dataset.cases.length, 5);
  const provider = new WeiwuProvider();
  assert.match(provider.id(), /weiwu.*replay/);
  for (const item of dataset.cases) {
    const result = await provider.callApi(item.id, { vars: { caseId: item.id, datasetVersion: dataset.version } });
    const output = JSON.parse(result.output);
    assert.equal(output.executionKind, 'fixture');
    assert.equal(output.modelExecuted, false);
    assert.equal(evaluateEvidence(output, item.expected).pass, true);
  }
  await assert.rejects(provider.callApi('x', { vars: { caseId: 'missing', datasetVersion: '1' } }), /case/);
  await assert.rejects(provider.callApi('x', { vars: { caseId: dataset.cases[0].id, datasetVersion: '999' } }), /version/);
});

test('unsafe paths and non-replay modes are rejected', async () => {
  for (const fixturePath of ['../package.json', 'https://example.test/a', 'C:/Windows/win.ini']) {
    await assert.rejects(new WeiwuProvider({ config: { fixturePath } }).callApi('x'), /path|fixture/);
  }
  await assert.rejects(new WeiwuProvider({ config: { mode: 'live' } }).callApi('x'), /mode/);
});

test('runner allows only generated provider and deterministic reviewed assertion', () => {
  const config = buildConfig();
  assert.equal(validateConfig(config), true);
  for (const mutate of [
    c => { c.providers = ['openai:gpt-4']; },
    c => { c.tests[0].assert = [{ type: 'llm-rubric', value: 'paid' }]; },
    c => { c.tests[0].assert = [{ type: 'javascript', value: 'fetch("http://example.test")' }]; },
    c => { c.prompts = ['file://https://example.test/prompt']; },
    c => { c.defaultTest = { transform: 'fetch("http://example.test")' }; },
  ]) {
    const unsafe = structuredClone(config); mutate(unsafe);
    assert.throws(() => validateConfig(unsafe), /controlled-config-required/);
  }
});

test('runner refuses execute before spawning Promptfoo', async () => {
  await assert.rejects(runEvaluation({ mode: 'execute' }), /LIVE_AUTHORIZATION_REQUIRED/);
});
