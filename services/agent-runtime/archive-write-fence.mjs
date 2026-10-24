import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { types } from 'node:util';
import { performance } from 'node:perf_hooks';

const guards = new WeakMap();
const activeJournals = new Set();
const sleeper = new Int32Array(new SharedArrayBuffer(4));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const modes = new Set(['writer', 'source', 'maintenance', 'root-exclusive']);

function fail(code) {
  return Object.assign(new Error(`Archive fence ${code.toLowerCase()}`), { code: `E_ARCHIVE_FENCE_${code}` });
}

function checkedIO(fn, code = 'IO') {
  try { return fn(); }
  catch (error) { if (error?.code?.startsWith('E_ARCHIVE_FENCE_')) throw error; throw fail(code); }
}

function identity(stat) { return { dev: stat.dev, ino: stat.ino }; }
function same(a, b) { return a.dev === b.dev && a.ino === b.ino; }

function directory(name, code) {
  return checkedIO(() => {
    const stat = fs.lstatSync(name, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync.native(name) !== name) throw fail(code);
    return { path: name, ...identity(stat) };
  }, code);
}

function ancestors(name) {
  const result = [];
  for (;;) {
    result.push(directory(name, 'PATH'));
    const parent = path.dirname(name);
    if (parent === name) return result;
    name = parent;
  }
}

function canonicalRoot(name, allowMissing = false) {
  if (typeof name !== 'string' || !path.isAbsolute(name) || path.normalize(name) !== name || name === path.parse(name).root || name.includes('\0')) throw fail('PATH');
  // Network shares and Windows alternate streams are outside the verified platform contract.
  if (process.platform === 'win32' && (!/^[A-Za-z]:\\/.test(name) || name.slice(2).includes(':'))) throw fail('PATH');
  if (allowMissing) {
    try { fs.lstatSync(name); }
    catch (error) { if (error.code === 'ENOENT') { directory(path.dirname(name), 'PATH'); return name; } throw fail('PATH'); }
  }
  directory(name, 'PATH');
  return name;
}

function assertDirectories(dirs) {
  for (const item of dirs) if (!same(item, directory(item.path, 'IDENTITY'))) throw fail('IDENTITY');
}

function runSet(ids) {
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > 128) throw fail('RUNS');
  const copy = Array.from(ids);
  if (copy.some((id) => typeof id !== 'string' || !UUID.test(id)) || new Set(copy).size !== copy.length) throw fail('RUNS');
  return copy.sort();
}

function options(value, defaultMs, async = true) {
  if (value === undefined) value = {};
  if (value === null || typeof value !== 'object') throw fail('OPTIONS');
  const { timeoutMs = defaultMs, signal } = value;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 2000) throw fail('OPTIONS');
  if (signal !== undefined && (!async || !(signal instanceof AbortSignal))) throw fail('OPTIONS');
  return { timeoutMs, signal };
}

function closeAll(records) {
  let failed = false;
  for (let i = records.length - 1; i >= 0; i--) {
    try { fs.closeSync(records[i].fd); } catch { failed = true; }
  }
  records.length = 0;
  if (failed) throw fail('IO');
}

function checkFile(record, code = 'IDENTITY') {
  checkedIO(() => {
    const stat = fs.lstatSync(record.path, { bigint: true });
    const actual = fs.fstatSync(record.fd, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || !actual.isFile() || actual.nlink !== 1n || !same(record, stat) || !same(record, actual)) throw fail(code);
  }, code);
}

