import { randomUUID } from 'node:crypto';
import { LlmAdapter, LlmError, attributionHeaders } from '@deepseek-ai/dsh-llm';
import { fitMessages } from './limits.mjs';
import { ExecutionBudget } from './budget.mjs';

function textOf(blocks) {
  return blocks.flatMap(block => {
    if (block.type === 'text' || block.type === 'reasoning') return [block.text];
    if (block.type === 'tool-result') return [textOf(block.content)];
    return [];
  }).filter(Boolean).join('\n');
}

function toWireMessage(message) {
  const toolResult = message.content.find(block => block.type === 'tool-result');
  if (toolResult) return { role: 'tool', tool_call_id: toolResult.toolCallId, content: textOf(toolResult.content) };
  const calls = message.content.filter(block => block.type === 'tool-call').map(block => ({
    id: block.id, type: 'function', function: { name: block.name, arguments: block.arguments },
  }));
  const visible = message.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
  const reasoning = message.content.filter(block => block.type === 'reasoning').map(block => block.text).join('\n');
  return {
    role: message.role,
    content: visible || null,
    ...(reasoning ? { reasoning_content: reasoning } : {}),
    ...(calls.length ? { tool_calls: calls } : {}),
  };
}

function usageOf(value) {
  if (!value || !Number.isSafeInteger(value.prompt_tokens) || value.prompt_tokens < 0 || !Number.isSafeInteger(value.completion_tokens) || value.completion_tokens < 0) return null;
  const cached = value.prompt_tokens_details?.cached_tokens;
  const cacheReadTokens = Number.isSafeInteger(cached) && cached >= 0 && cached <= value.prompt_tokens ? cached : 0;
  const reasoning = value.completion_tokens_details?.reasoning_tokens;
  return {
    inputTokens: value.prompt_tokens - cacheReadTokens,
    outputTokens: value.completion_tokens,
    ...(cacheReadTokens ? { cacheReadTokens } : {}),
    ...(Number.isSafeInteger(reasoning) && reasoning >= 0 ? { reasoningTokens: reasoning } : {}),
    ...(Number.isSafeInteger(value.total_tokens) && value.total_tokens >= value.prompt_tokens + value.completion_tokens ? { totalTokens: value.total_tokens } : {}),
  };
}

function finishReason(value, hasCalls) {
  if (hasCalls || value === 'tool_calls' || value === 'function_call') return { kind: 'tool-calls' };
  if (value === 'length') return { kind: 'max-tokens' };
  return { kind: 'stop' };
}

export class OpenAiCompatibleAdapter extends LlmAdapter {
  constructor({ routes, maxBudget, onUsage, onError, maxModelCalls = 100, contextBytes = 64000, signal, onContext, onRequest, onFallback, priorSpend=0,priorModelCalls=0,tasks=[],maxTaskModelCalls=40,taskUsage={},onBudget,beforeRequest,onCallError }) {
    super();
    this.routes = new Map(routes.map(route => [route.id, Object.freeze({ ...route })]));
    this.maxBudget = maxBudget;
    this.onUsage = onUsage;
    this.onError = onError;
    this.spent = 0;
    this.reserved = 0;
    this.maxModelCalls=maxModelCalls; this.calls=0; this.contextBytes=contextBytes; this.signal=signal; this.onContext=onContext;
    this.onRequest=onRequest;this.onFallback=onFallback;this.sessionPolicies=new Map();
    this.budget=new ExecutionBudget({maxBudget,priorSpend,maxModelCalls,priorModelCalls,tasks,maxTaskModelCalls,taskUsage,onEvent:onBudget});
    this.beforeRequest=beforeRequest;this.onCallError=onCallError;
  }

  providerInfo(provider) { return { id: provider, name: 'Agent Department Relay' }; }
  async listModels(provider) { return [...this.routes.values()].map(route => ({ provider, id: route.id, name: route.name })); }
  async resolveModel(provider, model) {
    const route = this.routes.get(model);
    if (!route) throw new LlmError(`运行快照中不存在模型 ${model}`, 'UNKNOWN_MODEL');
    return { provider, id: model, name: route.name, defaultMaxTokens: route.maxOutputTokens };
  }

