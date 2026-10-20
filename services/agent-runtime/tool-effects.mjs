import { createHash } from 'node:crypto';
import { types } from 'node:util';

const MAX_DEPTH = 32;
const MAX_NODES = 10_000;
const MAX_BYTES = 256 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;

function strictJson(value) {
  const seen = new WeakSet();
  let nodes = 0;
  let bytes = 0;
  const count = text => {
    bytes += Buffer.byteLength(text, 'utf8');
    if (bytes > MAX_BYTES) throw new TypeError('effect JSON exceeds size limit');
  };
  function copy(item, depth) {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) throw new TypeError('effect JSON exceeds depth or node limit');
    if (item === null || typeof item === 'boolean') return item;
    if (typeof item === 'string') { count(item); return item; }
    if (typeof item === 'number') {
      if (!Number.isFinite(item) || Object.is(item, -0)) throw new TypeError('effect JSON contains an ambiguous number');
      return item;
    }
    if (typeof item !== 'object') throw new TypeError('effect JSON contains a non-JSON value');
    if (types.isProxy(item)) throw new TypeError('effect JSON contains a Proxy');
    if (seen.has(item)) throw new TypeError('effect JSON contains a cycle');
    seen.add(item);
    if (Array.isArray(item)) {
      if (Object.getPrototypeOf(item) !== Array.prototype || item.length > MAX_NODES ||
          Object.getOwnPropertyDescriptor(Array.prototype, 'toJSON') ||
          Object.getOwnPropertyDescriptor(Object.prototype, 'toJSON')) throw new TypeError('effect JSON contains an unsupported array');
      const names = Reflect.ownKeys(item);
      if (names.length > MAX_NODES + 1) throw new TypeError('effect JSON exceeds node limit');
      const out = [];
      for (let i = 0; i < item.length; i++) {
        const descriptor = Object.getOwnPropertyDescriptor(item, String(i));
        if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) throw new TypeError('effect JSON contains a sparse or accessor array');
        out[i] = copy(descriptor.value, depth + 1);
      }
      if (names.some(name => name !== 'length' && (!/^(0|[1-9]\d*)$/.test(String(name)) || Number(name) >= item.length)))
        throw new TypeError('effect JSON contains an extra array property');
      seen.delete(item);
      return Object.freeze(out);
    }
    const prototype = Object.getPrototypeOf(item);
    if ((prototype !== Object.prototype && prototype !== null) ||
        (prototype === Object.prototype && Object.getOwnPropertyDescriptor(Object.prototype, 'toJSON')))
      throw new TypeError('effect JSON contains a prototype or toJSON hook');
    const keys = Reflect.ownKeys(item);
    if (keys.length > MAX_NODES || keys.some(key => typeof key !== 'string')) throw new TypeError('effect JSON contains a symbol or too many keys');
    const out = Object.create(null);
    for (const key of keys.sort()) {
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) throw new TypeError('effect JSON contains an accessor or hidden value');
      count(key);
      out[key] = copy(descriptor.value, depth + 1);
    }
    seen.delete(item);
    return Object.freeze(out);
  }
  const copied = copy(value, 0);
  function serialize(item) {
    if (Array.isArray(item)) return `[${item.map(serialize).join(',')}]`;
    if (item !== null && typeof item === 'object')
      return `{${Object.keys(item).sort().map(key => `${JSON.stringify(key)}:${serialize(item[key])}`).join(',')}}`;
    return JSON.stringify(item);
  }
  const serialized = serialize(copied);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_BYTES) throw new TypeError('effect JSON exceeds size limit');
  return { copied, serialized };
}

/** SHA-256 of bounded strict JSON; object keys sorted, arrays and values preserved. */
export function effectDigest(value) {
  return createHash('sha256').update(strictJson(value).serialized).digest('hex');
}

function shape(value, required, optional = []) {
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new TypeError('effect contract field must be an object');
  const keys = Object.keys(value);
  if (required.some(key => !Object.hasOwn(value, key)) || keys.some(key => !required.includes(key) && !optional.includes(key)))
    throw new TypeError('effect contract has missing or unknown fields');
}

