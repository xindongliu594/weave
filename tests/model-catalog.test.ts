import test from 'node:test';
import assert from 'node:assert/strict';
import { parseModelCatalog, applyNewApiPrices, catalogResult } from '../apps/api/src/model-catalog.ts';
import { gatewaySchema } from '../packages/contracts/index.ts';
import { applyOfficialPrices, officialPricingVerifiedAt } from '../apps/api/src/official-model-prices.ts';

const source = 'https://gateway.example/v1/models', pricingSource = 'https://gateway.example/api/pricing';
const parse = (pricing: unknown) => parseModelCatalog({ data: [{ id: 'a', pricing }] }, source)![0].pricing;

test('catalog converts actual per-token prices, retains explicit free quotes and validates metadata', () => {
  const catalog = parseModelCatalog({ data: [
    { id: 'z', name: '模型 Z', context_length: 128000, pricing: { prompt: '0.0000014', completion: '0.0000056', request: '0' } },
    { id: 'free', pricing: { prompt: '0', completion: 0 } },
    { id: 'z', name: '重复行', context_length: 128000, pricing: { prompt: '0.0000014', completion: '0.0000056', request: '0' } },
    { id: 'unknown', context_length: 'unlimited' },
  ] }, source)!;
  assert.deepEqual(catalog.map(model => model.id), ['free', 'unknown', 'z']);
  assert.deepEqual(catalog[2], { id: 'z', name: '模型 Z', contextWindowTokens: 128000, pricing: { status: 'available', source, inputRate: 1.4, outputRate: 5.6 } });
  assert.deepEqual(catalog[0].pricing, { status: 'available', source, inputRate: 0, outputRate: 0 });
  assert.equal(catalog[1].contextWindowTokens, undefined);
  const result = catalogResult(catalog, 3, source);
  assert.equal(result.gatewayVersion, 3); assert.deepEqual(result.models, ['free', 'unknown', 'z']);
  assert.ok(Number.isFinite(Date.parse(result.fetchedAt)));
});

test('missing, blank, negative, nonfinite, partial and ambiguous quotes never become zero', () => {
  for (const pricing of [undefined, null, {}, { prompt: 0 }, { prompt: '', completion: '' }, { prompt: false, completion: null }, { prompt: -1, completion: 0 }, { prompt: 'NaN', completion: 1 }, { prompt: Infinity, completion: 0 }, { prompt: '  ', completion: '0' }]) {
    const result = parse(pricing);
    assert.equal(result.status, 'missing'); assert.equal(result.inputRate, undefined); assert.equal(result.outputRate, undefined);
  }
  const conflicting = parseModelCatalog({ data: [{ id: 'a', pricing: { prompt: '0', completion: '0' } }, { id: 'a', pricing: { prompt: '0.000002', completion: '0.000004' } }] }, source)!;
  assert.equal(conflicting.length, 1); assert.equal(conflicting[0].pricing.status, 'missing');
});

test('fixed-call, tiered, unknown-currency, unit and out-of-range prices require manual reconciliation', () => {
  for (const extra of [{ request: '.02' }, { request: '0.02' }, { request: -1 }, { currency: 'CNY' }, { unit: 'million_tokens' }, { overrides: [{ prompt: '0.01' }] }, { overrides: {} }]) {
    const result = parse({ prompt: '0.000002', completion: '0.000004', ...extra });
    assert.equal(result.status, 'unsupported'); assert.equal(result.inputRate, undefined);
  }
  assert.equal(parse({ prompt: '0.1', completion: '0.1' }).status, 'unsupported');
  assert.equal(parse({ prompt: '1e-6', completion: '2e-6', currency: 'USD', unit: 'per_token', overrides: [] }).inputRate, 1);
  for (const data of [null, { data: [{ model: 'a' }] }, { data: [{ id: '' }] }, { data: [{ id: 'x'.repeat(201) }] }]) assert.equal(parseModelCatalog(data, source), undefined);
});

test('New API returns group-specific quotes only for accessible models, without guessing this key\'s group', () => {
  const catalog = parseModelCatalog({ data: [{ id: 'a' }, { id: 'free' }] }, source)!;
  assert.equal(applyNewApiPrices(catalog, { success: true, data: [
    { model_name: 'a', quota_type: 0, model_ratio: 1.25, completion_ratio: 4, enable_group: ['default', 'vip', 'unpriced'] },
    { model_name: 'free', quota_type: 0, model_ratio: 0, completion_ratio: 1, enable_group: ['default'] },
    { model_name: 'not-accessible', quota_type: 0, model_ratio: 1, completion_ratio: 1, enable_group: ['default'] },
  ], group_ratio: { default: 1, vip: .8 } }, pricingSource), true);
  assert.deepEqual(catalog.map(model => model.id), ['a', 'free']);
  assert.equal(catalog[0].pricing.status, 'group_required'); assert.equal(catalog[0].pricing.inputRate, undefined);
  assert.deepEqual(catalog[0].pricing.groups, [{ name: 'default', ratio: 1, inputRate: 2.5, outputRate: 10 }, { name: 'vip', ratio: .8, inputRate: 2, outputRate: 8 }]);
  assert.deepEqual(catalog[1].pricing.groups, [{ name: 'default', ratio: 1, inputRate: 0, outputRate: 0 }]);
});

