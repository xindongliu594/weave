import type { CatalogModel } from '../../../packages/contracts/index.ts';

// Maintained snapshot, checked against each exact model's official page. Directory
// refresh is live; this table has its own verification date and is not a live scrape.
export const officialPricingSource = 'https://developers.openai.com/api/docs/pricing';
export const officialPricingVerifiedAt = '2026-10-02';
const prices: Record<string, { inputRate: number; outputRate: number }> = {
  'gpt-5.5': { inputRate: 5, outputRate: 30 },
  'gpt-5.6-sol': { inputRate: 4, outputRate: 20 },
  'gpt-5.6-terra': { inputRate: 2, outputRate: 12 },
  'gpt-5.6-luna': { inputRate: .2, outputRate: 1.2 },
  'gpt-6-astra': { inputRate: 10, outputRate: 50 },
  'gpt-6-sol': { inputRate: 2, outputRate: 10 },
  'gpt-6-luna': { inputRate: .1, outputRate: .5 },
  'gpt-6.1-sol': { inputRate: 2, outputRate: 10 },
};

export function applyOfficialPrices(catalog: CatalogModel[]) {
  for (const model of catalog) {
    const price = Object.hasOwn(prices, model.id) ? prices[model.id] : undefined;
    if (!price) {
      model.pricing = { status: 'missing', basis: 'official', source: officialPricingSource, verifiedAt: officialPricingVerifiedAt, note: '官方文本价格表未收录此准确模型 ID，请手动核对；不按相近型号推算。' };
      continue;
    }
    model.pricing = {
      status: 'available', basis: 'official', source: `https://developers.openai.com/api/docs/models/${model.id}`,
      verifiedAt: officialPricingVerifiedAt, ...price,
      longContext: { inputRate: Number((price.inputRate * 2).toPrecision(12)), outputRate: Number((price.outputRate * 1.5).toPrecision(12)) }, inputTokenLimit: 272000,
      note: '官方 Standard 文本报价：输入不超过 272K Token。更长输入使用长上下文档；缓存、Fast 模式、地区和中转站费用另计。',
    };
  }
}
