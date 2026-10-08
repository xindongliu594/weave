import { z } from 'zod';
import { pool } from './db.ts';
import { AppError, gatewayRequest } from './provider.ts';

// New API quota points are neither token counts nor a verified currency amount.
export type NewApiUsageData = {
  unit: 'quota'; totalGranted: number; totalUsed: number; totalAvailable: number;
  unlimitedQuota: boolean; expiresAt: number;
};
export type NewApiLogRecord = {
  createdAt?: number; type?: number; modelName?: string; quota?: number;
  promptTokens?: number; completionTokens?: number;
  requestId?: string; upstreamRequestId?: string;
};
export type BillingFailureReason = 'permission-denied' | 'endpoint-unsupported';
type BillingFailure = { status: 'failed'; message: string; code: string; upstreamStatus?: number; failureReason?: BillingFailureReason };
export type DashboardBillingUsageData = { unit: 'unknown'; totalUsage: number };
export type DashboardBillingSubscriptionData = {
  unit: 'USD'; unlimited: boolean; hardLimitUSD?: number; softLimitUSD?: number;
  systemHardLimitUSD?: number; accessUntil?: number;
};
export type DashboardBillingCompatibility = {
  source: 'documented-dashboard-billing';
  usage: { status: 'available'; message: string; data: DashboardBillingUsageData } | BillingFailure;
  subscription: { status: 'available'; message: string; data: DashboardBillingSubscriptionData } | BillingFailure;
};
export type NewApiBillingResult = {
  gatewayId: string; gatewayVersion: number; checkedAt: string;
  billingUnit?: { quotaPerUSD: number; basis: 'new-api-status' };
  compatibility?: DashboardBillingCompatibility;
  usage: { status: 'available'; message: string; data: NewApiUsageData } | BillingFailure;
  logs: { status: 'available'; message: string; records: NewApiLogRecord[]; recordCount: number } | BillingFailure;
};

const nonnegativeInteger = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const signedInteger = z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER);
// Model identifiers/request identifiers cannot contain prose, controls or secrets.
const safeIdentifier = (max: number) => z.string().min(1).max(max)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/)
  .refine(value => !/^sk-/i.test(value));
const optionalIdentifier = (max: number) => z.preprocess(value => value === '' || value === null ? undefined : value, safeIdentifier(max).optional());
const usageSchema = z.object({
  code: z.literal(true),
  data: z.object({
    total_granted: nonnegativeInteger, total_used: nonnegativeInteger,
    total_available: signedInteger, unlimited_quota: z.boolean(),
    expires_at: z.number().int().min(-1).max(Number.MAX_SAFE_INTEGER),
  }),
});
const logSchema = z.object({
  // The API's display id can change after filtering; it is deliberately discarded.
  created_at: nonnegativeInteger.optional(), type: nonnegativeInteger.optional(),
  model_name: optionalIdentifier(200), quota: signedInteger.optional(),
  prompt_tokens: nonnegativeInteger.optional(), completion_tokens: nonnegativeInteger.optional(),
  request_id: optionalIdentifier(256), upstream_request_id: optionalIdentifier(256),
});
const logsSchema = z.object({ success: z.literal(true), data: z.array(logSchema).max(1000) });
const statusSchema = z.object({ success: z.literal(true), data: z.object({ display_in_currency: z.literal(true), quota_per_unit: z.number().finite().positive() }) });
const nonnegativeAmount = z.number().finite().min(0).max(Number.MAX_SAFE_INTEGER);
const dashboardUsageSchema = z.object({ object: z.literal('list'), total_usage: nonnegativeAmount });
const dashboardSubscriptionSchema = z.object({
  object: z.literal('billing_subscription'), hard_limit_usd: nonnegativeAmount,
  soft_limit_usd: nonnegativeAmount.optional(), system_hard_limit_usd: nonnegativeAmount.optional(),
  access_until: nonnegativeInteger.optional(),
});
const unlimitedLimitSentinel = 100000000;
function explicitlyDenied(value: unknown): boolean {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    ((value as { code?: unknown }).code === false || (value as { success?: unknown }).success === false || Object.hasOwn(value, 'error'));
}

