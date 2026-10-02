export class ApiError extends Error { constructor(message: string, public status: number, public code?: string) { super(message); } }
export async function api<T>(path: string, method = 'GET', body?: unknown, requestKey?: string): Promise<T> {
  try {
    const response = await fetch(import.meta.env.BASE_URL + 'api' + path, { method, headers: { 'Content-Type': 'application/json', ...(method === 'GET' ? {} : { 'Idempotency-Key': requestKey ?? crypto.randomUUID() }) }, body: body === undefined ? undefined : JSON.stringify(body), ...(method === 'GET' ? { cache:'no-store',signal: AbortSignal.timeout(10000) } : {}) });
    const data = await response.json();
    if (!response.ok) throw new ApiError(data.message ?? '请求失败', response.status, data.code);
    return data as T;
  } catch (error) {
    if (method === 'GET' && error instanceof Error && error.name === 'TimeoutError') throw new ApiError('读取请求超时，请刷新；后台执行和已保存记录仍然保留。',408,'READ_TIMEOUT');
    throw error;
  }
}