  async *stream(options) {
    const fused = AbortSignal.any([...(options.signal ? [options.signal] : []), ...(this.signal ? [this.signal] : []), AbortSignal.timeout(90000)]);
    options = { ...options, signal: fused };
    const route = this.routes.get(options.model);
    if (!route) throw new LlmError(`运行快照中不存在模型 ${options.model}`, 'UNKNOWN_MODEL');
    options.signal?.throwIfAborted();
    const original = [...(options.system ? [{ role: 'system', content: options.system }] : []), ...options.messages.map(toWireMessage)];
    let fitted;
    try { fitted = fitMessages(original, Math.min(this.contextBytes, route.contextBytes ?? this.contextBytes)); }
    catch(e) { this.onError?.(e); throw e; }
    const messages = fitted.messages;
    if(fitted.removed) this.onContext?.({ modelId: route.id, removedGroups: fitted.removed, beforeBytes: Buffer.byteLength(JSON.stringify(original)), afterBytes: Buffer.byteLength(JSON.stringify(messages)), note: '完整记录仍保存在追溯档案；仅从本次模型请求移除较早的完整对话组。' });
    const maxTokens = Math.max(1, Math.min(options.maxTokens ?? route.maxOutputTokens, route.maxOutputTokens));
    const tools = options.tools?.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } }));
    const body = {
      model: route.wireModel, messages, stream: false, max_tokens: maxTokens,
      ...(tools?.length ? { tools } : {}),
      ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
      ...(options.stop?.length ? { stop: options.stop } : {}),
      ...((this.sessionPolicies.get(options.sessionId)?.reasoningEffort??options.reasoningEffort) ? { reasoning_effort: this.sessionPolicies.get(options.sessionId)?.reasoningEffort??options.reasoningEffort } : {}),
    };
    const inputUpperBound = Buffer.byteLength(JSON.stringify({messages,tools})) + 1024;
    const reservation = (inputUpperBound * route.inputRate + maxTokens * route.outputRate) / 1e6;
    const attribution=this.attribution?.(options.sessionId)??{sessionId:options.sessionId};
    let ticket;
    try { ticket=this.budget.reserve(reservation,attribution,options.fallbackAttempted??false); }
    catch(error) { this.onError?.(error);throw error; }
    this.calls++;this.reserved+=reservation;
    let reservationHeld=true;
    const release=()=>{ticket.release();if(reservationHeld){this.reserved=Math.max(0,this.reserved-reservation);reservationHeld=false;}};
    let response;
    const started=Date.now();
    const usageId=randomUUID();let registered=false,dispatched=false,accounted=false;
    try {
      await this.beforeRequest?.({id:usageId,...attribution,modelId:route.id,reservation});registered=!!this.beforeRequest;
      this.onRequest?.({usageId,...attribution,modelId:route.id,body,reservation});
      dispatched=true;
      response = await fetch(route.baseUrl.replace(/\/$/, '') + '/chat/completions', {
        method: 'POST', signal: options.signal, redirect: 'error',
        headers: { 'Content-Type': 'application/json', ...attributionHeaders(), ...(route.apiKey ? { Authorization: `Bearer ${route.apiKey}` } : {}) },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const fallbackId=this.sessionPolicies.get(options.sessionId)?.fallbackModelId;
        if(!options.fallbackAttempted && [429,503].includes(response.status) && fallbackId && this.routes.has(fallbackId) && fallbackId!==route.id){
          if(registered)await this.onCallError?.({id:usageId,dispatched:true,code:'HTTP_'+response.status});accounted=true;
          release();
          this.onFallback?.({sessionId:options.sessionId,from:route.id,to:fallbackId,status:response.status});
          yield* this.stream({...options,model:fallbackId,fallbackAttempted:true});return;
        }
        throw new LlmError(`中转站返回 HTTP ${response.status}`, response.status === 401 || response.status === 403 ? 'AUTH' : response.status === 429 ? 'RATE_LIMIT' : 'PROVIDER_ERROR', { status: response.status });
      }
      let payload;
      try { payload = await response.json(); }
      catch { throw new LlmError('中转站返回的模型响应不是 JSON', 'INVALID_RESPONSE'); }
      const reported = usageOf(payload.usage);
      if (!reported) throw new LlmError('中转站未返回标准 Token 用量，已停止本次运行', 'USAGE_MISSING');
      const actualCost = ((reported.inputTokens + (reported.cacheReadTokens ?? 0)) * route.inputRate + reported.outputTokens * route.outputRate) / 1e6;
      release();ticket.settle(actualCost);
      this.spent += actualCost;
      await this.onUsage?.({ id: usageId, ...attribution, modelId: route.id, durationMs:Date.now()-started, inputTokens: reported.inputTokens + (reported.cacheReadTokens ?? 0), outputTokens: reported.outputTokens, cost: actualCost });accounted=true;
      ticket.check();
      const message = payload.choices?.[0]?.message;
      if (!message || typeof message !== 'object') throw new LlmError('中转站响应缺少 assistant message', 'INVALID_RESPONSE');
      const blocks = [];
      if (typeof message.reasoning_content === 'string' && message.reasoning_content) blocks.push({ type: 'reasoning', text: message.reasoning_content });
      if (typeof message.content === 'string' && message.content) blocks.push({ type: 'text', text: message.content });
      if (Array.isArray(message.tool_calls)) {
        for (const call of message.tool_calls) {
          if (!call || typeof call.id !== 'string' || typeof call.function?.name !== 'string' || typeof call.function?.arguments !== 'string') throw new LlmError('中转站返回了无效工具调用', 'INVALID_RESPONSE');
          blocks.push({ type: 'tool-call', id: call.id, name: call.function.name, arguments: call.function.arguments });
        }
      }
      if (!blocks.length) throw new LlmError('模型返回了空响应', 'EMPTY_RESPONSE');
      for (const [index, block] of blocks.entries()) {
        yield { type: 'block-start', index, blockType: block.type };
        yield { type: 'block-end', index, block };
      }
      yield { type: 'usage', usage: reported };
      yield { type: 'finish', reason: finishReason(payload.choices?.[0]?.finish_reason, blocks.some(block => block.type === 'tool-call')) };
    } catch (error) {
      release();
      let accountingError;
      try{if(registered&&!accounted)await this.onCallError?.({id:usageId,dispatched,code:error.code??'CALL_INTERRUPTED'});}catch(failure){accountingError=failure;}
      const normalized = accountingError?new LlmError('费用状态未能持久化，停止运行并保留请求预留','BILLING_PERSISTENCE_FAILED',{cause:accountingError}):
        error instanceof LlmError ? error : !dispatched&&typeof error.status==='number'&&typeof error.code==='string'?new LlmError(error.message,error.code):
        options.signal?.aborted ? options.signal.reason ?? error : new LlmError('无法连接中转站执行模型请求', 'CONNECTION_FAILED', { cause: error });
      this.onError?.(normalized);
      throw normalized;
    }
  }
}