test('New API rejects incomplete ratios, duplicate quotes, fixed-call and missing group billing', () => {
  for (const row of [
    { quota_type: 0, model_ratio: 1, enable_group: ['default'] },
    { quota_type: 0, model_ratio: 1, completion_ratio: 1, enable_group: ['missing'] },
    { quota_type: 0, model_ratio: -1, completion_ratio: 1, enable_group: ['default'] },
    { quota_type: 0, model_ratio: 1, completion_ratio: 1 },
    { model_ratio: 1, completion_ratio: 1, enable_group: ['default'] },
  ]) {
    const catalog = parseModelCatalog({ data: [{ id: 'a' }] }, source)!;
    assert.equal(applyNewApiPrices(catalog, { success: true, data: [{ model_name: 'a', ...row }], group_ratio: { default: 1 } }, pricingSource), true);
    assert.equal(catalog[0].pricing.status, 'missing'); assert.equal(catalog[0].pricing.inputRate, undefined);
  }
  const fixed = parseModelCatalog({ data: [{ id: 'a' }] }, source)!;
  applyNewApiPrices(fixed, { success: true, data: [{ model_name: 'a', quota_type: 1, model_price: .1 }], group_ratio: {} }, pricingSource);
  assert.equal(fixed[0].pricing.status, 'unsupported');
  const duplicate = parseModelCatalog({ data: [{ id: 'a' }] }, source)!;
  const row = { model_name: 'a', quota_type: 0, model_ratio: 1, completion_ratio: 1, enable_group: ['default'] };
  applyNewApiPrices(duplicate, { success: true, data: [row, { ...row, model_ratio: 2 }], group_ratio: { default: 1 } }, pricingSource);
  assert.equal(duplicate[0].pricing.status, 'missing');
});

test('unavailable price metadata cannot erase direct quotes or add unauthorised models', () => {
  const catalog = parseModelCatalog({ data: [{ id: 'a', pricing: { prompt: '0.000001', completion: '0.000003' } }] }, source)!;
  const before = structuredClone(catalog);
  assert.equal(applyNewApiPrices(catalog, { success: false, message: 'secret' }, pricingSource), false);
  assert.deepEqual(catalog, before);
  applyNewApiPrices(catalog, { success: true, data: [{ model_name: 'a', quota_type: 1, model_price: 10 }, { model_name: 'extra' }], group_ratio: {} }, pricingSource);
  assert.deepEqual(catalog, before);
});

test('old gateways still validate and explicit price source is stored without accepting arbitrary URLs', () => {
  const gateway = { name: '测试', baseUrl: 'https://gateway.example/v1' };
  assert.equal(gatewaySchema.safeParse(gateway).success, true);
  for (const pricingSource of ['official', 'auto', 'models', 'new-api']) assert.equal(gatewaySchema.safeParse({ ...gateway, pricingSource }).success, true);
  assert.equal(gatewaySchema.safeParse({ ...gateway, pricingSource: 'https://other.example/pricing' }).success, false);
  assert.equal(gatewaySchema.parse({...gateway,baseUrl:'https://gateway.example'}).baseUrl,'https://gateway.example/v1');
  assert.equal(gatewaySchema.parse({...gateway,baseUrl:'https://gateway.example/custom/v1'}).baseUrl,'https://gateway.example/custom/v1');
});

test('New API deployments exposing enable_groups retain their group-specific prices',()=>{
 const catalog=parseModelCatalog({data:[{id:'fixture-model'}]},source)!;
 applyNewApiPrices(catalog,{success:true,group_ratio:{default:1,codex:.5},data:[{model_name:'fixture-model',quota_type:0,model_ratio:.625,completion_ratio:8,enable_groups:['codex','default']}]},pricingSource);
 assert.deepEqual(catalog[0].pricing.groups,[{name:'codex',ratio:.5,inputRate:.625,outputRate:5},{name:'default',ratio:1,inputRate:1.25,outputRate:10}]);
});

test('official quotes match exact IDs, carry their verification date, and never borrow a similar model price', () => {
  const catalog = parseModelCatalog({ data: [
    { id: 'gpt-6.1-sol', pricing: { prompt: '0', completion: '0' } },
    { id: 'gpt-5.6-luna' }, { id: 'gpt-5.5' },
    { id: 'gpt-6.1-sol-custom' }, { id: 'gpt-reserve' }, { id: 'toString' },
  ] }, source)!;
  applyOfficialPrices(catalog);
  const quote = catalog.find(model => model.id === 'gpt-6.1-sol')!.pricing;
  assert.equal(quote.inputRate, 2); assert.equal(quote.outputRate, 10); assert.equal(quote.basis, 'official');
  assert.equal(quote.verifiedAt, officialPricingVerifiedAt); assert.equal(quote.inputTokenLimit, 272000);
  assert.deepEqual(quote.longContext, { inputRate: 4, outputRate: 15 });
  assert.equal(quote.source, 'https://developers.openai.com/api/docs/models/gpt-6.1-sol');
  assert.deepEqual(catalog.find(model => model.id === 'gpt-5.6-luna')!.pricing.longContext, { inputRate: .4, outputRate: 1.8 });
  assert.equal(catalog.find(model => model.id === 'gpt-5.5')!.pricing.outputRate, 30);
  for (const id of ['gpt-6.1-sol-custom', 'gpt-reserve', 'toString']) {
    const unknown = catalog.find(model => model.id === id)!.pricing;
    assert.equal(unknown.status, 'missing'); assert.equal(unknown.inputRate, undefined); assert.equal(unknown.outputRate, undefined);
  }
});