export function parseDashboardBillingUsage(value: unknown): DashboardBillingUsageData | undefined {
  if (explicitlyDenied(value)) return;
  const parsed = dashboardUsageSchema.safeParse(value);
  if (!parsed.success) return;
  // The site's documentation does not specify the total_usage unit. It must not
  // be divided by quotaPerUSD or subtracted from a USD authorization limit.
  return { unit: 'unknown', totalUsage: parsed.data.total_usage };
}

export function parseDashboardBillingSubscription(value: unknown): DashboardBillingSubscriptionData | undefined {
  if (explicitlyDenied(value)) return;
  const parsed = dashboardSubscriptionSchema.safeParse(value);
  if (!parsed.success) return;
  const data = parsed.data;
  const unlimited = data.hard_limit_usd === unlimitedLimitSentinel;
  return {
    unit: 'USD', unlimited,
    ...(!unlimited ? { hardLimitUSD: data.hard_limit_usd } : {}),
    ...(data.soft_limit_usd !== undefined && data.soft_limit_usd !== unlimitedLimitSentinel ? { softLimitUSD: data.soft_limit_usd } : {}),
    ...(data.system_hard_limit_usd !== undefined && data.system_hard_limit_usd !== unlimitedLimitSentinel ? { systemHardLimitUSD: data.system_hard_limit_usd } : {}),
    ...(data.access_until !== undefined ? { accessUntil: data.access_until } : {}),
  };
}

export function parseNewApiBillingUnit(value: unknown): NewApiBillingResult['billingUnit'] {
  if (explicitlyDenied(value)) return;
  const parsed = statusSchema.safeParse(value);
  if (!parsed.success) return;
  return { quotaPerUSD: parsed.data.data.quota_per_unit, basis: 'new-api-status' };
}

export function parseNewApiUsage(value: unknown): NewApiUsageData | undefined {
  if (explicitlyDenied(value)) return;
  const parsed = usageSchema.safeParse(value);
  if (!parsed.success) return;
  const data = parsed.data.data;
  return {
    unit: 'quota', totalGranted: data.total_granted, totalUsed: data.total_used,
    totalAvailable: data.total_available, unlimitedQuota: data.unlimited_quota, expiresAt: data.expires_at,
  };
}

export function parseNewApiLogs(value: unknown): NewApiLogRecord[] | undefined {
  if (explicitlyDenied(value)) return;
  const parsed = logsSchema.safeParse(value);
  if (!parsed.success) return;
  return parsed.data.data.map(data => ({
    ...(data.created_at !== undefined ? { createdAt: data.created_at } : {}),
    ...(data.type !== undefined ? { type: data.type } : {}),
    ...(data.model_name !== undefined ? { modelName: data.model_name } : {}),
    ...(data.quota !== undefined ? { quota: data.quota } : {}),
    ...(data.prompt_tokens !== undefined ? { promptTokens: data.prompt_tokens } : {}),
    ...(data.completion_tokens !== undefined ? { completionTokens: data.completion_tokens } : {}),
    ...(data.request_id !== undefined ? { requestId: data.request_id } : {}),
    ...(data.upstream_request_id !== undefined ? { upstreamRequestId: data.upstream_request_id } : {}),
  }));
}

export function billingFailureReason(code: string, upstreamStatus?: number): BillingFailureReason | undefined {
  if (code === 'NEW_API_QUERY_REJECTED' || code === 'GATEWAY_REJECTED' && (upstreamStatus === 401 || upstreamStatus === 403)) return 'permission-denied';
  if (code === 'GATEWAY_REJECTED' && [404, 405, 410].includes(upstreamStatus ?? 0) ||
      ['NEW_API_INVALID_USAGE', 'NEW_API_INVALID_LOGS', 'DASHBOARD_BILLING_INVALID_USAGE', 'DASHBOARD_BILLING_INVALID_SUBSCRIPTION'].includes(code)) return 'endpoint-unsupported';
  // Invalid JSON also covers body-read failures in the transport. It cannot,
  // by itself, prove permanent incompatibility; network/5xx/429 remain bounded retries.
}

