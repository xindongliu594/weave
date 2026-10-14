import { randomUUID } from 'node:crypto';
import { LlmAdapter, LlmError, attributionHeaders } from '@deepseek-ai/dsh-llm';
import { fitAffordableMessages, fitMessages } from './limits.mjs';
import { ExecutionBudget } from './budget.mjs';
import { dedupeReadOnlyEvidence, readOnlyEvidenceSignature, completedWriteEvidenceSignature } from './request-context.mjs';
import { completionRequest, completionResponse, completionUsage, conversationHeaders } from './completion-protocol.mjs';
import { modelCompletionOptions } from './completion-options.mjs';
import { joinContextSections } from '@deepseek-ai/dsh-system-prompt';

// The native prompt plugin explicitly replaces its full runtime snapshot at
// each step. Keep the journal intact, but do not spend the wire budget on old
// copies that displace work history. Text resemblance alone is never enough.
function currentRuntimeMessages(messages) {
  const sections = message => {
    const source=message.source,list=source?.sections;
    if(message.role!=='user'||source?.kind!=='plugin'||source.plugin!=='@deepseek-ai/dsh-system-prompt'||source.form!=='snapshot'||
      !Array.isArray(list)||!list.length||list.some(item=>typeof item.name!=='string'||typeof item.text!=='string')||
      new Set(list.map(item=>item.name)).size!==list.length||!list.some(item=>item.name==='department:approved-context')||
      message.content?.length!==1||message.content[0].type!=='text'||message.content[0].text!==joinContextSections(list))return;
    return list;
  };
  const latest=messages.findLastIndex(message=>sections(message));
  if(latest<0)return {messages,removed:0};
  const covered=new Set(sections(messages[latest]).map(item=>item.name));
  const retained=messages.filter((message,index)=>index>=latest||!sections(message)?.every(item=>covered.has(item.name)));
  return {messages:retained,removed:messages.length-retained.length};
}

function responsesHistory(messages) {
  if (!Array.isArray(messages)) throw new LlmError('Responses 请求缺少完整对话历史', 'INVALID_COMPLETION_HISTORY');
  for (const message of messages) {
    if (!message || !['system', 'developer', 'user', 'assistant', 'tool'].includes(message.role)
      || !Array.isArray(message.content) || message.content.some(block => !block || !['text', 'reasoning', 'tool-call', 'tool-result'].includes(block.type)
        || ['text', 'reasoning'].includes(block.type) && typeof block.text !== 'string'))
      throw new LlmError('Responses 兼容层仅支持文本与原生函数历史', 'INVALID_COMPLETION_HISTORY');
    if (message.content.some(block => block.type === 'reasoning' && block.text))
      throw new LlmError('Responses 兼容层无法无损重放历史推理状态', 'UNSUPPORTED_REASONING');
    const results = message.content.filter(block => block.type === 'tool-result');
    if (results.length && (results.length !== 1 || message.content.length !== 1 || !Array.isArray(results[0].content)
      || results[0].content.some(part => part?.type !== 'text' || typeof part.text !== 'string')))
      throw new LlmError('Responses 工具结果必须是独立的完整文本结果；没有丢弃历史', 'INVALID_COMPLETION_HISTORY');
  }
}

/** Fit an explicitly configured envelope with the same complete Chat groups.
 * No output cap, tool schema or protected evidence text is changed. */
function fitWireMessages(messages, request, { maxBytes, inputRate, outputRate, maxTokens, availableBudget }, protectedIndexes, protocol) {
  const label = protocol === 'responses' ? 'Responses' : 'Chat Completions';
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || ![inputRate, outputRate, availableBudget].every(value => Number.isFinite(value) && value >= 0)
    || !Number.isSafeInteger(maxTokens) || maxTokens < 1) throw new LlmError(`${label} 预算、价格、输出上限或上下文上限无效`, 'INVALID_BUDGET_CONTEXT');
  const size = value => Buffer.byteLength(JSON.stringify(value));
  const lastAssistant = messages.findLastIndex(message => message.role === 'assistant');
  const essential = lastAssistant < 0 ? protectedIndexes : [...protectedIndexes, lastAssistant];
  const packet = fitted => {
    const wire = completionRequest(protocol, request(fitted.messages));
    const afterBytes = size(wire.body), inputUpperBound = afterBytes + 1024;
    const reservation = (inputUpperBound * inputRate + maxTokens * outputRate) / 1e6;
    return { ...fitted, ...wire, afterBytes, inputUpperBound, reservation };
  };
  const beforeBytes = size(completionRequest(protocol, request(messages)).body);
  let minimumLimit = 1, high = size(messages);
  while (minimumLimit < high) {
    const middle = Math.floor((minimumLimit + high) / 2);
    try { fitMessages(messages, middle, essential); high = middle; } catch { minimumLimit = middle + 1; }
  }
  const minimum = packet(fitMessages(messages, minimumLimit, essential));
  if (minimum.afterBytes > maxBytes) throw new LlmError(`CONTEXT_LIMIT: ${label} 完整受保护请求超过字节或上下文上限；没有发送模型请求`, 'CONTEXT_LIMIT');
  const blocked = () => {
    const error = new LlmError(`BUDGET_CONTEXT_LIMIT: 原预算无法容纳 ${label} 完整受保护请求；没有发送模型请求`, 'BUDGET_CONTEXT_LIMIT');
    error.details = Object.freeze({ beforeBytes, maxMessageBytes: maxBytes, availableBudget, maxTokens });
    return error;
  };
  if (!Number.isFinite(minimum.reservation) || minimum.reservation > availableBudget) throw blocked();
  let low = minimumLimit; high = Math.min(size(messages), maxBytes);
  let result = minimum;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2), candidate = packet(fitMessages(messages, middle, essential));
    if (candidate.afterBytes <= maxBytes && candidate.reservation <= availableBudget) { result = candidate; low = middle + 1; }
    else high = middle - 1;
  }
  return { ...result, beforeBytes, maxMessageBytes: high };
}

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

