import { createHash } from 'node:crypto';
import { isArtifactPath } from '../../packages/contracts/task-contracts.mjs';

const hash = text => createHash('sha256').update(text).digest('hex');
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const only = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key));
const parameter = { filesystem: 'path', knowledge_search: 'query', knowledge_read: 'chunkId' };

function incomplete(value) {
  if (typeof value === 'string') return value.includes('text omitted; this text is incomplete');
  if (Array.isArray(value)) return value.some(incomplete);
  if (!object(value)) return false;
  if (value.complete === false || value.incomplete === true || value.truncated === true || value.partial === true || value.omitted === true ||
      value.hasMore === true || value.nextCursor != null || value.nextOffset != null || value.isError === true || value.error != null) return true;
  return Object.values(value).some(incomplete);
}

function chunk(value) {
  return object(value) && typeof value.id === 'string' && value.id.length > 0 && typeof value.documentId === 'string' && value.documentId.length > 0 &&
    Number.isSafeInteger(value.version) && value.version > 0 && hex(value.sha256) && typeof value.content === 'string' && value.content.length > 0 &&
    Number.isSafeInteger(value.lineStart) && value.lineStart > 0 && Number.isSafeInteger(value.lineEnd) && value.lineEnd >= value.lineStart;
}

/** A source-side signature of a successful, complete product read. No content is retained. */
export function readOnlyEvidenceSignature(name, args, value) {
  const key = parameter[name];
  if (!key || !only(args, [key]) || Object.keys(args).length !== 1 || typeof args[key] !== 'string' || !args[key] || incomplete(value)) return undefined;
  if (name === 'filesystem') {
    if (!isArtifactPath(args.path) || !only(value, ['path', 'content', 'sha256', 'artifacts', 'workspaceRevision', 'localWorkspace']) || value.path !== args.path ||
        typeof value.content !== 'string' || !hex(value.sha256) || hash(value.content) !== value.sha256) return undefined;
    if (value.workspaceRevision !== undefined && !hex(value.workspaceRevision)) return undefined;
    // LocalRunExecutor exposes the authorized directory alongside the mirrored
    // file. It participates in the complete result hash; changing directories
    // never makes two results equivalent.
    if (value.localWorkspace !== undefined && (typeof value.localWorkspace !== 'string' || !value.localWorkspace || value.localWorkspace.length > 4096)) return undefined;
    if (value.artifacts !== undefined && (!Array.isArray(value.artifacts) || value.artifacts.some(file => !only(file, ['path', 'sha256', 'size']) ||
      !isArtifactPath(file.path) || !hex(file.sha256) || !Number.isSafeInteger(file.size) || file.size < 0))) return undefined;
  } else if (name === 'knowledge_read') {
    if (!chunk(value) || value.id !== args.chunkId) return undefined;
  } else if (!Array.isArray(value) || !value.length || !value.every(chunk)) return undefined;
  try { return { name, argumentsSha256: hash(JSON.stringify({ [key]: args[key] })), resultSha256: hash(JSON.stringify(value)) }; }
  catch { return undefined; }
}

function describeGroup(messages, indexes) {
  const first = messages[indexes[0]];
  if (!only(first, ['role', 'content', 'reasoning_content', 'tool_calls']) || first.role !== 'assistant' ||
      !Array.isArray(first.tool_calls) || !first.tool_calls.length || first.tool_calls.length + 1 !== indexes.length) return undefined;
  const ids = first.tool_calls.map(call => call?.id);
  if (ids.some(id => typeof id !== 'string' || !id) || new Set(ids).size !== ids.length) return undefined;
  const calls = [], canonical = [{ ...first, tool_calls: [] }];
  for (let at = 0; at < first.tool_calls.length; at++) {
    const call = first.tool_calls[at], result = messages[indexes[at + 1]];
    if (!only(call, ['id', 'type', 'function']) || call.type !== 'function' || !only(call.function, ['name', 'arguments']) || typeof call.function.arguments !== 'string' ||
        !only(result, ['role', 'tool_call_id', 'content']) || result.role !== 'tool' || result.tool_call_id !== call.id || typeof result.content !== 'string') return undefined;
    let signature;
    try { signature = readOnlyEvidenceSignature(call.function.name, JSON.parse(call.function.arguments), JSON.parse(result.content)); }
    catch { return undefined; }
    if (!signature) return undefined;
    calls.push(Object.freeze({ callId: call.id, ...signature }));
    canonical[0].tool_calls.push({ ...call, id: `read-${at}` });
    canonical.push({ ...result, tool_call_id: `read-${at}` });
  }
  return { calls: Object.freeze(calls), canonicalSha256: hash(JSON.stringify(canonical)) };
}

