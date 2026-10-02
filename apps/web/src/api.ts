export class ApiError extends Error { constructor(message: string, public status: number, public code?: string) { super(message); } }
export async function api<T>(path: string, method = 'GET', body?: unknown, requestKey?: string): Promise<T> {
  const response = await fetch(import.meta.env.BASE_URL + 'api' + path, { method, headers: { 'Content-Type': 'application/json', ...(method === 'GET' ? {} : { 'Idempotency-Key': requestKey ?? crypto.randomUUID() }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new ApiError(data.message ?? '请求失败', response.status, data.code);
  return data as T;
}
