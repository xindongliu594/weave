import { createHash } from 'node:crypto';

function failure(message, code = 'UNSUPPORTED_COMPLETION_OPTION') {
  const error = new Error(message); error.code = code; return error;
}
function protocolOf(protocol) {
  if (protocol === undefined || protocol === 'chat-completions') return 'chat-completions';
  if (protocol === 'responses') return protocol;
  throw failure('模型请求协议无效', 'INVALID_COMPLETION_PROTOCOL');
}
function text(value, label) {
  if (typeof value !== 'string') throw failure(`${label}仅支持文本`, 'INVALID_COMPLETION_HISTORY');
  return value;
}
function identifier(value, label, code = 'INVALID_COMPLETION_HISTORY') {
  if (typeof value !== 'string' || !value.trim()) throw failure(`${label}缺失`, code);
  return value;
}
function argumentsOf(value, code = 'INVALID_COMPLETION_HISTORY') {
  if (typeof value !== 'string') throw failure('函数调用参数不是 JSON 文本', code);
  let parsed;
  try { parsed = JSON.parse(value); } catch { throw failure('函数调用参数不是完整 JSON', code); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw failure('函数调用参数必须是 JSON 对象', code);
  return value;
}

/** Explicit stateless, text/native-function compatibility. Chat is untouched. */
export function completionRequest(protocol, chatBody) {
  if (protocolOf(protocol) === 'chat-completions') return { path: '/chat/completions', body: chatBody };
  if (!chatBody || typeof chatBody !== 'object' || !Array.isArray(chatBody.messages))
    throw failure('Responses 请求缺少完整对话历史', 'INVALID_COMPLETION_HISTORY');
  const supported = new Set(['model', 'messages', 'stream', 'max_tokens', 'max_completion_tokens', 'tools', 'tool_choice',
    'parallel_tool_calls', 'response_format', 'temperature', 'top_p', 'reasoning_effort', 'reasoning', 'stop']);
  if (Object.keys(chatBody).some(key => chatBody[key] !== undefined && !supported.has(key)))
    throw failure('Responses 请求包含尚未支持的 Chat 选项');
  if (chatBody.stream !== undefined && chatBody.stream !== false) throw failure('Responses 兼容层仅支持非流式响应');
  if (chatBody.stop?.length) throw failure('Responses 兼容层不能无损转换 stop 条件');
  const reasoning = chatBody.reasoning;
  if (reasoning !== undefined && (!reasoning || typeof reasoning !== 'object' || Array.isArray(reasoning)
    || Object.keys(reasoning).some(key => key !== 'effort'))) throw failure('Responses 兼容层尚不支持保存推理状态', 'UNSUPPORTED_REASONING');
  if (chatBody.reasoning_effort !== undefined && reasoning?.effort !== undefined && chatBody.reasoning_effort !== reasoning.effort)
    throw failure('Responses 推理配置互相冲突', 'UNSUPPORTED_REASONING');
  const effort = chatBody.reasoning_effort === undefined
    ? reasoning?.effort === undefined ? 'none' : reasoning.effort : chatBody.reasoning_effort;
  if (effort !== 'none') throw failure('Responses 兼容层当前仅支持 reasoning none；不会丢弃加密推理状态', 'UNSUPPORTED_REASONING');
  const input = [], calls = new Set(), results = new Set();
  for (const message of chatBody.messages) {
    if (!message || !['system', 'developer', 'user', 'assistant', 'tool'].includes(message.role))
      throw failure('Responses 历史包含无效消息角色', 'INVALID_COMPLETION_HISTORY');
    if (message.reasoning_content || message.reasoning || message.response_items)
      throw failure('Responses 兼容层无法无损重放历史推理状态', 'UNSUPPORTED_REASONING');
    if (message.role === 'tool') {
      const callId = identifier(message.tool_call_id, '工具结果 call_id');
      if (!calls.has(callId) || results.has(callId)) throw failure('工具结果缺少对应调用或重复提交', 'INVALID_COMPLETION_HISTORY');
      results.add(callId); input.push({ type: 'function_call_output', call_id: callId, output: text(message.content, '工具结果') });
      continue;
    }
    const toolCalls = message.tool_calls;
    if (toolCalls !== undefined && (!Array.isArray(toolCalls) || message.role !== 'assistant'))
      throw failure('Responses 历史包含无效函数调用', 'INVALID_COMPLETION_HISTORY');
    if (message.content !== null && message.content !== undefined) input.push({ role: message.role, content: text(message.content, '消息') });
    else if (!toolCalls?.length) throw failure('Responses 历史包含空消息', 'INVALID_COMPLETION_HISTORY');
    for (const call of toolCalls ?? []) {
      if (call?.type !== 'function') throw failure('Responses 兼容层仅支持原生函数工具');
      const callId = identifier(call.id, '函数调用 call_id');
      if (calls.has(callId)) throw failure('Responses 历史包含重复函数调用 ID', 'INVALID_COMPLETION_HISTORY');
      calls.add(callId);
      input.push({ type: 'function_call', call_id: callId, name: identifier(call.function?.name, '函数名称'), arguments: argumentsOf(call.function?.arguments) });
    }
  }
  if (calls.size !== results.size) throw failure('Responses 历史仍有未完成的工具结果；不重放外部操作', 'INVALID_COMPLETION_HISTORY');
  const maxOutput = chatBody.max_completion_tokens ?? chatBody.max_tokens;
  if (!Number.isSafeInteger(maxOutput) || maxOutput < 1) throw failure('Responses 请求缺少有效单次输出上限', 'INVALID_OUTPUT_LIMIT');
  const body = { model: identifier(chatBody.model, '模型'), input, stream: false, max_output_tokens: maxOutput, store: false, reasoning: { effort } };
  if (chatBody.tools !== undefined) {
    if (!Array.isArray(chatBody.tools)) throw failure('Responses 工具目录无效');
    body.tools = chatBody.tools.map(tool => {
      if (tool?.type !== 'function' || !tool.function || typeof tool.function !== 'object') throw failure('Responses 兼容层仅支持原生函数工具');
      if (!tool.function.parameters || typeof tool.function.parameters !== 'object' || Array.isArray(tool.function.parameters)) throw failure('Responses 函数工具缺少原授权参数 schema');
      return { type: 'function', name: identifier(tool.function.name, '工具名称'),
        ...(tool.function.description === undefined ? {} : { description: text(tool.function.description, '工具说明') }),
        parameters: structuredClone(tool.function.parameters), strict: false };
    });
  }
  if (chatBody.tool_choice !== undefined) {
    const choice = chatBody.tool_choice;
    if (['auto', 'none', 'required'].includes(choice)) body.tool_choice = choice;
    else if (choice?.type === 'function') body.tool_choice = { type: 'function', name: identifier(choice.function?.name, '指定工具') };
    else throw failure('Responses 工具选择尚不支持');
  }
  if (chatBody.response_format !== undefined) {
    if (!['text', 'json_object'].includes(chatBody.response_format?.type)) throw failure('Responses 文本格式尚不支持');
    body.text = { format: { type: chatBody.response_format.type } };
  }
  for (const key of ['temperature', 'top_p', 'parallel_tool_calls']) if (chatBody[key] !== undefined) body[key] = chatBody[key];
  return { path: '/responses', body };
}

/** Usage conversion is separate so known usage can settle before output validation. */
export function completionUsage(protocol, payload) {
  if (protocolOf(protocol) === 'chat-completions') return payload?.usage;
  const usage = payload?.usage;
  if (!usage || typeof usage !== 'object') return undefined;
  return { prompt_tokens: usage.input_tokens, completion_tokens: usage.output_tokens,
    ...(usage.total_tokens === undefined ? {} : { total_tokens: usage.total_tokens }),
    ...(usage.input_tokens_details === undefined ? {} : { prompt_tokens_details: structuredClone(usage.input_tokens_details) }),
    ...(usage.output_tokens_details === undefined ? {} : { completion_tokens_details: structuredClone(usage.output_tokens_details) }) };
}

export function completionResponse(protocol, payload) {
  if (protocolOf(protocol) === 'chat-completions') return payload;
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.output)) throw failure('Responses 响应缺少 output', 'INVALID_RESPONSE');
  if (payload.status !== 'completed') throw failure('Responses 响应尚未完整完成；不执行工具', 'INCOMPLETE_RESPONSE');
  const parts = [], toolCalls = [], callIds = new Set();
  for (const item of payload.output) {
    if (item?.type === 'reasoning') {
      // Some none-effort gateways still emit an empty container. Missing usage
      // is not proof of emptiness, nor is an empty visible summary of a cipher.
      const empty = payload.usage?.output_tokens_details?.reasoning_tokens === 0
        && (item.encrypted_content == null || item.encrypted_content === '')
        && (item.summary === undefined || Array.isArray(item.summary) && item.summary.length === 0)
        && (item.content === undefined || Array.isArray(item.content) && item.content.length === 0)
        && (item.status === undefined || item.status === 'completed')
        && Object.keys(item).every(key => ['type', 'id', 'status', 'summary', 'content', 'encrypted_content'].includes(key));
      if (empty) continue;
      throw failure('Responses 返回推理状态，当前兼容层不能无损续接；不执行工具', 'UNSUPPORTED_REASONING');
    }
    if (item?.status !== undefined && item.status !== 'completed') throw failure('Responses 输出项未完成；不执行工具', 'INCOMPLETE_RESPONSE');
    if (item?.type === 'message') {
      if (item.role !== 'assistant' || !Array.isArray(item.content)) throw failure('Responses assistant 消息无效', 'INVALID_RESPONSE');
      for (const part of item.content) {
        if (part?.type === 'refusal') throw failure('模型拒绝了本次请求', 'MODEL_REFUSAL');
        if (part?.type !== 'output_text' || typeof part.text !== 'string') throw failure('Responses 包含尚未支持的输出类型', 'INVALID_RESPONSE');
        parts.push(part.text);
      }
    } else if (item?.type === 'function_call') {
      const callId = identifier(item.call_id, '函数响应 call_id', 'INVALID_RESPONSE');
      if (callIds.has(callId)) throw failure('Responses 返回重复函数调用 ID', 'INVALID_RESPONSE');
      callIds.add(callId);
      toolCalls.push({ id: callId, type: 'function', function: { name: identifier(item.name, '函数名称', 'INVALID_RESPONSE'), arguments: argumentsOf(item.arguments, 'INVALID_RESPONSE') } });
    } else throw failure('Responses 返回未经授权的输出工具或类型', 'INVALID_RESPONSE');
  }
  return { id: payload.id, model: payload.model, choices: [{ index: 0, message: { role: 'assistant', content: parts.join(''),
    ...(toolCalls.length ? { tool_calls: toolCalls } : {}) }, finish_reason: toolCalls.length ? 'tool_calls' : 'stop' }], usage: completionUsage(protocol, payload) };
}

/** Identify this product honestly; never send raw local IDs to Go or unrelated hosts. */
export function conversationHeaders(baseUrl, stableSession) {
  let url;
  try { url = new URL(baseUrl); } catch { return {}; }
  if (url.protocol !== 'https:' || url.hostname !== 'opencode.ai' || url.port || !/^\/zen\/go\/v1\/?$/.test(url.pathname)
    || url.username || url.password || url.search || url.hash) return {};
  if (typeof stableSession !== 'string' || !stableSession.trim()) throw failure('Go 请求需要稳定的会话标识', 'SESSION_REQUIRED');
  return { 'User-Agent': 'AgentDepartment/0.2.0', 'x-opencode-session': 'agent-department-' + createHash('sha256').update(stableSession).digest('hex') };
}
