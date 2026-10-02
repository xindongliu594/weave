import { useState } from 'react';
import type { CatalogModel, CatalogRate, GatewayCatalog } from '../../../packages/contracts/index.ts';

export type CatalogSelection = { gatewayId: string; model: CatalogModel; rate?: CatalogRate; group?: string; fetchedAt: string; officialTier?: 'standard' | 'long_context' };
export function selectedCatalogRate(model: CatalogModel, group: string, tier: 'standard' | 'long_context' = 'standard'): CatalogRate | undefined {
  if (model.pricing.basis === 'official' && tier === 'long_context' && model.pricing.longContext) return model.pricing.longContext;
  if (model.pricing.status === 'available' && model.pricing.inputRate !== undefined && model.pricing.outputRate !== undefined)
    return { inputRate: model.pricing.inputRate, outputRate: model.pricing.outputRate };
  const quote = model.pricing.status === 'group_required' ? model.pricing.groups?.find(item => item.name === group) : undefined;
  return quote ? { inputRate: quote.inputRate, outputRate: quote.outputRate } : undefined;
}
const money = (value: number) => '$' + value.toLocaleString('en-US', { maximumFractionDigits: 8 });

export function GatewayCatalogBrowser({ gatewayId, result, onSelect }: { gatewayId: string; result: GatewayCatalog; onSelect: (selection: CatalogSelection) => void }) {
  const [query, setQuery] = useState(''), [group, setGroup] = useState(''), [tier, setTier] = useState<'standard' | 'long_context'>('standard');
  const groups = [...new Set(result.catalog.flatMap(model => model.pricing.groups?.map(item => item.name) ?? []))].sort();
  const matches = result.catalog.filter(model => (model.id + ' ' + model.name).toLowerCase().includes(query.toLowerCase()));
  return <section className="gateway-catalog" aria-label="中转站模型与价格">
    <div className="section-title"><h3>已获取 {result.catalog.length} 个模型</h3><span className="muted">USD / 百万 Token</span></div>
    <p className="subcopy">选择需要的模型，核对单价后保存。获取目录不会进行推理或连接测试，也不会修改已添加模型的价格。</p>
    <div className="catalog-source"><small>目录获取时间：{new Date(result.fetchedAt).toLocaleString('zh-CN')}</small><small>模型来源：<code>{result.modelSource}</code></small>{result.pricingSource && <small>价格来源：<code>{result.pricingSource}</code></small>}{result.pricingVerifiedAt && <small>官方报价核对日期：{result.pricingVerifiedAt}</small>}</div>
    {result.warnings.map((warning, index) => <p key={index} className="catalog-warning" role="status">{warning}</p>)}
    {result.pricingVerifiedAt && <label className="field lower-small"><span>官方计费档位</span><select value={tier} onChange={event => setTier(event.target.value as typeof tier)}><option value="standard">Standard：输入不超过 272K Token</option><option value="long_context">Standard：长上下文</option></select><small>普通档导入时将上下文总容量限制在 272K Token 内；长上下文使用对应的较高单价。官方价格用于估算，实际扣费以所用服务的账单为准。</small></label>}
    {groups.length > 0 && <label className="field lower-small"><span>API Key 的计费分组</span><select aria-label="API Key 的计费分组" value={group} onChange={event => setGroup(event.target.value)}><option value="">请选择实际分组</option>{groups.map(name => <option key={name} value={name}>{name}</option>)}</select><small>报价包含该分组倍率；个人折扣、自动分组和附加费用需按站点账单核对。</small></label>}
    <label className="field lower-small"><span>搜索模型</span><input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="输入模型名称或 ID"/></label>
    <div className="table-scroll catalog-table"><table><thead><tr><th>模型</th><th>输入 / 输出单价</th><th>操作</th></tr></thead><tbody>{matches.slice(0, 100).map(model => {
      const quote = selectedCatalogRate(model, group, tier);
      const selectedModel = model.pricing.basis === 'official' && quote && tier === 'standard' && model.pricing.inputTokenLimit ? { ...model, contextWindowTokens: Math.min(model.contextWindowTokens ?? model.pricing.inputTokenLimit, model.pricing.inputTokenLimit) } : model;
      return <tr key={model.id}><td><strong>{model.name}</strong><code>{model.id}</code></td><td>{quote ? <><strong>{money(quote.inputRate)} / {money(quote.outputRate)}</strong><small>{model.pricing.basis === 'official' ? `官方 ${tier === 'standard' ? '普通' : '长上下文'}档` : model.pricing.status === 'group_required' ? `${group} 分组报价` : '接口报价'}</small></> : <><span className="tag amber">{model.pricing.status === 'group_required' ? (group ? '此分组无报价' : '待选择分组') : model.pricing.status === 'unsupported' ? '需核对计费方式' : '价格待填写'}</span><small>{model.pricing.note}</small></>}</td><td><button type="button" onClick={() => onSelect({ gatewayId, model: selectedModel, ...(quote ? { rate: quote } : {}), ...(quote && model.pricing.status === 'group_required' ? { group } : {}), ...(model.pricing.basis === 'official' ? { officialTier: tier } : {}), fetchedAt: result.fetchedAt })}>选择</button></td></tr>;
    })}</tbody></table></div>
    {!matches.length && <p className="compact-empty">{result.catalog.length ? '没有匹配的模型。' : '中转站返回的模型列表为空，可以手动添加。'}</p>}
    {matches.length > 100 && <small>当前显示前 100 项，请搜索缩小范围。</small>}
  </section>;
}
