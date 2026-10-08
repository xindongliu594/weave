import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { pool } from './db.ts';
import { unseal } from './vault.ts';
import type { Model } from '../../../packages/contracts/index.ts';
import { completionRequest, completionResponse, conversationHeaders } from '../../../services/agent-runtime/completion-protocol.mjs';
import { modelCompletionOptions } from '../../../services/agent-runtime/completion-options.mjs';
import {safeFinishReason,planningOutputDiagnostic,PlanningOutputError,type PlanningOutputDiagnostic} from './planning-output.ts';
export class AppError extends Error {
  outputDiagnostic?:PlanningOutputDiagnostic;
  constructor(public status: number, message: string, public code = 'REQUEST_FAILED', public upstreamStatus?: number) { super(message); }
}
export type NewApiPath = '/api/usage/token/' | '/api/log/token';
export type DashboardBillingPath = '/dashboard/billing/usage' | '/dashboard/billing/subscription';
export type GatewayRequestOptions = {
  timeoutMs?: number; maxBytes?: number; publicPricing?: boolean; expectedVersion?: number;
  sessionId?: string;
  newApiPath?: NewApiPath;
  dashboardBillingPath?: DashboardBillingPath;
  publicNewApiStatus?: boolean;
  onResponse?: (response: Response) => Promise<void>;
};
export async function gatewayRequest(gatewayId: string, path: string, body?: unknown, options: GatewayRequestOptions = {}) {
  const newApiRequest = options.newApiPath !== undefined || options.dashboardBillingPath !== undefined || options.publicNewApiStatus === true;
  if (options.newApiPath !== undefined && (!['/api/usage/token/', '/api/log/token'].includes(options.newApiPath) || path !== options.newApiPath || body !== undefined || options.publicPricing || options.publicNewApiStatus || options.dashboardBillingPath !== undefined))
    throw new AppError(400, '仅允许查询当前中转站的 New API 额度和消费日志', 'NEW_API_READ_ONLY');
  if (options.dashboardBillingPath !== undefined && (!['/dashboard/billing/usage', '/dashboard/billing/subscription'].includes(options.dashboardBillingPath) || path !== options.dashboardBillingPath || body !== undefined || options.publicPricing || options.publicNewApiStatus || options.newApiPath !== undefined))
    throw new AppError(400, '仅允许查询已配置中转站的兼容用量和授权额度', 'NEW_API_READ_ONLY');
  if (options.publicNewApiStatus && (path !== '/api/status' || body !== undefined || options.publicPricing || options.newApiPath !== undefined || options.dashboardBillingPath !== undefined))
    throw new AppError(400, '仅允许读取当前中转站的公开 New API 状态', 'NEW_API_READ_ONLY');
  const { rows } = await pool.query('SELECT * FROM gateways WHERE id=$1', [gatewayId]);
  const gateway = rows[0];
  if (!gateway) throw new AppError(404, '中转站不存在');
  if (options.expectedVersion !== undefined && gateway.version !== options.expectedVersion) throw new AppError(409, '获取期间中转站配置已变化，请重新获取', 'VERSION_CONFLICT');
  const key = !options.publicPricing && !options.publicNewApiStatus && gateway.credential ? unseal(gateway.credential) : '';
  // Compatibility billing lives beneath the configured model API prefix (often
  // /v1), while New API management/status routes live at the same site's origin.
  const url = options.dashboardBillingPath !== undefined ? gateway.data.baseUrl.replace(/\/$/, '') + options.dashboardBillingPath : newApiRequest ? new URL(options.publicNewApiStatus ? '/api/status' : options.newApiPath!, gateway.data.baseUrl).href : options.publicPricing ? new URL('/api/pricing', gateway.data.baseUrl).href : gateway.data.baseUrl.replace(/\/$/, '') + path;
  const bounded = (value: number | undefined, ceiling: number) => Number.isSafeInteger(value) && value! > 0 ? Math.min(value!, ceiling) : ceiling;
  const timeoutMs = newApiRequest ? bounded(options.timeoutMs, 8000) : options.timeoutMs ?? 90000;
  const maxBytes = newApiRequest ? bounded(options.maxBytes, 8 * 1024 * 1024) : options.maxBytes;
  let response: Response;
  try {
    response = await fetch(url, {
      method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json', ...(body ? conversationHeaders(gateway.data.baseUrl, options.sessionId) : {}), ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      body: body ? JSON.stringify(body) : undefined, redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const cause = (error as { cause?: { code?: string }; name?: string });
    if (cause.name === 'TimeoutError' || cause.cause?.code === 'UND_ERR_CONNECT_TIMEOUT') throw new AppError(502, '中转站响应超时，请检查服务状态或网络后重试', 'GATEWAY_TIMEOUT');
    if (cause.cause?.code === 'ECONNREFUSED') throw new AppError(502, '连接被拒绝，请启动中转服务并核对 API 地址和端口', 'GATEWAY_CONNECTION_REFUSED');
    if (['ENOTFOUND', 'EAI_AGAIN'].includes(cause.cause?.code ?? '')) throw new AppError(502, '无法解析中转站域名，请检查地址和网络', 'GATEWAY_DNS_FAILED');
    throw new AppError(502, '无法连接中转站，请检查 API 地址、网络和 HTTPS 证书', 'GATEWAY_CONNECTION_FAILED');
  }
  // Preserve response evidence before parsing, without forwarding a provider's
  // arbitrary headers/body or an identifier that echoes the saved credential.
  if (options.onResponse) {
    const headers = new Headers();
    for (const name of ['x-oneapi-request-id', 'x-upstream-request-id', 'x-request-id']) {
      const value = response.headers.get(name);
      if (value && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value) && !/^sk-/i.test(value) && (!key || !value.includes(key))) headers.set(name, value);
    }
    // A failed evidence write must not be misreported as invalid provider JSON.
    try { await options.onResponse(new Response(null, { status: response.status, headers })); }
    catch (error) { await response.body?.cancel().catch(() => {}); throw error; }
  }
  // Never return provider error bodies: they may echo credentials or request data.
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    const reason = response.status === 401 ? '密钥认证失败，请检查 API Key 是否有效' : response.status === 403 ? '访问被拒绝，请检查密钥权限或服务访问限制' : response.status === 404 ? newApiRequest ? 'New API 查询接口不存在，请检查站点版本及代理是否转发 /api 路径' : '接口不存在，请核对 API 基础地址（通常以 /v1 结尾）' : response.status === 429 ? '请求受限，请检查服务额度或稍后重试' : response.status >= 500 ? '中转服务异常，请检查上游服务或稍后重试' : '请求被拒绝，请检查连接配置';
    throw new AppError(502, `中转站返回 HTTP ${response.status}：${reason}`, 'GATEWAY_REJECTED', response.status);
  }
  try {
    if (maxBytes) {
      const chunks: Uint8Array[] = []; let bytes = 0;
      const reader = response.body?.getReader();
      if (reader) try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          bytes += value.length;
          if (bytes > maxBytes) { await reader.cancel(); throw new AppError(502, newApiRequest ? 'New API 查询数据超过读取上限，保留待核对状态' : '中转站目录数据超过读取上限，请手动添加模型', 'GATEWAY_RESPONSE_TOO_LARGE'); }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      // A misconfigured log endpoint can echo a Key in an otherwise allowed
      // identifier. Remove the exact credential before any caller sees its data.
      return JSON.parse(Buffer.concat(chunks).toString('utf8'), newApiRequest && key
        ? (_field, value) => typeof value === 'string' && value.includes(key) ? undefined : value
        : undefined) as unknown;
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
export type CompletionOptions={tools?:unknown[];tool_choice?:unknown;response_format?:{type:'json_object'}};
export const PLANNING_TIMEOUT_MS = 180_000;
const completionSchema = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string().nullable().default(null),tool_calls:z.array(toolCallSchema).nullish().transform(value => value ?? undefined) }),finish_reason:z.unknown().optional().transform(safeFinishReason) })).min(1),
  usage: z.object({ prompt_tokens: z.number().int().nonnegative(), completion_tokens: z.number().int().nonnegative() }).optional(),
});
export function assertCompletionContext(model: Pick<Model, 'protocol' | 'contextWindowTokens'>, inputBytes: number, maxTokens: number) {
  if (model.protocol === 'responses' && model.contextWindowTokens !== undefined && inputBytes + maxTokens > model.contextWindowTokens)
    throw new AppError(422, '完整 Responses 请求的保守输入与输出上限超过已配置上下文容量；请核对模型容量和计费档位', 'CONTEXT_LIMIT');
}
/** The estimator and dispatcher share the same explicitly configured envelope. */
export function prepareCompletionRequest(model: Partial<Pick<Model, 'protocol' | 'model' | 'thinkingMode'>>, messages: ChatMessage[], maxTokens: number, request: CompletionOptions = {}) {
  try {
    return completionRequest(model.protocol, { ...request, model: model.model, messages, max_tokens: maxTokens, stream: false, ...modelCompletionOptions(model) });
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'INVALID_THINKING_MODE' || code === 'THINKING_PROTOCOL_MISMATCH') throw new AppError(422, (error as Error).message, code);
    throw error;
  }
}
export async function complete(model: Model, messages: ChatMessage[], maxTokens: number,onUsage?:(usage:{prompt_tokens:number;completion_tokens:number})=>Promise<void>,request:CompletionOptions={},transport:Pick<GatewayRequestOptions, 'timeoutMs' | 'onResponse' | 'sessionId'>={}) {
  const prepared = prepareCompletionRequest(model, messages, maxTokens, request);
  assertCompletionContext(model, Buffer.byteLength(JSON.stringify(prepared.body)) + 1024, maxTokens);
  const raw: any = await gatewayRequest(model.gatewayId, prepared.path, prepared.body, { ...transport, sessionId: transport.sessionId ?? 'direct:' + randomUUID() });
  // Persist trustworthy usage before validating output/tools. An invalid output
  // with reported tokens is a paid failure, not an unconfirmed zero-cost call.
  const usageData = model.protocol === 'responses' ? { usage: { prompt_tokens: raw?.usage?.input_tokens, completion_tokens: raw?.usage?.output_tokens } } : raw;
  const usage=z.object({usage:z.object({prompt_tokens:z.number().int().nonnegative(),completion_tokens:z.number().int().nonnegative()})}).safeParse(usageData);
  if(usage.success)await onUsage?.(usage.data.usage);
  const outputText=model.protocol==='responses'&&Array.isArray(raw?.output)
    ?raw.output.flatMap((item:any)=>item?.type==='message'&&Array.isArray(item.content)?item.content.filter((part:any)=>part?.type==='output_text'&&typeof part.text==='string').map((part:any)=>part.text):[]).join('')
    :raw?.choices?.[0]?.message?.content;
  const finishReason=model.protocol==='responses'&&raw?.status!=='completed'
    ?raw?.incomplete_details?.reason==='max_output_tokens'?'length':raw?.incomplete_details?.reason==='content_filter'?'content_filter':'incomplete'
    :safeFinishReason(raw?.choices?.[0]?.finish_reason);
  if(finishReason==='length'||finishReason==='content_filter'){
    const reason=finishReason==='length'?'OUTPUT_TRUNCATED':'OUTPUT_FILTERED';
    throw Object.assign(new AppError(422,finishReason==='length'?'模型输出达到长度上限，结果未被采用；已取得的用量已记录':'模型输出被过滤，结果未被采用；已取得的用量已记录',finishReason==='length'?'MODEL_OUTPUT_TRUNCATED':'MODEL_OUTPUT_FILTERED'),{outputDiagnostic:planningOutputDiagnostic(outputText,finishReason,new PlanningOutputError(reason))});
  }
  // API probes do not preserve reasoning state across their tool roundtrip.
  // Refuse an ignored explicit disable only after any trustworthy fee receipt.
  if (model.thinkingMode === 'disabled' && Array.isArray(raw?.choices) && raw.choices.some((choice: any) => {
    const reasoning = choice?.message?.reasoning_content;
    return reasoning !== undefined && reasoning !== null && reasoning !== '';
  })) throw new AppError(502, '中转站忽略关闭 thinking 的配置并返回了推理状态；本轮输出未被采用，已取得的用量继续保留', 'THINKING_MODE_IGNORED');
  let data: unknown;
  try { data = completionResponse(model.protocol, raw); }
  catch { throw Object.assign(new AppError(502, '中转站返回格式不兼容所选接口协议；用量回执如已取得则保持登记', 'GATEWAY_INVALID_RESPONSE'),{outputDiagnostic:planningOutputDiagnostic(outputText,finishReason,new PlanningOutputError('INVALID_COMPLETION'))}); }
  const parsed = completionSchema.safeParse(data);
  if (!parsed.success) {
    // Only schema paths/codes are included, never provider content or credentials.
    const fields = parsed.error.issues.slice(0, 3).map(issue => `${issue.path.join('.')} (${issue.code})`).join('、');
    throw Object.assign(new AppError(502, '中转站返回格式不兼容 ' + (model.protocol === 'responses' ? 'Responses' : 'Chat Completions') + '：' + fields, 'GATEWAY_INVALID_RESPONSE'),{outputDiagnostic:planningOutputDiagnostic(outputText,finishReason,new PlanningOutputError('INVALID_COMPLETION'))});
  }
  return parsed.data;
}
