import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { dedupeReadOnlyEvidence, readOnlyEvidenceSignature } from './request-context.mjs';
import { fitAffordableMessages } from './limits.mjs';

const sha = text => createHash('sha256').update(text).digest('hex');
const file = (content = 'full local file\n', path = 'server.mjs') => ({ path, content, sha256: sha(content) });
const chunk = (version = 3, content = 'full cited chunk\n') => ({ id: 'chunk-fixed', documentId: 'document-fixed', version, sha256: sha('whole document'), lineStart: 1, lineEnd: 2, content, title: 'local fixture' });
const group = (id, value, name = 'filesystem', args = { path: 'server.mjs' }) => [
  { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] },
  { role: 'tool', tool_call_id: id, content: JSON.stringify(value) },
];
const proof = meta => ({ scopeId: 'a'.repeat(64), canonicalSha256: meta.canonicalSha256, successful: true, complete: true, readOnly: true });
const dedupe = (messages, protectedIndexes = []) => dedupeReadOnlyEvidence(messages, protectedIndexes, { attestGroup: proof });

test('identical complete reads retain the latest actual call IDs and remap every protected old index without editing original evidence', () => {
  const messages = [{ role: 'system', content: 'approved contract' }, ...group('old', file()), { role: 'user', content: 'current' }, ...group('new', file())];
  const before = JSON.stringify(messages), reduced = dedupe(messages, [1, 2, 3, 4, 5]);
  assert.equal(reduced.removedGroups, 1);
  assert.deepEqual(reduced.messages, [messages[0], messages[3], messages[4], messages[5]]);
  assert.deepEqual(reduced.indexMap, [0, 2, 3, 1, 2, 3]);
  assert.deepEqual(reduced.protectedIndexes, [2, 3, 1]);
  assert.ok(reduced.afterBytes < reduced.beforeBytes);
  assert.equal(JSON.stringify(messages), before);
  assert.equal(reduced.messages[2].tool_calls[0].id, 'new'); assert.equal(reduced.messages[3].tool_call_id, 'new');
});

test('missing, asynchronous, exceptional, invalid or incomplete host attestations preserve all original groups', () => {
  const messages = [...group('old', file()), ...group('new', file())];
  for (const attestGroup of [undefined, () => undefined, () => false, () => Promise.resolve(proof({ canonicalSha256: 'x' })),
    () => { throw Error('host not available'); }, meta => ({ ...proof(meta), canonicalSha256: 'b'.repeat(64) }),
    meta => ({ ...proof(meta), successful: false }), meta => ({ ...proof(meta), complete: false }), meta => ({ ...proof(meta), readOnly: false })]) {
    const result = dedupeReadOnlyEvidence(messages, [1, 3], { attestGroup });
    assert.equal(result.removedGroups, 0); assert.equal(result.messages, messages); assert.deepEqual(result.indexMap, [0, 1, 2, 3]);
  }
});

test('a different employee/task/attempt scope cannot collapse byte-identical file results', () => {
  const messages = [...group('old', file()), ...group('new', file())];
  const result = dedupeReadOnlyEvidence(messages, [1, 3], { attestGroup: meta => ({ ...proof(meta), scopeId: meta.calls[0].callId === 'old' ? 'a'.repeat(64) : 'b'.repeat(64) }) });
  assert.equal(result.removedGroups, 0); assert.equal(result.messages, messages);
});

test('different paths, complete versions, read arguments and assistant reasoning remain unique evidence', () => {
  for (const [first, last] of [
    [group('old', file('version one')), group('new', file('version two'))],
    [group('old', file()), group('new', file('full local file\n', 'README.md'), 'filesystem', { path: 'README.md' })],
    [group('old', file()), group('new', { ...file(), workspaceRevision: 'b'.repeat(64) })],
  ]) assert.equal(dedupe([...first, ...last], [1, 3]).removedGroups, 0);
  const first = group('old', file()), last = group('new', file());
  first[0].reasoning_content = 'an earlier unique finding'; last[0].reasoning_content = 'a later unique finding';
  assert.equal(dedupe([...first, ...last]).removedGroups, 0);
  first[0].reasoning_content = last[0].reasoning_content;
  assert.equal(dedupe([...first, ...last]).removedGroups, 1, 'even assistant reasoning must be exactly repeated');
});

