import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const A = '00000000-0000-4000-8000-000000000001';
const B = '00000000-0000-4000-8000-000000000002';
const code = (name) => ({ code: `E_ARCHIVE_FENCE_${name}` });
const { createArchiveWriteFence } = await import('./archive-write-fence.mjs').catch(() => ({}));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fixture(t) {
  const temporaryRoot = fs.realpathSync(os.tmpdir());
  const base = fs.realpathSync(fs.mkdtempSync(path.join(temporaryRoot, 'archive-fence-')));
  const traceRoot = path.join(base, 'traces');
  const lockRoot = path.join(base, 'locks');
  fs.mkdirSync(traceRoot); fs.mkdirSync(lockRoot);
  t.after(() => {
    const relative = path.relative(temporaryRoot, base);
    assert.match(relative, /^archive-fence-[A-Za-z0-9]+$/);
    assert.equal(path.isAbsolute(relative), false);
    assert.equal(fs.lstatSync(base).isSymbolicLink(), false);
    assert.equal(fs.realpathSync(base), base);
    fs.rmSync(base, { recursive: true, force: true });
  });
  const options = { traceRoot, lockRoot };
  const logical = process.platform === 'win32' ? traceRoot.toLowerCase() : traceRoot;
  const namespace = path.join(lockRoot, createHash('sha256').update(logical).digest('hex'));
  return { ...options, base, namespace, fence: createArchiveWriteFence(options), options };
}

function renameInside(f, from, to) {
  for (const target of [from, to]) {
    const relative = path.relative(f.base, path.resolve(target));
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
  }
  assert.equal(fs.lstatSync(f.base).isSymbolicLink(), false);
  assert.equal(fs.realpathSync(f.base), f.base);
  fs.renameSync(from, to);
}

async function child(t, f, action, extra = {}) {
  const proc = fork(fileURLToPath(new URL('./test-helpers/archive-write-fence-child.mjs', import.meta.url)), [], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true,
    env: { ...process.env, ARCHIVE_FENCE_TEST: JSON.stringify({ ...f.options, action, runId: A, ...extra }) },
  });
  let stderr = ''; proc.stderr.on('data', (data) => { stderr += data; });
  proc.finished = once(proc, 'exit');
  t.after(async () => { if (proc.exitCode === null && proc.signalCode === null) { const exited = once(proc, 'exit'); proc.kill(); await exited; } });
  let timer;
  const message = await Promise.race([
    once(proc, 'message').then(([value]) => value),
    once(proc, 'exit').then(([exit]) => { throw new Error(`child exited ${exit}: ${stderr}`); }),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('child readiness timeout')), 8000); }),
  ]).finally(() => clearTimeout(timer));
  assert.deepEqual(message, { ready: true }, stderr);
  return proc;
}

test('private archive fence factory exists', () => assert.equal(typeof createArchiveWriteFence, 'function'));

test('guards are frozen, privately owned, mode/run scoped and expire only on release', async (t) => {
  const f = fixture(t); const other = createArchiveWriteFence(f.options);
  const abort = new AbortController(); const guard = await f.fence.acquireWriter([A], { signal: abort.signal });
  t.after(() => guard.release());
  assert.ok(Object.isFrozen(guard)); assert.ok(Object.isFrozen(f.fence));
  assert.throws(() => f.fence.assertGuard({}, { mode: 'writer', runId: A }), code('GUARD'));
  assert.throws(() => other.assertGuard(guard, { mode: 'writer', runId: A }), code('GUARD'));
  assert.throws(() => f.fence.assertGuard(guard, { mode: 'source', runId: A }), code('MODE'));
  assert.throws(() => f.fence.assertGuard(guard, { mode: 'writer', runId: B }), code('GUARD'));
  abort.abort(); f.fence.assertGuard(guard, { mode: 'writer', runId: A });
  guard.release(); guard.release();
  assert.throws(() => f.fence.assertGuard(guard, { mode: 'writer' }), code('GUARD'));
  const source = await f.fence.acquireSource(A); t.after(() => source.release());
  assert.throws(() => f.fence.withJournalAppendSync(source, A, () => {}), code('MODE'));
});