/** Remove only fully identical, source-attested read groups; map every old index to retained evidence. */
export function dedupeReadOnlyEvidence(messages, protectedIndexes = [], { attestGroup, pairwise = false } = {}) {
  if (!Array.isArray(messages) || !Array.isArray(protectedIndexes) || protectedIndexes.some(index => !Number.isSafeInteger(index) || index < 0 || index >= messages.length))
    throw new TypeError('只读证据去重的消息或保护索引无效');
  const beforeBytes = Buffer.byteLength(JSON.stringify(messages)), groups = [];
  const idCounts = new Map();
  for (const [index, message] of messages.entries()) {
    if (message.role === 'tool' && groups.length) groups.at(-1).push(index); else groups.push([index]);
    if (message.role === 'assistant' && Array.isArray(message.tool_calls)) for (const call of message.tool_calls)
      idCounts.set(call?.id, (idCounts.get(call?.id) ?? 0) + 1);
  }
  const equivalent = new Map(), replace = new Map(), duplicates = [], attested = [];
  if (typeof attestGroup === 'function') for (let at = groups.length - 1; at >= 0; at--) {
    const indexes = groups[at], description = describeGroup(messages, indexes);
    if (!description || description.calls.some(call => idCounts.get(call.callId) !== 1)) continue;
    let proof;
    try { proof = attestGroup(Object.freeze({ ...description, indexes: Object.freeze([...indexes]) })); } catch { continue; }
    if (!object(proof) || typeof proof.then === 'function' || proof.successful !== true || proof.readOnly !== true || proof.complete !== true ||
        proof.canonicalSha256 !== description.canonicalSha256 || !hex(proof.scopeId)) continue;
    attested.push({ indexes, description, proof });
    const key = proof.scopeId + ':' + description.canonicalSha256, latest = equivalent.get(key);
    if (!latest) { equivalent.set(key, indexes); continue; }
    for (let offset = 0; offset < indexes.length; offset++) replace.set(indexes[offset], latest[offset]);
    duplicates.push(Object.freeze({ from: Object.freeze([...indexes]), to: Object.freeze([...latest]), scopeId: proof.scopeId, canonicalSha256: description.canonicalSha256 }));
  }
  const edited = new Map(), preserveText = new Set();
  if (pairwise) {
    const latestPairs = new Map();
    // A batch may contain several successful complete reads. Deduplicate their
    // exact pairs independently while retaining every assistant explanation and
    // all other calls/results. The original transcript is never modified.
    for (const { indexes, description, proof } of attested) {
      if (replace.has(indexes[0])) continue;
      const removedIds = new Set();
      for (const [at, call] of description.calls.entries()) {
        const resultIndex = indexes[at + 1], key = `${proof.scopeId}:${call.name}:${call.argumentsSha256}:${call.resultSha256}`;
        const latest = latestPairs.get(key);
        if (!latest) { latestPairs.set(key, { assistantIndex: indexes[0], resultIndex }); continue; }
        replace.set(resultIndex, latest.resultIndex); removedIds.add(call.callId);
        duplicates.push(Object.freeze({ kind: 'exact-read-pair', from: Object.freeze([indexes[0], resultIndex]),
          to: Object.freeze([latest.assistantIndex, latest.resultIndex]), scopeId: proof.scopeId, canonicalSha256: description.canonicalSha256 }));
      }
      if (!removedIds.size) continue;
      const assistant = messages[indexes[0]], calls = assistant.tool_calls.filter(call => !removedIds.has(call.id));
      if (!calls.length && !assistant.content && !assistant.reasoning_content) replace.set(indexes[0], duplicates.at(-1).to[0]);
      else {
        const { tool_calls, ...text } = assistant;
        edited.set(indexes[0], calls.length ? { ...assistant, tool_calls: calls } : text);
        if (assistant.content || assistant.reasoning_content) preserveText.add(indexes[0]);
      }
    }
  }
  const retained = [], keptIndexes = new Map();
  for (const [index, message] of messages.entries()) if (!replace.has(index)) { keptIndexes.set(index, retained.length); retained.push(edited.get(index) ?? message); }
  const indexMap = messages.map((_message, index) => keptIndexes.get(replace.get(index) ?? index));
  return { messages: replace.size ? retained : messages, indexMap, protectedIndexes: [...new Set([...protectedIndexes, ...preserveText].map(index => indexMap[index]))],
    removedGroups: duplicates.length, duplicates, beforeBytes, afterBytes: Buffer.byteLength(JSON.stringify(replace.size ? retained : messages)) };
}

/** Source-side proof for a known CAS write, not a promise of a model's success. */
export function completedWriteEvidenceSignature(args, value) {
  if (!only(args, ['path', 'content', 'expectedSha256']) || !isArtifactPath(args.path) || typeof args.content !== 'string' || !hex(args.expectedSha256) ||
      !object(value) || incomplete(value) || value.path !== args.path || !hex(value.sha256) || hash(args.content) !== value.sha256) return undefined;
  if (!only(value, ['path', 'bytes', 'sha256', 'artifacts', 'workspaceRevision', 'localWorkspace']) || !Number.isSafeInteger(value.bytes) ||
      value.bytes !== Buffer.byteLength(args.content)) return undefined;
  return { name: 'artifact_write', path: args.path, expectedSha256: args.expectedSha256, sha256: value.sha256,
    argumentsSha256: hash(JSON.stringify(args)), resultSha256: hash(JSON.stringify(value)) };
}
