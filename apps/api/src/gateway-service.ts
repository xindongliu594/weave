import { pool } from './db.ts';
import { AppError, gatewayRequest } from './provider.ts';
import { parseModelCatalog } from './model-catalog.ts';
import type { GatewayServiceCheck } from '../../../packages/contracts/index.ts';

export async function checkGatewayService(id: string, expectedVersion?: number): Promise<GatewayServiceCheck> {
  const gateway = (await pool.query('SELECT data,version FROM gateways WHERE id=$1', [id])).rows[0];
  if (!gateway) throw new AppError(404, '中转站不存在');
  if (expectedVersion !== undefined && expectedVersion !== gateway.version) throw new AppError(409, '中转站配置已变化，请刷新后重新测试', 'VERSION_CONFLICT');
  const started = performance.now();
  let result: Pick<GatewayServiceCheck, 'status' | 'message' | 'modelCount' | 'code' | 'upstreamStatus'>;
  try {
    const data = await gatewayRequest(id, '/models', undefined, { timeoutMs: 15000, maxBytes: 8 * 1024 * 1024, expectedVersion: gateway.version });
    const catalog = parseModelCatalog(data, gateway.data.baseUrl.replace(/\/$/, '') + '/models');
    if (!catalog) throw new AppError(502, '服务有响应，但模型目录格式不兼容，请检查 API 地址是否正确', 'GATEWAY_INVALID_CATALOG');
    result = { status: catalog.length ? 'available' : 'empty', modelCount: catalog.length, upstreamStatus: 200, message: catalog.length ? `模型目录访问正常，返回 ${catalog.length} 个模型。` : '服务有响应，但模型目录为空，请检查密钥的模型权限或中转站配置。' };
  } catch (error) {
    if (!(error instanceof AppError) || error.status !== 502) throw error;
    result = { status: 'failed', message: error.message, code: error.code, ...(error.upstreamStatus !== undefined ? { upstreamStatus: error.upstreamStatus } : {}) };
  }
  const current = (await pool.query('SELECT version FROM gateways WHERE id=$1', [id])).rows[0];
  if (!current || current.version !== gateway.version) throw new AppError(409, '测试期间中转站配置已变化，请重新测试', 'VERSION_CONFLICT');
  return { ...result, gatewayVersion: gateway.version, checkedAt: new Date().toISOString(), durationMs: Math.round(performance.now() - started) };
}