test('UUID sets, options and pre-abort reject before acquisition', async (t) => {
  const f = fixture(t);
  for (const ids of [[], Array(1), [A, A], [A.toUpperCase().replace('8000', 'A000')], ['../escape'], Array(129).fill(A)]) {
    await assert.rejects(f.fence.acquireWriter(ids), code('RUNS'));
  }
  for (const timeoutMs of [-1, 2001, 0.5, NaN, Infinity, '1']) {
    await assert.rejects(f.fence.acquireWriter([A], { timeoutMs }), code('OPTIONS'));
  }
  const aborted = AbortSignal.abort();
  await assert.rejects(f.fence.acquireWriter([A], { signal: aborted }), code('ABORTED'));
  assert.deepEqual(fs.readdirSync(f.namespace), []);
});

test('one acquisition deadline covers all run locks rather than restarting per file', async (t) => {
  const f = fixture(t);
  const first = await child(t, f, 'timed-source', { runId: A });
  const second = await child(t, f, 'timed-source', { runId: B });
  first.send(120); second.send(280);
  const start = performance.now();
  await assert.rejects(f.fence.acquireMaintenance([B, A], { timeoutMs: 200 }), code('TIMEOUT'));
  assert.ok(performance.now() - start < 500);
  await Promise.all([first.finished, second.finished]);
  const guard = await f.fence.acquireMaintenance([A, B]); guard.release();
});

test('nested different-run journal scopes cannot release their still active outer guard', async (t) => {
  const f = fixture(t); const guard = await f.fence.acquireWriter([A, B]); t.after(() => guard.release());
  f.fence.withJournalAppendSync(guard, A, () => {
    f.fence.withJournalAppendSync(guard, B, () => {});
    assert.throws(() => guard.release(), code('BUSY'));
  });
  f.fence.assertGuard(guard, { mode: 'writer' });
});

test('actual process writers coexist, block source and release independently', async (t) => {
  const f = fixture(t); const proc = await child(t, f, 'writer');
  const local = await f.fence.acquireWriter([A], { timeoutMs: 0 }); local.release();
  const start = performance.now();
  await assert.rejects(f.fence.acquireSource(A, { timeoutMs: 50 }), code('TIMEOUT'));
  assert.ok(performance.now() - start >= 40); assert.ok(performance.now() - start < 1000);
  proc.kill(); await once(proc, 'exit');
  const source = await f.fence.acquireSource(A); source.release();
});

test('root exclusive blocks writers in another process', async (t) => {
  const f = fixture(t); const proc = await child(t, f, 'root');
  await assert.rejects(f.fence.acquireWriter([A], { timeoutMs: 0 }), code('TIMEOUT'));
  proc.kill(); await once(proc, 'exit');
  const guard = await f.fence.acquireWriter([A]); guard.release();
});

test('multi-run timeout and waiting abort clean earlier run and root locks', async (t) => {
  const f = fixture(t); const proc = await child(t, f, 'source', { runId: B });
  await assert.rejects(f.fence.acquireMaintenance([B, A], { timeoutMs: 30 }), code('TIMEOUT'));
  let first = await f.fence.acquireSource(A); first.release();
  const abort = new AbortController();
  const pending = f.fence.acquireMaintenance([B, A], { timeoutMs: 2000, signal: abort.signal });
  setTimeout(() => abort.abort(), 30);
  await assert.rejects(pending, code('ABORTED'));
  first = await f.fence.acquireSource(A); first.release();
  proc.kill(); await once(proc, 'exit');
  const root = await f.fence.acquireRootExclusive(); root.release();
});

