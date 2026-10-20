import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { validateObservabilityTestConfig } from '../scripts/test-observability-postgres.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
test('runner accepts explicit loopback test URLs and defaults to the owned native fixture only', () => {
  for (const host of ['127.0.0.1', 'localhost', '[::1]']) {
    const config = validateObservabilityTestConfig(`postgresql://user:password@${host}:5432/weiwu_observation_test_fixture`, []);
    assert.deepEqual(config.tests, ['tests/audit-outbox.test.ts']);
  }
  assert.throws(() => validateObservabilityTestConfig('postgresql://127.0.0.1/weiwu_observation_test_fixture', ['tests/audit-events.test.ts']), /OBSERVABILITY_TEST_FILES_REJECTED/);
});
function run(url, args = ['tests/audit-outbox.test.ts'], extra = {}, worker = false) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, ...extra, DATABASE_URL: 'postgresql://unused:secret@127.0.0.1:1/production' };
    delete env.OBSERVABILITY_TEST_DATABASE_URL;
    if (url !== undefined) env.OBSERVABILITY_TEST_DATABASE_URL = url;
    const command = worker ? ['--import', 'tsx', 'tests/fixtures/observability/project-once.ts'] : ['scripts/test-observability-postgres.mjs', ...args];
    const child = spawn(process.execPath, command, { cwd: root, env });
    let output = ''; child.stdout.on('data', chunk => output += chunk); child.stderr.on('data', chunk => output += chunk);
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    child.once('error', reject); child.once('exit', code => { clearTimeout(timer); resolve({ code, output }); });
  });
}

test('runner refuses absent, remote and non-test URLs before any connection and hides credentials', async () => {
  let connections = 0;
  const server = createServer(socket => { connections++; socket.destroy(); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    for (const url of [undefined, '', 'not-a-url', `postgresql://u:fixture-secret@127.0.0.1:${port}/production`,
      'postgresql://u:fixture-secret@db.example/weiwu_observation_test_fixture',
      'http://u:fixture-secret@127.0.0.1/weiwu_observation_test_fixture',
      `postgresql://u:fixture-secret@127.0.0.1:${port}/weiwu_observation_test_fixture?host=db.example`,
      `postgresql://u:fixture-secret@127.0.0.1:${port}/weiwu_observation_test_fixture#fragment`,
      `postgresql://u:fixture-secret@127.0.0.1:${port}/weiwu_observation_test_%66ixture`,
      `postgresql://u:fixture-secret@127.0.0.1:${port}/weiwu_observation_test_`]) {
      const result = await run(url);
      assert.notEqual(result.code, 0);
      assert.match(result.output, /OBSERVABILITY_TEST_URL_REJECTED/);
      assert.doesNotMatch(result.output, /fixture-secret|unused:secret/);
    }
    assert.equal(connections, 0);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('restart worker refuses ambient database URL without explicit guarded test configuration', async () => {
  const result = await run(undefined, [], {}, true);
  assert.notEqual(result.code, 0); assert.match(result.output, /OBSERVABILITY_TEST_URL_REJECTED/);
  assert.doesNotMatch(result.output, /unused:secret/);
});

test('runner rejects files and options outside its narrow allowlist before connecting', async () => {
  let connections = 0;
  const server = createServer(socket => { connections++; socket.destroy(); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `postgresql://u:fixture-secret@127.0.0.1:${server.address().port}/weiwu_observation_test_fixture`;
  try {
    for (const args of [['tests/api.test.ts'], ['../tests/audit-outbox.test.ts'], ['tests/audit-outbox.test.ts', '--import=evil'],
      ['--test-name-pattern=.*'], ['tests/audit-outbox.test.ts', 'tests/audit-outbox.test.ts']]) {
      const result = await run(url, args);
      assert.notEqual(result.code, 0); assert.match(result.output, /OBSERVABILITY_TEST_FILES_REJECTED/);
      assert.doesNotMatch(result.output, /fixture-secret/);
    }
    assert.equal(connections, 0);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
