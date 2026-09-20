import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configuredOrigins } from '../apps/api/src/request-origin.ts';

test('public deployment origins must be explicit canonical HTTPS origins', () => {
  assert.deepEqual([...configuredOrigins(' https://47.88.76.167,https://example.com ')], ['https://47.88.76.167', 'https://example.com']);
  for (const origin of ['*', 'http://example.com', 'https://example.com/', 'https://example.com/app', 'https://user@example.com', 'null']) {
    assert.throws(() => configuredOrigins(origin));
  }
});
