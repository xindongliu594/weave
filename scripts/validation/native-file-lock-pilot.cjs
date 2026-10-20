// Isolated library evaluation: no product runtime, database, model or sandbox calls.
// Install the pinned dependency into a separate directory with --ignore-scripts.
// node this-file --dependency-root <directory> --output <report.json>
const fs = require('node:fs');
const path = require('node:path');
const { fork } = require('node:child_process');
const { createRequire } = require('node:module');
const { createHash, randomUUID } = require('node:crypto');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');

const expectedIntegrity = 'sha512-abjiHKkYdcH5M9ikBEJb0MKb/fEpPtZx/yfLHzTptvUAoiFayX0tIe0BTLBU4SAoRyjZLzA0dP1Rn2p0+QRyVg==';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const sha = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function dependency(root) {
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  const record = lock.packages?.['node_modules/fs-native-extensions'];
  assert.equal(record?.version, '1.5.1');
  assert.equal(record?.integrity, expectedIntegrity);
  const localRequire = createRequire(path.join(root, 'package.json'));
  assert.equal(localRequire('fs-native-extensions/package.json').version, '1.5.1');
  return localRequire('fs-native-extensions');
}

async function worker(root, dir, mode, arg) {
  const native = dependency(root);
  const fd = fs.openSync(path.join(dir, 'lock'), 'a+');
  const deadline = performance.now() + 5000;
  const acquire = async () => {
    while (!native.tryLock(fd)) {
      if (performance.now() > deadline) throw Error('worker lock deadline');
      await sleep(2);
    }
  };
  if (mode === 'counter') {
    await new Promise(resolve => {
      process.once('message', resolve);
      process.send({ event: 'ready' });
    });
    for (let i = 0; i < Number(arg); i++) {
      await acquire();
      try {
        const file = path.join(dir, 'counter');
        const value = Number(fs.readFileSync(file, 'utf8'));
        await sleep(1);
        fs.writeFileSync(file, String(value + 1));
      } finally { native.unlock(fd); }
    }
    fs.closeSync(fd);
    process.send({ event: 'done' }, () => process.exit(0));
    return;
  }
  assert.equal(native.tryLock(fd, { shared: mode === 'shared' }), true);
  process.on('message', message => {
    if (message === 'close') {
      fs.closeSync(fd);
      // Keep the owner alive: otherwise this would only prove process-exit release.
      process.send({ event: 'closed' });
      return;
    }
    else if (message === 'unlock') { native.unlock(fd); fs.closeSync(fd); }
    else if (message !== 'exit') throw Error('unknown worker command');
    // "exit" deliberately leaves the locked descriptor open for the OS.
    process.send({ event: 'done' }, () => process.exit(0));
  });
  process.send({ event: 'ready' });
}

function child(root, dir, mode, arg = '') {
  const proc = fork(__filename, ['--worker', root, dir, mode, arg], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true,
  });
  const messages = [], listeners = [];
  let ended, failure, stderr = '';
  const flush = () => {
    for (const listener of [...listeners]) {
      const at = messages.findIndex(message => message.event === listener.event);
      if (at >= 0) listener.settle(null, messages.splice(at, 1)[0]);
      else if (failure || ended) listener.settle(failure || Error(`worker exited: ${ended.code}/${ended.signal}`));
    }
  };
  proc.stderr.on('data', bytes => { stderr = (stderr + bytes.toString()).slice(-2000); });
  proc.on('message', message => { messages.push(message); flush(); });
  proc.on('error', error => { failure = error; flush(); });
  const exit = new Promise(resolve => proc.once('close', (code, signal) => {
    ended = { code, signal, stderr }; flush(); resolve(ended);
  }));
  const event = name => new Promise((resolve, reject) => {
    const listener = { event: name, settle(error, value) {
      clearTimeout(timer);
      listeners.splice(listeners.indexOf(listener), 1);
      error ? reject(error) : resolve(value);
    } };
    const timer = setTimeout(() => listener.settle(Error(`worker timed out: ${name}`)), 7000);
    listeners.push(listener); flush();
  });
  return { proc, event, exit, stop: async () => {
    if (!ended) proc.kill('SIGKILL');
    return exit;
  } };
}

