import { z } from 'zod';
import { pool } from './db.ts';
import { unseal } from './vault.ts';
import type { Model } from '../../../packages/contracts/index.ts';
export class AppError extends Error {
  constructor(public status: number, message: string, public code = 'REQUEST_FAILED', public upstreamStatus?: number) { super(message); }
}
export async function gatewayRequest(gatewayId: string, path: string, body?: unknown, options: { timeoutMs?: number; maxBytes?: number; publicPricing?: boolean; expectedVersion?: number } = {}) {
  const { rows } = await pool.query('SELECT * FROM gateways WHERE id=$1', [gatewayId]);
  const gateway = rows[0];
  if (!gateway) throw new AppError(404, '中转站不存在');
  if (options.expectedVersion !== undefined && gateway.version !== options.expectedVersion) throw new AppError(409, '获取期间中转站配置已变化，请重新获取', 'VERSION_CONFLICT');
  const key = !options.publicPricing && gateway.credential ? unseal(gateway.credential) : '';
  const url = options.publicPricing ? new URL('/api/pricing', gateway.data.baseUrl).href : gateway.data.baseUrl.replace(/\/$/, '') + path;
  let response: Response;
  try {
    response = await fetch(url, {
      method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      body: body ? JSON.stringify(body) : undefined, redirect: 'error', signal: AbortSignal.timeout(options.timeoutMs ?? 90000),
    });
  } catch (error) {
    const cause = (error as { cause?: { code?: string }; name?: string });
    if (cause.name === 'TimeoutError' || cause.cause?.code === 'UND_ERR_CONNECT_TIMEOUT') throw new AppError(502, '中转站响应超时，请检查服务状态或网络后重试', 'GATEWAY_TIMEOUT');
    if (cause.cause?.code === 'ECONNREFUSED') throw new AppError(502, '连接被拒绝，请启动中转服务并核对 API 地址和端口', 'GATEWAY_CONNECTION_REFUSED');
    if (['ENOTFOUND', 'EAI_AGAIN'].includes(cause.cause?.code ?? '')) throw new AppError(502, '无法解析中转站域名，请检查地址和网络', 'GATEWAY_DNS_FAILED');
    throw new AppError(502, '无法连接中转站，请检查 API 地址、网络和 HTTPS 证书', 'GATEWAY_CONNECTION_FAILED');
  }
  // Never return provider error bodies: they may echo credentials or request data.
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    const reason = response.status === 401 ? '密钥认证失败，请检查 API Key 是否有效' : response.status === 403 ? '访问被拒绝，请检查密钥权限或服务访问限制' : response.status === 404 ? '接口不存在，请核对 API 基础地址（通常以 /v1 结尾）' : response.status === 429 ? '请求受限，请检查服务额度或稍后重试' : response.status >= 500 ? '中转服务异常，请检查上游服务或稍后重试' : '请求被拒绝，请检查连接配置';
    throw new AppError(502, `中转站返回 HTTP ${response.status}：${reason}`, 'GATEWAY_REJECTED', response.status);
  }
  try {
    if (options.maxBytes) {
      const chunks: Uint8Array[] = []; let bytes = 0;
      const reader = response.body?.getReader();
      if (reader) try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          bytes += value.length;
          if (bytes > options.maxBytes) { await reader.cancel(); throw new AppError(502, '中转站目录数据超过读取上限，请手动添加模型', 'GATEWAY_RESPONSE_TOO_LARGE'); }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    }
    return await response.json() as unknown;
  }
  catch (error) {
    if (error instanceof AppError) throw error;
    if ((error as Error).name === 'TimeoutError' || (error as Error).name === 'AbortError') throw new AppError(502, '中转站响应读取超时，请稍后重试', 'GATEWAY_TIMEOUT');
    throw new AppError(502, '中转站返回的内容不是有效 JSON，或响应读取失败', 'GATEWAY_INVALID_RESPONSE');
  }
}
const toolCallSchema=z.object({id:z.string().min(1),type:z.literal('function'),function:z.object({name:z.string().min(1),arguments:z.string()})});
export type ChatMessage={role:string;content:string|null;tool_calls?:z.infer<typeof toolCallSchema>[];tool_call_id?:string};
export type CompletionOptions={tools?:unknown[];tool_choice?:unknown};
export const PLANNING_TIMEOUT_MS = 180_000;
const completionSchema = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string().nullable().default(null),tool_calls:z.array(toolCallSchema).nullish().transform(value => value ?? undefined) }) })).min(1),
  usage: z.object({ prompt_tokens: z.number().int().nonnegative(), completion_tokens: z.number().int().nonnegative() }).optional(),
});
export async function complete(model: Model, messages: ChatMessage[], maxTokens: number,onUsage?:(usage:{prompt_tokens:number;completion_tokens:number})=>Promise<void>,request:CompletionOptions={},transport:{timeoutMs?:number}={}) {
  const data = await gatewayRequest(model.gatewayId, '/chat/completions', { ...request,model: model.model, messages, max_tokens: maxTokens, stream: false },transport);
  const usage=z.object({usage:z.object({prompt_tokens:z.number().int().nonnegative(),completion_tokens:z.number().int().nonnegative()})}).safeParse(data);
  if(usage.success)await onUsage?.(usage.data.usage);
  const parsed = completionSchema.safeParse(data);
  if (!parsed.success) {
    // Only schema paths/codes are included, never provider content or credentials.
    const fields = parsed.error.issues.slice(0, 3).map(issue => `${issue.path.join('.')} (${issue.code})`).join('、');
    throw new AppError(502, '中转站返回格式不兼容 Chat Completions：' + fields, 'GATEWAY_INVALID_RESPONSE');
  }
  return parsed.data;
}
