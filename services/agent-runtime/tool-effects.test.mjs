import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { effectDigest, validateEffectContract } from './tool-effects.mjs';

const hash = text => createHash('sha256').update(text).digest('hex');
const sha = 'a'.repeat(64);
const base = () => ({
  schema: 1, capabilityId: 'tool.read', namespace: 'native', toolName: 'read',
  source: { kind: 'native', reference: 'bundle/read', version: '1.0.0', digest: sha },
  definitionSha256: 'b'.repeat(64), effect: 'read', isolationProfile: 'task-v1',
  permissions: ['file:read'], retry: 'bounded-read', cost: { kind: 'free' },
  reconciliation: { kind: 'receipt' },
  compensation: { kind: 'none', requiresApproval: true }, evidenceRefs: ['review:1'],
});

test('digest sorts object keys but preserves nested values and array order', () => {
  const left = { b: [1, { z: '原文', a: null }], a: true };
  const right = { a: true, b: [1, { a: null, z: '原文' }] };
  assert.equal(effectDigest(left), hash('{"a":true,"b":[1,{"a":null,"z":"原文"}]}'));
  assert.equal(effectDigest(left), effectDigest(right));
  assert.notEqual(effectDigest(left), effectDigest({ ...left, b: [{ z: '原文', a: null }, 1] }));
  assert.equal(effectDigest({ 2: 'two', 10: 'ten' }), hash('{"10":"ten","2":"two"}'));
});

test('contract digest binds permissions, source version, definition and evidence', () => {
  const contract = base();
  const baseline = effectDigest(validateEffectContract(contract));
  for (const changed of [
    { ...contract, permissions: ['file:write'] },
    { ...contract, source: { ...contract.source, version: '1.0.1' } },
    { ...contract, definitionSha256: 'c'.repeat(64) },
    { ...contract, evidenceRefs: ['review:2'] },
  ]) assert.notEqual(effectDigest(validateEffectContract(changed)), baseline);
});

test('generic digest binds account references, arguments and negative zero is rejected', () => {
  const intent = { accountRef: 'acct-a', arguments: { path: 'a' } };
  assert.notEqual(effectDigest(intent), effectDigest({ ...intent, accountRef: 'acct-b' }));
  assert.notEqual(effectDigest(intent), effectDigest({ ...intent, arguments: { path: 'b' } }));
  assert.throws(() => effectDigest(-0));
});

test('validator returns a detached deeply frozen contract and leaves input unchanged', () => {
  const input = base();
  const before = structuredClone(input);
  const result = validateEffectContract(input);
  const digest = effectDigest(result);
  assert.deepEqual(input, before);
  assert.notEqual(result, input);
  assert.notEqual(result.source, input.source);
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.source) && Object.isFrozen(result.permissions));
  assert.throws(() => { result.source.version = '2'; }, TypeError);
  assert.throws(() => { result.permissions.push('file:write'); }, TypeError);
  input.source.version = '3';
  assert.equal(effectDigest(result), digest);
});

test('validator rejects missing reviewed metadata and unknown fields', () => {
  for (const mutation of [
    v => { v.evidenceRefs = []; },
    v => { delete v.definitionSha256; },
    v => { v.source.digest = 'not-sha'; },
    v => { v.source.kind = 'plugin'; },
    v => { v.surprise = true; },
    v => { v.source.surprise = true; },
    v => { v.permissions = ['file:read', 'file:read']; },
    v => { v.evidenceRefs = ['review:1', 'review:1']; },
  ]) {
    const value = base(); mutation(value);
    assert.throws(() => validateEffectContract(value));
  }
});

