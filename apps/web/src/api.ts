export async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(import.meta.env.BASE_URL + 'api' + path, { method, headers: { 'Content-Type': 'application/json', ...(method === 'GET' ? {} : { 'Idempotency-Key': crypto.randomUUID() }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.message ?? '请求失败');
  return data as T;
}