function failed(error: unknown): BillingFailure {
  // Neither arbitrary exception text nor New API's message/content is public output.
  if (error instanceof AppError && error.status === 502) {
    const upstreamStatus = Number.isInteger(error.upstreamStatus) && error.upstreamStatus! >= 100 && error.upstreamStatus! <= 599 ? error.upstreamStatus : undefined;
    const failureReason = billingFailureReason(error.code, upstreamStatus);
    return { status: 'failed', message: error.message, code: error.code,
      ...(upstreamStatus === undefined ? {} : { upstreamStatus }), ...(failureReason ? { failureReason } : {}) };
  }
  return { status: 'failed', message: 'New API 查询失败，保留待核对状态，请检查服务和权限后重试', code: 'NEW_API_QUERY_FAILED' };
}

const capabilityTtlMs = 5 * 60 * 1000;
type UnsupportedEndpoints = { baseUrl: string; expiresAt: number; usage?: AppError; logs?: AppError };
const unsupportedEndpoints = new Map<string, UnsupportedEndpoints>();
function unsupported(error: unknown): error is AppError {
  return error instanceof AppError && error.status === 502 &&
    ((error.code === 'GATEWAY_REJECTED' && error.upstreamStatus === 404) ||
      ['GATEWAY_INVALID_RESPONSE', 'NEW_API_INVALID_USAGE', 'NEW_API_INVALID_LOGS'].includes(error.code));
}
function queryFailure(result: PromiseSettledResult<unknown>, invalidCode: string, invalidMessage: string): unknown {
  if (result.status === 'rejected') return result.reason;
  if (explicitlyDenied(result.value))
    return new AppError(502, '查询被中转站拒绝，请检查此查询接口的权限；保留待核对状态', 'NEW_API_QUERY_REJECTED');
  return new AppError(502, invalidMessage, invalidCode);
}
function cachedFailure(error: AppError): Promise<never> {
  return Promise.reject(new AppError(error.status, error.message + '（近期检测结果；5 分钟后重新探测）', error.code, error.upstreamStatus));
}

async function queryDashboardCompatibility(gatewayId: string, gatewayVersion: number): Promise<DashboardBillingCompatibility> {
  const options = { timeoutMs: 8000, maxBytes: 8 * 1024 * 1024, expectedVersion: gatewayVersion };
  const [usageResult, subscriptionResult] = await Promise.allSettled([
    gatewayRequest(gatewayId, '/dashboard/billing/usage', undefined, { ...options, dashboardBillingPath: '/dashboard/billing/usage' }),
    gatewayRequest(gatewayId, '/dashboard/billing/subscription', undefined, { ...options, dashboardBillingPath: '/dashboard/billing/subscription' }),
  ]);
  const usage = usageResult.status === 'fulfilled' ? parseDashboardBillingUsage(usageResult.value) : undefined;
  const subscription = subscriptionResult.status === 'fulfilled' ? parseDashboardBillingSubscription(subscriptionResult.value) : undefined;
  return {
    source: 'documented-dashboard-billing',
    usage: usage ? { status: 'available', message: '已读取兼容接口原始用量；单位未经核实，仅供辅助核对', data: usage }
      : failed(queryFailure(usageResult, 'DASHBOARD_BILLING_INVALID_USAGE', '兼容用量响应格式不兼容，不能推定费用')),
    subscription: subscription ? { status: 'available', message: subscription.unlimited ? 'Key 返回无限授权额度标志；这不代表账户有无限余额' : '已读取 Key 的 USD 授权额度上限；这不是当前可用余额', data: subscription }
      : failed(queryFailure(subscriptionResult, 'DASHBOARD_BILLING_INVALID_SUBSCRIPTION', '兼容授权额度响应格式不兼容，不能推定余额')),
  };
}