test('journal returns values, retains outer guard, and rejects async/thenable/reentry/early release', async (t) => {
  const f = fixture(t); const guard = await f.fence.acquireWriter([A]); t.after(() => guard.release());
  const append = (fn, options) => f.fence.withJournalAppendSync(guard, A, fn, options);
  assert.equal(append(() => 17), 17);
  const sentinel = new Error('sentinel'); assert.throws(() => append(() => { throw sentinel; }), (e) => e === sentinel);
  let invoked = false;
  assert.throws(() => append(async () => { invoked = true; }), code('CALLBACK')); assert.equal(invoked, false);
  assert.throws(() => append(() => ({ then() {} })), code('CALLBACK'));
  assert.throws(() => append(() => append(() => {})), code('REENTRANT'));
  assert.throws(() => append(() => guard.release()), code('BUSY'));
  assert.throws(() => f.fence.withJournalAppendSync(guard, B, () => {}), code('GUARD'));
  f.fence.assertGuard(guard, { mode: 'writer', runId: A }); assert.equal(append(() => 18), 18);
  guard.release(); const source = await f.fence.acquireSource(A); source.release();
  const maintenance = await f.fence.acquireMaintenance([A]);
  assert.equal(f.fence.withJournalAppendSync(maintenance, A, () => 19), 19); maintenance.release();
});

test('journal actual process contention times out without callback and short wait succeeds', async (t) => {
  const f = fixture(t); const guard = await f.fence.acquireWriter([A]); t.after(() => guard.release());
  const proc = await child(t, f, 'journal', { holdMs: 500 });
  let called = false;
  await assert.rejects(f.fence.acquireSource(A), code('TIMEOUT'));
  assert.throws(() => f.fence.withJournalAppendSync(guard, A, () => { called = true; }, { timeoutMs: 30 }), code('TIMEOUT'));
  assert.equal(called, false);
  assert.equal(f.fence.withJournalAppendSync(guard, A, () => 42, { timeoutMs: 1500 }), 42);
  await proc.finished;
});

test('two process journal increments produce exact contiguous sequence', async (t) => {
  const f = fixture(t); const counter = path.join(f.base, 'counter'); fs.writeFileSync(counter, '[]');
  const proc = await child(t, f, 'count', { counter, count: 30 });
  const guard = await f.fence.acquireWriter([A]);
  try {
    proc.send('go');
    for (let i = 0; i < 30; i++) {
      f.fence.withJournalAppendSync(guard, A, () => {
        const list = JSON.parse(fs.readFileSync(counter, 'utf8')); list.push(list.length + 1);
        fs.writeFileSync(counter, JSON.stringify(list));
      });
      await pause(1);
    }
    const [exit] = await proc.finished; assert.equal(exit, 0);
  } finally { guard.release(); }
  assert.deepEqual(JSON.parse(fs.readFileSync(counter, 'utf8')), Array.from({ length: 60 }, (_, i) => i + 1));
});

test('directory replacement invalidates old guards; root exclusive permits a legal trace swap', async (t) => {
  const f = fixture(t); const guard = await f.fence.acquireWriter([A]);
  t.after(() => guard.release());
  renameInside(f, f.traceRoot, path.join(f.base, 'old')); fs.mkdirSync(f.traceRoot);
  assert.throws(() => f.fence.assertGuard(guard, { mode: 'writer' }), code('IDENTITY'));
  assert.throws(() => f.fence.withJournalAppendSync(guard, A, () => {}), code('IDENTITY')); guard.release();
  const root = await f.fence.acquireRootExclusive();
  renameInside(f, f.traceRoot, path.join(f.base, 'second')); fs.mkdirSync(f.traceRoot);
  f.fence.assertGuard(root, { mode: 'root-exclusive' }); root.release();
  const next = await f.fence.acquireWriter([A]); f.fence.assertGuard(next, { mode: 'writer' }); next.release();
  assert.throws(() => f.fence.assertGuard(guard, { mode: 'writer' }), code('GUARD'));
});