test('complete local directory metadata qualifies but a different directory or invalid metadata remains distinct', () => {
  const value = { ...file(), localWorkspace: 'C:\\authorized\\run' };
  assert.ok(readOnlyEvidenceSignature('filesystem', { path: 'server.mjs' }, value));
  assert.equal(dedupe([...group('old', value), ...group('new', value)]).removedGroups, 1);
  assert.equal(dedupe([...group('old', value), ...group('new', { ...value, localWorkspace: 'C:\\different\\run' })]).removedGroups, 0);
  for (const localWorkspace of ['', 1, {}, 'x'.repeat(4097)])
    assert.equal(readOnlyEvidenceSignature('filesystem', { path: 'server.mjs' }, { ...file(), localWorkspace }), undefined);
  assert.equal(readOnlyEvidenceSignature('filesystem', { path: 'server.mjs' }, { ...value, unknownMetadata: true }), undefined);
});

test('mixed mutations, unmatched responses, missing results, duplicate call IDs and unknown fields never qualify', () => {
  const mixed = group('read', file());
  mixed[0].tool_calls.push({ id: 'write', type: 'function', function: { name: 'artifact_write', arguments: JSON.stringify({ path: 'server.mjs', content: 'x' }) } });
  mixed.push({ role: 'tool', tool_call_id: 'write', content: JSON.stringify({ path: 'server.mjs', sha256: sha('x') }) });
  const repeated = structuredClone(mixed); repeated[0].tool_calls[0].id = 'read2'; repeated[1].tool_call_id = 'read2'; repeated[0].tool_calls[1].id = 'write2'; repeated[2].tool_call_id = 'write2';
  assert.equal(dedupe([...mixed, ...repeated]).removedGroups, 0);
  for (const alter of [parts => parts.pop(), parts => { parts[1].tool_call_id = 'unmatched'; }, parts => { parts[0].extra = 'unrecognized'; },
    parts => { parts[0].tool_calls[0].function.arguments = JSON.stringify({ path: 'server.mjs', offset: 1 }); }]) {
    const first = group('old', file()), last = group('new', file()); alter(first); alter(last);
    assert.equal(dedupe([...first, ...last]).removedGroups, 0);
  }
  assert.equal(dedupe([...group('same', file()), ...group('same', file())]).removedGroups, 0);
});

test('invalid hash, partial JSON, explicit error and pruned text remain protected even with a positive callback', () => {
  for (const value of [{ ...file(), content: 'fragment' }, { ...file(), truncated: true }, { ...file(), incomplete: true },
    { ...file(), error: 'read failed' }, { ...file(), partial: true }, { ...file(), nextCursor: 'more' },
    { ...file(), content: 'text omitted; this text is incomplete', sha256: sha('text omitted; this text is incomplete') }]) {
    assert.equal(readOnlyEvidenceSignature('filesystem', { path: 'server.mjs' }, value), undefined);
    assert.equal(dedupe([...group('old', value), ...group('new', value)], [1, 3]).removedGroups, 0);
  }
  const broken = [...group('old', file()), ...group('new', file())]; broken[1].content = broken[3].content = '{"path":"server.mjs"';
  assert.equal(dedupe(broken).removedGroups, 0);
});

test('knowledge deduplication preserves full chunk/version/citation metadata and distinguishes queries, versions and partial content', () => {
  for (const [name, args, value] of [['knowledge_read', { chunkId: 'chunk-fixed' }, chunk()], ['knowledge_search', { query: 'verify' }, [chunk()]]]) {
    const original = [...group('old', value, name, args), ...group('new', value, name, args)], result = dedupe(original, [1, 3]);
    assert.equal(result.removedGroups, 1); assert.deepEqual(JSON.parse(result.messages[1].content), value);
  }
  assert.equal(dedupe([...group('old', [chunk()], 'knowledge_search', { query: 'query-one' }), ...group('new', [chunk()], 'knowledge_search', { query: 'query-two' })]).removedGroups, 0);
  assert.equal(dedupe([...group('old', chunk(3), 'knowledge_read', { chunkId: 'chunk-fixed' }), ...group('new', chunk(4), 'knowledge_read', { chunkId: 'chunk-fixed' })]).removedGroups, 0);
  for (const value of [{ ...chunk(), version: undefined }, { ...chunk(), sha256: undefined }, { ...chunk(), nextOffset: 9 },
    { ...chunk(), content: 'head text omitted; this text is incomplete tail' }])
    assert.equal(dedupe([...group('old', value, 'knowledge_read', { chunkId: 'chunk-fixed' }), ...group('new', value, 'knowledge_read', { chunkId: 'chunk-fixed' })]).removedGroups, 0);
});