function label(value) {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value, 'utf8') > 2048)
    throw new TypeError('effect contract requires a bounded nonempty string');
}

function digest(value) {
  if (typeof value !== 'string' || !SHA256.test(value)) throw new TypeError('effect contract requires a SHA-256 digest');
}

function choice(value, values) {
  if (!values.includes(value)) throw new TypeError('effect contract enum is unsupported');
}

function uniqueLabels(values, nonempty = false) {
  if (!Array.isArray(values) || (nonempty && values.length === 0) || values.length > 1024)
    throw new TypeError('effect contract list is invalid');
  for (const value of values) label(value);
  if (new Set(values).size !== values.length) throw new TypeError('effect contract list contains duplicates');
}

/**
 * Validate format and semantic combinations only. This grants no execution rights:
 * Task 1b/3 must verify reviewed source binding, current authorization and adapters.
 */
export function validateEffectContract(value) {
  const contract = strictJson(value).copied;
  shape(contract, ['schema', 'capabilityId', 'namespace', 'toolName', 'source', 'definitionSha256',
    'effect', 'isolationProfile', 'permissions', 'retry', 'cost', 'reconciliation', 'compensation', 'evidenceRefs']);
  if (contract.schema !== 1) throw new TypeError('effect contract schema is unsupported');
  for (const name of ['capabilityId', 'namespace', 'toolName', 'isolationProfile']) label(contract[name]);
  shape(contract.source, ['kind', 'reference', 'version', 'digest']);
  choice(contract.source.kind, ['builtin', 'native', 'mcp']);
  for (const name of ['reference', 'version']) label(contract.source[name]);
  digest(contract.source.digest);
  digest(contract.definitionSha256);
  choice(contract.effect, ['read', 'workspace', 'external', 'unknown']);
  uniqueLabels(contract.permissions);
  uniqueLabels(contract.evidenceRefs, true);
  choice(contract.retry, ['bounded-read', 'provider-key', 'never']);
  if (contract.effect === 'unknown' && contract.retry !== 'never') throw new TypeError('unknown effect cannot be retried');
  if (contract.retry === 'bounded-read' && contract.effect !== 'read') throw new TypeError('bounded retry requires read effect');

  shape(contract.cost, ['kind'], ['adapterId']);
  choice(contract.cost.kind, ['free', 'metered', 'unknown']);
  if (contract.cost.kind === 'metered') label(contract.cost.adapterId);
  else if (Object.hasOwn(contract.cost, 'adapterId')) throw new TypeError('cost adapter is only valid for metered cost');

  shape(contract.reconciliation, ['kind'], ['resolverId', 'version']);
  choice(contract.reconciliation.kind, ['receipt', 'query', 'manual']);
  if (contract.reconciliation.kind === 'query') {
    label(contract.reconciliation.resolverId);
    label(contract.reconciliation.version);
  } else if (Object.hasOwn(contract.reconciliation, 'resolverId') || Object.hasOwn(contract.reconciliation, 'version'))
    throw new TypeError('resolver fields require query reconciliation');
  if (contract.retry === 'provider-key' && (contract.effect !== 'external' || contract.reconciliation.kind !== 'query'))
    throw new TypeError('provider-key requires external effect and versioned query reconciliation');

  shape(contract.compensation, ['kind', 'requiresApproval'], ['capabilityId', 'contractSha256']);
  choice(contract.compensation.kind, ['none', 'operation']);
  if (contract.compensation.requiresApproval !== true) throw new TypeError('compensation requires approval');
  if (contract.compensation.kind === 'operation') {
    label(contract.compensation.capabilityId);
    digest(contract.compensation.contractSha256);
  } else if (Object.hasOwn(contract.compensation, 'capabilityId') || Object.hasOwn(contract.compensation, 'contractSha256'))
    throw new TypeError('none compensation cannot bind an operation');
  return contract;
}