function pinnedEvidence(value) {
  const pending = [value];
  while (pending.length) {
    const item = pending.pop();
    if (!item || typeof item !== 'object') continue;
    if (Array.isArray(item)) { for (const entry of item) pending.push(entry); continue; }
    if (/^[a-f0-9]{64}$/i.test(item.sha256 ?? '') &&
        (typeof item.path === 'string' || typeof item.documentId === 'string' && Number.isSafeInteger(item.version))) return true;
    for (const key of ['value', 'result', 'results']) if (item[key]) pending.push(item[key]);
  }
  return false;
}

function protectedWireIndexes(options, wire, checkpoint) {
  if (options.purpose === 'compaction') return wire.map((_, index) => index);
  const protectedIndexes = checkpoint < 0 ? [] : [checkpoint + (options.system ? 1 : 0)];
  const approvedContext = options.messages.findLastIndex(message => message.source?.kind === 'plugin' &&
    message.source.plugin === '@deepseek-ai/dsh-system-prompt' && message.source.form === 'snapshot' &&
    message.source.sections?.some(section => section.name === 'department:approved-context'));
  if (approvedContext >= 0) protectedIndexes.push(approvedContext + (options.system ? 1 : 0));
  const names = new Map(options.messages.flatMap(message => message.content.filter(block => block.type === 'tool-call').map(block => [block.id, block.name])));
  for (const [index, message] of wire.entries()) {
    if (message.role !== 'tool') continue;
    if (['knowledge_search', 'knowledge_read'].includes(names.get(message.tool_call_id))) { protectedIndexes.push(index); continue; }
    try { if (pinnedEvidence(JSON.parse(message.content))) protectedIndexes.push(index); } catch { /* Non-JSON tool data has no fixed file/citation metadata. */ }
  }
  return protectedIndexes;
}

// Wire text alone cannot prove a successful native tool result. Require the
// original source and the Host's source-side hashes before comparing groups.
function nativeReadGroup(options, indexes, calls) {
  const offset = options.system ? 1 : 0;
  const assistant = options.messages[indexes[0] - offset];
  if (assistant?.role !== 'assistant' || !Array.isArray(assistant.content) ||
      assistant.content.some(block => !['text', 'reasoning', 'tool-call'].includes(block.type))) return false;
  const nativeCalls = assistant.content.filter(block => block.type === 'tool-call');
  if (nativeCalls.length !== calls.length || nativeCalls.some((call, index) => call.id !== calls[index].callId)) return false;
  return calls.every((call, index) => {
    const result = options.messages[indexes[index + 1] - offset];
    if (!['user','tool'].includes(result?.role) || result.source?.kind !== 'tool' || result.source.callId !== call.callId ||
        result.content?.length !== 1) return false;
    const block = result.content[0];
    return block.type === 'tool-result' && block.toolCallId === call.callId && block.isError === false &&
      Array.isArray(block.content) && block.content.every(part => part.type === 'text' && typeof part.text === 'string');
  });
}

function supersededFileReads(options, source, attest) {
  if(typeof attest!=='function'||options.purpose==='compaction')return [];
  const offset=options.system?1:0,calls=new Map(),counts=new Map(),resultCounts=new Map(),reads=[],writes=[];
  for(const [index,message] of options.messages.entries())for(const call of message.content?.filter(block=>block.type==='tool-call')??[]){
    counts.set(call.id,(counts.get(call.id)??0)+1);calls.set(call.id,{call,index,role:message.role});
  }
  for(const message of options.messages)for(const block of message.content??[])if(block.type==='tool-result')resultCounts.set(block.toolCallId,(resultCounts.get(block.toolCallId)??0)+1);
  for(const [index,message] of options.messages.entries()){
    const block=message.content?.[0],entry=calls.get(block?.toolCallId);
    if(!entry||entry.role!=='assistant'||counts.get(block.toolCallId)!==1||resultCounts.get(block.toolCallId)!==1||entry.index>=index||!['user','tool'].includes(message.role)||
      message.source?.kind!=='tool'||message.source.callId!==block.toolCallId||message.content.length!==1||
      block.type!=='tool-result'||block.isError!==false||block.content?.some(part=>part.type!=='text'||typeof part.text!=='string'))continue;
    let args,value;try{args=JSON.parse(entry.call.arguments);value=JSON.parse(source[index+offset].content);}catch{continue;}
    const signature=entry.call.name==='filesystem'?readOnlyEvidenceSignature('filesystem',args,value):
      entry.call.name==='artifact_write'?completedWriteEvidenceSignature(args,value):undefined;
    if(!signature)continue;
    const proof={callId:block.toolCallId,...signature,index:index+offset,path:value.path,sha256:value.sha256};
    (entry.call.name==='filesystem'?reads:writes).push(proof);
  }
  const result=[];
  for(const read of reads)for(const write of writes){
    if(write.index<=read.index||read.path!==write.path||read.sha256!==write.expectedSha256||read.sha256===write.sha256)continue;
    let proof;try{proof=attest({read,write});}catch{continue;}
    if(!proof||typeof proof.then==='function'||proof.successful!==true||proof.complete!==true||proof.superseded!==true||!/^[a-f0-9]{64}$/.test(proof.scopeId??''))continue;
    result.push({readIndex:read.index,writeIndex:write.index,path:read.path,oldSha256:read.sha256,newSha256:write.sha256,scopeId:proof.scopeId,
      readCallId:read.callId,writeCallId:write.callId});break;
  }
  return result;
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

function responseRequestId(response, name, apiKey) {
  const value = response.headers?.get(name);
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value) || (apiKey && value.includes(apiKey))) return undefined;
  return value;
}

