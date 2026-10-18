// Component compatibility experiment only. No model requests or production changes.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const pilot = join(repo, '.data/plugin-pilot-20261018');
const runtime = join(repo, 'services/agent-runtime');
const pkg = join(pilot, 'node_modules/@huiliyi37/dsh-office');
const integrity = 'sha512-cTLnwzv9MdIXGO4vfK+1QHkOziZndFF4K/T8B98Im8h3gmQn1sAUpQ1z5PliEQHJsX4j4jCbFBBPBx37XFsZGw==';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
assert.equal('sha512-' + createHash('sha512').update(readFileSync(join(pilot, 'huiliyi37-dsh-office-0.2.4.tgz'))).digest('base64'), integrity);
assert.equal(JSON.parse(readFileSync(join(pkg, 'package.json'))).version, '0.2.4');
// The plugin's peer services must be the same DSH instance as the employee Host.
// npm install --legacy-peer-deps deliberately leaves those peers uninstalled.
for (const name of ['cordis', 'dsh-tools']) {
  const link = join(pilot, 'node_modules/@deepseek-ai', name);
  const target = join(runtime, 'node_modules/@deepseek-ai', name);
  if (!existsSync(link)) symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(realpathSync(link), realpathSync(target), `Unexpected DSH peer: ${name}`);
}
const out = join(pilot, 'runs', randomUUID());
mkdirSync(out, { recursive: true });
const worker = join(dirname(fileURLToPath(import.meta.url)), 'worker.mjs');
const deniedRead = join(pilot, 'ungranted-read-fixture.txt');
const deniedWrite = join(pilot, `ungranted-write-${randomUUID()}.docx`);
if (!existsSync(deniedRead)) writeFileSync(deniedRead, 'Public fixture: this sibling file must be inaccessible to the worker.');
const readAllowlist = [
  worker, join(runtime, 'approved-skills.mjs'),
  join(repo, 'package.json'), join(runtime, 'package.json'),
  join(repo, 'node_modules'), join(runtime, 'node_modules'),
  join(pilot, 'node_modules'), out,
];
// A clean environment prevents inheriting relay keys, proxies or NODE_OPTIONS.
// Node 24 permissions restrict filesystem/children, not networking: no network
// tools or remote image inputs are used, and this is not an OS sandbox claim.
const env = Object.fromEntries(['SystemRoot', 'WINDIR', 'PATH', 'LANG'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
Object.assign(env, { HOME: out, USERPROFILE: out, TEMP: out, TMP: out, TMPDIR: out });
const started = Date.now();
const child = spawnSync(process.execPath, ['--permission', ...readAllowlist.map(path => `--allow-fs-read=${path}`), `--allow-fs-write=${out}`, worker, out, deniedRead, deniedWrite], {
  cwd: out, env, encoding: 'utf8', timeout: 90000, maxBuffer: 2 * 1024 * 1024,
});
writeFileSync(join(out, 'stdout.txt'), child.stdout ?? '');
writeFileSync(join(out, 'stderr.txt'), child.stderr ?? '');
const receipt = {
  package: '@huiliyi37/dsh-office', version: '0.2.4', integrity,
  node: process.version, dsh: JSON.parse(readFileSync(join(runtime, 'node_modules/@deepseek-ai/dsh/package.json'))).version,
  lockSha256: hash(readFileSync(join(pilot, 'package-lock.json'))),
  entrySha256: hash(readFileSync(join(pkg, 'lib/index.js'))),
  elapsedMs: Date.now() - started, exitCode: child.status, signal: child.signal,
  ...(child.error ? { error: child.error.message } : {}),
  output: out, modelCallsAuthorized: 0, productionChanged: false,
  boundary: 'Node filesystem permission experiment; not OpenShell or network isolation verification',
  readAllowlist, writeAllowlist: [out],
  outsideWriteAbsent: !existsSync(deniedWrite),
};
writeFileSync(join(out, 'receipt.json'), JSON.stringify(receipt, null, 2));
console.log(JSON.stringify(receipt, null, 2));
if (child.status !== 0) console.error((child.stderr || child.stdout || child.error?.message || '').slice(-3500));
process.exitCode = !receipt.outsideWriteAbsent ? 1 : child.status === 0 ? 0 : child.status === 2 ? 2 : 1;
