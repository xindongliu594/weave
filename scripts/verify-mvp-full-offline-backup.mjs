import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { cp, lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// Offline copying is opt-in, after the owner explicitly confirms launcher/database closure.
// Only the fresh restore database is ever opened. No app, migrations, credential vault,
// device client, execution coordinator, billing client or provider module is imported.
const root = fileURLToPath(new URL('../', import.meta.url));
const script = fileURLToPath(import.meta.url);
const dataRoot = resolve(root, '.data');
const actualSource = resolve('C:/Users/JJ/Desktop/la/agent_department/.data/local');
const digest = value => createHash('sha256').update(value).digest('hex');
const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const exclusions = new Set(['launcher.lock', 'session.json', 'database/postmaster.pid', 'database/postmaster.opts']);
const opaque = path => path.split('/').some(part => /^(credentials|credential(?:\..*)?|device\.credential)$/i.test(part) || /(?:^|[._-])(master|auth|secret|token|password)(?:[._-]|$)/i.test(part));

function childOf(parent, target) {
  const path = relative(resolve(parent), resolve(target));
  assert.ok(path && !path.startsWith('..') && !isAbsolute(path), 'Fresh destination must stay within workspace .data');
}
async function checkedRoot(directory) {
  assert.equal((await lstat(directory)).isSymbolicLink(), false, 'Root cannot be a junction/link');
  assert.equal((await realpath(directory)).toLowerCase(), resolve(directory).toLowerCase(), 'Root must resolve to its declared absolute directory');
}
async function newDirectory(directory) {
  childOf(dataRoot, directory);
  await checkedRoot(dataRoot);
  assert.equal(existsSync(directory), false, 'Destination already exists; refusing overwrite');
  await mkdir(directory);
  await checkedRoot(directory);
}
async function fileHash(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
async function inventory(directory, includeHashes) {
  await checkedRoot(directory);
  const rows = [], directories = [];
  async function walk(current, prefix = '') {
    for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (exclusions.has(name)) continue;
      const path = join(current, entry.name), stat = await lstat(path);
      assert.ok(!stat.isSymbolicLink(), 'Copy refuses source links/junctions');
      if (stat.isDirectory()) { directories.push(name); await walk(path, name); }
      else {
        assert.ok(stat.isFile(), 'Copy supports ordinary files only');
        assert.ok(rows.length < 200000, 'Unexpected file count; refusing unbounded inventory');
        rows.push({ path: name, bytes: stat.size, modified: stat.mtimeMs, opaque: opaque(name), ...(includeHashes && !opaque(name) ? { sha256: await fileHash(path) } : {}) });
      }
    }
  }
  await walk(directory);
  const bytes = rows.reduce((sum, row) => sum + row.bytes, 0);
  assert.ok(bytes <= 10 * 1024 ** 3, 'Offline verification is bounded to 10 GiB');
  return { rows, directories, bytes };
}
function stable(inv) { return inv.rows.map(({ path, bytes, modified }) => ({ path, bytes, modified })); }
function content(inv) { return { directories: inv.directories, files: inv.rows.map(({ path, bytes, opaque: hidden, sha256 }) => ({ path, bytes, opaque: hidden, ...(sha256 ? { sha256 } : {}) })) }; }
async function copyTree(source, destination) {
  childOf(dataRoot, destination);
  await checkedRoot(dirname(destination));
  assert.equal(existsSync(destination), false, 'Copy destination must be new; refusing overwrite');
  await cp(source, destination, { recursive: true, force: false, errorOnExist: true, preserveTimestamps: true, dereference: false,
    filter: async path => {
      if (exclusions.has(relative(source, path).split(sep).join('/'))) return false;
      assert.equal((await lstat(path)).isSymbolicLink(), false, 'Copy refuses source links/junctions');
      return true;
    } });
  await checkedRoot(destination);
}
function assertClosed(source) {
  assert.equal(existsSync(join(source, 'launcher.lock')), false, 'Original launcher lock still exists; do not copy a live database');
  assert.equal(existsSync(join(source, 'database', 'postmaster.pid')), false, 'Database process marker still exists');
}
function runChild(args, { cwd = root, env = process.env, timeout = 120000 } = {}) {
  return new Promise((accept, reject) => {
    const child = spawn(process.execPath, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let output = '', result, timedOut = false;
    const collect = bytes => { output += bytes.toString(); if (output.length > 512000) child.kill(); };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    child.on('message', value => { if (value?.type === 'audit') result = value.result; });
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeout);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); accept({ code, output, result, timedOut }); });
  });
}