for (const kind of ['namespace', 'lockRoot', 'file']) {
  test(`renamed ${kind} invalidates guard (OS rename restrictions reported separately)`, async (t) => {
    const f = fixture(t); const guard = await f.fence.acquireWriter([A]);
    t.after(() => guard.release());
    const target = kind === 'namespace' ? f.namespace : kind === 'lockRoot' ? f.lockRoot : path.join(f.namespace, `${A}.lifetime`);
    try { renameInside(f, target, `${target}-old`); }
    catch (error) {
      if (error.code !== 'EPERM') throw error;
      guard.release();
      renameInside(f, target, `${target}-old`);
      return t.skip(`live ${kind} replacement fixture blocked by OS EPERM; rename works after guard release`);
    }
    if (kind === 'file') fs.writeFileSync(target, ''); else fs.mkdirSync(target);
    assert.throws(() => f.fence.assertGuard(guard, { mode: 'writer' }), code('IDENTITY'));
    guard.release(); guard.release();
  });
}

test('invalid roots and aliases are rejected without modifying invalid entries', (t) => {
  const f = fixture(t);
  for (const input of [null, undefined, 2, {}, { traceRoot: f.traceRoot }]) assert.throws(() => createArchiveWriteFence(input), code('PATH'));
  for (const traceRoot of ['relative', `${f.traceRoot}${path.sep}..${path.sep}traces`, path.parse(f.traceRoot).root, f.lockRoot]) {
    assert.throws(() => createArchiveWriteFence({ traceRoot, lockRoot: f.lockRoot }), code('PATH'));
  }
  const nested = path.join(f.traceRoot, 'nested'); fs.mkdirSync(nested);
  assert.throws(() => createArchiveWriteFence({ traceRoot: f.traceRoot, lockRoot: nested }), code('PATH'));
  const file = path.join(f.base, 'regular'); fs.writeFileSync(file, 'keep');
  assert.throws(() => createArchiveWriteFence({ traceRoot: file, lockRoot: f.lockRoot }), code('PATH'));
  assert.equal(fs.readFileSync(file, 'utf8'), 'keep');
});

test('hardlinked native file rejected (permission failures reported as skipped fixtures)', async (t) => {
  const f = fixture(t); const original = path.join(f.base, 'original'); fs.writeFileSync(original, 'keep');
  try { fs.linkSync(original, path.join(f.namespace, 'root.gate')); }
  catch (e) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(e.code)) return t.skip(`hardlink fixture unavailable: ${e.code}`); throw e; }
  await assert.rejects(f.fence.acquireWriter([A]), code('PATH')); assert.equal(fs.readFileSync(original, 'utf8'), 'keep');
});

test('native files must be regular and existing native-file contents are not truncated', async (t) => {
  const f = fixture(t); const gate = path.join(f.namespace, 'root.gate'); fs.writeFileSync(gate, 'retained');
  const guard = await f.fence.acquireWriter([A]); guard.release();
  assert.equal(fs.readFileSync(gate, 'utf8'), 'retained');
  const g = fixture(t); fs.mkdirSync(path.join(g.namespace, 'root.gate'));
  await assert.rejects(g.fence.acquireWriter([A]), code('PATH'));
});

test('symlink/junction roots, namespace and lock files are rejected', async (t) => {
  const f = fixture(t); const alias = path.join(f.base, 'alias');
  try { fs.symlinkSync(f.traceRoot, alias, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (e) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(e.code)) return t.skip(`directory link fixture unavailable: ${e.code}`); throw e; }
  assert.throws(() => createArchiveWriteFence({ traceRoot: alias, lockRoot: f.lockRoot }), code('PATH'));
  fs.rmdirSync(f.namespace); fs.symlinkSync(f.traceRoot, f.namespace, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.fence.acquireWriter([A]), code('IDENTITY'));
});

test('symlink lock file rejected without touching target', async (t) => {
  const f = fixture(t); const target = path.join(f.base, 'target'); fs.writeFileSync(target, 'keep');
  try { fs.symlinkSync(target, path.join(f.namespace, 'root.gate'), 'file'); }
  catch (e) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(e.code)) return t.skip(`file link fixture unavailable: ${e.code}`); throw e; }
  await assert.rejects(f.fence.acquireWriter([A]), code('PATH')); assert.equal(fs.readFileSync(target, 'utf8'), 'keep');
});
