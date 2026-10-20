import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunSandbox } from './sandbox.mjs';
const tick = () => new Promise(setImmediate);

for (const fail of [false, true]) test('sandbox original cleanup is shared per container generation: ' + fail, async t => {
  const root = await mkdtemp(join(tmpdir(), 'sandbox-close-')), removals = [], runs = [];
  t.mock.method(childProcess, 'spawn', (_command, args) => {
    const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {};
    if (args[0] === 'rm') removals.push(code => child.emit('close', code));
    else {
      if (args[0] === 'run') runs.push(args);
      setImmediate(() => {
        if (args[0] === 'exec' && args.includes('sh')) child.stdout.write('fixture\n[exit_code=0]\n');
        else if (args[0] === 'exec') child.stdout.write('[]');
        child.emit('close', 0);
      });
    }
    return child;
  }); syncBuiltinESMExports();
  try {
    const sandbox = new RunSandbox('fixture', root);
    await sandbox.start();
    const first = sandbox.close(), observed = first.catch(error => error), second = sandbox.close();
    assert.equal(first, second);
    await tick(); assert.equal(removals.length, 1);
    let restarted = false;
    const start = sandbox.start().then(() => { restarted = true; }, error => error);
    await tick(); assert.equal(restarted, false); assert.equal(runs.length, 1);
    removals[0](fail ? 1 : 0);
    const result = await observed; await start;
    if (fail) {
      assert.ok(result instanceof Error);
      await assert.rejects(sandbox.close());
      assert.equal(removals.length, 1); assert.equal(runs.length, 1);
    } else {
      assert.equal(result, undefined); assert.equal(runs.length, 2);
      const terminal = sandbox.execute('terminal', { command: 'fixture' });
      while (removals.length < 2) await tick(); removals[1](0); assert.equal((await terminal).exitCode, 0);
      const next = sandbox.execute('terminal_test', { command: 'fixture' });
      while (removals.length < 3) await tick(); removals[2](0); assert.equal((await next).exitCode, 0);
      assert.equal(runs.length, 3); await sandbox.close(); assert.equal(removals.length, 3);
    }
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); assert.ok(root.startsWith(join(tmpdir(), 'sandbox-close-'))); await rm(root, { recursive: true, force: true }); }
});