function networkGuardCode({ allowLoopbackFetch = false } = {}) {
  assert.equal(typeof allowLoopbackFetch, 'boolean', 'allowLoopbackFetch must be an explicit boolean');
  const fetchGuard = allowLoopbackFetch ? String.raw`
const nativeFetch=globalThis.fetch.bind(globalThis);
globalThis.fetch=async(input,init)=>{
  let request,url,path;
  try{
    if(typeof input!=='string'&&!(input instanceof URL)&&!(input instanceof Request))throw Error();
    // Build one immutable request so validation and dispatch share the same URL.
    // Reject all redirects before the native client can follow a new endpoint.
    request=new Request(input,{...init,redirect:'error'});url=new URL(request.url);
    if(!['http:','https:'].includes(url.protocol)||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||url.username||url.password)throw Error();
    path=url.pathname;
    for(let i=0;i<4;i++){const decoded=decodeURIComponent(path);if(decoded===path)break;path=decoded;}
    if(path.includes('%')||/\/(?:v1|v\d+(?:\/|$)|chat\/completions|completions(?:\/|$)|responses|messages(?:\/|$)|embeddings(?:\/|$)|api\/(?:log|usage|billing|models|gateways|providers)|api\/projects\/[^/]+\/(?:generate|generated-plan))/i.test(path))throw Error();
  }catch{throw Error('OFFLINE_PROVIDER_FETCH_BLOCKED');}
  return nativeFetch(request);
};
` : "globalThis.fetch=async()=>{throw Error('OFFLINE_PROVIDER_FETCH_BLOCKED')};\n";
  return `const net=require('node:net'),http=require('node:http'),https=require('node:https'),module_=require('node:module');\nconst local=h=>['127.0.0.1','localhost','::1'].includes(String(h||'localhost').toLowerCase());\nconst old=net.Socket.prototype.connect;net.Socket.prototype.connect=function(...args){let a=args[0];if(Array.isArray(a))a=a[0];const host=typeof a==='object'?a?.host:typeof args[1]==='string'?args[1]:'localhost';if(!local(host))throw Error('OFFLINE_EXTERNAL_NETWORK_BLOCKED');return old.apply(this,args)};\nfunction guard(fn){return function(...args){const a=args[0];const url=typeof a==='string'||a instanceof URL?new URL(a):null;const opt=url?(args[1]||{}):(a||{});const host=url?url.hostname:(opt.hostname||opt.host||'localhost');const path=url?url.pathname:String(opt.path||'/');if(!local(host)||/\\/(?:v1|chat\\/completions|responses|api\\/(?:log|usage|billing))/i.test(path))throw Error('OFFLINE_PROVIDER_REQUEST_BLOCKED');return fn.apply(this,args)}};http.request=guard(http.request);http.get=guard(http.get);https.request=guard(https.request);https.get=guard(https.get);${fetchGuard}module_.syncBuiltinESMExports();\n`;
}

function executionEnv(preload, source = process.env) {
  const env = Object.fromEntries(Object.entries(source).filter(([name]) => /^(systemroot|windir|comspec|path|pathext|temp|tmp|processor_architecture|number_of_processors)$/i.test(name)));
  env.NODE_OPTIONS = `--require=${JSON.stringify(preload)}`;
  return env;
}

