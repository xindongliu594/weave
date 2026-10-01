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
