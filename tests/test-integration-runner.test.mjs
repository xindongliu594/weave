import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { integrationTestConfig } from '../scripts/test-integration.mjs';

test('identity store uses its direct SQL adapter through the standard integration entry', () => {
  for (const path of ['tests/identity-store.test.ts', '.\\tests\\identity-store.test.ts', resolve('tests/identity-store.test.ts')]) {
    const config = integrationTestConfig(path);
    assert.equal(config.directIdentity, true);
    assert.equal(config.env.IDENTITY_TEST_DIRECT_PGLITE, '1');
    assert.equal(config.env.SIMULATED_INTEGRATION, 'pglite');
    assert.equal(config.args.includes('./scripts/test-support/pglite-pool.mjs'), false);
    assert.equal(config.args.at(-1), path);
  }
});

test('other files retain the socket preload and cannot inherit the direct identity flag', () => {
  for (const path of ['tests/identity-management.test.ts', 'tests/api.test.ts', 'elsewhere/identity-store.test.ts']) {
    const config = integrationTestConfig(path);
    assert.equal(config.directIdentity, false);
    assert.equal(config.env.IDENTITY_TEST_DIRECT_PGLITE, '0');
    assert.equal(config.args.includes('./scripts/test-support/pglite-pool.mjs'), true);
    assert.equal(config.env.IDENTITY_MANAGEMENT_POSTGRES_URL, undefined);
  }
});

test('identity path comparison follows platform casing without matching other files', () => {
  const canonical = resolve('tests/identity-store.test.ts');
  for (const alias of [canonical.toLowerCase(), canonical.toUpperCase()]) {
    const expected = process.platform === 'win32' || alias === canonical;
    const config = integrationTestConfig(alias);
    assert.equal(config.directIdentity, expected, alias);
    assert.equal(config.env.IDENTITY_TEST_DIRECT_PGLITE, expected ? '1' : '0');
  }
  for (const other of ['elsewhere/identity-store.test.ts', 'tests/identity-store-copy.test.ts']) {
    assert.equal(integrationTestConfig(resolve(other).toUpperCase()).directIdentity, false);
  }
});

test('runner selection preserves caller filters and never adds test skips', () => {
  for (const path of ['tests/identity-store.test.ts', 'tests/api.test.ts']) {
    const options = ['--test-name-pattern=audit'];
    const { args } = integrationTestConfig(path, options);
    assert.deepEqual(args.slice(-2), [...options, path]);
    assert.equal(args.includes('--test'), true);
    assert.equal(args.includes('--test-concurrency=1'), true);
    assert.equal(args.some((arg) => arg.startsWith('--test-skip-pattern=')), false);
  }
});