async function worker(directory, runId) {
  childOf(dataRoot, directory); await checkedRoot(directory);
  globalThis.fetch = async () => { throw new Error('OFFLINE_RESTORE_PROVIDER_BLOCKED'); };
  const { PGlite } = await import('@electric-sql/pglite');
  const { vector } = await import('@electric-sql/pglite-pgvector');
  const db = await PGlite.create({ dataDir: join(directory, 'database'), extensions: { vector } });
  try {
    await db.exec('BEGIN READ ONLY');
    const tableRows = (await db.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows;
    const tables = new Set(tableRows.map(row => row.tablename));
    const qid = id => `"${id.replaceAll('"', '""')}"`;
    const activeChecks = [
      ['project_runs', "status IN ('queued','running')"],
      ['model_reservations', "status='pending'"],
      ['manager_messages', "status IN ('waiting','replying')"],
      ['automation_schedules', "status='active'"],
      ['local_operations', "status IN ('queued','claimed','started')"],
      ['model_capability_tests', "status='running'"],
    ];
    const active = {};
    for (const [table, where] of activeChecks) {
      active[table] = tables.has(table) ? Number((await db.query(`SELECT count(*) AS n FROM ${qid(table)} WHERE ${where}`)).rows[0].n) : 0;
      assert.equal(active[table], 0, `Isolated restore has active ${table}; no execution is permitted`);
    }
    const fingerprints = {};
    for (const table of tables) {
      const count = Number((await db.query(`SELECT count(*) AS n FROM ${qid(table)}`)).rows[0].n);
      assert.ok(count <= 250000, 'Per-table row audit limit exceeded; refusing partial evidence');
      const columns = (await db.query('SELECT column_name FROM information_schema.columns WHERE table_schema=\'public\' AND table_name=$1', [table])).rows.map(row => row.column_name);
      const excluded = columns.filter(column => /credential|token_hash|claim_token|password|secret|auth/i.test(column));
      // Hash in the database; raw credentials/context/content never leave SQL in public evidence.
      const rows = (await db.query(`SELECT md5((to_jsonb(t)-$1::text[])::text) AS digest FROM ${qid(table)} t ORDER BY digest`, [excluded])).rows;
      fingerprints[table] = { count, sha256: digest(rows.map(row => row.digest).join('\n')), excludedColumns: excluded };
    }
    const reservations = tables.has('model_reservations') ? (await db.query("SELECT id,run_id AS \"runId\",status,amount::text AS amount,jsonb_array_length(history) AS \"historyEntries\",md5(history::text) AS \"historyDigest\" FROM model_reservations WHERE status IN ('pending','uncertain') ORDER BY id")).rows : [];
    const usage = tables.has('usage') ? (await db.query('SELECT count(*) AS count,COALESCE(sum(cost),0)::text AS cost,COALESCE(sum(input_tokens),0)::text AS input_tokens,COALESCE(sum(output_tokens),0)::text AS output_tokens FROM usage')).rows[0] : {};
    const run = tables.has('project_runs') ? (await db.query('SELECT id,project_id AS \"projectId\",status,snapshot FROM project_runs WHERE id=$1', [runId])).rows[0] : undefined;
    if (runId) assert.ok(run, 'Requested employee-artifact run is absent from full database restore');
    const runProof = run ? { id: run.id, projectId: run.projectId, status: run.status,
      snapshotSha256: digest(canonical(run.snapshot)), dagSha256: digest(canonical(run.snapshot?.dag ?? run.snapshot?.tasks ?? run.snapshot?.plan?.tasks ?? null)),
      costCarryoverSha256: digest(canonical(run.snapshot?.costCarryover ?? null)),
      executionBudget: run.snapshot?.executionBudget ?? null, carryoverReserved: run.snapshot?.costCarryover?.reserved ?? null,
      policyMaxBudget: run.snapshot?.policy?.maxBudget ?? null } : null;
    const kb = tables.has('knowledge_revisions') ? (await db.query('SELECT document_id AS \"documentId\",version,sha256 FROM knowledge_revisions ORDER BY document_id,version')).rows : [];
    const workfiles = tables.has('work_file_snapshots') ? (await db.query('SELECT id,bytes,md5(files::text) AS "filesDigest" FROM work_file_snapshots ORDER BY id')).rows : [];
    // No business write or migration. Opening PostgreSQL may update physical engine files only.
    await db.exec('ROLLBACK');
    return { readOnlyTransaction: true, appServicesStarted: false, providerFetchBlocked: true, active,
      fingerprints, reservations, usage, run: runProof, knowledgeVersions: kb, workfiles };
  } finally { await db.close(); }
}

async function makeFixture(directory) {
  await mkdir(directory, { recursive: true });
  const { PGlite } = await import('@electric-sql/pglite');
  const db = await PGlite.create({ dataDir: join(directory, 'database') });
  await db.exec("CREATE TABLE fixture_business(id text PRIMARY KEY,history jsonb,credential text);INSERT INTO fixture_business VALUES ('fixture','[{\"source\":\"local-fixture\"}]','opaque-fixture-only');");
  await db.close();
  await mkdir(join(directory, 'credentials'));
  await writeFile(join(directory, 'credentials', 'credential.master'), 'SYNTHETIC_OFFLINE_FIXTURE_NOT_A_REAL_KEY');
  await writeFile(join(directory, 'session.json'), '{"fixture":true}');
}

async function main() {
  const args = process.argv.slice(2), fixture = args.includes('--fixture');
  if (args[0] === '--worker') { const result = await worker(resolve(args[1]), args[2] ?? ''); process.send?.({ type: 'audit', result }); process.disconnect?.(); return; }
  if (args.includes('--help')) { console.log('Fixture: node scripts/verify-mvp-full-offline-backup.mjs --fixture\nAfter explicit owner shutdown confirmation only: node scripts/verify-mvp-full-offline-backup.mjs --confirmed-stopped --run-id=<UUID>\nOriginal data is never opened or changed; restores are fresh workspace .data children.'); return; }
  const runId = args.find(arg => arg.startsWith('--run-id='))?.slice(9) ?? '';
  assert.ok(fixture || args.includes('--confirmed-stopped'), 'Explicit owner shutdown confirmation is required');
  assert.ok(fixture || uuid.test(runId), 'Real restore requires the employee-artifact run UUID');
  await mkdir(dataRoot, { recursive: true }); await checkedRoot(dataRoot);
  const group = join(dataRoot, `full-offline-backup${fixture ? '-fixture' : ''}`, randomUUID());
  await mkdir(dirname(group), { recursive: true }); await checkedRoot(dirname(group)); await newDirectory(group);
  const source = fixture ? join(group, 'source') : actualSource;
  if (fixture) await makeFixture(source);
  assertClosed(source);
  const startedAt = new Date().toISOString(), before = await inventory(source, true);
  const snapshot = join(group, 'snapshot'), restore = join(group, 'restore');
  await copyTree(source, snapshot);
  assertClosed(source);
  const after = await inventory(source, false);
  assert.deepEqual(stable(after), stable(before), 'Source changed while copying; no consistent offline evidence');
  assert.deepEqual(after.directories, before.directories, 'Source directories changed while copying');
  const snap = await inventory(snapshot, true);
  assert.deepEqual(content(snap), content(before), 'Snapshot files differ from the closed original');
  await copyTree(snapshot, restore);
  const restored = await inventory(restore, true);
  assert.deepEqual(content(restored), content(snap), 'Restore files differ from the untouched snapshot');
  const copiedAt = new Date().toISOString();
  const opaqueRows = before.rows.filter(row => row.opaque);
  const copyProof = { startedAt, copiedAt, source, snapshot, restore, sourceLockAbsent: true, sourceStableDuringCopy: true,
    sourceDatabaseNeverOpened: true, sourceFiles: before.rows.length, sourceBytes: before.bytes,
    opaqueFiles: opaqueRows.length, opaqueBytes: opaqueRows.reduce((sum, row) => sum + row.bytes, 0),
    opaqueContentsReadOrHashed: false, credentialUnsealOrReuseAttempted: false,
    businessAndDatabaseFilesExactSha256: true, contentManifestSha256: digest(canonical(content(before))),
    exclusions: [...exclusions], originalCanRestart: true };
  await writeFile(join(group, 'copy-proof.json'), JSON.stringify(copyProof, null, 2));
  console.log(JSON.stringify({ phase: 'copy-complete-original-can-restart', group, sourceFiles: before.rows.length, sourceBytes: before.bytes, opaqueFiles: opaqueRows.length }));
  const audits = [], logs = [];
  for (let index = 0; index < 2; index++) {
    const child = await runChild([script, '--worker', restore, runId]);
    logs.push(`restore-open-${index + 1}: exit=${child.code} timedOut=${child.timedOut}\n${child.output}`);
    assert.equal(child.code, 0, 'Read-only restore worker failed'); assert.ok(child.result, 'Restore worker provided no audit');
    audits.push(child.result);
  }
  assert.deepEqual(audits[1], audits[0], 'Persistent business data changed after close/reopen');
  let employeeTest = { status: 'not-run-fixture', paidAcceptance: false }, artifactHashes = [];
  if (!fixture) {
    const artifacts = join(restore, 'runs', runId, 'artifacts');
    const files = await inventory(artifacts, true);
    artifactHashes = files.rows.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 }));
    const execution = join(group, 'execution'); await copyTree(artifacts, execution);
    const preload = join(group, 'offline-network-guard.cjs');
    // Only the new execution copy may use fetch for its own loopback HTTP tests.
    // Restore workers retain their unconditional fetch prohibition.
    await writeFile(preload, networkGuardCode({ allowLoopbackFetch: true }));
    const env = executionEnv(preload);
    const tested = await runChild(['--test', 'todo.test.mjs'], { cwd: execution, env, timeout: 30000 });
    logs.push(`employee-development-tests: exit=${tested.code} timedOut=${tested.timedOut}\n${tested.output}`);
    employeeTest = { status: tested.code === 0 ? 'passed' : 'failed', exitCode: tested.code, executionDirectory: execution,
      command: 'node --test todo.test.mjs', externalNetworkBlocked: true, networkMode: 'loopback-fetch', fetchRedirectsBlocked: true, testOutput: tested.output, paidAcceptance: false,
      testCounts: Object.fromEntries(['tests', 'pass', 'fail'].map(name => [name, Number(tested.output.match(new RegExp(`(?:#|ℹ)\\s*${name}\\s+(\\d+)`))?.[1] ?? NaN)])),
      employeeFilesChanged: canonical(content(await inventory(artifacts, true))) !== canonical(content(files)) };
    assert.equal(employeeTest.employeeFilesChanged, false, 'Restore employee artifacts were modified');
  }
  const report = { format: 'full-offline-isolated-restore-v1', fixture, checkedAt: new Date().toISOString(), copyProof,
    restoreReadOnlyOpenedTwice: true, persistentBusinessFingerprintsEqual: true, audits, artifactHashes, employeeTest,
    limitations: ['Offline full-directory copying after confirmed service closure; not the product 50-MiB online encrypted export.',
      'Credentials/device grants were transparently copied as opaque files; contents were never read/hashed/unsealed and authentication migration was not tested.',
      'No app/device/coordinator/provider service started in restore; no historical external operation replayed.',
      'Development employee Todo tests do not establish independent QA acceptance or manager completion; those remain incomplete.',
      'PostgreSQL engine may update restore physical startup files; untouched snapshot is retained and all business-table digests survive reopen.'] };
  const name = fixture ? 'my-gateway-full-backup-fixture-2026-10-05' : 'my-gateway-full-backup-2026-10-05';
  const reportPath = join(root, 'docs', 'test-evidence', `${name}.json`), logPath = join(root, 'docs', 'validation', `${name}.txt`);
  assert.equal(existsSync(reportPath), false, 'Do not replace previous acceptance evidence');
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  await writeFile(logPath, logs.join('\n') + '\n');
  console.log(JSON.stringify({ phase: 'restore-audit-complete', reportPath, logPath, persistentReopen: 'passed', employeeTest: employeeTest.status }));
  if (employeeTest.status === 'failed') process.exitCode = 1;
}

export { childOf, checkedRoot, newDirectory, inventory, content, copyTree, assertClosed, worker, networkGuardCode, executionEnv };
if (process.argv[1] && resolve(process.argv[1]) === script) {
  main().catch(error => { console.error(`Offline restore verification failed: ${error.message}`); process.exitCode = 1; });
}