export async function queryNewApiBilling(gatewayId: string, expectedVersion?: number, options: { forceProbe?: boolean } = {}): Promise<NewApiBillingResult> {
  const gateway = (await pool.query('SELECT data,version FROM gateways WHERE id=$1', [gatewayId])).rows[0];
  if (!gateway) throw new AppError(404, '中转站不存在');
  if (expectedVersion !== undefined && gateway.version !== expectedVersion)
    throw new AppError(409, '中转站配置已变化，请刷新后重新查询', 'VERSION_CONFLICT');
  // Only this site's own public documentation has verified these fallback
  // endpoints. Other gateways are not probed for guessed billing routes.
  let documentedDashboard = false;
  try { documentedDashboard = new URL(gateway.data.baseUrl).origin === 'https://api.rcouyi.com'; } catch { /* Existing gateway validation will report configuration issues. */ }
  const cacheKey = `${gatewayId}:${gateway.version}`;
  // An explicit receipt query may retry a repaired endpoint immediately; a
  // capability cache must not silently turn that user action into a cached denial.
  if (options.forceProbe) unsupportedEndpoints.delete(cacheKey);
  let cached = unsupportedEndpoints.get(cacheKey);
  if (cached && (cached.expiresAt <= Date.now() || cached.baseUrl !== gateway.data.baseUrl)) { unsupportedEndpoints.delete(cacheKey); cached = undefined; }
  const requestOptions = { timeoutMs: 8000, maxBytes: 8 * 1024 * 1024, expectedVersion: gateway.version };
  const [usageResult, logsResult, statusResult] = await Promise.allSettled([
    cached?.usage ? cachedFailure(cached.usage) : gatewayRequest(gatewayId, '/api/usage/token/', undefined, { ...requestOptions, newApiPath: '/api/usage/token/' }),
    cached?.logs ? cachedFailure(cached.logs) : gatewayRequest(gatewayId, '/api/log/token', undefined, { ...requestOptions, newApiPath: '/api/log/token' }),
    gatewayRequest(gatewayId, '/api/status', undefined, { ...requestOptions, publicNewApiStatus: true }),
  ]);
  const usage = usageResult.status === 'fulfilled' ? parseNewApiUsage(usageResult.value) : undefined;
  const records = logsResult.status === 'fulfilled' ? parseNewApiLogs(logsResult.value) : undefined;
  const usageFailure = usage ? undefined : queryFailure(usageResult, 'NEW_API_INVALID_USAGE', '额度响应格式不兼容，不能推定余额或费用');
  const logsFailure = records ? undefined : queryFailure(logsResult, 'NEW_API_INVALID_LOGS', '消费日志响应格式不兼容，保留待核对状态');
  const compatibility = documentedDashboard && unsupported(usageFailure) ? await queryDashboardCompatibility(gatewayId, gateway.version) : undefined;
  const current = (await pool.query('SELECT version FROM gateways WHERE id=$1', [gatewayId])).rows[0];
  if (!current || current.version !== gateway.version)
    throw new AppError(409, '查询期间中转站配置已变化，请重新查询', 'VERSION_CONFLICT');

  if (documentedDashboard && (unsupported(usageFailure) || unsupported(logsFailure))) {
    // Preserve the original failure without extending its lease on cached reads.
    if (!cached) {
      if (unsupportedEndpoints.size >= 256) unsupportedEndpoints.delete(unsupportedEndpoints.keys().next().value!);
      unsupportedEndpoints.set(cacheKey, { baseUrl: gateway.data.baseUrl, expiresAt: Date.now() + capabilityTtlMs,
        ...(unsupported(usageFailure) ? { usage: usageFailure } : {}), ...(unsupported(logsFailure) ? { logs: logsFailure } : {}) });
    } else {
      if (!cached.usage && unsupported(usageFailure)) cached.usage = usageFailure;
      if (!cached.logs && unsupported(logsFailure)) cached.logs = logsFailure;
    }
  }
  const billingUnit = statusResult.status === 'fulfilled' ? parseNewApiBillingUnit(statusResult.value) : undefined;
  return {
    gatewayId, gatewayVersion: gateway.version, checkedAt: new Date().toISOString(),
    ...(billingUnit ? { billingUnit } : {}),
    ...(compatibility ? { compatibility } : {}),
    usage: usage ? { status: 'available', message: '已读取当前 Key 的额度，数值单位为中转站原始额度点', data: usage }
      : failed(usageFailure),
    logs: records ? { status: 'available', message: '已读取当前 Key 的消费日志；没有记录不能证明未调用或零费用', records, recordCount: records.length }
      : failed(logsFailure),
  };
}
