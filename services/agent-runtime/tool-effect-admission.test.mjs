import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import { createTeamHost } from './host.mjs';
import { EmployeeHostFactory } from './employee-hosts.mjs';
import { captureToolDefinition, indexEffectContracts } from './tool-definition-effects.mjs';

const req = createRequire(import.meta.url), base = createRequire(req.resolve('@deepseek-ai/dsh-base/package.json'));
const snapshot = effectContracts => ({ effectContractVersion: 1, effectContracts });
const contract = definitionSha256 => ({ schema: 1, capabilityId: 'fixture.read', namespace: 'fixture', toolName: 'fixture_read',
  source: { kind: 'builtin', reference: 'fixed-release', version: '1', digest: 'a'.repeat(64) }, definitionSha256,
  effect: 'read', permissions: ['fixture:read'], isolationProfile: 'runtime-read-v1', retry: 'never', cost: { kind: 'free' },
  reconciliation: { kind: 'receipt' }, compensation: { kind: 'none', requiresApproval: true }, evidenceRefs: ['fixture:review'] });

test('contract mode rejects unknown, malformed and duplicate snapshots without guessing legacy', () => {
  const known = contract('b'.repeat(64));
  assert.equal(indexEffectContracts(undefined), undefined);
  for (const value of [{}, { effectContractVersion: 2, effectContracts: [] }, snapshot([known, known]), snapshot([{ ...known, effect: 'unknown' }])])
    assert.throws(() => indexEffectContracts(value), /TOOL_EFFECT/);
});

test('unreviewed or mismatched tools are hidden and denied even when the employee grant names them', async () => {
  const root = await mkdtemp(join(tmpdir(), 'contract-admission-'));
  const host = await createTeamHost({ adapter: new class extends LlmAdapter { async *stream() { throw Error('NO_MODEL_CALL'); } }(), provider: 'fixture', sessionRoot: join(root, 'sessions') });
  let calls = 0, factory;
  const definition = defineTool({ name: 'fixture_read', description: 'fixture', parameters: {}, output: { schema: { type: 'json' }, render: () => [] }, execute: async () => { calls++; return true; } });
  host.ctx.tools.register(definition);
  const options = { coordinator: host.ctx, provider: 'fixture', sessionRoot: join(root, 'sessions'), identify: () => ({ id: 'reader', tools: ['fixture_read'] }), loadPlugin: name => import(pathToFileURL(base.resolve(name)).href) };
  try {
    assert.throws(() => new EmployeeHostFactory({ ...options, effectSnapshot: snapshot([]) }), /TOOL_EFFECT_AUTHORITY_REQUIRED/);
    for (const contracts of [[], [contract('0'.repeat(64))]]) {
      factory = new EmployeeHostFactory({ ...options, effectSnapshot: snapshot(contracts), effectAuthority: { async assertSnapshot() {}, async withAdmission() { throw Error('UNEXPECTED_ADMISSION'); } } });
      const handle = await factory.createAgent(host.ctx, { sessionId: randomUUID(), agentOptions: { provider: 'fixture', model: 'reader' } });
      const ctx = factory.list()[0].ctx;
      assert.deepEqual(ctx.tools.schemas(handle.agent), []);
      const result = await ctx.tools.execute({ name: 'fixture_read', arguments: {}, agent: handle.agent, callId: randomUUID(), signal: AbortSignal.timeout(1000) });
      assert.equal(result.isError, true); assert.equal(calls, 0);
      await factory.close(); factory = undefined;
    }
    assert.match(captureToolDefinition(definition, 'weiwu-coordinator-registry-v1').definitionSha256, /^[a-f0-9]{64}$/);
  } finally { await factory?.close(); await host.close(); await rm(root, { recursive: true, force: true }); }
});
