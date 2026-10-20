import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadIdentityConfig } from '../apps/api/src/identity-config.ts';
import { principalKey } from '../apps/api/src/identity-types.ts';

const env = () => ({ WEIWU_AUTH_MODE: 'oidc', WEIWU_PUBLIC_ORIGIN: 'https://weiwu.example',
  WEIWU_OIDC_ISSUER: 'https://id.example/tenant/', WEIWU_OIDC_CLIENT_ID: 'weiwu',
  WEIWU_OIDC_CLIENT_SECRET: 'fixture-client-credential',
  WEIWU_SESSION_SECRETS: JSON.stringify(['R5fKs9vX2aQ7wZ4nE8cJ6tH3yU0pL1dB']),
  WEIWU_BOOTSTRAP_ISSUER: 'https://id.example/tenant/', WEIWU_BOOTSTRAP_SUBJECT: 'owner-sub' });

test('identity config defaults only to explicit local compatibility and validates complete OIDC config', () => {
  assert.deepEqual(loadIdentityConfig({}), { mode: 'legacy-local' });
  assert.deepEqual(loadIdentityConfig({ WEIWU_AUTH_MODE: 'legacy-local' }), { mode: 'legacy-local' });
  const config = loadIdentityConfig(env());
  assert.equal(config.mode, 'oidc');
  if (config.mode === 'oidc') {
    assert.equal(config.issuer, env().WEIWU_OIDC_ISSUER);
    assert.equal(config.publicOrigin, 'https://weiwu.example');
    assert.equal(config.bootstrapSubject, 'owner-sub');
  }
  assert.throws(() => loadIdentityConfig({ WEIWU_AUTH_MODE: 'other' }));
  for (const key of Object.keys(env()).filter(key => key !== 'WEIWU_AUTH_MODE')) {
    const input: NodeJS.ProcessEnv = env(); delete input[key];
    assert.throws(() => loadIdentityConfig(input), key);
  }
});

test('identity config rejects ambiguous URLs, weak secrets and nonexact bootstrap issuer', () => {
  for (const value of ['http://weiwu.example', 'https://weiwu.example/', 'https://weiwu.example/a',
    'https://u@weiwu.example', 'https://weiwu.example?q=x', 'https://weiwu.example#x', ' https://weiwu.example']) {
    assert.throws(() => loadIdentityConfig({ ...env(), WEIWU_PUBLIC_ORIGIN: value }), value);
  }
  for (const value of ['http://id.example', 'https://u@id.example', 'https://id.example?q=x', 'https://id.example#x', 'https://id.example?']) {
    assert.throws(() => loadIdentityConfig({ ...env(), WEIWU_OIDC_ISSUER: value, WEIWU_BOOTSTRAP_ISSUER: value }), value);
  }
  for (const value of ['not-json', '{}', '[]', '[1]', JSON.stringify(['short']),
    JSON.stringify(['a'.repeat(40)]), JSON.stringify(['abcd'.repeat(12)]), JSON.stringify(['replace-with-your-session-secret-123456789'])]) {
    assert.throws(() => loadIdentityConfig({ ...env(), WEIWU_SESSION_SECRETS: value }), value);
  }
  assert.throws(() => loadIdentityConfig({ ...env(), WEIWU_BOOTSTRAP_ISSUER: 'https://id.example/tenant' }));
  assert.throws(() => loadIdentityConfig({ ...env(), WEIWU_OIDC_CLIENT_SECRET: 'changeme' }));
  for (const value of ['secret', 'password', 'a'.repeat(40), 'abcd'.repeat(12)]) {
    assert.throws(() => loadIdentityConfig({ ...env(), WEIWU_OIDC_CLIENT_SECRET: value }), value);
  }
});

test('principal cache keys use immutable identity and reject malformed principals', () => {
  const human = { kind: 'human' as const, userId: 'u1', sessionId: 's1', issuer: 'https://id.example', subject: 'sub', orgRole: 'member' as const, sessionEpoch: 0, authenticatedAt: '2026-10-20T00:00:00.000Z' };
  assert.equal(principalKey(human), 'human:u1');
  assert.equal(principalKey({ ...human, sessionId: 'other' }), 'human:u1');
  assert.equal(principalKey({ kind: 'local-owner' }), 'legacy-local');
  assert.equal(principalKey({ kind: 'device', deviceId: 'd1' }), 'device:d1');
  assert.equal(principalKey({ kind: 'system', service: 'scheduler' }), 'system:scheduler');
  for (const input of [null, {}, { kind: 'human', userId: 'u1' }, { ...human, orgRole: 'root' },
    { ...human, sessionEpoch: -1 }, { ...human, authenticatedAt: 'bad' }, { kind: 'device', deviceId: '' },
    { ...human, email: 'someone@example.com' }, { kind: 'local-owner', userId: 'u1' }]) {
    assert.throws(() => principalKey(input as never));
  }
  const hidden = { ...human };
  Object.defineProperty(hidden, 'accessToken', { value: 'sensitive', enumerable: false });
  assert.throws(() => principalKey(hidden));
  assert.throws(() => principalKey(Object.create({ kind: 'local-owner' })));
});
