import { types } from 'node:util';
import { effectDigest, validateEffectContract } from './tool-effects.mjs';

const callbacks = ['execute', 'finalizeContent', 'presentCall', 'presentResult', 'isConcurrencySafe'];
const invalid = () => new TypeError('TOOL_DEFINITION_INVALID: 工具定义不能固定核对');

function fields(value) {
  if (!value || typeof value !== 'object' || types.isProxy(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw invalid();
  return Object.getOwnPropertyDescriptors(value);
}

function field(descriptors, name, optional = false) {
  const descriptor = descriptors[name];
  if (!descriptor && optional) return undefined;
  if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw invalid();
  return descriptor.value;
}

function inspect(definition, registrationBinding) {
  const own = fields(definition), output = fields(field(own, 'output'));
  const name = field(own, 'name'), description = field(own, 'description');
  const timeoutMs = field(own, 'timeoutMs', true);
  if (typeof name !== 'string' || !name || typeof description !== 'string' ||
      timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) throw invalid();
  const functions = callbacks.map(key => field(own, key, key !== 'execute'));
  functions.push(field(output, 'render'), field(output, 'presentationMeta', true));
  if (typeof functions[0] !== 'function' || typeof functions[callbacks.length] !== 'function' ||
      functions.some(value => value !== undefined && typeof value !== 'function')) throw invalid();
  const definitionSha256 = effectDigest({ version: 1, registrationBinding, name, description,
    parameters: field(own, 'parameters'), output: field(output, 'schema'), timeoutMs: timeoutMs ?? null });
  return { name, description, definitionSha256, functions };
}

/** Registry integrity only. This is neither source review nor permission to execute/retry. */
export function captureToolDefinition(definition, registrationBinding) {
  let pinned;
  try {
    if (typeof registrationBinding !== 'string' || !registrationBinding.trim() ||
        Buffer.byteLength(registrationBinding, 'utf8') > 2048) throw invalid();
    pinned = inspect(definition, registrationBinding);
  } catch { throw invalid(); }
  let valid = true;
  return Object.freeze({ name: pinned.name, description: pinned.description,
    definitionSha256: pinned.definitionSha256,
    // Never infer review/read-only status from annotations, a name, or a digest.
    effectContract: Object.freeze({ status: 'unreviewed', effect: 'unknown', definitionSha256: pinned.definitionSha256 }),
    matches(actual) {
      if (!valid) return false;
      try {
        const current = actual === definition && inspect(actual, registrationBinding);
        valid = Boolean(current && current.definitionSha256 === pinned.definitionSha256 &&
          current.functions.every((fn, index) => fn === pinned.functions[index]));
      } catch { valid = false; }
      return valid;
    },
  });
}

/** Trusted approved snapshot only; the database authority still rechecks each call. */
export function indexEffectContracts(snapshot) {
  if (snapshot === undefined) return undefined;
  if (snapshot?.effectContractVersion !== 1 || !Array.isArray(snapshot.effectContracts) || snapshot.effectContracts.length > 256)
    throw Error('TOOL_EFFECT_SNAPSHOT_INVALID');
  const contracts = new Map(), capabilities = new Set();
  for (const input of snapshot.effectContracts) {
    const contract = validateEffectContract(input);
    if (contracts.has(contract.toolName) || capabilities.has(contract.capabilityId)) throw Error('TOOL_EFFECT_DUPLICATE');
    if (contract.effect === 'unknown' || contract.cost.kind !== 'free' || contract.retry === 'provider-key') throw Error('TOOL_EFFECT_UNSUPPORTED');
    contracts.set(contract.toolName, contract); capabilities.add(contract.capabilityId);
  }
  return contracts;
}

export function boundEffectSummary(binding, contract) {
  if (!contract || contract.toolName !== binding.name || contract.definitionSha256 !== binding.definitionSha256) return undefined;
  return Object.freeze({ status: 'reviewed', effect: contract.effect, definitionSha256: contract.definitionSha256,
    contractSha256: effectDigest(contract), namespace: contract.namespace, sourceVersion: contract.source.version });
}