test('the source result signature prevents unmarked projection changes from becoming proof of a complete knowledge chunk', () => {
  const complete = chunk(), expected = readOnlyEvidenceSignature('knowledge_read', { chunkId: 'chunk-fixed' }, complete);
  const projection = { ...complete, content: complete.content.slice(0, 4) };
  const messages = [...group('old', projection, 'knowledge_read', { chunkId: 'chunk-fixed' }), ...group('new', projection, 'knowledge_read', { chunkId: 'chunk-fixed' })];
  const reduced = dedupeReadOnlyEvidence(messages, [1, 3], { attestGroup: meta => meta.calls.every(call => call.resultSha256 === expected.resultSha256) ? proof(meta) : undefined });
  assert.equal(reduced.removedGroups, 0); assert.equal(reduced.messages, messages);
});

test('three complete duplicates map to the newest group and financial fitting still protects the only full file and current contract', () => {
  const messages = [{ role: 'system', content: 'approved rule' }, ...group('first', file('full file\n'.repeat(300))),
    ...group('second', file('full file\n'.repeat(300))), ...group('last', file('full file\n'.repeat(300))), { role: 'user', content: 'current full contract' }];
  const result = dedupe(messages, [2, 4, 6, 7]);
  assert.equal(result.removedGroups, 2);
  assert.deepEqual(result.indexMap.slice(1, 7), [1, 2, 1, 2, 1, 2]);
  const settings = { maxBytes: 192000, inputRate: 1, outputRate: 2, maxTokens: 500, availableBudget: .0065 };
  assert.throws(() => fitAffordableMessages(messages, undefined, settings, [2, 4, 6, 7]), error => error.code === 'BUDGET_CONTEXT_LIMIT');
  const fitted = fitAffordableMessages(result.messages, undefined, settings, result.protectedIndexes);
  assert.ok(fitted.reservation <= .0065); assert.ok(fitted.messages.some(message => message.role === 'tool' && message.content.includes('full file')));
  assert.ok(fitted.messages.some(message => message.content === 'current full contract'));
  assert.throws(() => fitAffordableMessages(result.messages, undefined, { ...settings, availableBudget: .001 }, result.protectedIndexes), error => error.code === 'BUDGET_CONTEXT_LIMIT');
});

test('exact read pairs deduplicate across different batches without losing assistant explanations or other paired reads', () => {
  const old=group('old',file()),other=group('other',file('another file','README.md'),'filesystem',{path:'README.md'}),latest=group('new',file());
  old[0].content='earlier unique explanation';old[0].tool_calls.push(other[0].tool_calls[0]);
  latest[0].content='later unique explanation';
  const messages=[old[0],old[1],other[1],latest[0],latest[1]],before=JSON.stringify(messages);
  const reduced=dedupeReadOnlyEvidence(messages,[1,2,4],{attestGroup:proof,pairwise:true});
  assert.equal(reduced.removedGroups,1);assert.equal(reduced.messages.length,4);
  assert.equal(reduced.messages[0].content,old[0].content);assert.equal(reduced.messages[2].content,latest[0].content);
  assert.deepEqual(reduced.messages[0].tool_calls.map(call=>call.id),['other']);
  assert.deepEqual(reduced.messages.filter(message=>message.role==='tool').map(message=>message.tool_call_id),['other','new']);
  assert.equal(JSON.stringify(messages),before);
  const noProof=dedupeReadOnlyEvidence(messages,[1,2,4],{pairwise:true});assert.equal(noProof.messages,messages);
});
