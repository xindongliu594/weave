import { useEffect, useRef, useState } from 'react';
import { LoaderCircle, Wallet } from 'lucide-react';
import type { Gateway } from '../../../packages/contracts/index.ts';
import { api } from './api.ts';

type CheckState = { status: 'available' | 'failed'; message: string; code?: string };
export type GatewayBillingCheck = {
  gatewayId: string;
  gatewayVersion: number;
  checkedAt: string;
  billingUnit?: { quotaPerUSD: number; basis: 'new-api-status' };
  usage: CheckState & { data?: { totalGranted: number; totalUsed: number; totalAvailable: number; unlimitedQuota: boolean; expiresAt?: number } };
  logs: CheckState & { recordCount?: number };
  compatibility?: {
    source: 'documented-dashboard-billing';
    usage: CheckState & { data?: { unit: 'unknown'; totalUsage: number } };
    subscription: CheckState & { data?: { unit: 'USD'; hardLimitUSD?: number; softLimitUSD?: number; systemHardLimitUSD?: number; accessUntil?: number; unlimited: boolean } };
  };
};

const quotaFormat = new Intl.NumberFormat('zh-CN', { maximumSignificantDigits: 15 });
const dollarFormat = new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'USD', maximumFractionDigits: 6 });
function convertedQuota(value: number, rate?: number) {
  if (rate === undefined || !Number.isFinite(rate) || rate <= 0 || !Number.isFinite(value / rate)) return null;
  return <small>约 {dollarFormat.format(value / rate)}</small>;
}
function dollarLimit(value?: number) {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? dollarFormat.format(value) : null;
}
function expiryDate(value?: number) {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return null;
  const date = new Date(value * 1000);
  return Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN') : null;
}

export function GatewayBillingDetails({ result }: { result: GatewayBillingCheck }) {
  const rate = result.billingUnit?.basis === 'new-api-status' && Number.isFinite(result.billingUnit.quotaPerUSD) && result.billingUnit.quotaPerUSD > 0 ? result.billingUnit.quotaPerUSD : undefined;
  const compatibility = result.compatibility?.source === 'documented-dashboard-billing' ? result.compatibility : undefined;
  const hasCompatibility = compatibility && (compatibility.usage.status === 'available' || compatibility.subscription.status === 'available');
  const subscription = compatibility?.subscription.status === 'available' ? compatibility.subscription.data : undefined;
  const compatibilityUsage = compatibility?.usage.status === 'available' ? compatibility.usage.data : undefined;
  const hasModernUsage = result.usage.status === 'available';
  return <div className="gateway-billing-results">
    {hasModernUsage || !hasCompatibility ? <>
      <p><strong>Key 额度：{hasModernUsage ? '可查询' : '查询失败'}</strong></p><p>{result.usage.message}</p>
      {hasModernUsage && result.usage.data && <>
        <dl><div><dt>累计额度</dt><dd>{result.usage.data.unlimitedQuota ? '无限额度' : quotaFormat.format(result.usage.data.totalGranted)}</dd>{!result.usage.data.unlimitedQuota && convertedQuota(result.usage.data.totalGranted, rate)}</div><div><dt>已用额度</dt><dd>{quotaFormat.format(result.usage.data.totalUsed)}</dd>{convertedQuota(result.usage.data.totalUsed, rate)}</div><div><dt>剩余额度</dt><dd>{result.usage.data.unlimitedQuota ? '无限额度' : quotaFormat.format(result.usage.data.totalAvailable)}</dd>{!result.usage.data.unlimitedQuota && convertedQuota(result.usage.data.totalAvailable, rate)}</div></dl>
        <p className="subcopy">数值保留中转站原始额度单位。{rate !== undefined ? `美元金额按站点额度配置折算（${quotaFormat.format(rate)} 额度 / USD）。` : '尚未取得有效的美元换算配置。'}{result.usage.data.expiresAt !== undefined && ` Key 有效期：${result.usage.data.expiresAt > 0 ? new Date(result.usage.data.expiresAt * 1000).toLocaleString('zh-CN') : '无固定有效期'}。`}</p>
      </>}
    </> : <>
      <p><strong>Key 额度：兼容查询{compatibility?.usage.status === 'available' && compatibility.subscription.status === 'available' ? '可用' : '部分可用'}</strong></p><p>该站支持兼容额度查询，本次分别查询 Key 授权上限与接口返回的累计用量。</p>
      {subscription && <>
        <dl><div><dt>Key 授权上限（USD）</dt><dd>{subscription.unlimited ? '无限授权上限' : dollarLimit(subscription.hardLimitUSD) ?? '未提供'}</dd></div>{!subscription.unlimited && dollarLimit(subscription.softLimitUSD) !== null && <div><dt>软上限（USD）</dt><dd>{dollarLimit(subscription.softLimitUSD)}</dd></div>}{!subscription.unlimited && dollarLimit(subscription.systemHardLimitUSD) !== null && <div><dt>系统上限（USD）</dt><dd>{dollarLimit(subscription.systemHardLimitUSD)}</dd></div>}</dl>
        <p className="subcopy">这是当前 Key 的授权上限，不代表剩余额度。{expiryDate(subscription.accessUntil) && `授权有效期：${expiryDate(subscription.accessUntil)}。`}</p>
      </>}
      {!subscription && <p>授权上限：{compatibility?.subscription.message}</p>}
      {compatibilityUsage && Number.isFinite(compatibilityUsage.totalUsage) ? <><dl><div><dt>累计用量（原始数值）</dt><dd>{quotaFormat.format(compatibilityUsage.totalUsage)}</dd></div></dl><p className="subcopy">累计用量的单位未注明，不能按美元或 Token 展示，也不能与授权上限相减推算余额或单次请求费用。</p></> : <p>累计用量：{compatibility?.usage.message}</p>}
      <details className="gateway-billing-modern-detail"><summary>查看标准额度接口结果</summary><p>{result.usage.message}</p></details>
    </>}
    {!hasModernUsage && !hasCompatibility && compatibility && <details className="gateway-billing-modern-detail"><summary>查看兼容查询结果</summary><p>授权上限：{compatibility.subscription.message}</p><p>累计用量：{compatibility.usage.message}</p></details>}
    {(hasModernUsage || hasCompatibility) && <p className="subcopy">这里是当前 Key 的额度信息；账户总钱包请在中转站查看，本机每日预算在系统设置中单独管理。</p>}
    <div className={result.logs.status === 'failed' ? 'gateway-billing-warning' : undefined}>
      <p><strong>消费日志：{result.logs.status === 'available' ? '可查询' : '不可查询'}</strong>{result.logs.status === 'available' && result.logs.recordCount !== undefined && ` · 本次返回 ${result.logs.recordCount} 条`}</p><p>{result.logs.message}</p>
      {result.logs.status === 'failed' && <p className="subcopy">当前无法取得单次请求的消费证据，失败或中断调用的费用仍需核对。核对完成前，恢复入口仍受限制；可在系统设置中手动核对账单。</p>}
    </div>
    <small>{new Date(result.checkedAt).toLocaleString('zh-CN')} · 本次检查结果</small><p className="subcopy">日志为空不能证明请求未调用或未扣费。待核对调用可在系统设置中查询中转站账单。</p>
  </div>;
}

