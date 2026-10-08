export class Semaphore {
  constructor(limit) { this.limit = limit; this.active = 0; this.queue = []; }
  acquire(signal) {
    signal?.throwIfAborted();
    return new Promise((resolve,reject)=>{
      const ticket={start:()=>{signal?.removeEventListener('abort',abort);this.active++;let done=false;resolve(()=>{if(done)return;done=true;this.active--;this.queue.shift()?.start();});}};
      const abort=()=>{const i=this.queue.indexOf(ticket);if(i>=0)this.queue.splice(i,1);reject(signal.reason??Error('Cancelled'));};
      if(this.active<this.limit)ticket.start();else{this.queue.push(ticket);signal?.addEventListener('abort',abort,{once:true});}
    });
  }
}
export function fitMessages(messages, maxBytes, protectedIndexes = []) {
  const size=value=>Buffer.byteLength(JSON.stringify(value));
  if(size(messages)<=maxBytes)return {messages,removed:0};
  const groups=[];
  for(const message of messages){if(message.role==='tool'&&groups.length)groups.at(-1).push(message);else groups.push([message]);}
  const lastUser=groups.findLastIndex(g=>g[0].role==='user');
  let removed=0;
  const protectedMessages=new Set(protectedIndexes.map(index=>messages[index]));
  const keep=groups.map((group,i)=>({group,essential:group[0].role==='system'||i===lastUser||i===groups.length-1||group.some(message=>protectedMessages.has(message))}));
  while(size(keep.flatMap(g=>g.group))>maxBytes){const index=keep.findIndex(g=>!g.essential);if(index<0)throw Error('CONTEXT_LIMIT: 岗位、当前任务与最新工具响应超过上下文上限');keep.splice(index,1);removed++;}
  return {messages:keep.flatMap(g=>g.group),removed};
}

/** Match the transport's conservative reservation exactly. The byte counts are
 * UTF-8 JSON.stringify({messages,tools}) envelopes, excluding the 1024 guard.
 * Remove whole old groups only; never edit their text, schemas or output cap.
 */
export function fitAffordableMessages(messages, tools, { maxBytes, inputRate, outputRate, maxTokens, availableBudget }, protectedIndexes = []) {
  if (!Array.isArray(messages) || !Number.isSafeInteger(maxBytes) || maxBytes < 1
    || ![inputRate, outputRate, availableBudget].every(value => Number.isFinite(value) && value >= 0)
    || !Number.isSafeInteger(maxTokens) || maxTokens < 1
    || !Array.isArray(protectedIndexes) || protectedIndexes.some(index => !Number.isSafeInteger(index) || index < 0 || index >= messages.length)) {
    const error = new RangeError('可负担上下文的预算、价格、输出上限或保护索引无效');
    error.code = 'INVALID_BUDGET_CONTEXT';
    throw error;
  }
  const bytes = value => Buffer.byteLength(JSON.stringify(value));
  const beforeBytes = bytes({ messages, tools });
  const outputAmount = maxTokens * outputRate;
  // Keep undefined tools undefined: it omits a JSON field, whereas [] does not.
  const overhead = bytes({ messages: [], tools }) - bytes([]);
  const affordableBytes = inputRate === 0 ? maxBytes
    : Math.floor((availableBudget * 1e6 - outputAmount) / inputRate) - 1024 - overhead;
  const maxMessageBytes = Math.min(maxBytes, affordableBytes);
  const lastAssistant = messages.findLastIndex(message => message.role === 'assistant');
  const protectedGroups = lastAssistant < 0 ? protectedIndexes : [...protectedIndexes, lastAssistant];
  // The existing byte guard is independent of money. If these same protected
  // groups cannot fit even with unlimited funds, retain that failure class.
  try { fitMessages(messages, maxBytes, protectedGroups); }
  catch (error) {
    if (error instanceof Error && error.message.startsWith('CONTEXT_LIMIT:')) error.code = 'CONTEXT_LIMIT';
    throw error;
  }
  const blocked = cause => {
    const error = new Error('BUDGET_CONTEXT_LIMIT: 原预算无法容纳岗位、当前合同、最新回复与受保护证据；没有发送模型请求', { cause });
    error.code = 'BUDGET_CONTEXT_LIMIT';
    error.details = Object.freeze({ beforeBytes, maxMessageBytes, availableBudget, maxTokens });
    return error;
  };
  if (!Number.isFinite(outputAmount) || outputAmount / 1e6 > availableBudget || maxMessageBytes < 1) throw blocked();
  let fitted;
  try { fitted = fitMessages(messages, maxMessageBytes, protectedGroups); }
  catch (cause) {
    if (cause instanceof Error && cause.message.startsWith('CONTEXT_LIMIT:')) throw blocked(cause);
    throw cause;
  }
  const afterBytes = bytes({ messages: fitted.messages, tools });
  const inputUpperBound = afterBytes + 1024;
  const reservation = (inputUpperBound * inputRate + outputAmount) / 1e6;
  // Check the exact resulting envelope rather than relying solely on division
  // and rounding near a budget boundary. A failure never retries or truncates.
  if (!Number.isFinite(reservation) || reservation > availableBudget) throw blocked();
  return { ...fitted, beforeBytes, afterBytes, inputUpperBound, reservation, maxMessageBytes };
}
