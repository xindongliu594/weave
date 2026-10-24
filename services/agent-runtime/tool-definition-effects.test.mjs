import test from 'node:test';
import assert from 'node:assert/strict';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { captureToolDefinition } from './tool-definition-effects.mjs';

const tool = () => defineTool({ name: 'office_read', description: 'Read approved record',
  parameters: { id: { type: 'string' } }, output: { schema: { type: 'json' }, render: (_, value) => [{ type: 'text', text: JSON.stringify(value) }] },
  async execute() { return 'ok'; } });
const capture = async (...args) => captureToolDefinition(...args);

test('definition digest is stable, binds schemas and registration, and makes no effect approval claim', async () => {
  const source = tool(), pinned = await capture(source, 'coordinator-v1');
  assert.match(pinned.definitionSha256, /^[a-f0-9]{64}$/);
  assert.equal(pinned.definitionSha256, (await capture(tool(), 'coordinator-v1')).definitionSha256);
  assert.notEqual(pinned.definitionSha256, (await capture(tool(), 'employee-forward-v1')).definitionSha256);
  assert.deepEqual(pinned.effectContract, { status: 'unreviewed', effect: 'unknown', definitionSha256: pinned.definitionSha256 });
  assert.equal(pinned.matches(source), true);
  assert.equal(Object.isFrozen(pinned.effectContract), true);
  source.annotations = { readOnlyHint: true, idempotentHint: true };
  assert.equal((await capture(source, 'coordinator-v1')).effectContract.effect, 'unknown');
});

for (const [label, mutate] of [
  ['parameters', definition => { definition.parameters.properties.id.type = 'number'; }],
  ['output', definition => { definition.output.schema = { type: 'string' }; }],
  ['description', definition => { definition.description = 'different tool'; }],
  ['timeout', definition => { definition.timeoutMs = 50; }],
  ['execute', definition => { definition.execute = async () => 'replacement'; }],
  ['render', definition => { definition.output.render = () => []; }],
  ['concurrency', definition => { definition.isConcurrencySafe = () => true; }],
]) test(`same-object ${label} drift is denied and the observed mismatch remains latched`, async () => {
  const source = tool(), original = Object.getOwnPropertyDescriptors(source), pinned = await capture(source, 'coordinator-v1');
  original.parameters.value = structuredClone(source.parameters);
  original.output.value = { ...source.output, schema: structuredClone(source.output.schema) };
  mutate(source);
  assert.equal(pinned.matches(source), false);
  for (const key of Reflect.ownKeys(source)) if (!Object.hasOwn(original, key)) delete source[key];
  Object.defineProperties(source, original);
  assert.equal((await capture(source, 'coordinator-v1')).definitionSha256, pinned.definitionSha256, 'restore original schema before checking the latch');
  assert.equal(pinned.matches(source), false);
});

test('replacement identity is denied even when it has identical serialized schemas', async () => {
  const source = tool(), pinned = await capture(source, 'coordinator-v1');
  assert.equal(pinned.matches({ ...source }), false);
});

test('invalid and accessor schema input is rejected without evaluating getter or toJSON', async () => {
  let touched = 0;
  const accessor = tool(); Object.defineProperty(accessor, 'parameters', { get() { touched++; return {}; } });
  await assert.rejects(capture(accessor, 'coordinator-v1'), /TOOL_DEFINITION_INVALID/);
  const hooked = tool(); hooked.parameters.toJSON = () => { touched++; return {}; };
  await assert.rejects(capture(hooked, 'coordinator-v1'), /TOOL_DEFINITION_INVALID/);
  const huge = tool(); huge.description = 'a'.repeat(300_000);
  await assert.rejects(capture(huge, 'coordinator-v1'), /TOOL_DEFINITION_INVALID/);
  assert.equal(touched, 0);
});
