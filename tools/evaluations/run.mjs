import { mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { resolve, relative, isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { toolRoot, readJson, readBounded, hash } from './files.mjs';
import { loadDataset } from './weiwu-provider.mjs';
import { createManifest, sourceIdentity, expectedBindings } from './report-manifest.mjs';
import { checkReleaseGate } from './release-gate.mjs';

export function assertRuntime(version = process.versions.node) {
  const [major, minor] = version.split('.').map(Number);
  if (!Number.isInteger(major) || !Number.isInteger(minor) || major < 22 || (major === 22 && minor < 22)) throw new Error('evaluation-node-runtime-requires->=22.22.0');
}
export function buildConfig({ configDir = toolRoot } = {}) {
  // Promptfoo 0.124.1 splits assertion references on ':', including Windows drive letters.
  const fileReference = name => `file://${relative(configDir, resolve(toolRoot, name)).replaceAll('\\', '/')}`;
  const dataset = loadDataset();
  return { description: 'Private synthetic engineering evaluation; no live/model execution',
    sharing: false, prompts: ['{{caseId}}'],
    providers: [{ id: fileReference('weiwu-provider.mjs'), config: { mode: 'replay' } }],
    tests: dataset.cases.map(item => ({ description: item.id, vars: { caseId: item.id, datasetVersion: dataset.version, expected: item.expected },
      assert: [{ type: 'javascript', value: fileReference('evidence-assertion.mjs') }] })),
    evaluateOptions: { maxConcurrency: 1 }, commandLineOptions: { cache: false, share: false, write: false } };
}
export function validateConfig(config, options) {
  if (JSON.stringify(config) !== JSON.stringify(buildConfig(options))) throw new Error('controlled-config-required');
  return true;
}

export async function runEvaluation({ mode = 'replay', outputDir, config } = {}) {
  if (mode === 'execute') throw new Error('LIVE_AUTHORIZATION_REQUIRED');
  if (mode !== 'replay') throw new Error('unsupported-mode');
  assertRuntime();
  if (!outputDir) throw new Error('explicit-ignored-output-required');
  const output = resolve(outputDir);
  const controlled = config ?? buildConfig({ configDir: output });
  validateConfig(controlled, { configDir: output });
  const expectedVersion = readJson(resolve(toolRoot, 'package.json')).dependencies.promptfoo;
  const installed = readJson(resolve(toolRoot, 'node_modules/promptfoo/package.json'));
  const lock = readJson(resolve(toolRoot, 'package-lock.json'));
  if (installed.version !== expectedVersion || lock.packages?.['node_modules/promptfoo']?.version !== expectedVersion || !lock.packages['node_modules/promptfoo'].integrity?.startsWith('sha512-')) throw new Error('evaluator-version-lock-mismatch');
  const outputRoot = resolve(toolRoot, 'output');
  const rel = relative(outputRoot, output);
  if (!rel || rel === '..' || rel.startsWith('..\\') || rel.startsWith('../') || isAbsolute(rel)) throw new Error('output-must-be-under-ignored-output');
  mkdirSync(outputRoot, { recursive: true });
  const parent = resolve(output, '..'); mkdirSync(parent, { recursive: true });
  const realRel = relative(realpathSync(outputRoot), realpathSync(parent));
  if (realRel === '..' || realRel.startsWith('..\\') || realRel.startsWith('../') || isAbsolute(realRel)) throw new Error('unsafe-output-path');
  mkdirSync(output); // Refuse stale report reuse or overwrite.
  const source = sourceIdentity();
  const lockDigest = hash(readBounded(resolve(toolRoot, 'package-lock.json')));
  const configPath = join(output, 'controlled-config.json');
  writeFileSync(configPath, JSON.stringify(controlled, null, 2));
  const rawPath = join(output, 'promptfoo.json');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => ['path', 'systemroot', 'windir', 'temp', 'tmp', 'comspec', 'pathext'].includes(key.toLowerCase())));
  Object.assign(env, { HOME: output, USERPROFILE: output, CI: 'true', DO_NOT_TRACK: '1',
    PROMPTFOO_CONFIG_DIR: join(output, 'private-config'), PROMPTFOO_DISABLE_TELEMETRY: 'true', PROMPTFOO_DISABLE_UPDATE: 'true',
    PROMPTFOO_DISABLE_REMOTE_GENERATION: 'true', PROMPTFOO_DISABLE_REDTEAM_REMOTE_GENERATION: 'true' });
  const result = spawnSync(process.execPath, ['--require', resolve(toolRoot, 'offline-guard.cjs'),
    resolve(toolRoot, 'node_modules/promptfoo/dist/src/entrypoint.js'), 'eval', '--config', configPath,
    '--output', rawPath, join(output, 'promptfoo.junit.xml'), join(output, 'promptfoo.html'), '--no-cache', '--no-write', '--no-progress-bar'],
  { cwd: output, env, encoding: 'utf8', timeout: 120000, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
  writeFileSync(join(output, 'runner.log'), `${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  if (result.error || result.status !== 0) throw new Error(`promptfoo-runner-failed:${result.error?.code ?? result.status}`);
  if (JSON.stringify(sourceIdentity()) !== JSON.stringify(source)) throw new Error('source-changed-during-evaluation');
  for (const name of ['promptfoo.json', 'promptfoo.junit.xml', 'promptfoo.html']) if (!readBounded(join(output, name)).length) throw new Error('missing-runner-report');
  const manifest = createManifest({ rawPath, evaluationId: `weiwu-synthetic-${Date.now()}`, evaluatorVersion: installed.version, source, lockDigest });
  writeFileSync(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2));
  const gate = checkReleaseGate(manifest, { rawPath, expected: expectedBindings() });
  writeFileSync(join(output, 'gate.json'), JSON.stringify(gate, null, 2));
  if (!gate.pass) throw new Error(`release-gate-failed:${gate.reasons.join(',')}`);
  return { outputDir: output, evaluatorVersion: installed.version, gate };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 2 || args[0] !== '--output') throw new Error('usage: node run.mjs --output tools/evaluations/output/UNIQUE_RUN');
    console.log(JSON.stringify(await runEvaluation({ outputDir: args[1] }), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
