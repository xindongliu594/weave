import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
function launch(...args: string[]) {
  const result = spawnSync(process.execPath, ['scripts/local.mjs', ...args], {
    cwd: root, encoding: 'utf8', windowsHide: true, timeout: 15000,
  });
  assert.ifError(result.error);
  return { status: result.status, output: result.stdout + result.stderr };
}

test('local launcher documents the explicit data directory', () => {
  const result = launch('--help');
  assert.equal(result.status, 0);
  assert.match(result.output, /--data-dir/);
  assert.match(result.output, /--production/);
  assert.match(result.output, /npm run build/);
});

test('API-only local check cannot be presented as a production static-web check', () => {
  const result = launch('--check', '--production');
  assert.notEqual(result.status, 0);
  assert.match(result.output, /静态网页须单独验证/);
});

test('local check refuses a data directory override before accessing it', () => {
  const result = launch('--check', '--data-dir=' + join(tmpdir(), 'existing-workspace'));
  assert.notEqual(result.status, 0);
  assert.match(result.output, /检查模式不接受 --data-dir/);
});

test('local launcher refuses relative and empty data directories', () => {
  for (const value of ['', '.data/local']) {
    const result = launch('--data-dir=' + value);
    assert.notEqual(result.status, 0);
    assert.match(result.output, /--data-dir 必须是绝对路径/);
  }
});

test('local launcher refuses ambiguous duplicate data directory options', () => {
  const result = launch('--data-dir=' + tmpdir(), '--data-dir=' + root);
  assert.notEqual(result.status, 0);
  assert.match(result.output, /--data-dir 只能指定一次/);
});

test('an absolute data directory with spaces retains its existing launch lock', () => {
  const directory = mkdtempSync(join(tmpdir(), 'weiwu launcher '));
  const lockFile = join(directory, 'launcher.lock');
  writeFileSync(lockFile, JSON.stringify({ id: 'existing-owner', pid: process.pid }));
  try {
    const result = launch('--data-dir=' + directory);
    assert.notEqual(result.status, 0);
    assert.match(result.output, /本机工作空间正在运行/);
    assert.equal(existsSync(lockFile), true);
    assert.equal(existsSync(join(directory, 'database')), false);
    assert.equal(existsSync(join(directory, 'session.json')), false);
  } finally {
    unlinkSync(lockFile);
    rmdirSync(directory);
  }
});