function openFile(name) {
  return checkedIO(() => {
    let fd;
    try {
      try { fd = fs.openSync(name, 'wx+', 0o600); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const stat = fs.lstatSync(name, { bigint: true });
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) throw fail('PATH');
        fd = fs.openSync(name, fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW ?? 0));
      }
      const record = { path: name, fd, ...identity(fs.fstatSync(fd, { bigint: true })) };
      checkFile(record, 'PATH');
      return record;
    } catch (error) {
      if (fd !== undefined) fs.closeSync(fd);
      throw error;
    }
  }, 'PATH');
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    const onAbort = () => { clearTimeout(timer); signal.removeEventListener('abort', onAbort); reject(fail('ABORTED')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

/** Private primitive only; callers must share one deployment-owned trace/lock root mapping. */
export function createArchiveWriteFence(roots) {
  if (!roots || typeof roots !== 'object') throw fail('PATH');
  let { traceRoot, lockRoot, allowMissingTraceRoot = false } = roots;
  if (typeof allowMissingTraceRoot !== 'boolean') throw fail('PATH');
  if (!['win32', 'linux'].includes(process.platform) || process.arch !== 'x64') throw fail('UNAVAILABLE');
  let native;
  try { native = createRequire(import.meta.url)('fs-native-extensions'); }
  catch { throw fail('UNAVAILABLE'); }
  // Startup reconciliation may encounter the original root between renames.
  // Only root-exclusive skips binding this inode; every run mode still requires it.
  traceRoot = canonicalRoot(traceRoot, allowMissingTraceRoot); lockRoot = canonicalRoot(lockRoot);
  const logical = process.platform === 'win32' ? traceRoot.toLowerCase() : traceRoot;
  const lockLogical = process.platform === 'win32' ? lockRoot.toLowerCase() : lockRoot;
  if (logical === lockLogical || logical.startsWith(`${lockLogical}${path.sep}`) || lockLogical.startsWith(`${logical}${path.sep}`)) throw fail('PATH');
  const fixedDirs = [...ancestors(path.dirname(traceRoot)), ...ancestors(lockRoot)];
  const namespace = path.join(lockRoot, createHash('sha256').update(logical).digest('hex'));
  checkedIO(() => { try { fs.mkdirSync(namespace, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; } }, 'PATH');
  fixedDirs.push(directory(namespace, 'PATH'));
  assertDirectories(fixedDirs);
  const owner = {};

  function tryLock(record, shared) {
    return checkedIO(() => native.tryLock(record.fd, { shared }), 'NATIVE');
  }

  function checkState(state) {
    assertDirectories(fixedDirs);
    if (state.trace && !same(state.trace, directory(traceRoot, 'IDENTITY'))) throw fail('IDENTITY');
    for (const file of state.files) checkFile(file);
  }

  function stateFor(guard) {
    const state = guards.get(guard);
    if (!state || state.owner !== owner || !state.live) throw fail('GUARD');
    checkState(state);
    return state;
  }

  function assertGuard(guard, expected) {
    const state = stateFor(guard);
    if (!expected || !modes.has(expected.mode) || state.mode !== expected.mode) throw fail('MODE');
    if (expected.runId !== undefined && !state.ids.includes(expected.runId)) throw fail('GUARD');
  }

  async function acquire(mode, ids, opts) {
    const { timeoutMs, signal } = options(opts, mode === 'writer' ? 2000 : 0);
    const deadline = performance.now() + timeoutMs;
    if (signal?.aborted) throw fail('ABORTED');
    const state = { owner, mode, ids, files: [], live: true, trace: null, journalDepth: 0 };
    async function take(name, shared) {
      assertDirectories(fixedDirs);
      if (signal?.aborted) throw fail('ABORTED');
      const record = openFile(path.join(namespace, name));
      state.files.push(record);
      for (;;) {
        if (signal?.aborted) throw fail('ABORTED');
        checkState(state);
        if (timeoutMs > 0 && performance.now() >= deadline) throw fail('TIMEOUT');
        if (tryLock(record, shared)) { checkState(state); return; }
        const remaining = deadline - performance.now();
        if (remaining <= 0) throw fail('TIMEOUT');
        await delay(Math.min(10, remaining), signal);
      }
    }
    try {
      await take('root.gate', mode !== 'root-exclusive');
      if (mode !== 'root-exclusive') state.trace = directory(traceRoot, 'IDENTITY');
      for (const id of ids) await take(`${id}.lifetime`, mode === 'writer');
      if (signal?.aborted) throw fail('ABORTED');
      checkState(state);
      const guard = Object.freeze({
        release() {
          if (!state.live) return;
          if (state.journalDepth > 0) throw fail('BUSY');
          state.live = false; closeAll(state.files);
        },
      });
      guards.set(guard, state);
      return guard;
    } catch (error) { state.live = false; closeAll(state.files); throw error; }
  }

  function withJournalAppendSync(guard, runId, syncFn, opts) {
    const state = stateFor(guard);
    if (state.mode !== 'writer' && state.mode !== 'maintenance') throw fail('MODE');
    if (!state.ids.includes(runId)) throw fail('GUARD');
    if (typeof syncFn !== 'function' || types.isAsyncFunction(syncFn)) throw fail('CALLBACK');
    const { timeoutMs } = options(opts, 2000, false);
    const key = path.join(namespace, `${runId}.journal`);
    if (activeJournals.has(key)) throw fail('REENTRANT');
    const files = []; const deadline = performance.now() + timeoutMs;
    activeJournals.add(key); state.journalDepth++;
    try {
      const record = openFile(key); files.push(record);
      for (;;) {
        checkState(state); checkFile(record);
        if (timeoutMs > 0 && performance.now() >= deadline) throw fail('TIMEOUT');
        if (tryLock(record, false)) break;
        const remaining = deadline - performance.now();
        if (remaining <= 0) throw fail('TIMEOUT');
        Atomics.wait(sleeper, 0, 0, Math.min(5, remaining));
      }
      checkState(state); checkFile(record);
      const value = syncFn();
      // Trusted internal callback: detecting a thenable cannot undo earlier side effects.
      if (value !== null && (typeof value === 'object' || typeof value === 'function') && typeof value.then === 'function') throw fail('CALLBACK');
      return value;
    } finally {
      state.journalDepth--; activeJournals.delete(key); closeAll(files);
    }
  }

  return Object.freeze({
    acquireWriter: async (ids, opts) => acquire('writer', runSet(ids), opts),
    acquireSource: async (id, opts) => acquire('source', runSet([id]), opts),
    acquireMaintenance: async (ids, opts) => acquire('maintenance', runSet(ids), opts),
    acquireRootExclusive: (opts) => acquire('root-exclusive', [], opts),
    assertGuard, withJournalAppendSync,
  });
}
