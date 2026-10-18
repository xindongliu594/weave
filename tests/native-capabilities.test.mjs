import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { validateNativeManifest, nativeManifestId, nativeToolBinding, nativeFileAccess, assertNativeTaskAccess } from '../services/agent-runtime/native-capabilities.mjs';
const hash = text => createHash('sha256').update(text).digest('hex');
export const fixture = () => ({ format: 'dsh-native-tools-v1', namespace: 'office', package: '@company/office', version: '1.0.0', source: { kind: 'company', reference: 'private local package' },
  dshVersion: '0.1.5-rc.1', config: {}, lockSha256: hash('lock'), bundle: { sha256: hash('gzip'), codeSha256: hash('code'), metadataSha256: hash('metadata'), bytes: 10 },
  tools: [{ name: 'plugin__office__read', originalName: 'read', description: 'Read', parameters: { type: 'object', properties: { file: { type: 'string' } }, required: ['file'] }, files: { read: ['file'], write: [] } },
    { name: 'plugin__office__edit', originalName: 'edit', description: 'Edit', parameters: { type: 'object', properties: { file: { type: 'string' }, output: { type: 'string' } }, required: ['file'] }, files: { read: ['file'], write: [{ field: 'output', fallback: 'file' }] } }] });
test('native catalog binds package, config, tool schemas and file permissions in content identity', () => {
  const manifest = fixture(); assert.deepEqual(validateNativeManifest(manifest), manifest);
  const id = nativeManifestId(manifest); assert.match(id, /^[a-f0-9]{64}$/);
  assert.notEqual(nativeManifestId({ ...manifest, version: '2.0.0' }), id);
  assert.throws(() => validateNativeManifest({ ...manifest, tools: [...manifest.tools, manifest.tools[0]] }), /NATIVE_MANIFEST/);
  assert.throws(() => validateNativeManifest({ ...manifest, tools: [{ ...manifest.tools[0], name: 'agent_teams_status' }] }), /NATIVE_MANIFEST/);
  assert.throws(() => validateNativeManifest({ ...manifest, dshVersion: 'latest' }), /NATIVE_MANIFEST/);
});
test('approval checks registered file effects, not merely native tool name syntax',()=>{
 const manifest=fixture(),nativeCapabilities=[{id:nativeManifestId(manifest),manifest}];
 const task={id:'report',assigneeId:'worker',inputs:[],outputs:[{path:'report.docx'}]};
 assert.throws(()=>assertNativeTaskAccess({agents:[{id:'worker',tools:['plugin__office__read']}],tasks:[task],nativeCapabilities}),/NATIVE_TASK_ACCESS/);
 assert.doesNotThrow(()=>assertNativeTaskAccess({agents:[{id:'worker',tools:['plugin__office__edit']}],tasks:[task],nativeCapabilities}));
 assert.throws(()=>assertNativeTaskAccess({agents:[{id:'worker',tools:['plugin__office__edit']}],tasks:[{...task,outputs:[{path:'report*'}]}],nativeCapabilities}),/NATIVE_PATH/);
});
test('native binding denies absent grants, mismatched identity and duplicate tool names', () => {
  const manifest = fixture(), binding = { id: nativeManifestId(manifest), manifest }, snapshot = { nativeCapabilities: [binding] };
  assert.equal(nativeToolBinding(snapshot, 'plugin__office__read').manifest.version, '1.0.0');
  assert.throws(() => nativeToolBinding({}, 'plugin__office__read'), /NATIVE_TOOL_UNAVAILABLE/);
  assert.throws(() => nativeToolBinding({ nativeCapabilities: [{ ...binding, id: 'a'.repeat(64) }] }, 'plugin__office__read'), /NATIVE_VERSION/);
  assert.throws(() => nativeToolBinding({ nativeCapabilities: [binding, binding] }, 'plugin__office__read'), /NATIVE_TOOL_CONFLICT/);
});
test('native file declaration resolves fallback outputs and rejects escapes before execution', () => {
  const tool = fixture().tools[1];
  assert.deepEqual(nativeFileAccess(tool, { file: 'a.xlsx' }), { read: ['a.xlsx'], write: ['a.xlsx'] });
  assert.deepEqual(nativeFileAccess(tool, { file: 'a.xlsx', output: 'b.xlsx' }), { read: ['a.xlsx'], write: ['b.xlsx'] });
  for (const file of ['../secret', '/etc/passwd', 'C:/secret', 'a\\b', 'https://remote/file', '']) assert.throws(() => nativeFileAccess(tool, { file }), /NATIVE_PATH/);
});
