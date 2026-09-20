import { z } from 'zod';
import { pool } from './db.ts';
import { unseal } from './vault.ts';
import type { Model } from '../../../packages/contracts/index.ts';
export class AppError extends Error {
  constructor(public status: number, message: string, public code = 'REQUEST_FAILED') { super(message); }
}
export async function gatewayRequest(gatewayId: string, path: string, body?: unknown) {
  const { rows } = await pool.query('SELECT * FROM gateways WHERE id=$1', [gatewayId]);
  const gateway = rows[0];
  if (!gateway) throw new AppError(404, '中转站不存在');
  const key = gateway.credential ? unseal(gateway.credential) : '';
  let response: Response;
  try {
    response = await fetch(gateway.data.baseUrl.replace(/\/$/, '') + path, {
      method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      body: body ? JSON.stringify(body) : undefined, redirect: 'error', signal: AbortSignal.timeout(90000),
    });
  } catch { throw new AppError(502, '无法连接中转站，请检查 API 地址、网络和超时情况', 'GATEWAY_CONNECTION_FAILED'); }
  // Never return provider error bodies: they may echo credentials or request data.
  if (!response.ok) throw new AppError(502, `中转站返回 HTTP ${response.status}，请检查密钥、余额与模型权限`, 'GATEWAY_REJECTED');
  try { return await response.json() as unknown; }
  catch { throw new AppError(502, '中转站返回的内容不是 JSON', 'GATEWAY_INVALID_RESPONSE'); }
}
const toolCallSchema=z.object({id:z.string().min(1),type:z.literal('function'),function:z.object({name:z.string().min(1),arguments:z.string()})});
export type ChatMessage={role:string;content:string|null;tool_calls?:z.infer<typeof toolCallSchema>[];tool_call_id?:string};
export type CompletionOptions={tools?:unknown[];tool_choice?:unknown};
const completionSchema = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string().nullable().default(null),tool_calls:z.array(toolCallSchema).optional() }) })).min(1),
  usage: z.object({ prompt_tokens: z.number().int().nonnegative(), completion_tokens: z.number().int().nonnegative() }).optional(),
});
export async function complete(model: Model, messages: ChatMessage[], maxTokens: number,onUsage?:(usage:{prompt_tokens:number;completion_tokens:number})=>Promise<void>,request:CompletionOptions={}) {
  const data = await gatewayRequest(model.gatewayId, '/chat/completions', { ...request,model: model.model, messages, max_tokens: maxTokens, stream: false });
  const usage=z.object({usage:z.object({prompt_tokens:z.number().int().nonnegative(),completion_tokens:z.number().int().nonnegative()})}).safeParse(data);
  if(usage.success)await onUsage?.(usage.data.usage);
  const parsed = completionSchema.safeParse(data);
  if (!parsed.success) throw new AppError(502, '中转站返回格式不兼容 Chat Completions', 'GATEWAY_INVALID_RESPONSE');
  return parsed.data;
}
