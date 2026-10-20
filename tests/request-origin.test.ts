import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configuredOrigins,isAllowedCallbackNavigation } from '../apps/api/src/request-origin.ts';

test('public deployment origins must be explicit canonical HTTPS origins', () => {
  assert.deepEqual([...configuredOrigins(' https://47.88.76.167,https://example.com ')], ['https://47.88.76.167', 'https://example.com']);
  for (const origin of ['*', 'http://example.com', 'https://example.com/', 'https://example.com/app', 'https://user@example.com', 'null']) {
    assert.throws(() => configuredOrigins(origin));
  }
});

test('cross-site navigation is limited to the exact OIDC GET callback',()=>{
  assert.equal(isAllowedCallbackNavigation('GET','/auth/callback','navigate'),true);
  for(const [method,path,mode] of [['POST','/auth/callback','navigate'],['GET','/auth/callback/','navigate'],
    ['GET','/auth/login','navigate'],['GET','/auth/callback','cors']])
    assert.equal(isAllowedCallbackNavigation(method,path,mode),false);
});
