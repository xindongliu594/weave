export class ApiError extends Error { constructor(message: string, public status: number, public code?: string) { super(message); } }
const httpFailure = (status:number) => status===431
  ? '服务返回 HTTP 431：请求地址或请求头过长，请刷新工作台后重新检查。'
  : `服务返回 HTTP ${status}，响应为空或不是有效 JSON；请查看当前状态。`;
export async function readApiResponse<T>(response:Response,{readOnly=true}:{readOnly?:boolean}={}):Promise<T>{
  const invalid=(code:string):never=>{
    if(!readOnly)throw new Error(`服务返回 HTTP ${response.status}，本次操作的结果尚未确认，原请求编号与参数仍保留；请先查看当前状态，避免重复提交。`);
    throw new ApiError(httpFailure(response.status),response.status,code);
  };
  let data:any;
  try{const text=await response.text();data=text.trim()?JSON.parse(text):undefined;}
  catch{return invalid(response.ok?'INVALID_RESPONSE':'HTTP_RESPONSE_ERROR');}
  if(data===undefined)return invalid(response.ok?'EMPTY_RESPONSE':'HTTP_RESPONSE_ERROR');
  if(!response.ok)throw new ApiError(typeof data?.message==='string'?data.message:httpFailure(response.status),response.status,typeof data?.code==='string'?data.code:'HTTP_RESPONSE_ERROR');
  return data as T;
}
export async function api<T>(path: string, method = 'GET', body?: unknown, requestKey?: string, signal?: AbortSignal): Promise<T> {
  const readOnly=method==='GET'||method==='POST'&&/^\/projects\/[^/?]+\/planning-quote\/?$/.test(path);
  try {
    const init: RequestInit = { method, headers: { 'Content-Type': 'application/json', ...(readOnly ? {} : { 'Idempotency-Key': requestKey ?? crypto.randomUUID() }) }, body: body === undefined ? undefined : JSON.stringify(body), ...(readOnly ? { cache:'no-store',signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000) } : {}) };
    const response = await fetch((import.meta.env?.BASE_URL ?? '/') + 'api' + path, init).catch(error => {
      // Keep transport failures distinct from a confirmed HTTP response so pending request keys survive.
      if (error instanceof TypeError) throw new Error(readOnly
        ? '无法连接本机工作台服务。请确认启动窗口仍在运行，服务恢复后刷新页面。'
        : '无法连接本机工作台服务。请确认启动窗口仍在运行；此次操作的结果尚未确认，恢复连接后先查看状态，避免重复提交。');
      throw error;
    });
    return await readApiResponse<T>(response,{readOnly});
  } catch (error) {
    if (readOnly && error instanceof Error && error.name === 'TimeoutError') throw new ApiError('读取请求超时，请刷新；后台执行和已保存记录仍然保留。',408,'READ_TIMEOUT');
    throw error;
  }
}