test('validator enforces effect, retry, cost, reconciliation and compensation combinations', () => {
  const invalid = [
    { effect: 'unknown', retry: 'bounded-read' },
    { effect: 'workspace', retry: 'bounded-read' },
    { effect: 'read', retry: 'provider-key' },
    { effect: 'external', retry: 'provider-key', reconciliation: { kind: 'receipt' } },
    { cost: { kind: 'metered' } },
    { cost: { kind: 'free', adapterId: 'cost-adapter' } },
    { reconciliation: { kind: 'query', resolverId: 'resolver' } },
    { reconciliation: { kind: 'manual', resolverId: 'resolver' } },
    { compensation: { kind: 'none', requiresApproval: true, capabilityId: 'undo' } },
    { compensation: { kind: 'operation', requiresApproval: true, capabilityId: 'undo' } },
    { compensation: { kind: 'operation', requiresApproval: false, capabilityId: 'undo', contractSha256: sha } },
  ];
  for (const fields of invalid) assert.throws(() => validateEffectContract({ ...base(), ...fields }));
  assert.doesNotThrow(() => validateEffectContract({ ...base(), effect: 'unknown', retry: 'never', cost: { kind: 'unknown' } }));
  assert.doesNotThrow(() => validateEffectContract({ ...base(), effect: 'external', retry: 'provider-key',
    cost: { kind: 'metered', adapterId: 'billing-v1' }, reconciliation: { kind: 'query', resolverId: 'lookup', version: '1' },
    compensation: { kind: 'operation', capabilityId: 'undo', contractSha256: sha, requiresApproval: true } }));
});

test('strict JSON rejects accessors, hooks, prototypes, sparse arrays and non-JSON values', () => {
  const sparse = []; sparse[1] = 'x';
  const accessor = Object.defineProperty({}, 'x', { enumerable: true, get: () => 1 });
  const hook = { x: 1, toJSON() { return { x: 1 }; } };
  const cycle = {}; cycle.self = cycle;
  for (const value of [undefined, NaN, Infinity, -Infinity, 1n, () => 1, Symbol('x'),
    new Date(), new Number(1), sparse, accessor, hook, cycle, { x: undefined },
    { [Symbol('x')]: 1 }]) assert.throws(() => effectDigest(value));
  assert.throws(() => validateEffectContract({ ...base(), permissions: sparse }));
});

test('repeated references serialize by value while true cycles are rejected', () => {
  const shared = { v: 'same' };
  assert.equal(effectDigest({ a: shared, b: shared }), effectDigest({ a: { v: 'same' }, b: { v: 'same' } }));
});

test('rejects a toJSON accessor without executing it', () => {
  let calls = 0;
  const value = Object.defineProperty({ a: 1 }, 'toJSON', { enumerable: true, get() { calls++; return () => ({}); } });
  assert.throws(() => effectDigest(value));
  assert.equal(calls, 0);
});

test('rejects root and nested proxies before any reflection trap executes', () => {
  let calls = 0;
  const trap = {
    get() { calls++; throw Error('get trap executed'); },
    getPrototypeOf() { calls++; throw Error('prototype trap executed'); },
    ownKeys() { calls++; throw Error('keys trap executed'); },
    getOwnPropertyDescriptor() { calls++; throw Error('descriptor trap executed'); },
  };
  for (const run of [
    () => effectDigest(new Proxy({ a: 1 }, trap)),
    () => effectDigest({ nested: new Proxy([1], trap) }),
    () => validateEffectContract(new Proxy(base(), trap)),
    () => validateEffectContract({ ...base(), source: new Proxy(base().source, trap) }),
  ]) assert.throws(run, { name: 'TypeError', message: 'effect JSON contains a Proxy' });
  assert.equal(calls, 0);
});

test('revoked proxies are explicitly rejected by both APIs', () => {
  const first = Proxy.revocable({}, {});
  const second = Proxy.revocable(base().source, {});
  first.revoke(); second.revoke();
  assert.throws(() => effectDigest(first.proxy), { name: 'TypeError', message: 'effect JSON contains a Proxy' });
  assert.throws(() => validateEffectContract({ ...base(), source: second.proxy }),
    { name: 'TypeError', message: 'effect JSON contains a Proxy' });
});

test('digest rejects excessive depth and size before recursion can grow without bound', () => {
  let deep = null;
  for (let i = 0; i < 100; i++) deep = [deep];
  assert.throws(() => effectDigest(deep));
  assert.throws(() => effectDigest('x'.repeat(300_000)));
  assert.throws(() => effectDigest(Array.from({ length: 20_000 }, () => 1)));
});