async function main(args) {
  assert.equal(args.length, 4, 'expected --dependency-root <dir> --output <file>');
  assert.equal(args[0], '--dependency-root'); assert.equal(args[2], '--output');
  const root = path.resolve(args[1]), output = path.resolve(args[3]);
  const native = dependency(root), directory = path.join(root, `files-${randomUUID()}`);
  fs.mkdirSync(directory, { mode: 0o700 });
  const lockFile = path.join(directory, 'lock');
  fs.writeFileSync(lockFile, '');
  const children = [], descriptors = new Set(), results = [];
  const open = () => { const fd = fs.openSync(lockFile, 'a+'); descriptors.add(fd); return fd; };
  const close = fd => { fs.closeSync(fd); descriptors.delete(fd); };
  const start = (mode, arg) => { const c = child(root, directory, mode, arg); children.push(c); return c; };
  const check = async (name, test) => {
    const startAt = performance.now();
    try { const detail = await test(); results.push({ name, passed: true, milliseconds: performance.now() - startAt, detail }); }
    catch (error) { results.push({ name, passed: false, milliseconds: performance.now() - startAt, error: error.message }); throw error; }
  };
  let error;
  try {
    await check('two descriptors in one process exclude each other', () => {
      const a = open(), b = open();
      assert.equal(native.tryLock(a), true); assert.equal(native.tryLock(b), false);
      native.unlock(a); assert.equal(native.tryLock(b), true);
      native.unlock(b); close(a); close(b);
    });
    await check('two processes share; exclusive waits for both', async () => {
      const a = start('shared'), b = start('shared');
      await Promise.all([a.event('ready'), b.event('ready')]);
      const fd = open();
      assert.equal(native.tryLock(fd, { shared: true }), true); native.unlock(fd);
      assert.equal(native.tryLock(fd), false);
      a.proc.send('unlock'); assert.equal((await a.exit).code, 0);
      assert.equal(native.tryLock(fd), false);
      b.proc.send('unlock'); assert.equal((await b.exit).code, 0);
      assert.equal(native.tryLock(fd), true); native.unlock(fd); close(fd);
    });
    for (const command of ['close', 'exit', 'kill']) {
      await check(`exclusive blocks until owner ${command}`, async () => {
        const owner = start('exclusive'); await owner.event('ready');
        const fd = open(); assert.equal(native.tryLock(fd), false);
        if (command === 'kill') await owner.stop();
        else if (command === 'close') {
          owner.proc.send(command); await owner.event('closed');
          assert.equal(owner.proc.exitCode, null); assert.equal(owner.proc.signalCode, null);
          assert.equal(process.kill(owner.proc.pid, 0), true);
        } else { owner.proc.send(command); assert.equal((await owner.exit).code, 0); }
        assert.equal(native.tryLock(fd), true); native.unlock(fd); close(fd);
        if (command === 'close') {
          owner.proc.send('exit'); assert.equal((await owner.exit).code, 0);
          return { reacquiredWhileOwnerAlive: true };
        }
      });
    }
    await check('bounded retries never steal a held lock', async () => {
      const owner = start('exclusive'); await owner.event('ready');
      const fd = open(), until = performance.now() + 100;
      let attempts = 0;
      do { assert.equal(native.tryLock(fd), false); attempts++; await sleep(5); } while (performance.now() < until);
      owner.proc.send('unlock'); assert.equal((await owner.exit).code, 0); close(fd);
      return { attempts };
    });
    await check('two real processes serialize read-modify-write', async () => {
      fs.writeFileSync(path.join(directory, 'counter'), '0');
      const a = start('counter', '30'), b = start('counter', '30');
      await Promise.all([a.event('ready'), b.event('ready')]);
      a.proc.send('start'); b.proc.send('start');
      await Promise.all([a.event('done'), b.event('done')]);
      for (const result of await Promise.all([a.exit, b.exit])) assert.equal(result.code, 0);
      const actual = Number(fs.readFileSync(path.join(directory, 'counter'), 'utf8'));
      assert.equal(actual, 60);
      return { actual, expected: 60 };
    });
    await check('locked descriptor does not imply stable pathname', () => {
      const fd = open(); assert.equal(native.tryLock(fd), true);
      let replaced = false, code;
      try { fs.renameSync(lockFile, path.join(directory, 'original-lock')); replaced = true; }
      catch (error) { code = error.code; if (!['EPERM', 'EACCES', 'EBUSY'].includes(code)) throw error; }
      let newFileLocked;
      if (replaced) {
        fs.writeFileSync(lockFile, '', { flag: 'wx' });
        const other = open(); newFileLocked = native.tryLock(other);
        if (newFileLocked) native.unlock(other);
        close(other);
      }
      native.unlock(fd); close(fd);
      return { replaced, newFileLocked, refusalCode: code, interpretation: 'Measurement only; integration must preserve the lock inode and cover all writers.' };
    });
    await check('uncontended open-lock-unlock-close cost', () => {
      const started = performance.now(), iterations = 1000;
      for (let i = 0; i < iterations; i++) {
        const fd = open(); assert.equal(native.tryLock(fd), true); native.unlock(fd); close(fd);
      }
      return { iterations, microsecondsPerOperation: (performance.now() - started) * 1000 / iterations };
    });
  } catch (caught) { error = caught; }
  finally {
    await Promise.all(children.map(c => c.stop()));
    for (const fd of descriptors) { try { fs.closeSync(fd); } catch {} }
  }
  const report = {
    version: 1, at: new Date().toISOString(), platform: process.platform, arch: process.arch, node: process.version,
    library: 'fs-native-extensions@1.5.1', integrity: expectedIntegrity,
    scriptSha256: sha(__filename), packageLockSha256: sha(path.join(root, 'package-lock.json')),
    results, passed: !error, modelCalls: 0, productionAccess: false,
    limits: 'Synthetic local files only. This tests the lock primitive, not product writer coverage, lifecycle draining, SQL atomicity, network filesystems, or recovery.',
  };
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  if (error) process.exitCode = 1;
}
if (process.argv[2] === '--worker') {
  worker(...process.argv.slice(3)).catch(error => { process.stderr.write(error.stack + '\n'); process.exit(1); });
} else {
  main(process.argv.slice(2)).catch(error => { process.stderr.write(error.stack + '\n'); process.exitCode = 1; });
}