export function GatewayBilling({ gateway }: { gateway: Gateway }) {
  const [busy, setBusy] = useState(false), [result, setResult] = useState<GatewayBillingCheck | null>(null), [error, setError] = useState('');
  const inFlight = useRef(false), generation = useRef(0);
  useEffect(() => {
    generation.current += 1;
    inFlight.current = false;
    setBusy(false); setResult(null); setError('');
    return () => { generation.current += 1; };
  }, [gateway.id, gateway.version]);

  async function check() {
    if (inFlight.current) return;
    inFlight.current = true;
    const ticket = generation.current;
    setBusy(true); setResult(null); setError('');
    try {
      const response = await api<GatewayBillingCheck>(`/gateways/${gateway.id}/billing-check`, 'POST', { version: gateway.version });
      if (ticket !== generation.current) return;
      if (response.gatewayId !== gateway.id || response.gatewayVersion !== gateway.version) throw new Error('连接配置已变化，请按当前配置重新检查。');
      setResult(response);
    } catch (failure) {
      if (ticket === generation.current) setError(failure instanceof TypeError && /fetch/i.test(failure.message) ? '后端连接失败，请检查本机服务后重新查询。' : (failure as Error).message);
    } finally {
      if (ticket === generation.current) { inFlight.current = false; setBusy(false); }
    }
  }

  return <div className="gateway-billing">
    <div className="gateway-test-actions"><button type="button" disabled={busy} onClick={() => void check()}>{busy ? <LoaderCircle size={15} className="spin"/> : <Wallet size={15}/>} {busy ? '正在查询额度与日志…' : '检查额度与消费日志'}</button><small>使用当前 Key 查询 New API，不发起模型推理。</small></div>
    <div aria-live="polite" aria-atomic="true">
      {result && <GatewayBillingDetails result={result}/>}
    </div>
    {error && <p className="banner error" role="alert">{error}</p>}
  </div>;
}