function responseMetadata(response, id, apiKey) {
  const providerRequestId = responseRequestId(response, 'x-oneapi-request-id', apiKey);
  const upstreamRequestId = responseRequestId(response, 'x-upstream-request-id', apiKey);
  const responseRequestIdValue = responseRequestId(response, 'x-request-id', apiKey);
  return {
    id, providerStatus: response.status,
    ...(providerRequestId ? { providerRequestId } : {}),
    ...(upstreamRequestId ? { upstreamRequestId } : {}),
    ...(responseRequestIdValue ? { responseRequestId: responseRequestIdValue } : {}),
  };
}

const ERROR_BODY_BYTES = 16 * 1024;
const ERROR_BODY_TIMEOUT_MS = 1500;
function cancelErrorBody(body) {
  // Cancellation is best effort: an untrusted stream must not keep failure
  // accounting waiting for its cancel callback to finish.
  try { body?.cancel()?.catch?.(() => {}); } catch { /* Keep the HTTP failure. */ }
}

async function boundedErrorBody(response, signal) {
  signal?.throwIfAborted();
  const contentType = response.headers?.get('content-type')?.split(';')[0].trim().toLowerCase();
  const length = response.headers?.get('content-length');
  if ((contentType && contentType !== 'text/plain' && !/^application\/(?:[a-z0-9!#$&^_.+-]+\+)?json$/.test(contentType)) ||
      (/^\d+$/.test(length ?? '') && Number(length) > ERROR_BODY_BYTES)) {
    cancelErrorBody(response.body); return null;
  }
  let reader;
  try { reader = response.body?.getReader?.(); } catch { cancelErrorBody(response.body); return null; }
  if (!reader) return null;
  let timer, onAbort;
  try {
    const reading = (async () => {
      const chunks = []; let bytes = 0;
      // Also bound empty/tiny chunks, which could otherwise starve the timer.
      for (let count = 0; count < 128; count++) {
        const { value, done } = await reader.read();
        signal?.throwIfAborted();
        if (done) return Buffer.concat(chunks, bytes).toString('utf8');
        bytes += value.byteLength;
        if (bytes > ERROR_BODY_BYTES) return null;
        chunks.push(Buffer.from(value));
      }
      return null;
    })().catch(() => null);
    const result = await Promise.race([
      reading,
      new Promise(resolve => { timer = setTimeout(() => resolve(null), ERROR_BODY_TIMEOUT_MS); }),
      new Promise(resolve => { onAbort = () => resolve(null); if (signal?.aborted) onAbort(); else signal?.addEventListener('abort', onAbort, { once: true }); }),
    ]);
    signal?.throwIfAborted();
    return result;
  } finally {
    clearTimeout(timer); if (onAbort) signal?.removeEventListener('abort', onAbort);
    cancelErrorBody(reader);
    try { reader.releaseLock(); } catch { /* A cancelled read may still be pending. */ }
  }
}

function safeErrorText(value, apiKey, limit) {
  if (typeof value !== 'string') return '';
  let text = value;
  if (apiKey) {
    const secrets = new Set([apiKey]);
    try {
      const encoded = encodeURIComponent(apiKey);
      secrets.add(encoded); secrets.add(encoded.replace(/%[a-f0-9]{2}/gi, value => value.toLowerCase()));
      secrets.add(Buffer.from(apiKey).toString('base64')); secrets.add(Buffer.from(apiKey).toString('base64url'));
    } catch { /* Invalid keys never add diagnostic data. */ }
    for (const secret of secrets) text = text.split(secret).join('[REDACTED]');
  }
  text = text.replace(/\b(?:Bearer|Basic)\s+[^\s"'<>(),;]+/gi, '[REDACTED]')
    .replace(/\bsk-[a-z0-9_-]+/gi, '[REDACTED]')
    .replace(/\beyJ[a-z0-9_-]+\.[a-z0-9_-]+\.[a-z0-9_-]+\b/gi, '[REDACTED]')
    .replace(/\bauthorization["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\r\n,;<>]*)/gi, 'authorization=[REDACTED]')
    .replace(/\b(api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|secret|password|credential)["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;&<>]+)/gi, '$1=[REDACTED]')
    .replace(/\bhttps?:\/\/[^@\s/"<>]+@/gi, 'https://[REDACTED]@')
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '\ufffd').replace(/\s+/g, ' ').trim();
  if (/<[!/a-z]/i.test(text)) return '';
  if (text.length <= limit) return text;
  let clipped = text.slice(0, limit - 1);
  if (/[\ud800-\udbff]$/.test(clipped)) clipped = clipped.slice(0, -1);
  return clipped + '…';
}

async function upstreamErrorSummary(response, apiKey, signal) {
  const text = await boundedErrorBody(response, signal);
  if (!text?.trimStart().startsWith('{')) return '';
  let payload;
  try { payload = JSON.parse(text); } catch { return ''; }
  const source = payload?.error && typeof payload.error === 'object' && !Array.isArray(payload.error) ? payload.error : payload;
  const parts = [];
  for (const key of ['code', 'type']) {
    const value = safeErrorText(source?.[key], apiKey, 65);
    if (/^[a-z0-9][a-z0-9_.:-]{0,63}$/i.test(value)) parts.push(`${key}=${value}`);
  }
  const message = safeErrorText(typeof payload?.error === 'string' ? payload.error : source?.message, apiKey, 360);
  if (message) parts.push(JSON.stringify(message));
  // Diagnostic scalar data only: never forward a provider object or raw body
  // as model content, a tool call, an instruction or a persisted cause.
  return parts.length ? `；上游错误摘要（仅诊断）：${parts.join('；')}` : '';
}

export class OpenAiCompatibleAdapter extends LlmAdapter {
  constructor({ routes, maxBudget, onUsage, onError, maxModelCalls = 100, contextBytes = 64000, signal, onContext, onRequest, onResponse, onFallback, priorSpend=0,priorModelCalls=0,tasks=[],maxTaskModelCalls=40,taskUsage={},taskCallCeilings,onBudget,beforeRequest,onCallError }) {
    super();
    this.routes = new Map(routes.map(route => [route.id, Object.freeze({ ...route })]));
    this.maxBudget = maxBudget;
    this.onUsage = onUsage;
    this.onError = onError;
    this.spent = 0;
    this.reserved = 0;
    this.maxModelCalls=maxModelCalls; this.calls=0; this.contextBytes=contextBytes; this.signal=signal; this.onContext=onContext;
    this.onRequest=onRequest;this.onFallback=onFallback;this.sessionPolicies=new Map();
    this.budget=new ExecutionBudget({maxBudget,priorSpend,maxModelCalls,priorModelCalls,tasks,maxTaskModelCalls,taskUsage,taskCallCeilings,onEvent:onBudget});
    this.taskOutputCaps = new Map();
    for (const task of tasks) if (task.maxOutputTokens !== undefined) {
      if (!Number.isSafeInteger(task.maxOutputTokens) || task.maxOutputTokens < 1 || task.maxOutputTokens > 32768)
        throw new LlmError('批准快照中的任务单次输出上限无效，停止执行', 'INVALID_TASK_OUTPUT_LIMIT');
      this.taskOutputCaps.set(task.id, task.maxOutputTokens);
    }
    this.beforeRequest=beforeRequest;this.onResponse=onResponse;this.onCallError=onCallError;
    this.activeRequests = new Map();
  }

  stopAdmission(error = new LlmError('运行正在停止，禁止新的模型调用', 'RUNTIME_STOPPING')) { this.stopReason ??= error; }
  get pendingRequests() { return [...this.activeRequests.values()].filter(request => request.dispatched).length; }
  async drain(timeoutMs = 30000, signal = this.signal) {
    const requests = [...this.activeRequests.values()].filter(request => request.dispatched);
    const result = (timedOut = false, aborted = false) => ({ pendingRequests: requests.filter(request => this.activeRequests.has(request.id)).length, finishedRequests: requests.filter(request => !this.activeRequests.has(request.id)).length, timedOut, aborted });
    if (!requests.length) return result();
    let timer, onAbort;
    try {
      return await Promise.race([
        Promise.all(requests.map(request => request.done)).then(() => result()),
        new Promise(resolve => { timer = setTimeout(() => resolve(result(true)), Math.min(30000, Math.max(0, Number.isFinite(timeoutMs) ? timeoutMs : 30000))); }),
        new Promise(resolve => { onAbort = () => resolve(result(false, true)); if (signal?.aborted) onAbort(); else signal?.addEventListener('abort', onAbort, { once: true }); }),
      ]);
    } finally { clearTimeout(timer); if (onAbort) signal?.removeEventListener('abort', onAbort); }
  }

  providerInfo(provider) { return { id: provider, name: 'Agent Department Relay' }; }
  async listModels(provider) { return [...this.routes.values()].map(route => ({ provider, id: route.id, name: route.name })); }
  async resolveModel(provider, model) {
    const route = this.routes.get(model);
    if (!route) throw new LlmError(`运行快照中不存在模型 ${model}`, 'UNKNOWN_MODEL');
    return { provider, id: model, name: route.name, defaultMaxTokens: route.maxOutputTokens,
      ...(route.contextWindowTokens ? { context: { contextWindow: route.contextWindowTokens } } : {}) };
  }

  /** Builds the same packet as stream, but never reserves, emits, counts or
   * dispatches. A successful preview is not a ticket for a later request. */
  prepareRequest(options) { return this.#prepareRequest(options, false); }

  #prepareRequest(options, notifyBudget) {
    if (this.stopReason) throw this.stopReason;
    const route = this.routes.get(options.model);
    if (!route) throw new LlmError(`运行快照中不存在模型 ${options.model}`, 'UNKNOWN_MODEL');
    options.signal?.throwIfAborted(); this.signal?.throwIfAborted();
    let configured;
    try { configured = modelCompletionOptions(route); }
    catch (error) { throw new LlmError(error.message, error.code); }
    const retainOriginal = options.purpose !== 'compaction' && this.requireCompleteContext?.(options.sessionId) === true;
    const runtimeSnapshots=options.purpose==='compaction'||retainOriginal?{messages:options.messages,removed:0}:currentRuntimeMessages(options.messages);
    options={...options,messages:runtimeSnapshots.messages};
    const fullEnvelope = route.protocol === 'responses' || route.thinkingMode !== undefined;
    if (route.protocol === 'responses') {
      responsesHistory(options.messages);
      const policyEffort = this.sessionPolicies.get(options.sessionId)?.reasoningEffort;
      const effort = policyEffort === undefined ? options.reasoningEffort : policyEffort;
      if (effort !== undefined && effort !== 'none') throw new LlmError('Responses 兼容层当前仅支持 reasoning none；不会丢弃加密推理状态', 'UNSUPPORTED_REASONING');
    }
    // Validate Go's stable identity before any durable reservation or dispatch.
    const headers = conversationHeaders(route.baseUrl, options.sessionId);
    const source = [...(options.system ? [{ role: 'system', content: options.system }] : []), ...options.messages.map(toWireMessage)];
    const limit = Math.min(this.contextBytes, route.contextBytes ?? this.contextBytes);
    const checkpoint = options.messages.findLastIndex(message => message.source?.kind === 'plugin' && message.source.plugin === 'compact');
    const attribution={ ...(this.attribution?.(options.sessionId)??{sessionId:options.sessionId}), requestPurpose: options.purpose === 'compaction' ? 'compaction' : 'execution' };
    const closure=this.handoffClosure?.(options.sessionId);
    if(closure){
      if(closure.taskId!==attribution.taskId||closure.attemptId!==attribution.attemptId)throw new LlmError('交接阶段与当前任务身份不一致','HANDOFF_IDENTITY');
      if(options.purpose==='compaction')throw new LlmError('最后一次调用保留用于正式交接，不能用于上下文压缩','HANDOFF_CALL_RESERVED');
      if(!options.tools?.some(tool=>tool.name==='agent_teams_update_task'))throw new LlmError('交接阶段缺少正式任务更新工具，未发送请求','HANDOFF_TOOL_MISSING');
      attribution.requestPurpose='handoff';
      attribution.handoffTaskStatus=closure.taskStatus;
    }
    const tools = options.tools?.filter(tool=>!closure||tool.name==='agent_teams_update_task').map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: structuredClone(tool.parameters) } }));
    const fallback = !!options.fallbackAttempted || !!attribution.reworkRound;
    // A known truncated summary never grants permission to discard its source.
    // The trusted employee context gate applies to preview AND dispatch, so a
    // concurrent budget change cannot turn the preview into a lossy request.
    const expired = retainOriginal ? [] : supersededFileReads(options,source,meta=>this.attestSupersededRead?.({...attribution,...meta}));
    const expiredIndexes=new Set(expired.map(item=>item.readIndex));
    const protectedSource = retainOriginal ? source.map((_, index) => index) : protectedWireIndexes(options, source, checkpoint);
    const deduplicated = dedupeReadOnlyEvidence(source, protectedSource.filter(index=>!expiredIndexes.has(index)), {
      pairwise: true,
      attestGroup: options.purpose === 'compaction' || retainOriginal ? undefined : meta => nativeReadGroup(options, meta.indexes, meta.calls) ?
        this.attestReadGroup?.({ ...attribution, ...meta }) : undefined,
    });
    const original = deduplicated.messages, protectedIndexes = deduplicated.protectedIndexes;
    const chatBody = (messages, maxTokens) => ({
      model: route.wireModel, messages, stream: false, max_tokens: maxTokens,
      ...(tools?.length ? { tools } : {}),
      ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
      ...(options.stop?.length ? { stop: options.stop } : {}),
      ...((this.sessionPolicies.get(options.sessionId)?.reasoningEffort??options.reasoningEffort) ? { reasoning_effort: this.sessionPolicies.get(options.sessionId)?.reasoningEffort??options.reasoningEffort } : {}),
      ...configured,
    });
    let fitted, maxTokens;
    try {
      if (options.purpose === 'compaction' && Buffer.byteLength(JSON.stringify(original)) > limit)
        throw new LlmError('CONTEXT_LIMIT: 摘要输入超过字节上限，保留原始历史，不能丢弃来源后生成摘要', 'CONTEXT_LIMIT');
      const availableBudget = notifyBudget ? this.budget.available(attribution, fallback) : this.budget.peekAvailable(attribution, fallback);
      // The approved whole-task estimate is never a per-request output cap.
      // Resolve only after task/employee admission; missing legacy fields and
      // unattributed coordination retain the original pinned route limit.
      const taskOutputCap = attribution.taskId ? this.taskOutputCaps.get(attribution.taskId) : undefined;
      maxTokens = Math.max(1, Math.min(options.maxTokens ?? route.maxOutputTokens, route.maxOutputTokens, taskOutputCap ?? route.maxOutputTokens));
      const wireLimit = route.protocol === 'responses' && Number.isSafeInteger(route.contextWindowTokens) && route.contextWindowTokens > 0
        ? Math.min(limit, route.contextWindowTokens - maxTokens - 1024) : limit;
      if (wireLimit < 1) throw new LlmError('CONTEXT_LIMIT: 输出上限与保守字节余量已超过模型上下文上限；没有发送模型请求', 'CONTEXT_LIMIT');
      fitted = fullEnvelope
        ? fitWireMessages(original, messages => chatBody(messages, maxTokens),
          { maxBytes:wireLimit, inputRate:route.inputRate, outputRate:route.outputRate, maxTokens, availableBudget }, protectedIndexes, route.protocol ?? 'chat-completions')
        : fitAffordableMessages(original, tools, { maxBytes:limit, inputRate:route.inputRate, outputRate:route.outputRate, maxTokens, availableBudget }, protectedIndexes);
      fitted.availableBudget = availableBudget;
      fitted.deduplicatedGroups = deduplicated.removedGroups;
      fitted.deduplicatedBytes = deduplicated.beforeBytes - deduplicated.afterBytes;
      fitted.evidenceDuplicates = deduplicated.duplicates;
      fitted.supersededReads = expired;
      fitted.supersededRuntimeSnapshots=runtimeSnapshots.removed;
    }
    catch(error) {
      let failure = error instanceof LlmError ? error : typeof error?.code === 'string' ? new LlmError(error.message, error.code) : error;
      if (error?.code === 'BUDGET_CONTEXT_LIMIT' && error.details) {
        const { beforeBytes, maxMessageBytes, availableBudget, maxTokens } = error.details;
        const reservationBefore = ((beforeBytes + 1024) * route.inputRate + maxTokens * route.outputRate) / 1e6;
        // Find the exact lower bound under the same whole-group protections.
        // It is a one-request minimum, never an estimate of finishing a task.
        const lastAssistant = original.findLastIndex(message => message.role === 'assistant');
        const essential = lastAssistant < 0 ? protectedIndexes : [...protectedIndexes, lastAssistant];
        let low = 1, high = Buffer.byteLength(JSON.stringify(original));
        while (low < high) {
          const middle = Math.floor((low + high) / 2);
          try { fitMessages(original, middle, essential); high = middle; } catch { low = middle + 1; }
        }
        const minimum = fitMessages(original, low, essential);
        const minimumEnvelopeBytes = Buffer.byteLength(JSON.stringify(fullEnvelope
          ? completionRequest(route.protocol, chatBody(minimum.messages, maxTokens)).body : { messages: minimum.messages, tools }));
        const minimumReservation = ((minimumEnvelopeBytes + 1024) * route.inputRate + maxTokens * route.outputRate) / 1e6;
        const additionalBudget = Math.max(0, minimumReservation - availableBudget);
        // These internal facts are numbers only. The original request amount is
        // deliberately not described as the minimum protected-context cost.
        const byteLabel = fullEnvelope ? `精简前实际 ${route.protocol === 'responses' ? 'Responses' : 'Chat Completions'} 请求` : '精简前消息与工具';
        const limitLabel = fullEnvelope ? '当前请求字节上限' : '当前可容纳消息字节';
        failure = new LlmError(`${error.message}；${byteLabel} ${beforeBytes} 字节，精简前预留 $${reservationBefore.toFixed(8)}；${limitLabel} ${maxMessageBytes}；可用预算 $${availableBudget.toFixed(8)}；输出上限 ${maxTokens} tokens 保持不变；单次完整上下文最低预留 $${minimumReservation.toFixed(8)}，至少另需 $${additionalBudget.toFixed(8)}`, error.code);
        failure.contextBudget = Object.freeze({ beforeBytes, reservationBefore, maxMessageBytes, availableBudget, maxTokens, minimumEnvelopeBytes, minimumReservation, additionalBudget });
      }
      throw failure;
    }
    const { path, body } = completionRequest(route.protocol, chatBody(fitted.messages, maxTokens));
    return { path, body, headers, protocol: route.protocol ?? 'chat-completions', fitted, attribution, fallback, maxTokens, reservation: fitted.reservation };
  }

  async *stream(options) {
    if (this.stopReason) throw this.stopReason;
    const fused = AbortSignal.any([...(options.signal ? [options.signal] : []), ...(this.signal ? [this.signal] : []), AbortSignal.timeout(90000)]);
    options = { ...options, signal: fused };
    const route = this.routes.get(options.model);
    if (!route) throw new LlmError(`运行快照中不存在模型 ${options.model}`, 'UNKNOWN_MODEL');
    options.signal?.throwIfAborted();
    let prepared, ticket;
    try {
      prepared = this.#prepareRequest(options, true);
      // This deliberately rebuilds a preview. Fitting and reservation are
      // synchronous, so no employee can take this allowance between them.
      ticket = this.budget.reserve(prepared.reservation, prepared.attribution, prepared.fallback);
    } catch (error) { this.onError?.(error); throw error; }
    const { path, body, headers, protocol, fitted, attribution, maxTokens, reservation } = prepared;
    this.calls++;this.reserved+=reservation;
    let reservationHeld=true;
    const release=()=>{ticket.release();if(reservationHeld){this.reserved=Math.max(0,this.reserved-reservation);reservationHeld=false;}};
    let response, receivedMetadata;
    const started=Date.now();
    const usageId=randomUUID();let registered=false,dispatched=false,accounted=false;
    let finishRequest;
    const activeRequest = { id: usageId, dispatched: false, done: new Promise(resolve => { finishRequest = resolve; }) };
    this.activeRequests.set(usageId, activeRequest);
    try {
      if(fitted.removed || fitted.deduplicatedGroups || fitted.supersededRuntimeSnapshots) this.onContext?.({ sessionId: options.sessionId, modelId: route.id, requestPurpose: attribution.requestPurpose, removedGroups: fitted.removed,
        deduplicatedGroups:fitted.deduplicatedGroups,deduplicatedBytes:fitted.deduplicatedBytes,evidenceDuplicates:fitted.evidenceDuplicates,supersededReads:fitted.supersededReads,
        supersededRuntimeSnapshots:fitted.supersededRuntimeSnapshots,
        beforeBytes:fitted.beforeBytes,afterBytes:fitted.afterBytes,inputUpperBound:fitted.inputUpperBound,reservation,availableBudget:fitted.availableBudget,maxTokens,
        note:'完整记录仍保存在追溯档案；仅精简较早完整对话组、经宿主证实的精确重复只读对，或经同任务成功CAS写入替换的过期可写输出读版本。重复对的独立说明保留，固定输入和知识版本不失去保护，新版完整代码保留；未降低输出上限或预留公式。' });
      await this.beforeRequest?.({id:usageId,...attribution,modelId:route.id,reservation},options.signal);registered=!!this.beforeRequest;
      options.signal?.throwIfAborted();
      if (this.stopReason) throw this.stopReason;
      this.onRequest?.({usageId,...attribution,modelId:route.id,protocol,path,body,reservation});
      dispatched=true; activeRequest.dispatched = true;
      response = await fetch(route.baseUrl.replace(/\/$/, '') + path, {
        method: 'POST', signal: options.signal, redirect: 'error',
        headers: { 'Content-Type': 'application/json', ...attributionHeaders(), ...headers, ...(route.apiKey ? { Authorization: `Bearer ${route.apiKey}` } : {}) },
        body: JSON.stringify(body),
      });
      // Response audit metadata is opt-in so legacy error callbacks retain their payload shape.
      receivedMetadata = this.onResponse ? responseMetadata(response, usageId, route.apiKey) : undefined;
      try { await this.onResponse?.({ ...receivedMetadata }); }
      catch (cause) { throw new LlmError('中转站响应信息未能持久化，停止运行并保留请求预留', 'BILLING_PERSISTENCE_FAILED', { cause }); }
      options.signal?.throwIfAborted();
      if (!response.ok) {
        const summary = await upstreamErrorSummary(response, route.apiKey, options.signal);
        options.signal?.throwIfAborted();
        const fallbackId=this.sessionPolicies.get(options.sessionId)?.fallbackModelId;
        if(protocol !== 'responses' && !this.stopReason && !options.fallbackAttempted && [429,503].includes(response.status) && fallbackId && this.routes.has(fallbackId) && fallbackId!==route.id){
          if(registered)await this.onCallError?.({...receivedMetadata,id:usageId,dispatched:true,code:'HTTP_'+response.status});accounted=true;
          release();
          this.onFallback?.({sessionId:options.sessionId,from:route.id,to:fallbackId,status:response.status});
          yield* this.stream({...options,model:fallbackId,fallbackAttempted:true});return;
        }
        throw new LlmError(`中转站返回 HTTP ${response.status}${summary}`, response.status === 401 || response.status === 403 ? 'AUTH' : response.status === 429 ? 'RATE_LIMIT' : 'PROVIDER_ERROR', { status: response.status });
      }
      let payload;
      try { payload = await response.json(); }
      catch { throw new LlmError('中转站返回的模型响应不是 JSON', 'INVALID_RESPONSE'); }
      const reported = usageOf(completionUsage(protocol, payload));
      if (!reported) throw new LlmError('中转站未返回标准 Token 用量，已停止本次运行', 'USAGE_MISSING');
      const actualCost = ((reported.inputTokens + (reported.cacheReadTokens ?? 0)) * route.inputRate + reported.outputTokens * route.outputRate) / 1e6;
      const usageEvent = { id: usageId, ...attribution, modelId: route.id, durationMs:Date.now()-started, inputTokens: reported.inputTokens + (reported.cacheReadTokens ?? 0), outputTokens: reported.outputTokens, cost: actualCost };
      if (protocol === 'responses') {
        // Keep the run/task hold until the fee is durably recorded. A failed
        // write leaves the sent request uncertain and cannot fund another call.
        try { await this.onUsage?.(usageEvent); }
        catch (cause) { throw new LlmError('模型费用未能持久化，停止运行并保留请求预留', 'BILLING_PERSISTENCE_FAILED', { cause }); }
        accounted = true;
        release(); ticket.settle(actualCost); this.spent += actualCost;
      } else {
        release(); ticket.settle(actualCost); this.spent += actualCost;
        await this.onUsage?.(usageEvent); accounted = true;
      }
      ticket.check();
      // The original response may settle its usage after an internal stop, but may never execute a late tool call.
      if (this.stopReason) throw this.stopReason;
      try { payload = completionResponse(protocol, payload); }
      catch (error) { throw new LlmError(error.message, error.code ?? 'INVALID_RESPONSE'); }
      const message = payload.choices?.[0]?.message;
      if (!message || typeof message !== 'object') throw new LlmError('中转站响应缺少 assistant message', 'INVALID_RESPONSE');
      if(attribution.requestPurpose==='handoff'&&!message.tool_calls?.length)
        throw new LlmError('最后一次请求未提交正式交接，实际费用已记录，停止后续调用','HANDOFF_NOT_SUBMITTED');
      // Execution cannot treat a capped response (text or tool arguments) as
      // completed work. Known usage has already been durably recorded above.
      // Compaction owns its separate incomplete-checkpoint/retained-source gate.
      if (options.purpose !== 'compaction' && payload.choices?.[0]?.finish_reason === 'length')
        throw new LlmError(`模型 ${route.wireModel} 的执行输出达到本次 ${maxTokens} Token 上限而被截断；未采纳为完成结果或执行工具。实际用量已记录，不会自动续写或重试。请缩短单次结果，或在项目中重新制定并确认方案。`, 'MAX_TOKENS');
      const blocks = [];
      if (typeof message.reasoning_content === 'string' && message.reasoning_content) blocks.push({ type: 'reasoning', text: message.reasoning_content });
      if (typeof message.content === 'string' && message.content) blocks.push({ type: 'text', text: message.content });
      if (Array.isArray(message.tool_calls)) {
        for (const call of message.tool_calls) {
          if (!call || typeof call.id !== 'string' || typeof call.function?.name !== 'string' || typeof call.function?.arguments !== 'string') throw new LlmError('中转站返回了无效工具调用', 'INVALID_RESPONSE');
          if(attribution.requestPurpose==='handoff'){
            let args;try{args=JSON.parse(call.function.arguments);}catch{throw new LlmError('交接参数不是完整JSON，未执行工具','HANDOFF_ONLY');}
            if(call.function.name!=='agent_teams_update_task'||!['completed','failed'].includes(args?.status))
              throw new LlmError('最后一次调用仅能提交正式完成或失败交接，未执行其他操作','HANDOFF_ONLY');
            if(args.status==='completed'&&attribution.handoffTaskStatus==='claimed')
              throw new LlmError('任务尚未进入进行中，不能从已认领直接提交完成；未执行交接','HANDOFF_ONLY');
          }
          if (protocol === 'responses' && !body.tools?.some(tool => tool.name === call.function.name)) throw new LlmError('Responses 返回了本轮未授权的工具调用', 'INVALID_RESPONSE');
          // The known fee was awaited above. Check every call before yielding
          // any block; a capped, incomplete JSON call cannot reach native tools.
          if (payload.choices[0].finish_reason === 'tool_calls' && reported.outputTokens >= maxTokens) {
            try { JSON.parse(call.function.arguments); }
            catch { throw new LlmError(`模型 ${route.wireModel} 的工具调用 JSON 不完整，输出已达到本次 ${maxTokens} Token 上限；未执行工具。请让 AI 重新规划输出上限或减小单次输出。`, 'OUTPUT_TRUNCATED'); }
          }
          blocks.push({ type: 'tool-call', id: call.id, name: call.function.name, arguments: call.function.arguments });
        }
      }
      if (!blocks.length) throw new LlmError('模型返回了空响应', 'EMPTY_RESPONSE');
      for (const [index, block] of blocks.entries()) {
        if (this.stopReason) throw this.stopReason;
        yield { type: 'block-start', index, blockType: block.type };
        if (this.stopReason) throw this.stopReason;
        yield { type: 'block-end', index, block };
      }
      if (this.stopReason) throw this.stopReason;
      yield { type: 'usage', usage: reported };
      yield { type: 'finish', reason: finishReason(payload.choices?.[0]?.finish_reason, blocks.some(block => block.type === 'tool-call')) };
    } catch (error) {
      // Unknown dispatched Responses fees retain both synchronous holds, even
      // when no durable receipt callback is installed. Chat keeps its contract.
      if (protocol !== 'responses' || !dispatched || accounted) release();
      let accountingError;
      try{if(registered&&!accounted)await this.onCallError?.({...receivedMetadata,id:usageId,dispatched,code:typeof error.code==='string'?error.code:'CALL_INTERRUPTED'});}catch(failure){accountingError=failure;}
      const normalized = accountingError?new LlmError('费用状态未能持久化，停止运行并保留请求预留','BILLING_PERSISTENCE_FAILED',{cause:accountingError}):
        error instanceof LlmError || error === this.stopReason ? error : !dispatched&&typeof error.status==='number'&&typeof error.code==='string'?new LlmError(error.message,error.code):
        options.signal?.aborted ? options.signal.reason ?? error : new LlmError('无法连接中转站执行模型请求', 'CONNECTION_FAILED', { cause: error });
      this.onError?.(normalized);
      throw normalized;
    } finally {
      this.activeRequests.delete(usageId); finishRequest();
    }
  }
}
