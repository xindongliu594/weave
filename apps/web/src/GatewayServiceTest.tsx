import { useState } from 'react';
import { Activity, LoaderCircle } from 'lucide-react';
import type { Gateway, GatewayServiceCheck } from '../../../packages/contracts/index.ts';
import { api } from './api.ts';

// The parent keys this component by connection version so edits discard old results.
export function GatewayServiceTest({ gateway }: { gateway: Gateway }) {
  const [busy, setBusy] = useState(false), [result, setResult] = useState<GatewayServiceCheck | null>(null), [error, setError] = useState('');
  async function test() {
    if (busy) return;
    setBusy(true); setResult(null); setError('');
    try { setResult(await api<GatewayServiceCheck>(`/gateways/${gateway.id}/test`, 'POST', { version: gateway.version })); }
    catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  }
  return <div className="gateway-service-test">
    <div className="gateway-test-actions"><button disabled={busy} onClick={() => void test()}>{busy ? <LoaderCircle size={15} className="spin"/> : <Activity size={15}/>} {busy ? '正在测试 API…' : '测试 API 服务'}</button><small>检查当前连接的模型目录，不发起模型推理。</small></div>
    <div aria-live="polite" aria-atomic="true">
      {result && <div className={'gateway-test-result ' + result.status}>
        <strong>{result.status === 'available' ? '服务可访问' : result.status === 'empty' ? '服务响应 · 暂无模型' : '服务测试未通过'}</strong>
        <p>{result.message}</p>
        <small>{new Date(result.checkedAt).toLocaleString('zh-CN')} · {result.durationMs} ms{result.upstreamStatus !== undefined && ` · HTTP ${result.upstreamStatus}`}</small>
        {result.status !== 'failed' && <small>模型回复尚需在模型卡片点击“测试连接”；目录可访问不代表所有模型都能调用。</small>}
      </div>}
    </div>
    {error && <p className="banner error" role="alert">{error}</p>}
  </div>;
}
