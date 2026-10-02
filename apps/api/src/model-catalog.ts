import { z } from 'zod';
import type { CatalogModel, CatalogPrice, GatewayCatalog } from '../../../packages/contracts/index.ts';

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
function number(value: unknown): number | undefined {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+(?:\.\d*)?(?:e[+-]?\d+)?$/i.test(value.trim()))) return;
  const result = Number(value);
  return Number.isFinite(result) && result >= 0 ? result : undefined;
}
function rate(value: number): number | undefined {
  return Number.isFinite(value) && value >= 0 && value <= 10000 ? Number(value.toPrecision(12)) : undefined;
}
const missing = (note = '接口未提供完整的输入和输出价格，请手动填写。'): CatalogPrice => ({ status: 'missing', note });
const unsupported = (source: string, note: string): CatalogPrice => ({ status: 'unsupported', source, note });

// OpenRouter-compatible pricing.prompt/completion is USD per token. Unknown formats
// are deliberately not converted: missing, negative, and blank prices are not free.
function inlinePrice(value: unknown, source: string): CatalogPrice {
  const pricing = record(value);
  if (!pricing) return missing();
  if ((pricing.currency !== undefined && pricing.currency !== 'USD') ||
      (pricing.unit !== undefined && pricing.unit !== 'token' && pricing.unit !== 'per_token'))
    return unsupported(source, '报价币种或单位不兼容 USD / Token，请手动核对价格。');
  if (pricing.overrides !== undefined && (!Array.isArray(pricing.overrides) || pricing.overrides.length > 0))
    return unsupported(source, '报价包含分档或时段价格，当前费用系统使用固定单价，请手动填写适用上限。');
  const request = number(pricing.request);
  if (pricing.request !== undefined && (request === undefined || request > 0))
    return unsupported(source, '报价包含按次收费，不能换算为固定 Token 单价。');
  const prompt = number(pricing.prompt), completion = number(pricing.completion);
  if (prompt === undefined || completion === undefined) return { ...missing(), source };
  const inputRate = rate(prompt * 1e6), outputRate = rate(completion * 1e6);
  if (inputRate === undefined || outputRate === undefined) return unsupported(source, '报价超出可配置的单价范围，请手动核对。');
  return { status: 'available', source, inputRate, outputRate };
}

const listSchema = z.object({ data: z.array(z.object({ id: z.string().min(1).max(200) }).passthrough()).max(10000) });
export function parseModelCatalog(data: unknown, source: string): CatalogModel[] | undefined {
  const parsed = listSchema.safeParse(data);
  if (!parsed.success) return;
  const entries = new Map<string, CatalogModel>();
  for (const item of parsed.data.data) {
    const context = item.context_length;
    const model: CatalogModel = {
      id: item.id, name: typeof item.name === 'string' && item.name.trim() ? item.name.trim().slice(0, 100) : item.id.slice(0, 100),
      ...(typeof context === 'number' && Number.isInteger(context) && context >= 2048 && context <= 2000000 ? { contextWindowTokens: context } : {}),
      pricing: inlinePrice(item.pricing, source),
    };
    const previous = entries.get(item.id);
    if (previous && JSON.stringify(previous.pricing) !== JSON.stringify(model.pricing)) {
      previous.pricing = missing('接口对同一模型返回了不同报价，请手动核对。');
    } else if (!previous) entries.set(item.id, model);
  }
  return [...entries.values()].sort((a, b) => a.id.localeCompare(b.id));
}

// New API: one USD is 500,000 quota points; per-million-token price = ratio * 2.
// Anonymous public prices do not identify this key's billing group or personal discounts.
export function applyNewApiPrices(catalog: CatalogModel[], data: unknown, source: string): boolean {
  const root = record(data);
  if (root?.success !== true || !Array.isArray(root.data) || root.data.length > 10000 || !record(root.group_ratio)) return false;
  const ratios = record(root.group_ratio)!;
  const prices = new Map<string, Record<string, unknown>>();
  const duplicates = new Set<string>();
  for (const item of root.data) {
    const row = record(item);
    if (row && typeof row.model_name === 'string') {
      if (prices.has(row.model_name)) duplicates.add(row.model_name);
      prices.set(row.model_name, row);
    }
  }
  for (const model of catalog) {
    if (model.pricing.status === 'available' || model.pricing.status === 'unsupported') continue;
    const row = prices.get(model.id);
    if (!row) continue;
    if (duplicates.has(model.id)) { model.pricing = missing('价格接口对同一模型返回了多条报价，请手动核对。'); continue; }
    if (row.quota_type === 1) { model.pricing = unsupported(source, '该模型按次收费，不能换算为固定 Token 单价。'); continue; }
    const modelRatio = number(row.model_ratio), completionRatio = number(row.completion_ratio);
    if (row.quota_type !== 0 || modelRatio === undefined || completionRatio === undefined) { model.pricing = { ...missing(), source }; continue; }
    const names = Array.isArray(row.enable_group) ? row.enable_group.filter((v): v is string => typeof v === 'string') : [];
    const groups: NonNullable<CatalogPrice['groups']> = [];
    for (const name of [...new Set(names)].slice(0, 100)) {
      if (!Object.hasOwn(ratios, name)) continue;
      const ratio = number(ratios[name]);
      if (ratio === undefined) continue;
      const inputRate = rate(modelRatio * 2 * ratio), outputRate = rate(modelRatio * 2 * completionRatio * ratio);
      if (inputRate !== undefined && outputRate !== undefined) groups.push({ name, ratio, inputRate, outputRate });
    }
    model.pricing = groups.length ? { status: 'group_required', source, groups, note: '选择 API Key 的实际计费分组；个人折扣或自动分组需要手动核对。' } : { ...missing('价格接口未提供可核实的分组倍率，请手动填写。'), source };
  }
  return true;
}

export function catalogResult(catalog: CatalogModel[], gatewayVersion: number, modelSource: string, pricingSource?: string, warnings: string[] = []): GatewayCatalog {
  return { models: catalog.map(m => m.id), catalog, gatewayVersion, modelSource, ...(pricingSource ? { pricingSource } : {}), fetchedAt: new Date().toISOString(), warnings };
}
